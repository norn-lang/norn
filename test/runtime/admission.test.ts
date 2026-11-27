import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ADMISSION_INTERFACE_SOURCE, builtinInterface, checkSource, elaborate, hostSources, readLibrary,
} from "../../src/frontend/check/index.ts";
import { compile, evaluateAdmissionPolicy, text, variant, type Value } from "../../src/runtime/browser.ts";

const host = builtinInterface();
const strip = (source: string) => source.split("\n").filter((line) => !line.trim().startsWith("//") && line.trim() !== "").join("\n");

/** What a host hands a policy: the use of a secret, asked from a place, by a Run that may be working on a program's request. */
const asked = (target: string, work: { program: string; digest: string } | null = null): Value => ({
  type: "record",
  fields: {
    what: text("secret.use"), target: text(target), place: text("conversation-1"), owner: text("user-1"),
    work: work ? variant("Some", { type: "record", fields: { program: text(work.program), digest: text(work.digest) } }) : variant("None"),
  },
});

/**
 * A Space's policy library, and the program whose value is its `admit`. The
 * program wraps the call: a library's function named bare (`Access.admit`)
 * checks but is not yet a value the evaluator links.
 */
function policy(library: string) {
  const lib = readLibrary(library, "Access.norn", host, { name: "Access" });
  const errors = lib.diagnostics.filter((d) => d.severity === "error");
  const checked = errors.length ? null : checkSource("(asked: Admission.request) => Access.admit(asked)", { host, std: null, libraries: { Access: lib } });
  return {
    errors: [...errors, ...(checked?.diagnostics.filter((d) => d.severity === "error") ?? [])].map((d) => d.message),
    code: () => compile(elaborate(checked!.program!, checked!.reports), { sources: hostSources(host), libraries: { Access: lib.program } }),
    /** The effects of calling it, which a host refuses a policy for having. */
    effects: () => (checkSource(`switch Access.admit({what: "", target: "", place: "", owner: "", work: None}) {
| Allow => ()
| Deny(_) => ()
| AlsoAsk(_) => ()
}`, { host, std: null, libraries: { Access: lib } })),
  };
}

const ACCESS = `
pub let admit = (req: Admission.request) =>
  switch req.work {
  | Some(w) if req.what == "secret.use" && req.target == "database-read"
      && w.program == "page-1/patrol" => Allow
  | _ => if req.target == "retired-key" { Deny("That secret is retired") } else { AlsoAsk(@alice) }
  }
`;

test("the interface file and the text the checker embeds say the same", () => {
  assert.equal(strip(readFileSync(new URL("../../interfaces/admission.norn", import.meta.url), "utf8")), strip(ADMISSION_INTERFACE_SOURCE));
});

test("a policy admits, refuses, or has someone asked, from the record a host hands it", () => {
  const access = policy(ACCESS);
  assert.deepEqual(access.errors, []);
  const code = access.code();
  assert.deepEqual(evaluateAdmissionPolicy(code, asked("database-read", { program: "page-1/patrol", digest: "d" }), 1000), { decision: "Allow" });
  // The same secret, asked for by a Run that works on no program's request, or on another's.
  assert.deepEqual(evaluateAdmissionPolicy(code, asked("database-read"), 1000), { decision: "AlsoAsk", participant: "@alice" });
  assert.deepEqual(evaluateAdmissionPolicy(code, asked("database-read", { program: "page-2/other", digest: "d" }), 1000),
    { decision: "AlsoAsk", participant: "@alice" });
  assert.deepEqual(evaluateAdmissionPolicy(code, asked("retired-key"), 1000), { decision: "Deny", reason: "That secret is retired" });
});

test("a policy that compares the digest admits a program only at the text somebody read", () => {
  const access = policy(`pub let admit = (req: Admission.request) =>
  switch req.work {
  | Some(w) if w.program == "page-1/patrol" && w.digest == "read-by-alice" => Allow
  | _ => AlsoAsk(@alice)
  }`);
  const code = access.code();
  assert.deepEqual(evaluateAdmissionPolicy(code, asked("a", { program: "page-1/patrol", digest: "read-by-alice" }), 1000), { decision: "Allow" });
  assert.deepEqual(evaluateAdmissionPolicy(code, asked("a", { program: "page-1/patrol", digest: "edited-since" }), 1000),
    { decision: "AlsoAsk", participant: "@alice" });
});

test("a value is handed over as it is: no text in it is read as code", () => {
  const code = policy(`pub let admit = (req: Admission.request) => if req.target == "safe" { Allow } else { Deny(req.target) }`).code();
  const hostile = "\\" + "\"} else { Allow } // ${x} `\b\f\u0000";
  assert.deepEqual(evaluateAdmissionPolicy(code, asked(hostile), 1000), { decision: "Deny", reason: hostile });
});

test("the checker refuses a policy of another type, or one that reads what the record lacks", () => {
  assert.match(policy(`pub let admit = (req: Admission.request) => if req.team == "a" { Allow } else { Deny("no") }`).errors.join(),
    /has no field team/u);
  const reply = policy(`pub let admit = (req: Admission.request) => if req.target == "a" { Answered(Yes) } else { Refused("no") }`);
  assert.deepEqual(reply.errors, []);
  assert.equal(reply.effects().ok, false, "its answer is a reply, not an admission");
});

test("a policy has no effect: one that asks is found before it runs, and cannot run", () => {
  const asks = policy(`pub let admit = (req: Admission.request) =>
  switch confirm(@alice, req.target, ~by=1h)->wait { | Answered(Yes) => Allow | _ => Deny("no") }`);
  assert.deepEqual(asks.errors, []);
  assert.deepEqual((asks.effects().effects ?? []).map((effect) => effect.family).sort(), ["confirm", "wait"]);
  assert.throws(() => evaluateAdmissionPolicy(asks.code(), asked("a"), 1000), /effect/u);
  assert.deepEqual((policy(ACCESS).effects().effects ?? []), []);
});

test("a policy that fails, never stops, or answers something else decides nothing", () => {
  const spins = policy(`let rec spin = (n) => spin(n + 1)\npub let admit = (req: Admission.request) => if spin(0) == 0 { Allow } else { Allow }`);
  assert.throws(() => evaluateAdmissionPolicy(spins.code(), asked("a"), 1000));
  const other = policy(`pub let admit = (req: Admission.request) => req.target`);
  assert.throws(() => evaluateAdmissionPolicy(other.code(), asked("a"), 1000), /invalid value/u);
});

test("a library reads the interface's types by name, and by their fields alone", () => {
  const lib = readLibrary(`pub let admit = (req: Admission.request) => Allow`, "Admission.norn", host, { name: "Access" });
  assert.equal(lib.ok, true);
  const unannotated = policy(`pub let admit = req => if req.target == "a" && req.place == "b" { Allow } else { Deny("no") }`);
  assert.deepEqual(unannotated.errors, [], "its fields name the record with no annotation");
});
