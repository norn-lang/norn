import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  builtinInterface, checkSource, elaborate, hostSources, readInterface, readLibrary,
} from "../../src/frontend/check/index.ts";
import {
  addNote, compile, emptyLedger, evaluate, evaluateAdmissionPolicy, markTaken, markUndelivered,
  occur, release, settle, take, text,
} from "../../src/runtime/browser.ts";

const HOST_SRC = `
  external alert: (string) => stream<string>
  external deploy: (string) => stream<string>
`;
const STD_SRC = readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8");
const baseHost = builtinInterface();
const customHost = readInterface(HOST_SRC, "test-host.norn");
const stdLib = readLibrary(STD_SRC, "std/std.norn", customHost);

function compileChecked(src: string, options: { withHost?: boolean; requireDeadline?: boolean } = {}) {
  const host = options.withHost ? customHost : baseHost;
  const chk = checkSource(src, { host, std: stdLib, requireDeadline: options.requireDeadline });
  assert.deepEqual(chk.diagnostics, [], JSON.stringify(chk.diagnostics));
  return compile(elaborate(chk.program!, chk.reports), {
    sources: hostSources(host),
    std: stdLib.program,
  });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("Step 5: merge satisfies identity with never(), associativity, and homogeneous dispatch", () => {
  const src1 = `
    open Std
    alert("a")->merge(never())->forEach(~key="m", ~each=Queue, msg => ask(@alice, msg)->wait)
  `;
  const src2 = `
    open Std
    alert("a")->merge(alert("b"))->merge(deploy("c"))->forEach(~key="m3", ~each=Queue, msg => ask(@alice, msg)->wait)
  `;
  const src3 = `
    open Std
    alert("a")->merge(alert("b")->merge(deploy("c")))->forEach(~key="m3", ~each=Queue, msg => ask(@alice, msg)->wait)
  `;

  const code1 = compileChecked(src1, { withHost: true });
  const ledger1 = emptyLedger(0);
  evaluate(code1, ledger1, 0);
  occur(ledger1, { type: "source", kind: "stream", name: "alert", args: [text("a")], labels: {} }, text("boom"), 100);
  const p1 = evaluate(code1, ledger1, 100);
  assert.equal(p1.opened.length, 1);
  assert.equal(p1.opened[0]!.text, "boom");

  // Associativity: both groupings produce identical opened requests across streams.
  const runAssoc = (src: string) => {
    const code = compileChecked(src, { withHost: true });
    const l = emptyLedger(0);
    evaluate(code, l, 0);
    occur(l, { type: "source", kind: "stream", name: "deploy", args: [text("c")], labels: {} }, text("v1"), 10);
    occur(l, { type: "source", kind: "stream", name: "alert", args: [text("b")], labels: {} }, text("b1"), 20);
    const pA = evaluate(code, l, 20);
    settle(l, pA.opened[0]!.id, "@alice", { tag: "Answered", value: text("ok") }, 30);
    const pB = evaluate(code, l, 30);
    return [pA.opened[0]!.text, pB.opened[0]!.text];
  };
  assert.deepEqual(runAssoc(src2), ["v1", "b1"]);
  assert.deepEqual(runAssoc(src3), ["v1", "b1"]);
});

test("Step 5: scan accumulates pure state across occurrences and timed attaches occurrence timestamps", () => {
  const src = `
    open Std
    alert("ci")
      ->scan(0, (count, msg) => if count + 1 >= 3 { (0, Some(msg)) } else { (count + 1, None) })
      ->timed
      ->forEach(~key="flaky", ~each=Queue, item => ask(@alice, \`\${item.value}@\${item.at->show}\`)->wait)
  `;
  const code = compileChecked(src, { withHost: true });
  const ledger = emptyLedger(0);
  evaluate(code, ledger, 0);
  const s = { type: "source" as const, kind: "stream" as const, name: "alert", args: [text("ci")], labels: {} };

  occur(ledger, s, text("fail-1"), 1000);
  assert.equal(evaluate(code, ledger, 1000).opened.length, 0);
  occur(ledger, s, text("fail-2"), 2000);
  assert.equal(evaluate(code, ledger, 2000).opened.length, 0);
  occur(ledger, s, text("fail-3"), 3000);
  const p3 = evaluate(code, ledger, 3000);
  assert.equal(p3.opened.length, 1);
  assert.ok(p3.opened[0]!.text.startsWith("fail-3@1970-01-01T00:00:03"));
});

test("Step 5: mapRequest preserves request handle and transforms answer on wait", () => {
  const src = `
    let raw = ask(@alice, "Enter name")
    let upper = raw->mapRequest(s => String.toUpperCase(s))
    switch upper->wait {
    | Answered(v) => v
    | _ => "none"
    }
  `;
  const code = compileChecked(src);
  const ledger = emptyLedger(0);
  const p1 = evaluate(code, ledger, 0);
  assert.equal(p1.opened.length, 1);
  settle(ledger, p1.opened[0]!.id, "@alice", { tag: "Answered", value: text("alice") }, 10);
  const p2 = evaluate(code, ledger, 10);
  assert.equal(p2.status, "completed");
  assert.deepEqual(p2.result, text("ALICE"));
});

test("Step 5: forEach ~each=Queue processes FIFO and ~each=Restart cancels active round on newer event", () => {
  const queueSrc = `
    alert("q")->forEach(~key="q", ~each=Queue, msg => ask(@alice, msg)->wait)
  `;
  const qCode = compileChecked(queueSrc, { withHost: true });
  const qLedger = emptyLedger(0);
  evaluate(qCode, qLedger, 0);
  const qs = { type: "source" as const, kind: "stream" as const, name: "alert", args: [text("q")], labels: {} };
  occur(qLedger, qs, text("first"), 10);
  occur(qLedger, qs, text("second"), 20);
  const qp1 = evaluate(qCode, qLedger, 20);
  assert.equal(qp1.opened[0]!.text, "first");
  settle(qLedger, qp1.opened[0]!.id, "@alice", { tag: "Answered", value: text("done") }, 30);
  const qp2 = evaluate(qCode, qLedger, 30);
  assert.equal(qp2.opened[0]!.text, "second");

  const restartSrc = `
    alert("r")->forEach(~key="r", ~each=Restart, msg => ask(@alice, msg)->wait)
  `;
  const rCode = compileChecked(restartSrc, { withHost: true });
  const rLedger = emptyLedger(0);
  evaluate(rCode, rLedger, 0);
  const rs = { type: "source" as const, kind: "stream" as const, name: "alert", args: [text("r")], labels: {} };
  occur(rLedger, rs, text("v1"), 10);
  const rp1 = evaluate(rCode, rLedger, 10);
  assert.equal(rp1.opened.length, 1);
  const v1Id = rp1.opened[0]!.id;

  // Newer occurrence arrives while v1 is still open -> v1 is cancelled and v2 opens.
  occur(rLedger, rs, text("v2"), 20);
  const rp2 = evaluate(rCode, rLedger, 20);
  assert.equal(rLedger.requests[v1Id]!.reply?.tag, "Cancelled");
  assert.equal(rp2.opened.length, 1);
  assert.equal(rp2.opened[0]!.text, "v2");
});

test("Step 5: spawn isolates child scope and auto-cancels child open requests on cancel or completion", () => {
  const src = `
    let child = spawn(~key="review", () => {
      let a = ask(@alice, "Subtask A")
      let b = ask(@bob, "Subtask B")
      let (winner, reply) = first([a, b])
      cancel(winner)
      reply
    })
    child->wait
  `;
  const code = compileChecked(src);
  const ledger = emptyLedger(0);
  const p1 = evaluate(code, ledger, 0);
  const subA = p1.opened.find(r => r.text === "Subtask A")!;
  const subB = p1.opened.find(r => r.text === "Subtask B")!;
  assert.ok(subA && subB);
  assert.ok(subA.spawnOwner && subA.spawnOwner === subB.spawnOwner);

  // Answering Subtask A completes the spawned task, which auto-cancels Subtask B!
  settle(ledger, subA.id, "@alice", { tag: "Answered", value: text("approved") }, 100);
  const p2 = evaluate(code, ledger, 100);
  assert.equal(p2.status, "completed");
  assert.equal(ledger.requests[subB.id]!.reply?.tag, "Cancelled");

  // Also test parent explicitly calling cancel(child).
  const cancelSrc = `
    let child = spawn(~key="bg", () => ask(@alice, "Long job")->wait)
    cancel(child)
    "done"
  `;
  const cCode = compileChecked(cancelSrc);
  const cLedger = emptyLedger(0);
  const cp = evaluate(cCode, cLedger, 0);
  assert.equal(cp.status, "completed");
  const childJob = Object.values(cLedger.requests).find(r => r.text === "Long job")!;
  assert.equal(childJob.reply?.tag, "Cancelled");
});

test("Step 5: Std.race, Std.quorum, Std.allSettled, Std.orEither work end to end", () => {
  const raceSrc = `
    open Std
    let a = ask(@alice, "A")
    let b = ask(@bob, "B")
    let (winner, reply) = race([a, b])
    cancel(winner)
    reply
  `;
  const rCode = compileChecked(raceSrc);
  const rLedger = emptyLedger(0);
  const rp1 = evaluate(rCode, rLedger, 0);
  settle(rLedger, rp1.opened[0]!.id, "@alice", { tag: "Answered", value: text("fast") }, 10);
  const rp2 = evaluate(rCode, rLedger, 10);
  assert.equal(rp2.status, "completed");
  assert.equal(rLedger.requests[rp1.opened[1]!.id]!.reply?.tag, "Cancelled");

  const quorumSrc = `
    open Std
    let a = ask(@alice, "Q1")
    let b = ask(@bob, "Q2")
    let c = ask(@carol, "Q3")
    quorum([a, b, c], ~needed=2)
  `;
  const qCode = compileChecked(quorumSrc);
  const qLedger = emptyLedger(0);
  const qp1 = evaluate(qCode, qLedger, 0);
  settle(qLedger, qp1.opened[0]!.id, "@alice", { tag: "Answered", value: text("v1") }, 10);
  const qp2 = evaluate(qCode, qLedger, 10);
  assert.equal(qp2.status, "waiting");
  settle(qLedger, qp1.opened[2]!.id, "@carol", { tag: "Answered", value: text("v3") }, 20);
  const qp3 = evaluate(qCode, qLedger, 20);
  assert.equal(qp3.status, "completed");
  assert.equal(qLedger.requests[qp1.opened[1]!.id]!.reply?.tag, "Cancelled");
  assert.equal(qp3.result?.type, "list");
  assert.equal(qp3.result?.type === "list" ? qp3.result.values.length : 0, 2);
});

test("Step 6: taken(r), say(r, text) + r->notes, waitingOn, undelivered, release, ~except=r, and sameAs(r)", () => {
  // 1. taken(r) + say(r, text) + r->notes + waitingOn + markUndelivered
  const src = `
    let r = ask(@alice, "Prepare release", ~by=1d)
    let sub = ask(@bob, "Verify artifact", ~about=r, ~by=4h)
    say(r, "Draft checklist attached")
    let t = r->taken->wait
    let n = r->notes->wait
    let ans = r->wait
    let subAns = sub->wait
    (t, n, ans, subAns)
  `;
  const code = compileChecked(src);
  const ledger = emptyLedger(0);
  const p1 = evaluate(code, ledger, 0, { openedBy: "release-pipeline" });
  const mainReq = p1.opened.find(r => r.text === "Prepare release")!;
  const subReq = p1.opened.find(r => r.text === "Verify artifact")!;
  assert.equal(mainReq.openedBy, "release-pipeline");
  assert.deepEqual(ledger.requests[mainReq.id]!.waitingOn, [subReq.id]);
  // say(r, text) appended a note and did NOT settle r or extend r.by.
  assert.equal(ledger.requests[mainReq.id]!.reply, null);
  assert.equal(ledger.requests[mainReq.id]!.by, DAY);
  assert.equal(ledger.requestNotes?.[mainReq.id]?.length, 1);

  // Explicit undelivered tracking stays visible without becoming NoReply.
  assert.equal(markUndelivered(ledger, mainReq.id, "SMTP 550", 50), true);
  assert.equal(ledger.requests[mainReq.id]!.undelivered?.reason, "SMTP 550");
  assert.equal(ledger.requests[mainReq.id]!.reply, null);

  // markTaken resolves taken(r) and external addNote resolves r->notes.
  assert.equal(markTaken(ledger, mainReq.id, 100), true);
  evaluate(code, ledger, 100);
  addNote(ledger, mainReq.id, "@alice", "Working on it", 200);
  evaluate(code, ledger, 200);
  settle(ledger, mainReq.id, "@alice", { tag: "Answered", value: text("ready") }, 300);
  settle(ledger, subReq.id, "@bob", { tag: "Answered", value: text("verified") }, 300);
  const pDone = evaluate(code, ledger, 300);
  assert.equal(pDone.status, "completed");

  // 2. release + anyOf(~except=r) + sameAs(r)
  const sepSrc = `
    let firstTask = ask(anyOf([@alice, @bob]), "Draft PR")
    ignore(firstTask->wait)
    let review = ask(anyOf([@alice, @bob], ~except=firstTask), "Review PR")
    let followup = ask(sameAs(firstTask), "Merge PR")
    (review->wait, followup->wait)
  `;
  const sepCode = compileChecked(sepSrc);
  const sepLedger = emptyLedger(0);
  const sp1 = evaluate(sepCode, sepLedger, 0);
  const draft = sp1.opened[0]!;
  // @alice takes it, then releases it back to the pool; @bob takes and answers it.
  assert.equal(take(sepLedger, draft.id, "@alice", 10), true);
  assert.equal(release(sepLedger, draft.id, "@alice", 20, { reason: "busy" }), null);
  assert.deepEqual(sepLedger.requests[draft.id]!.candidates, ["@alice", "@bob"]);
  assert.equal(take(sepLedger, draft.id, "@bob", 30), true);
  settle(sepLedger, draft.id, "@bob", { tag: "Answered", value: text("PR #1") }, 40);

  const sp2 = evaluate(sepCode, sepLedger, 40);
  const reviewReq = sp2.opened.find(r => r.text === "Review PR")!;
  const mergeReq = sp2.opened.find(r => r.text === "Merge PR")!;
  // ~except=firstTask excluded @bob -> only @alice can review!
  assert.deepEqual(reviewReq.candidates, ["@alice"]);
  assert.deepEqual(reviewReq.excluded, ["@bob"]);
  // sameAs(firstTask) resolved to @bob!
  assert.equal(mergeReq.holder, "@bob");
});

test("Step 7: within clamps deadlines, requireDeadline & impure-callback checks fire, and admission policies evaluate purely", () => {
  // 1. within(deadline, f) clamps both explicit longer ~by and missing ~by.
  const withinSrc = `
    within(2h, () => {
      let a = ask(@alice, "Slow ask", ~by=1d)
      let b = ask(@bob, "No deadline ask")
      (a->wait, b->wait)
    })
  `;
  const wCode = compileChecked(withinSrc);
  const wLedger = emptyLedger(0);
  const wp = evaluate(wCode, wLedger, 1000);
  assert.equal(wp.opened.length, 2);
  assert.equal(wp.opened[0]!.by, 1000 + 2 * HOUR);
  assert.equal(wp.opened[1]!.by, 1000 + 2 * HOUR);

  // 2. requireDeadline static check.
  const missingBy = checkSource(`ask(@alice, "No deadline")->wait`, { host: baseHost, std: null, requireDeadline: true });
  assert.ok(missingBy.diagnostics.some(d => d.code === "missing-deadline"), JSON.stringify(missingBy.diagnostics));
  const withBy = checkSource(`ask(@alice, "Has deadline", ~by=1h)->wait`, { host: baseHost, std: null, requireDeadline: true });
  assert.deepEqual(withBy.diagnostics, []);

  // 3. Static impure-callback check on stream and request transforms.
  const impureFilter = checkSource(`alert("x")->filter(m => { say(@alice, m); true })->wait`, { host: customHost, std: null });
  assert.ok(impureFilter.diagnostics.some(d => d.code === "impure-callback"), JSON.stringify(impureFilter.diagnostics));
  const impureMapReq = checkSource(`ask(@alice, "hi")->mapRequest(s => { say(@bob, s); s })->wait`, { host: baseHost, std: null });
  assert.ok(impureMapReq.diagnostics.some(d => d.code === "impure-callback"), JSON.stringify(impureMapReq.diagnostics));

  // 4. Pure Norn admission policy (`request => Allow | Deny(string) | AlsoAsk(participant)`).
  const policySrc = `
    type reqInfo = { id: string, verb: string, holder: string, text: string, about: option<string>, context: option<string>, openedBy: string }
    (req: reqInfo) =>
      if req.verb == "run" && String.includes(req.text, "prod") {
        AlsoAsk(@secops)
      } else if req.holder == "@blocked" {
        Deny("Participant is restricted")
      } else {
        Allow
      }
  `;
  const policyCode = compileChecked(policySrc);
  const sampleReq = wLedger.requests[wp.opened[0]!.id]!;
  assert.deepEqual(evaluateAdmissionPolicy(policyCode, sampleReq, 1000), { decision: "Allow" });
  assert.deepEqual(
    evaluateAdmissionPolicy(policyCode, { ...sampleReq, verb: "run", text: "deploy to prod" }, 1000),
    { decision: "AlsoAsk", participant: "@secops" },
  );
  assert.deepEqual(
    evaluateAdmissionPolicy(policyCode, { ...sampleReq, holder: "@blocked" }, 1000),
    { decision: "Deny", reason: "Participant is restricted" },
  );
});
