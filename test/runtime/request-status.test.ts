import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply } from "../../src/runtime/ledger.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import { HOUR, answered, open, reply, started } from "./helpers.ts";

test("status is None while open and Some for each terminal request outcome", () => {
  const replies: [Reply, Value][] = [
    [answered(text("answer")), variant("Answered", text("answer"))],
    [{ tag: "Refused", reason: "no" }, variant("Refused", text("no"))], [{ tag: "Broke", reason: "fault" }, variant("Broke", text("fault"))],
    [{ tag: "Cancelled" }, variant("Cancelled")], [{ tag: "Revoked" }, variant("Revoked")],
  ];
  for (const [given, seen] of replies) {
    const { team } = started(`
      let q = ask(@alice, "Question?")
      let before = status(q)
      after(1h)->wait
      (before, status(q))
    `);
    assert.ok(reply(team, open(team), given));
    team.advanceTo(HOUR);
    const pass = team.run();
    assert.equal(pass.status, "completed");
    assert.deepEqual(pass.result, { type: "tuple", values: [variant("None"), variant("Some", seen)] });
  }
});

test("a timed-out explicit wait still has status None until the request is cancelled", () => {
  const { team } = started(`
    let q = ask(@alice, "Question?")
    let waited = q->waitUntil(1h)
    let pending = status(q)
    cancel(q)
    (waited, pending, status(q))
  `);
  team.advanceTo(HOUR);
  assert.deepEqual(team.run().result, { type: "tuple", values: [variant("None"), variant("None"), variant("Some", variant("Cancelled"))] });
});
