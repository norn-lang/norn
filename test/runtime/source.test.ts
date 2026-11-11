import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { text, variant } from "../../src/runtime/value.ts";
import { HOUR, answered, fact, open, reply, report, started, stream } from "./helpers.ts";

const example = (name: string) => started(readFileSync(new URL(`../../examples/${name}.norn`, import.meta.url), "utf8")).team;

test("decide.norn executes its explicit timeout default with a scripted participant", () => {
  const team = example("decide"), question = open(team, "confirm");
  team.advanceTo(Date.parse("2026-11-07T12:00Z")); team.run();
  assert.deepEqual(team.ledger.requests[question.id].reply, { tag: "NoReply" });
  const work = open(team, "run");
  assert.match(work.text, /at most US\$0\.10/);
  reply(team, work, answered(report("simulated report")));
  assert.equal(team.run().status, "completed");
});

test("follow-up.norn times out one wait and transfers the same request to a person", () => {
  const team = example("follow-up"), first = open(team, "ask");
  team.advanceTo(HOUR); team.run();
  const moved = open(team, "ask");
  assert.deepEqual([moved.id, moved.holder, moved.epoch], [first.id, "@alice", 1]);
  assert.equal(reply(team, first, answered(text("old reply"))), false);
  reply(team, moved, answered(text("answer")));
  const pass = team.run();
  assert.deepEqual([pass.status, pass.said], ["completed", [{ to: 'doc"ops#machines"', text: "answer" }]]);
});

test("release-chain.norn waits through release and machine facts before requesting verification", () => {
  const team = example("release-chain");
  team.emit(fact("merged", [text("acme/api#1436")]), text("pr1436")); team.run();
  team.emit(fact("released", [variant("Beta")], { containing: text("pr1436") }), { type: "record", fields: { version: text("v1") } });
  assert.equal(team.run().status, "waiting");
  assert.deepEqual(team.ledger.requests, {});
  team.emit(fact("machineUpdated", [], { machine: text("win-builder"), atLeast: text("v1") }), text("ready")); team.run();
  reply(team, open(team, "run"), answered(report("verified")));
  assert.equal(team.run().status, "completed");
});

test("push.norn recursively continues on a PR event and terminates after a positive judgement", () => {
  const team = example("push");
  for (const done of [false, true]) {
    reply(team, open(team, "run"), answered(report("report"))); team.run();
    reply(team, open(team, "judge"), answered({ type: "bool", value: done })); team.run();
    if (!done) { team.emit(stream("prActivity", text("acme/api#1439")), text("new activity")); team.run(); }
  }
  assert.equal(team.run().status, "completed");
});

test("standing-duty.norn tells the author of a failed round and takes the next one", () => {
  const team = example("standing-duty");
  team.advanceTo(24 * HOUR); team.run();
  reply(team, open(team, "run"), { tag: "Broke", reason: "no quota" });
  const pass = team.run();
  assert.deepEqual([pass.status, pass.nextDue], ["waiting", 48 * HOUR]);
  assert.deepEqual(team.notices, [{ at: 24 * HOUR, about: "handler", reply: variant("Broke", text("no quota")), error: null }]);
  team.emit(stream("ciFailed", text("acme/api")), text("lint")); team.run();
  assert.equal(open(team, "run").openedAt, 24 * HOUR);
});
