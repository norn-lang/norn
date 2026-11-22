import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtinInterface, checkSource, elaborate, readLibrary, type ConnectorManifest,
} from "../../src/frontend/check/index.ts";
import { compile } from "../../src/runtime/code.ts";
import { mismatchAll } from "../../src/runtime/form.ts";
import { deliverEvent, emptyLedger, evaluate, settle } from "../../src/runtime/ledger.ts";
import { text, variant } from "../../src/runtime/value.ts";

const host = builtinInterface();

const MANIFESTS: ConnectorManifest[] = [
  {
    app: "github",
    events: [
      {
        kind: "issues.opened",
        fields: [
          { name: "number", type: "int", required: true },
          { name: "title", type: "string", required: true },
          { name: "author", type: "string", required: true },
        ],
      },
      {
        kind: "workflow_run.completed",
        fields: [
          { name: "workflow", type: "string", required: true },
          { name: "conclusion", type: "string", required: true },
          { name: "branch", type: "string", required: true },
          { name: "defaultBranch", type: "string", required: true },
        ],
      },
    ],
  },
  {
    app: "gmail",
    events: [
      {
        kind: "message.received",
        fields: [
          { name: "messageId", type: "string", required: true },
          { name: "to", type: "list<string>", required: true },
          { name: "subject", type: "string", required: true },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 1. Row presence constraints `'r: {f: 'a, ..}` (order-independent!)
// ---------------------------------------------------------------------------
test("row presence constraints work across distinct record types regardless of declaration order", () => {
  const src = `
type alpha = {title: string, extra: int}
type beta = {title: string, other: bool}
let getTitle = x => x.title
let a = getTitle({title: "one", extra: 1})
let b = getTitle({title: "two", other: true})
a ++ b
`;
  const checked = checkSource(src, { host, std: null });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  // Adding an unrelated record with the same field at the top changes nothing!
  const withExtraTop = `type unrelated = {title: int}\n${src}`;
  const checked2 = checkSource(withExtraTop, { host, std: null });
  assert.equal(checked2.ok, true, JSON.stringify(checked2.diagnostics));

  // Missing field on a record passed to polymorphic `getTitle` is caught statically with `missing-row-field`!
  const bad = checkSource(`
type alpha = {title: string, a: int}
type beta = {title: string, b: bool}
type noTitle = {name: string}
let getTitle = x => x.title
getTitle({name: "nope"})
`, { host, std: null });
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((d) => d.code === "missing-row-field"), JSON.stringify(bad.diagnostics));
});

// ---------------------------------------------------------------------------
// 2. End-to-end `Events` standard capability + GitHub & Gmail libraries + feedback-pro!
// ---------------------------------------------------------------------------
test("Events standard capability, GitHub/Gmail libraries, CloudEvents dedup, optional occurredAt, and zero-PII feedback-pro", () => {
  const githubLib = readLibrary(`
pub type issue = {number: int, title: string, author: string}
pub type workflowRun = {workflow: string, conclusion: string, branch: string, defaultBranch: string}

let issuesOpened: Events.kind<issue> = Events.kind("github", "issues.opened")
let workflowCompleted: Events.kind<workflowRun> = Events.kind("github", "workflow_run.completed")

pub let issueOpened = repo =>
  Events.events(issuesOpened, ~source=repo)->map(e => e.data)

pub let ciFailed = repo =>
  Events.events(workflowCompleted, ~source=repo)
  ->map(e => e.data)
  ->filter(r => r.conclusion == "failure" && r.branch == r.defaultBranch)
`, "github.norn", host, { name: "GitHub" });
  assert.equal(githubLib.ok, true, JSON.stringify(githubLib.diagnostics));

  const gmailLib = readLibrary(`
pub type mailRef = {messageId: string}
type mailEnvelope = {messageId: string, to: list<string>, subject: string}
let messageReceived: Events.kind<mailEnvelope> = Events.kind("gmail", "message.received")

pub let receivedAt = (address, ~subjectContains) => {
  let target = String.toLowerCase(address)
  Events.events(messageReceived)
  ->map(e => e.data)
  ->filter(m =>
    m.to->List.map(String.toLowerCase)->List.includes(target) &&
    subjectContains->List.some(word => String.includes(m.subject, word)))
  ->map(m => {messageId: m.messageId})
}
`, "gmail.norn", host, { name: "Gmail" });
  assert.equal(gmailLib.ok, true, JSON.stringify(gmailLib.diagnostics));

  const progSrc = `
type trigger = Mail(Gmail.mailRef) | Issue(int)

Gmail.receivedAt("hello@xmatrix.sh", ~subjectContains=["改进 xMatrix", "Help improve xMatrix"])
->map(m => Mail(m))
->or(GitHub.issueOpened("LambdaLabsHQ/xmatrix")->map(i => Issue(i.number)))
->forEach(~key="feedback-pro", cause =>
    run(@claude(~repo="LambdaLabsHQ/xmatrix"), "Handle feedback-pro", ~about=cause, ~by=8h)->wait)
`;
  const checked = checkSource(progSrc, {
    host,
    std: null,
    libraries: { GitHub: githubLib, Gmail: gmailLib },
    manifests: MANIFESTS,
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));

  const code = compile(elaborate(checked.program!, checked.reports, checked.formEvidence), {
    libraries: { GitHub: githubLib.program, Gmail: gmailLib.program },
  });
  const ledger = emptyLedger(0);
  assert.equal(evaluate(code, ledger, 0).opened.length, 0);

  // 1. Irrelevant email -> 0 dispatches! (occurredAt omitted = valid CloudEvents 1.0.2!)
  const d1 = deliverEvent(ledger, {
    app: "gmail",
    kind: "message.received",
    source: "gmail:acct-1",
    id: "msg-001",
    occurredAt: null,
    data: {
      type: "record",
      fields: {
        messageId: text("msg-001"),
        to: { type: "list", values: [text("newsletter@other.com")] },
        subject: text("Weekly digest"),
      },
    },
  }, 100);
  assert.equal(d1.delivered, true);
  assert.equal(evaluate(code, ledger, 100).opened.length, 0);

  // 2. Matching feedback email -> 1 dispatch with ONLY mailRef in `about` (zero email PII!).
  const d2 = deliverEvent(ledger, {
    app: "gmail",
    kind: "message.received",
    source: "gmail:acct-1",
    id: "msg-002",
    data: {
      type: "record",
      fields: {
        messageId: text("msg-002"),
        to: { type: "list", values: [text("HELLO@XMATRIX.SH")] },
        subject: text("Re: Help improve xMatrix - secret subject"),
      },
    },
  }, 200);
  assert.equal(d2.delivered, true);
  const p2 = evaluate(code, ledger, 200);
  assert.equal(p2.opened.length, 1);
  assert.ok(p2.opened[0]!.about!.includes("msg-002"));
  assert.ok(!p2.opened[0]!.about!.includes("HELLO@XMATRIX.SH"), "must not leak email address into public about");
  assert.ok(!p2.opened[0]!.about!.includes("secret subject"), "must not leak email subject into public about");

  // 3. Redelivering the exact same `(app, kind, source, id)` -> deduplicated, 0 new dispatches!
  const dup = deliverEvent(ledger, {
    app: "gmail",
    kind: "message.received",
    source: "gmail:acct-1",
    id: "msg-002",
    data: {
      type: "record",
      fields: {
        messageId: text("msg-002"),
        to: { type: "list", values: [text("HELLO@XMATRIX.SH")] },
        subject: text("Re: Help improve xMatrix"),
      },
    },
  }, 300);
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.delivered, false);
});

test("Events.kind manifest check catches unknown app, unknown kind, and undeclared fields while permitting json", () => {
  const badKind = checkSource(`
let k = Events.kind("github", "issue.opened_typo")
Events.events(k)->wait
`, { host, std: null, manifests: MANIFESTS });
  assert.equal(badKind.ok, false);
  assert.ok(badKind.diagnostics.some((d) => d.code === "unknown-event-kind"), JSON.stringify(badKind.diagnostics));

  const badField = checkSource(`
type badIssue = {number: int, nonexistent: string}
let k: Events.kind<badIssue> = Events.kind("github", "issues.opened")
Events.events(k)->wait
`, { host, std: null, manifests: MANIFESTS });
  assert.equal(badField.ok, false);
  assert.ok(badField.diagnostics.some((d) => d.code === "manifest-field-mismatch"), JSON.stringify(badField.diagnostics));

  // `json` escape hatch passes even without a record type!
  const escapeHatch = checkSource(`
let k: Events.kind<json> = Events.kind("github", "issues.opened")
Events.events(k)->wait
`, { host, std: null, manifests: MANIFESTS });
  assert.equal(escapeHatch.ok, true, JSON.stringify(escapeHatch.diagnostics));
});

// ---------------------------------------------------------------------------
// 3. Step 4: Generic `form` evidence passing, doc comments in Form, and `accepting`
// ---------------------------------------------------------------------------
test("generic form evidence passes distinct ReportForms through one polymorphic wrapper without monomorphization", () => {
  const src = `
/** Verdict on a proposal */
type verdict =
  /** Ready to ship */
  | Ship
  /** Needs work */
  | Hold(string)

type scoreCard = {
  /** Score between 0 and 100 */
  score: int,
  /** Short justification */
  reason: string,
}

let attempt = (who, ~otherwise, ~by=8h, task) =>
  switch run(who, task, ~by)->wait {
  | Answered(r) => Answered(r)
  | _ => run(otherwise, task, ~by)->wait
  }

let v: verdict = attempt(@claude, ~otherwise=@codex, "Review")->?
let s: scoreCard = attempt(@claude, ~otherwise=@codex, "Score")->?
(v, s)
`;
  // Note: `attempt(...)` returns `reply<'a>`, so postfix `?` extracts `'a` directly!
  const cleanSrc = src.replaceAll("->?", "?");
  const checked = checkSource(cleanSrc, { host, std: null });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.ok(checked.formEvidence, "expected Wadler-Blott form evidence plan");
  assert.equal(checked.formEvidence.lambdas.length, 1);
  assert.equal(checked.formEvidence.callSites.length, 2);

  // Verify doc comments preserved in Form!
  const scoreForm = checked.formEvidence.callSites[1]!.form;
  const def = scoreForm.definitions["scoreCard"];
  assert.ok(def && def.kind === "record");
  assert.equal(def.fields[0]!.name, "score");
  assert.equal(def.fields[0]!.doc, "Score between 0 and 100");
  assert.equal(def.fields[1]!.name, "reason");
  assert.equal(def.fields[1]!.doc, "Short justification");

  // Execute: first call expects `verdict`, second call expects `scoreCard`!
  const code = compile(elaborate(checked.program!, checked.reports, checked.formEvidence));
  const ledger = emptyLedger(0);
  const p1 = evaluate(code, ledger, 0);
  assert.equal(p1.opened.length, 1);
  assert.equal(p1.opened[0]!.form?.text, "verdict");

  // Wrong answer rejected; valid `Ship` settles first call and opens second call with `scoreCard` form!
  assert.equal(settle(ledger, p1.opened[0]!.id, "@claude", { tag: "Answered", value: text("nope") }, 10), false);
  assert.equal(settle(ledger, p1.opened[0]!.id, "@claude", { tag: "Answered", value: variant("Ship") }, 20), true);
  const p2 = evaluate(code, ledger, 20);
  assert.equal(p2.opened.length, 1);
  assert.equal(p2.opened[0]!.form?.text, "scoreCard");
});

test("accepting rejects out-of-range answers cleanly back to retry and accepts valid answers; mismatchAll reports all paths", () => {
  const src = `
type scoreCard = {score: int, reason: string}
let scored =
  run(@codex, "Score 0..100", ~by=1h)
  ->accepting(r => if r.score >= 0 && r.score <= 100 { Ok(r) } else { Error("score must be 0..100") })
  ->wait?
scored.score
`;
  const checked = checkSource(src, { host, std: null });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  const code = compile(elaborate(checked.program!, checked.reports, checked.formEvidence));
  const ledger = emptyLedger(0);

  const p1 = evaluate(code, ledger, 0);
  assert.equal(p1.opened.length, 1);
  const req = p1.opened[0]!;

  // Multi-path structural error reporting via `mismatchAll` reports BOTH missing/wrong fields at once.
  const errs = mismatchAll({ type: "record", fields: { score: text("bad") } }, req.form!);
  assert.equal(errs.length, 2);
  assert.ok(errs.some((e) => e.path === "$.score"));
  assert.ok(errs.some((e) => e.path === "$.reason"));

  // Structurally valid but out-of-range score (150) is rejected by `accepting` and re-opens the request!
  assert.equal(settle(ledger, req.id, "@codex", {
    tag: "Answered",
    value: { type: "record", fields: { score: { type: "int", value: "150" }, reason: text("too high") } },
  }, 10), true);
  const p2 = evaluate(code, ledger, 10);
  assert.equal(p2.status, "waiting");
  assert.equal(p2.validationErrors?.length, 1);
  assert.equal(p2.validationErrors![0]!.reason, "score must be 0..100");
  assert.equal(ledger.requests[req.id]!.reply, null);

  // Valid score (85) passes `accepting` and completes!
  assert.equal(settle(ledger, req.id, "@codex", {
    tag: "Answered",
    value: { type: "record", fields: { score: { type: "int", value: "85" }, reason: text("good") } },
  }, 20), true);
  const p3 = evaluate(code, ledger, 20);
  assert.equal(p3.status, "completed");
  assert.deepEqual(p3.result, { type: "int", value: "85" });
});

test("JSON.decode refuses external pub opaque types with opaque-form", () => {
  const review = readLibrary(`pub opaque type approved = {pr: string}`, "review.norn", host, { name: "Review" });
  assert.equal(review.ok, true);
  const bad = checkSource(`
let decodeFake = (j: json): result<Review.approved, string> => JSON.decode(j)
decodeFake
`, { host, std: null, libraries: { Review: review } });
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some((d) => d.code === "opaque-form"), JSON.stringify(bad.diagnostics));
});
