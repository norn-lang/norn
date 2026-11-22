import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtinInterface, checkSource, deriveInterface, diffInterfaces, elaborate, hostSources,
  manifestEventForm, readInterface, readLibrary, type ConnectorManifest,
} from "../../src/frontend/check/index.ts";
import {
  compile, deliverEvent, emptyLedger, evaluate, occur, settle, text, verifyMigration,
} from "../../src/runtime/browser.ts";

const HOST_SRC = `
  external alert: (string) => stream<string>
`;
const customHost = readInterface(HOST_SRC, "test-host.norn");
const baseHost = builtinInterface();
const HOUR = 3_600_000;

function compileChecked(src: string, host = customHost) {
  const chk = checkSource(src, { host, std: null });
  assert.deepEqual(chk.diagnostics, [], JSON.stringify(chk.diagnostics));
  return compile(elaborate(chk.program!, chk.reports), { sources: hostSources(host) });
}

test("within(2h) anchors its absolute deadline on first entry and never shifts on later passes", () => {
  const code = compileChecked(`within(2h, () => ask(@alice, "Approve")->wait)`, baseHost);
  const ledger = emptyLedger(0);

  const p0 = evaluate(code, ledger, 0);
  assert.equal(p0.opened.length, 1);
  const reqId = p0.opened[0]!.id;
  assert.equal(ledger.requests[reqId]!.by, 2 * HOUR);

  // Re-evaluate at hour 1 and hour 1.5 — deadline MUST remain anchored at 2h!
  const p1 = evaluate(code, ledger, HOUR);
  assert.equal(p1.rescheduled.length, 0);
  assert.equal(ledger.requests[reqId]!.by, 2 * HOUR);

  const p15 = evaluate(code, ledger, Math.floor(1.5 * HOUR));
  assert.equal(p15.rescheduled.length, 0);
  assert.equal(ledger.requests[reqId]!.by, 2 * HOUR);

  // At hour 2, the anchored deadline expires into NoReply (a failure outcome at top level).
  const p2 = evaluate(code, ledger, 2 * HOUR);
  assert.equal(ledger.requests[reqId]!.reply?.tag, "NoReply");
  assert.equal(p2.status, "failed");
});

test("backlog A, B, C: v1 refuses unsupported Queue; v2 Queue, Batch, Together, and ~per deliver all expected items", () => {
  const streamVal = { type: "source" as const, kind: "stream" as const, name: "alert", args: [text("q")], labels: {} };

  // 1. v1 ledger rejects ~each=Queue instead of silently dropping A and B.
  const queueCode = compileChecked(`alert("q")->forEach(~key="q", ~each=Queue, msg => ask(@alice, msg)->wait)`);
  const v1Ledger = emptyLedger(0, { identityScheme: 1 });
  const v1Pass = evaluate(queueCode, v1Ledger, 0);
  assert.equal(v1Pass.status, "failed");
  assert.match(v1Pass.error ?? "", /identityScheme 2/u);

  // 2. v2 ~each=Batch freezes [A, B, C] and delivers ALL THREE in order without dropping A or B.
  const batchCode = compileChecked(`alert("q")->forEach(~key="b", ~each=Batch, msg => ask(@alice, msg)->wait)`);
  const bLedger = emptyLedger(0);
  evaluate(batchCode, bLedger, 0);
  occur(bLedger, streamVal, text("A"), 10);
  occur(bLedger, streamVal, text("B"), 20);
  occur(bLedger, streamVal, text("C"), 30);
  const bp1 = evaluate(batchCode, bLedger, 30);
  assert.equal(bp1.opened[0]!.text, "A");
  settle(bLedger, bp1.opened[0]!.id, "@alice", { tag: "Answered", value: text("ok") }, 40);
  const bp2 = evaluate(batchCode, bLedger, 40);
  assert.equal(bp2.opened[0]!.text, "B");
  settle(bLedger, bp2.opened[0]!.id, "@alice", { tag: "Answered", value: text("ok") }, 50);
  const bp3 = evaluate(batchCode, bLedger, 50);
  assert.equal(bp3.opened[0]!.text, "C");

  // 3. v2 ~each=Together runs A, B, C concurrently, survives JSON restart, and seals independently.
  const togetherCode = compileChecked(`alert("q")->forEach(~key="t", ~each=Together, msg => ask(@alice, msg)->wait)`);
  let tLedger = emptyLedger(0);
  evaluate(togetherCode, tLedger, 0);
  occur(tLedger, streamVal, text("A"), 10);
  occur(tLedger, streamVal, text("B"), 20);
  occur(tLedger, streamVal, text("C"), 30);
  const tp1 = evaluate(togetherCode, tLedger, 30);
  assert.deepEqual(tp1.opened.map(r => r.text).sort(), ["A", "B", "C"]);

  // JSON restart preserves all 3 open requests; answering B seals B while A and C stay open.
  tLedger = JSON.parse(JSON.stringify(tLedger));
  const reqB = Object.values(tLedger.requests).find(r => r.text === "B")!;
  settle(tLedger, reqB.id, "@alice", { tag: "Answered", value: text("done-B") }, 40);
  const tp2 = evaluate(togetherCode, tLedger, 40);
  assert.equal(tp2.opened.length, 0);
  assert.equal(tp2.unreached.length, 0);
  assert.equal(Object.values(tLedger.requests).filter(r => r.reply === null).length, 2);

  // 4. v2 ~each=Latest with ~per collapses per partition key without dropping distinct keys.
  const perCode = compileChecked(`
    alert("q")->forEach(~key="p", ~each=Latest, ~per=m => String.slice(m, 0, 1), msg => ask(@alice, msg)->wait)
  `);
  const pLedger = emptyLedger(0);
  evaluate(perCode, pLedger, 0);
  occur(pLedger, streamVal, text("A1"), 10);
  occur(pLedger, streamVal, text("A2"), 20);
  occur(pLedger, streamVal, text("B1"), 30);
  const pp1 = evaluate(perCode, pLedger, 30);
  assert.equal(pp1.opened[0]!.text, "A2");
  settle(pLedger, pp1.opened[0]!.id, "@alice", { tag: "Answered", value: text("ok") }, 40);
  const pp2 = evaluate(perCode, pLedger, 40);
  assert.equal(pp2.opened[0]!.text, "B1");
});

test("verifyMigration marks empty traces unverified, rejects unknown steps, and executes reply steps end-to-end", () => {
  const src = `
    let first = ask(@alice, "Step 1")->wait
    ignore(first)
    ask(@bob, "Step 2")->wait
  `;
  const code = compileChecked(src, baseHost);
  const v1 = emptyLedger(0, { identityScheme: 1 });
  const open1 = evaluate(code, v1, 0).opened[0]!;

  // Empty steps must NEVER claim ok: true!
  const emptyReport = verifyMigration(code, v1, 10, []);
  assert.equal(emptyReport.ok, false);
  assert.equal(emptyReport.verified, false);
  assert.equal(emptyReport.stepsExecuted, 0);

  // Unknown step kind fails closed.
  const badReport = verifyMigration(code, v1, 10, [{ kind: "bogus" } as unknown as never]);
  assert.equal(badReport.ok, false);
  assert.ok(badReport.differences.some(d => d.includes("unknown migration replay step")));

  // Real reply + restart trace actually settles Step 1 by original ID & epoch and dispatches Step 2 on BOTH ledgers!
  const realReport = verifyMigration(code, v1, 10, [
    { kind: "restart", at: 15 },
    { kind: "reply", requestId: open1.id, holder: "@alice", epoch: open1.epoch, reply: { tag: "Answered", value: text("go") }, at: 20 },
  ]);
  assert.equal(realReport.ok, true, JSON.stringify(realReport.differences));
  assert.equal(realReport.verified, true);
  assert.equal(realReport.stepsExecuted, 2);
  assert.deepEqual(realReport.legacyDispatched.map(d => d.text), ["Step 2"]);
  assert.deepEqual(realReport.migratedDispatched.map(d => d.text), ["Step 2"]);
});

test("Events manifest validation checks field types statically and manifestEventForm validates payloads at runtime", () => {
  const manifests: ConnectorManifest[] = [{
    app: "github",
    events: [{
      kind: "issues.opened",
      fields: [
        { name: "number", type: "int", required: true },
        { name: "title", type: "string", required: true },
      ],
    }],
  }];
  // Typing `number` as `string` instead of `int` must be rejected!
  const wrongType = checkSource(`
    type badIssue = { number: string, title: string }
    let k: Events.kind<badIssue> = Events.kind("github", "issues.opened")
    Events.events(k)->wait
  `, { host: baseHost, std: null, manifests });
  assert.ok(wrongType.diagnostics.some(d => d.code === "manifest-field-mismatch"), JSON.stringify(wrongType.diagnostics));

  // Runtime manifestEventForm catches wrong payload field type and records visible eventErrors.
  const form = manifestEventForm(manifests[0]!.events[0]!);
  const ledger = emptyLedger(0);
  const badRes = deliverEvent(ledger, {
    app: "github",
    kind: "issues.opened",
    source: "acme/app",
    id: "ev-1",
    data: { type: "record", fields: { number: text("not-an-int"), title: text("bug") } },
  }, 100, { form });
  assert.equal(badRes.delivered, false);
  assert.ok((badRes.errors?.length ?? 0) > 0);
  assert.equal(ledger.eventErrors?.length, 1);
});

test("diffInterfaces classifies removing or renaming a public record field or variant constructor as MAJOR", () => {
  const libBefore = readLibrary(`
    pub type ticket = { id: string, priority: int }
    pub type state = Open | Closed
    pub let mk = (id: string): ticket => { id: id, priority: 1 }
  `, "Lib.norn", baseHost, { name: "Lib" });
  const libAfterFieldRemoved = readLibrary(`
    pub type ticket = { id: string }
    pub type state = Open | Closed
    pub let mk = (id: string): ticket => { id: id }
  `, "Lib.norn", baseHost, { name: "Lib" });
  const libAfterCtorRenamed = readLibrary(`
    pub type ticket = { id: string, priority: int }
    pub type state = Open | Done
    pub let mk = (id: string): ticket => { id: id, priority: 1 }
  `, "Lib.norn", baseHost, { name: "Lib" });

  assert.equal(diffInterfaces(deriveInterface(libBefore), deriveInterface(libAfterFieldRemoved)).change, "MAJOR");
  assert.equal(diffInterfaces(deriveInterface(libBefore), deriveInterface(libAfterCtorRenamed)).change, "MAJOR");
});
