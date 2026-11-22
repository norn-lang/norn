import assert from "node:assert/strict";
import { test } from "node:test";
import { astFromJson, astToJson, astVersion, fixSource, formatSource, parse } from "../../../src/frontend/index.ts";
import {
  builtinInterface, checkSource, deriveInterface, diffInterfaces, diffProgramUpgrade, elaborate, pinProgramDefinitions, readLibrary,
} from "../../../src/frontend/check/index.ts";
import { compile } from "../../../src/runtime/code.ts";
import { emptyLedger, evaluate, settle } from "../../../src/runtime/ledger.ts";
import { variant } from "../../../src/runtime/value.ts";

const host = builtinInterface();

const REVIEW_LIB_SOURCE = `
pub opaque type approved = {pr: string}
let question = "Approve merge?"

pub let approve = (pr: string, ~reviewer): reply<approved> =>
  switch confirm(reviewer, question, ~about=pr, ~by=2d)->wait? {
  | Yes => Answered({pr: pr})
  | No => Refused("Not approved")
  }

pub let merge = (approval: approved, ~who) => run(who, "Merge", ~about=approval.pr, ~by=4h)
`;

test("pub opaque type enforces all 4 anti-leakage rules and rejects plain structural records at library boundary", () => {
  const review = readLibrary(REVIEW_LIB_SOURCE, "review.norn", host, { name: "Review" });
  assert.equal(review.ok, true, JSON.stringify(review.diagnostics));
  assert.deepEqual(review.exports.map((e) => e.name), ["approve", "merge"]);
  assert.deepEqual(review.types.map((t) => t.name), ["approved"]);

  // Valid program: obtains Review.approved via Review.approve and passes to Review.merge.
  const valid = checkSource(`
let a = Review.approve("acme/api#42", ~reviewer=@alice)?
Review.merge(a, ~who=@claude)->wait
`, { host, std: null, libraries: { Review: review } });
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  // CRITICAL ACCEPTANCE TEST: plain structural record {pr: "acme/api#42"} MUST be rejected by Review.merge!
  const forged = checkSource(`
type fake = {pr: string}
let f = {pr: "acme/api#42"}
Review.merge(f, ~who=@claude)->wait
`, { host, std: null, libraries: { Review: review } });
  assert.equal(forged.ok, false);
  assert.ok(forged.diagnostics.some((d) => d.code === "type-mismatch"), JSON.stringify(forged.diagnostics));

  // Rule 1: external `run` cannot forge an opaque type as its report form -> `opaque-form` naming `Review`.
  const forgedRun = checkSource(`
let fake: Review.approved = run(@claude, "Forge approval", ~by=1h)->wait?
Review.merge(fake, ~who=@claude)->wait
`, { host, std: null, libraries: { Review: review } });
  assert.equal(forgedRun.ok, false);
  assert.ok(forgedRun.diagnostics.some((d) => d.code === "opaque-form" && d.message.includes("Review")), JSON.stringify(forgedRun.diagnostics));

  // Rule 2: external `==` on opaque type is refused -> `opaque-equality`.
  const compareOpaque = checkSource(`
let a = Review.approve("acme/api#1", ~reviewer=@alice)?
let b = Review.approve("acme/api#2", ~reviewer=@alice)?
a == b
`, { host, std: null, libraries: { Review: review } });
  assert.equal(compareOpaque.ok, false);
  assert.ok(compareOpaque.diagnostics.some((d) => d.code === "opaque-equality"), JSON.stringify(compareOpaque.diagnostics));

  // Rule 3: external field access on opaque type is refused.
  const fieldRead = checkSource(`
let a = Review.approve("acme/api#1", ~reviewer=@alice)?
a.pr
`, { host, std: null, libraries: { Review: review } });
  assert.equal(fieldRead.ok, false);
  assert.ok(fieldRead.diagnostics.some((d) => d.code === "type-mismatch" && d.message.includes("opaque")), JSON.stringify(fieldRead.diagnostics));

  // Rule 4: external `~about=a` on opaque type is refused -> `opaque-about`.
  const leakAbout = checkSource(`
let a = Review.approve("acme/api#1", ~reviewer=@alice)?
ask(@bob, "Look", ~about=a, ~by=1h)->wait
`, { host, std: null, libraries: { Review: review } });
  assert.equal(leakAbout.ok, false);
  assert.ok(leakAbout.diagnostics.some((d) => d.code === "opaque-about"), JSON.stringify(leakAbout.diagnostics));

  // Private binding `question` is not exported.
  const privateAccess = checkSource(`Review.question`, { host, std: null, libraries: { Review: review } });
  assert.equal(privateAccess.ok, false);
  assert.ok(privateAccess.diagnostics.some((d) => d.code === "unknown-export"), JSON.stringify(privateAccess.diagnostics));
});

test("runtime links and executes libraries via Lib.name and selective open Lib.{a, b}", () => {
  const review = readLibrary(REVIEW_LIB_SOURCE, "review.norn", host, { name: "Review" });
  assert.equal(review.ok, true);
  const progSrc = `
open Review.{approve, merge}
let a = approve("acme/api#99", ~reviewer=@alice)?
merge(a, ~who=@claude)->wait
`;
  const checked = checkSource(progSrc, { host, std: null, libraries: { Review: review } });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  const code = compile(elaborate(checked.program!, checked.reports), { libraries: { Review: review.program } });
  const ledger = emptyLedger(0);
  const p1 = evaluate(code, ledger, 0);
  assert.equal(p1.opened.length, 1);
  assert.equal(p1.opened[0]!.holder, "@alice");
  settle(ledger, p1.opened[0]!.id, "@alice", { tag: "Answered", value: variant("Yes") }, 10);
  const p2 = evaluate(code, ledger, 10);
  assert.equal(p2.opened.length, 1);
  assert.equal(p2.opened[0]!.holder, "@claude");
  assert.equal(p2.opened[0]!.about, "acme/api#99");
});

test("no-shadowing open rejects ambiguous imports from two libraries and rejects shadowing locals", () => {
  const libA = readLibrary(`pub let ping = () => "a"`, "a.norn", host, { name: "LibA" });
  const libB = readLibrary(`pub let ping = () => "b"`, "b.norn", host, { name: "LibB" });
  assert.equal(libA.ok, true);
  assert.equal(libB.ok, true);

  const ambiguous = checkSource(`
open LibA
open LibB
ping()
`, { host, std: null, libraries: { LibA: libA, LibB: libB } });
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.diagnostics.some((d) => d.code === "ambiguous-open"), JSON.stringify(ambiguous.diagnostics));

  // Qualified access resolves cleanly even when both are opened.
  const qualified = checkSource(`
open LibA
open LibB
LibA.ping() ++ LibB.ping()
`, { host, std: null, libraries: { LibA: libA, LibB: libB } });
  assert.equal(qualified.ok, true, JSON.stringify(qualified.diagnostics));

  // Shadowing local binding with selective open is refused.
  const shadowed = checkSource(`
let ping = () => "local"
open LibA.{ping}
ping()
`, { host, std: null, libraries: { LibA: libA } });
  assert.equal(shadowed.ok, false);
  assert.ok(shadowed.diagnostics.some((d) => d.code === "shadowed-open"), JSON.stringify(shadowed.diagnostics));
});

test("flat library enforces purity at top level, private-in-public, and needs declaration", () => {
  const impure = readLibrary(`pub let bad = ask(@alice, "now")`, "impure.norn", host, { name: "Impure" });
  assert.equal(impure.ok, false);
  assert.ok(impure.diagnostics.some((d) => d.code === "library-effect"), JSON.stringify(impure.diagnostics));

  const leak = readLibrary(`
type secret = {token: string}
pub let make = (): secret => {token: "x"}
`, "leak.norn", host, { name: "Leak" });
  assert.equal(leak.ok, false);
  assert.ok(leak.diagnostics.some((d) => d.code === "private-in-public"), JSON.stringify(leak.diagnostics));

  const missingNeeds = readLibrary(`
needs Team
pub let who = () => Team.lead
`, "needs.norn", host, { name: "Policy" });
  assert.equal(missingNeeds.ok, false);
  assert.ok(missingNeeds.diagnostics.some((d) => d.code === "missing-needs"), JSON.stringify(missingNeeds.diagnostics));

  const team = readLibrary(`pub let lead = @alice`, "team.norn", host, { name: "Team" });
  const satisfied = readLibrary(`
needs Team
pub let askLead = (q: string) => ask(Team.lead, q, ~by=1h)
`, "policy.norn", host, { name: "Policy", libraries: { Team: team } });
  assert.equal(satisfied.ok, true, JSON.stringify(satisfied.diagnostics));
  assert.deepEqual(satisfied.needs, ["Team"]);
});

test("derived interface Elm-style diff, content-hash pinning, and 3-way upgrade diff requiring explicit adoption", () => {
  const v1 = readLibrary(`pub let check = (s: string) => s == "a"`, "filter.norn", host, { name: "Filter" });
  const v2PureChange = readLibrary(`pub let check = (s: string) => s == "b"`, "filter.norn", host, { name: "Filter" });
  const v3Minor = readLibrary(`pub let check = (s: string) => s == "a"\npub let extra = (x: int) => x + 1`, "filter.norn", host, { name: "Filter" });
  const v4Major = readLibrary(`pub let check = (n: int) => n > 0`, "filter.norn", host, { name: "Filter" });

  const i1 = deriveInterface(v1);
  const i2 = deriveInterface(v2PureChange);
  const i3 = deriveInterface(v3Minor);
  const i4 = deriveInterface(v4Major);

  const dPure = diffInterfaces(i1, i2);
  assert.equal(dPure.change, "NONE");
  assert.equal(dPure.definitionChanged, true);

  assert.equal(diffInterfaces(i1, i3).change, "MINOR");
  assert.equal(diffInterfaces(i1, i4).change, "MAJOR");

  // Even when interface diff, ledger preview diff, and effect-lock diff are ALL empty,
  // a changed pure filter condition MUST require explicit adoption (never silent auto-upgrade).
  const prog = parse(`if Filter.check("x") { ask(@alice, "go", ~by=1h)->wait } else { Answered("skip") }`);
  assert.equal(prog.ok, true);
  const pin = pinProgramDefinitions(prog.program, { Filter: v1 });
  assert.ok(pin.libraries.Filter!.hash.startsWith("sha256:"));

  const upgrade = diffProgramUpgrade({
    beforeProgram: prog.program,
    afterProgram: prog.program,
    host,
    std: null,
    beforeLibraries: { Filter: v1 },
    afterLibraries: { Filter: v2PureChange },
    ledger: emptyLedger(0),
    now: 0,
  });
  assert.equal(upgrade.interfaces[0]!.change, "NONE");
  assert.equal(upgrade.ledger!.empty, true);
  assert.equal(upgrade.effects.empty, true);
  assert.equal(upgrade.definitionChanged, true);
  assert.equal(upgrade.requiresExplicitAdoption, true);
});

test("norn fmt is idempotent and preserves v3 syntax; AST JSON v3 round-trips cleanly", () => {
  const src = `pub opaque type approved = {pr: string}\nneeds Team\nopen GitHub.{issueOpened}\npub let check = (x: string): bool => x == "ok"\n`;
  const formatted = formatSource(src);
  assert.equal(formatted.ok, true);
  const again = formatSource(formatted.text);
  assert.equal(again.ok, true);
  assert.equal(again.text, formatted.text);

  const parsed = parse(formatted.text);
  assert.equal(parsed.ok, true);
  assert.equal(astVersion(parsed.program), 3);
  const json = astToJson(parsed.program);
  assert.equal(astToJson(astFromJson(json)), json);
});

test("fixSource migrates event<T> to fact<T> cleanly", () => {
  const src = `external released: (string) => event<string>\n`;
  const res = fixSource(src, { host, std: null, migrate: true });
  assert.equal(res.changed, true);
  assert.equal(res.source, `external released: (string) => fact<string>\n`);
});
