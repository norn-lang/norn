import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLedger, evaluate } from "../../src/runtime/ledger.ts";
import { Team } from "../../src/runtime/team.ts";
import { text, variant } from "../../src/runtime/value.ts";
import { HOUR, answered, fact, open, reply, report, restarted, source, started, stream } from "./helpers.ts";

test("decide takes a declared default only on timeout; an unknown answer never consents", () => {
  const program = `switch choose(@alice, "Ship?", [Ship, Drop], ~by=1h)->wait {
| Answered(Ship) | NoReply => run(@codex, "ship within budget")->wait
| Answered(skip) => say(@alice, "skipped")
| other => fail(other)
}`;
  const silent = started(program).team, decision = open(silent, "choose");
  silent.advanceTo(HOUR);
  assert.deepEqual(silent.run().opened.map(r => r.text), ["ship within budget"]);
  assert.deepEqual(silent.ledger.requests[decision.id].reply, { tag: "NoReply" });
  reply(silent, open(silent, "run"), answered(report("shipped")));
  assert.equal(silent.run().status, "completed");

  const confused = started(program).team;
  assert.equal(reply(confused, open(confused, "choose"), answered(text("nonsense"))), false);
  assert.equal(confused.run().status, "waiting");
  assert.equal(open(confused).verb, "choose"); // Still open, and nothing else was asked.
  assert.match(confused.ledger.evidence[0].reason, /option/);
  assert.equal(confused.events.filter(event => event.kind === "offered").length, 1);
});

test("followUp hands the same request over after one wait times out", () => {
  const { team } = started(`let q = ask(@codex, "Build healthy?")
switch q->waitUntil(1h) { | Some(answer) => answer | None => q->handOver(@alice)->wait }`);
  const original = open(team);
  team.advanceTo(HOUR); team.run();
  const moved = open(team);
  assert.deepEqual([moved.id, moved.epoch, moved.holder], [original.id, 1, "@alice"]);
  assert.deepEqual(team.events.filter(event => event.kind === "handedOver"), [{ kind: "handedOver", at: HOUR, id: original.id, from: "@codex", to: "@alice" }]);
  assert.equal(reply(team, original, answered(text("late"))), false);
  assert.equal(reply(team, moved, answered(text("healthy"))), true);
  assert.deepEqual(team.run().result, variant("Answered", text("healthy")));
});

test("a release verification chain consumes preexisting facts and a later release before asking an agent", () => {
  const team = new Team(source(`let pr = merged("acme/api#1")->wait
let release = released(Beta, ~containing=pr)->wait
machineUpdated(~machine="builder", ~atLeast=release.version)->wait
run(@codex, "verify live")->wait`));
  team.emit(fact("merged", [text("acme/api#1")]), text("pr:1"));
  team.run();
  team.advanceTo(10);
  team.emit(fact("released", [variant("Beta")], { containing: text("pr:1") }), { type: "record", fields: { version: text("v1") } });
  assert.equal(team.run().status, "waiting");
  assert.deepEqual(team.ledger.requests, {});
  team.emit(fact("machineUpdated", [], { machine: text("builder"), atLeast: text("v1") }), text("ready"));
  team.run();
  reply(team, open(team, "run"), answered(report("verified")));
  assert.equal(team.run().status, "completed");
});

test("keep-going recursion wakes on a PR event, then stops when the judge says done", () => {
  const { team } = started(`let rec push = () => {
  let report = run(@codex, "advance PR")->wait?
  if !(judge("complete?", ~about=report)->wait?) {
    prActivity("acme/api#1")->or(after(1h))->wait
    push()
  }
}
push()`);
  for (const complete of [false, true]) {
    reply(team, open(team, "run"), answered(report("report"))); team.run();
    reply(team, open(team, "judge"), answered({ type: "bool", value: complete }));
    const pass = team.run();
    if (complete) { assert.equal(pass.status, "completed"); break; }
    assert.equal(pass.status, "waiting");
    team.emit(stream("prActivity", text("acme/api#1")), text("updated")); team.run();
  }
  assert.equal(Object.keys(team.ledger.requests).length, 4);
});

test("a process restart is the ledger's JSON: the program goes on from it with no other state", () => {
  const { team: before } = started('ask(@alice, "hello")->wait');
  const original = open(before);
  const after = restarted(before, 20);
  assert.deepEqual(after.ledger, JSON.parse(JSON.stringify(before.ledger)));
  assert.deepEqual(after.run().opened, []); // Alice is not asked again.
  assert.ok(reply(after, original, answered(text("answer"))));
  const pass = after.run();
  assert.deepEqual([pass.status, pass.result], ["completed", variant("Answered", text("answer"))]);
  // What the first process told is not replayed by the second: only what is new.
  assert.deepEqual(after.events.map(event => event.kind), ["closed", "waited", "ended"]);
});

test("current authority blocks new work: nothing is offered or said, and the program ends Revoked", () => {
  for (const program of ['run(@codex, "never")->wait', 'say(@alice, "notice")']) {
    const team = new Team(source(program));
    team.permitted = false;
    const pass = team.run();
    assert.deepEqual([pass.status, pass.result, pass.opened, pass.said], ["failed", variant("Revoked"), [], []], program);
    assert.deepEqual(team.events.map(event => event.kind), ["ended"]);
    assert.deepEqual(team.notices, [{ at: 0, about: "program", reply: variant("Revoked"), error: null }]);
    // The end is recorded: authority given back later does not revive the program.
    team.permitted = true;
    assert.deepEqual(team.run().result, variant("Revoked"));
    assert.deepEqual(team.ledger.requests, {});
  }
});

test("what the ledger already holds needs no authority again; only new effects ask for it", () => {
  const { team } = started('say(@alice, "started")\nlet q = ask(@alice, "question")\nafter(1h)->wait\nsay(@alice, "later")');
  team.permitted = false;
  team.advanceTo(HOUR);
  // The timer is a stream: without authority the wait on it ends the program, and its open request with it.
  const pass = team.run();
  assert.deepEqual([pass.status, pass.result, pass.said], ["failed", variant("Revoked"), []]);
  assert.deepEqual(Object.values(team.ledger.requests).map(request => request.reply), [{ tag: "Cancelled" }]);
});

test("a policy that cannot answer fails the pass and leaves the ledger as it was", () => {
  const code = source('say(@alice, "first")\nask(@alice, "question")->wait'), ledger = emptyLedger();
  let available = false;
  const authorize = () => { if (!available) throw new Error("permission service 503"); return true; };
  const untouched = structuredClone(ledger);
  assert.throws(() => evaluate(code, ledger, 0, { authorize }), /503/);
  assert.deepEqual(ledger, untouched); // Not even the message before the failure was recorded.
  available = true;
  const pass = evaluate(code, ledger, 0, { authorize });
  assert.deepEqual([pass.status, pass.said.length, pass.opened.length], ["waiting", 1, 1]);
});

test("the virtual clock only moves forward, in whole milliseconds", () => {
  const team = new Team(source("()"), { now: 10 });
  assert.throws(() => team.advanceTo(9), /backwards/);
  assert.throws(() => team.advanceTo(10.5), /safe integer/);
  assert.throws(() => new Team(source("()"), { now: -1 }), /safe integer/);
  team.advanceTo(10); team.advanceTo(11);
  assert.equal(team.now, 11);
});
