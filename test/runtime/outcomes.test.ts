import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, start } from "../../src/runtime/machine.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import { open, reply, source, started } from "./helpers.ts";

test("each final unsuccessful outcome fails visibly rather than completing", () => {
  const cases: [string, Value][] = [
    ['Refused("no")', variant("Refused", text("no"))],
    ['Broke("fault")', variant("Broke", text("fault"))],
    ['NoReply', variant("NoReply")], ['Cancelled', variant("Cancelled")], ['Revoked', variant("Revoked")],
  ];
  for (const [expression, expected] of cases) {
    const { team, pass } = started(expression);
    assert.deepEqual([pass.status, pass.result, pass.error], ["failed", expected, null]);
    assert.deepEqual(team.ledger.ended, { at: 0, status: "failed", result: expected, error: null });
    // The author is told once, however many passes follow.
    team.run();
    assert.deepEqual(team.notices, [{ at: 0, about: "program", reply: expected, error: null }]);
  }
});

test("a program ending in run reports a participant failure without requiring explicit ?", () => {
  const { team } = started('run(@codex, "Do the task")->wait');
  reply(team, open(team), { tag: "Broke", reason: "could not finish" });
  assert.equal(team.run().status, "failed");
  assert.deepEqual(team.notices, [{ at: 0, about: "program", reply: variant("Broke", text("could not finish")), error: null }]);
});

test("a function may return failure for its caller to handle", () => {
  const code = source(`
    let check = () => Broke("recoverable")
    switch check() {
    | Broke(reason) => Answered(reason)
    | other => other
    }
  `);
  assert.deepEqual(advance(code, start(code)).control, { kind: "done", value: variant("Answered", text("recoverable")) });
});

test("successful outcomes and ordinary final values still complete normally", () => {
  for (const expression of ['Answered("ok")', '42', '()', 'None', 'ignore(Broke("discarded"))']) {
    const code = source(expression);
    assert.equal(advance(code, start(code)).control.kind, "done", expression);
  }
});
