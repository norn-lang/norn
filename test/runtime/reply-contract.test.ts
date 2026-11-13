// The runtime contract of spec §11.1, against the ledger runtime. Contract
// cases 1 to 5 are marked where they are checked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLedger, evaluate, occur, settle } from "../../src/runtime/ledger.ts";
import { Team } from "../../src/runtime/team.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import { HOUR, answered, fact, open, reply, report, restarted, source, started, stream } from "./helpers.ts";

const tuple = (...values: Value[]): Value => ({ type: "tuple", values });

test("case 1: a request deadline passes with no scan; the late reply is evidence, and wait and status see NoReply", () => {
  const code = source('let q = ask(@alice, "Question", ~by=1h)\nlet r = q->wait\n(r, status(q))'), ledger = emptyLedger();
  evaluate(code, ledger, 0);
  const q = open(ledger);
  // No alarm, scan or pass runs at the boundary: the clock alone has decided.
  assert.equal(settle(ledger, q.id, "@alice", answered(text("late")), HOUR + 1), false);
  assert.deepEqual(ledger.evidence.map(e => [e.request, e.holder, e.reply, e.reason]), [[q.id, "@alice", answered(text("late")), "The request has already ended"]]);
  assert.deepEqual([ledger.requests[q.id].reply, ledger.requests[q.id].settledAt], [{ tag: "NoReply" }, HOUR]);
  const pass = evaluate(code, ledger, HOUR + 1);
  assert.deepEqual(pass.result, tuple(variant("NoReply"), variant("Some", variant("NoReply"))));
});

test("an answer recorded before the deadline wins; an answer exactly at it is too late", () => {
  for (const at of [HOUR - 1, HOUR]) {
    const code = source('ask(@alice, "Question", ~by=1h)->wait'), ledger = emptyLedger();
    evaluate(code, ledger, 0);
    assert.equal(settle(ledger, open(ledger).id, "@alice", answered(text("yes")), at), at === HOUR - 1);
    const pass = evaluate(code, ledger, 5 * HOUR);
    assert.deepEqual([pass.status, pass.result], at === HOUR - 1 ? ["completed", variant("Answered", text("yes"))] : ["failed", variant("NoReply")]);
  }
});

test("case 3: waitUntil is independent; equal request and wait deadlines yield Some(NoReply)", () => {
  for (const [by, expected] of [["1h", variant("Some", variant("NoReply"))], ["2h", variant("None")]] as const) {
    const { team } = started(`let q = ask(@alice, "Question", ~by=${by})\nlet observed = q->waitUntil(1h)\nlet state = status(q)\nafter(1h)->wait\n(observed, state)`);
    const q = open(team);
    team.advanceTo(HOUR); team.run();
    assert.deepEqual(team.ledger.requests[q.id].reply, by === "1h" ? { tag: "NoReply" } : null);
    team.advanceTo(2 * HOUR);
    assert.deepEqual(team.run().result, tuple(expected, by === "1h" ? variant("Some", variant("NoReply")) : variant("None")));
  }
});

test("case 2: handover preserves the deadline and fences the old holder's reply, across a restart", () => {
  let { team } = started('let q = ask(@codex, "Question", ~by=2h)\nlet r = switch q->waitUntil(1h) { | Some(r) => r | None => q->handOver(@alice)->wait }\nr');
  const first = open(team);
  team.advanceTo(HOUR); team.run();
  const moved = open(team);
  assert.deepEqual([moved.id, moved.holder, moved.epoch, moved.by], [first.id, "@alice", 1, 2 * HOUR]);
  team = restarted(team);
  assert.equal(reply(team, first, answered(text("obsolete"))), false);
  assert.equal(team.ledger.requests[first.id].reply, null);
  assert.deepEqual(team.ledger.evidence.map(e => [e.holder, e.reason]), [["@codex", "Not the request's holder"]]);
  assert.ok(reply(team, moved, answered(text("current"))));
  assert.deepEqual(team.run().result, variant("Answered", text("current")));
});

test("case 4: an unchecked dropped request stays open while the program runs, then is cancelled with its result", () => {
  const { team } = started('ask(@alice, "Unobserved")\nafter(1h)->wait');
  const q = open(team);
  team.advanceTo(HOUR);
  const pass = team.run();
  assert.equal(pass.status, "completed");
  assert.deepEqual(pass.cancelled, [q.id]);
  // One commit holds the result and the cancellation, and the holder is told once.
  assert.deepEqual([team.ledger.requests[q.id].reply, team.ledger.ended?.at], [{ tag: "Cancelled" }, HOUR]);
  const closures = team.events.filter(event => event.kind === "closed");
  assert.deepEqual(closures.map(event => [event.request.holder, event.reply]), [["@alice", { tag: "Cancelled" }]]);
  team.run();
  assert.equal(team.events.filter(event => event.kind === "closed").length, 1);
});

test("invalid answers are evidence, never refusal or consent", () => {
  const cases: [string, Value, Value][] = [
    ['confirm(@alice, "Proceed?")', text("maybe"), variant("Yes")],
    ['choose(@alice, "Choose", [Ship, Drop])', variant("Other"), variant("Drop")],
    ['ask(@alice, "Text?")', variant("Yes"), text("yes")],
    ['judge("Ready?")', text("yes"), { type: "bool", value: true }],
    ['run(@alice, "Work")', text("unstructured"), report("report")],
  ];
  for (const [expression, invalid, valid] of cases) {
    const { team } = started(`${expression}->wait`), q = open(team);
    assert.equal(reply(team, q, answered(invalid)), false);
    assert.equal(team.ledger.requests[q.id].reply, null);
    assert.deepEqual(team.ledger.evidence.map(e => e.reply), [answered(invalid)]);
    assert.ok(team.ledger.evidence[0].reason);
    assert.equal(team.run().status, "waiting");
    assert.ok(reply(team, q, answered(valid)));
    assert.deepEqual(team.run().result, variant("Answered", valid));
  }
});

test("a request nobody waits on still ends at its deadline, and a later handover does nothing", () => {
  const code = source('let q = ask(@alice, "Question", ~by=1h)\nafter(2h)->wait\nlet moved = q->handOver(@bob)\n(status(q), moved->wait)'), ledger = emptyLedger();
  evaluate(code, ledger, 0);
  const q = open(ledger);
  const pass = evaluate(code, ledger, 2 * HOUR);
  assert.deepEqual(pass.result, tuple(variant("Some", variant("NoReply")), variant("NoReply")));
  assert.deepEqual(pass.log.filter(step => step.kind === "handedOver"), []);
  const ended = ledger.requests[q.id];
  assert.deepEqual([ended.holder, ended.epoch, ended.settledAt], ["@alice", 0, HOUR]);
});

test("a request's deadline survives a disk restart without an active waiter", () => {
  const { team: before } = started('let q = ask(@alice, "Question", ~by=1h)\nafter(1d)->wait\nstatus(q)');
  const q = open(before);
  const after = restarted(before, HOUR + 1);
  assert.equal(reply(after, q, answered(text("late"))), false);
  const stored = after.ledger.requests[q.id];
  assert.deepEqual([stored.by, stored.settledAt, stored.reply], [HOUR, HOUR, { tag: "NoReply" }]);
  assert.deepEqual(after.events.map(event => [event.kind, event.at]), [["closed", HOUR]]);
});

test("program errors remain errors; every open request ends Cancelled, and the author is told", () => {
  const cases = [
    ["1 / 0", "Division by zero"], ["missing", "Unbound name missing"], ["fail(Answered(1))", "fail requires a reply other than Answered"],
    ['ask(@alice, "q", ~until=1h)', "Unknown ask label until"], ['say(@alice, 1)', "say needs a participant or a reference, and text"],
    ['after(0h)->wait', "A relative timer needs a positive duration"], ["status(1)", "status needs a request of this program"],
    ['ciFailed("acme/api")->filter(x => true)->forEach(x => ())', "Stream filter is not implemented by the reference host yet"],
  ] as const;
  for (const [expression, message] of cases) {
    const { team, pass } = started(`let q = ask(@alice, "Outstanding")\n${expression}`);
    assert.deepEqual([pass.status, pass.result, pass.error], ["failed", null, message]);
    assert.deepEqual(Object.values(team.ledger.requests).map(request => request.reply), [{ tag: "Cancelled" }]);
    assert.deepEqual(team.notices, [{ at: 0, about: "program", reply: null, error: message }]);
  }
});

test("events return their actual value, and lost observation authority ends the program Revoked", () => {
  const { team } = started('let q = ask(@alice, "Still open")\nmerged("pr")->wait');
  const q = open(team);
  team.permitted = false;
  team.emit(fact("merged", [text("pr")]), text("pr"));
  const pass = team.run();
  assert.deepEqual([pass.status, pass.result], ["failed", variant("Revoked")]);
  assert.deepEqual(team.ledger.requests[q.id].reply, { tag: "Cancelled" });
  assert.deepEqual(team.notices, [{ at: 0, about: "program", reply: variant("Revoked"), error: null }]);

  const permitted = started('merged("pr")->wait').team;
  permitted.emit(fact("merged", [text("pr")]), text("the pull request"));
  assert.deepEqual(permitted.run().result, text("the pull request")); // No Answered around it.
});

test("waitUntil preserves a reply-valued event without treating it as a request reply", () => {
  const { team } = started('let observed = runEnded("run")->waitUntil(1h)\n(observed, "continued")');
  const payload = variant("Refused", text("not a request from this program"));
  team.emit(fact("runEnded", [text("run")]), payload);
  const pass = team.run();
  assert.deepEqual([pass.status, pass.result], ["completed", tuple(variant("Some", payload), text("continued"))]);
  assert.deepEqual([team.ledger.requests, team.notices], [{}, []]);
});

test("request authority lost before or after the wait began gives the same Revoked reply", () => {
  for (const begun of [false, true]) {
    const code = source('let q = ask(@alice, "Question")\nswitch q->wait { | Revoked => "handled" | _ => "other" }'), ledger = emptyLedger();
    // Before: authority is already gone when the program first reaches the wait. After: it goes while the wait is open.
    const first = evaluate(code, ledger, 0, { authorize: effect => begun || effect.name === "ask" });
    const pass = begun ? evaluate(code, ledger, 1, { authorize: () => false }) : first;
    assert.equal(first.opened.length, 1);
    assert.deepEqual(Object.values(ledger.requests).map(request => request.reply), [{ tag: "Revoked" }]);
    assert.deepEqual([pass.status, pass.result], ["completed", text("handled")]);
    assert.deepEqual(pass.log.filter(step => step.kind === "closed").map(step => step.reply), [{ tag: "Revoked" }]); // The holder is told.
  }
});

test("relative request deadlines count from when the request is recorded, and no participant can declare NoReply", () => {
  const ledger = emptyLedger();
  evaluate(source('ask(@alice, "Question", ~by=1h)->wait'), ledger, 123);
  const q = open(ledger);
  assert.equal(q.by, HOUR + 123);
  assert.equal(settle(ledger, q.id, "@alice", { tag: "NoReply" }, 124), false);
  assert.match(ledger.evidence[0].reason, /only by the ledger's clock/);
  assert.equal(ledger.requests[q.id].reply, null);
});

test("a deadline already reached when the request is recorded has passed", () => {
  const { team, pass } = started('ask(@alice, "Too late", ~by=2026-11-07T12:00Z)->wait', Date.parse("2026-11-07T12:00Z"));
  assert.deepEqual([pass.status, pass.result], ["failed", variant("NoReply")]);
  assert.deepEqual(team.events.map(event => event.kind), ["offered", "closed", "waiting", "waited", "ended"]);
});

test("facts can predate the wait; a stream never replays an occurrence from before it", () => {
  const ci = stream("ciFailed", text("acme/api"));
  const team = new Team(source('(merged("acme/api#1")->wait, ciFailed("acme/api")->wait)'));
  team.emit(fact("merged", [text("acme/api#1")]), text("known"));
  team.emit(ci, text("old occurrence"));
  assert.equal(team.run().status, "waiting");
  team.advanceTo(2);
  team.emit(ci, text("new"));
  assert.deepEqual(team.run().result, tuple(text("known"), text("new")));
});

test("external event timestamps are data, not a clock for unrelated deadlines", () => {
  const code = source('ask(@alice, "Question", ~by=1h)->wait'), ledger = emptyLedger();
  evaluate(code, ledger, 0);
  const q = open(ledger);
  occur(ledger, stream("docChanged", text("other")), { type: "record", fields: { occurredAt: { type: "time", value: "2592000000" } } }, 1);
  assert.equal(evaluate(code, ledger, 1).status, "waiting");
  assert.equal(ledger.requests[q.id].reply, null);
  assert.equal(settle(ledger, q.id, "@alice", answered(text("late with no caller time")), HOUR + 1), false);
  assert.deepEqual(evaluate(code, ledger, HOUR + 1).result, variant("NoReply"));
});
