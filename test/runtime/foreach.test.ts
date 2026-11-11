import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../../src/runtime/ledger.ts";
import { advance, start } from "../../src/runtime/machine.ts";
import { text, unit, variant } from "../../src/runtime/value.ts";
import { answered, open, reply, report, restarted, source, started, stream } from "./helpers.ts";

const ci = stream("ciFailed", text("acme/api"));
const told = (team: { notices: { about: string }[] }) => team.notices.filter(notice => notice.about === "handler");

test("one failed run reports its outcome and does not end a standing duty", () => {
  const { team } = started('ciFailed("acme/api")->forEach(_ => run(@auto, "Check health")->wait)');
  team.emit(ci, text("first incident")); team.run();
  const first = open(team);
  reply(team, first, { tag: "Broke", reason: "temporary failure" });
  assert.equal(team.run().status, "waiting");
  assert.deepEqual(told(team), [{ at: 0, about: "handler", reply: variant("Broke", text("temporary failure")), error: null }]);
  team.emit(ci, text("second incident")); team.run();
  const second = open(team);
  assert.notEqual(second.id, first.id);
  reply(team, second, answered(report("healthy")));
  assert.equal(team.run().status, "waiting");
  assert.equal(told(team).length, 1);
});

test("every unsuccessful handler outcome reports once and takes the next occurrence", () => {
  for (const expression of ['Refused("no")', 'Broke("fault")', 'NoReply', 'Cancelled', 'Revoked']) {
    const { team } = started(`ciFailed("acme/api")->forEach(_ => ${expression})`);
    for (let i = 1; i <= 2; i++) {
      team.emit(ci, text("incident"));
      assert.equal(team.run().status, "waiting", expression);
      assert.equal(told(team).length, i, expression);
    }
  }
});

test("competing passes and a restart cannot report one handler failure twice", () => {
  const { team } = started('ciFailed("acme/api")->forEach(_ => Broke("retry later"))');
  team.emit(ci, text("incident"));
  // Two workers look at the same ledger: both see the same report to make, under one identity.
  const [a, b] = [0, 1].map(() => evaluate(team.code, team.ledger, team.now, { commit: false }));
  assert.deepEqual(a.log, b.log);
  assert.deepEqual(a.log.filter(step => step.kind === "handlerFailed"), [{ kind: "handlerFailed", reply: variant("Broke", text("retry later")) }]);
  team.run();
  const reports = () => Object.keys(team.ledger.entries).filter(key => key.startsWith("report:"));
  assert.equal(reports().length, 1);
  assert.deepEqual(team.run().log, []);
  const after = restarted(team), pass = after.run();
  assert.deepEqual([pass.status, pass.log, after.notices], ["waiting", [], []]);
  assert.deepEqual(Object.keys(after.ledger.entries).filter(key => key.startsWith("report:")), reports());
});

test("successful and unchecked ordinary callback values are discarded without a failure notice", () => {
  for (const expression of ['()', 'Answered("ok")', '1', 'false', '"unused"', 'None', '{unused: 1}']) {
    const { team } = started(`ciFailed("acme/api")->forEach(_ => ${expression})`);
    team.emit(ci, text("incident"));
    assert.equal(team.run().status, "waiting", expression);
    assert.deepEqual(team.notices, [], expression);
  }
});

test("explicit fail in a handler terminates the program and stops further occurrences", () => {
  const { team } = started('ciFailed("acme/api")->forEach(_ => fail(Broke("stop")))');
  team.emit(ci, text("incident"));
  const failed = team.run();
  assert.deepEqual([failed.status, failed.result], ["failed", variant("Broke", text("stop"))]);
  assert.deepEqual(team.notices, [{ at: 0, about: "program", reply: variant("Broke", text("stop")), error: null }]);
  team.emit(ci, text("incident"));
  const events = team.events.length, again = team.run();
  assert.deepEqual([again.status, again.result, again.log], ["failed", variant("Broke", text("stop")), []]);
  assert.deepEqual([team.events.length, team.notices.length], [events, 1]);
});

test("ignore evaluates its argument, can be piped, and explicitly discards an outcome", () => {
  const code = source('(ignore(1), Broke("explicitly ignored")->ignore)');
  assert.deepEqual(advance(code, start(code)).control, { kind: "done", value: { type: "tuple", values: [unit, unit] } });
  const { pass } = started('ignore(say(@alice, "Still evaluated"))');
  assert.deepEqual([pass.status, pass.result, pass.said], ["completed", unit, [{ to: "@alice", text: "Still evaluated" }]]);
  for (const expression of ['ignore()', 'ignore(1, 2)', 'ignore(1, ~unused=2)']) {
    const invalid = source(expression);
    assert.equal(advance(invalid, start(invalid)).control.kind, "error", expression);
  }
});

test("ignore on a handler outcome suppresses automatic failure reporting", () => {
  const { team } = started('ciFailed("acme/api")->forEach(_ => Broke("ignored")->ignore)');
  team.emit(ci, text("incident"));
  assert.equal(team.run().status, "waiting");
  assert.deepEqual(team.notices, []);
});

test("a standing duty's long history does not use up a pass's step budget", () => {
  const { team } = started('ciFailed("acme/api")->forEach(_ => say(@alice, "seen"))');
  // 200 rounds are 400 recorded effects to replay; a pass given five slices of computation still gets through them.
  for (let round = 0; round < 200; round++) { team.emit(ci, text("incident")); team.run(); }
  const pass = evaluate(team.code, team.ledger, team.now, { steps: 50_000 });
  assert.deepEqual([pass.status, pass.error], ["waiting", null]);
});
