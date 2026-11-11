import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, start } from "../../src/runtime/machine.ts";
import { text } from "../../src/runtime/value.ts";
import { source, started } from "./helpers.ts";

test("a 10,000-stage source pipe compiles and executes without a native traversal stack", () => {
  const code = source(`let inc = x => x + 1\n0${"->inc".repeat(10_000)}`);
  const machine = start(code);
  do { advance(code, machine, 10_000); } while (machine.control.kind === "eval" || machine.control.kind === "value");
  assert.deepEqual(machine.control, { kind: "done", value: { type: "int", value: "10000" } });
});

test("show is callable in source and through a pipe without a host effect", () => {
  const code = source('(show(2026-11-07T12:00Z), 1h->show, show(@alice), show(Answered("yes")))');
  const machine = advance(code, start(code));
  assert.deepEqual(machine.control, { kind: "done", value: { type: "tuple", values: [
    text("2026-11-07T12:00:00.000Z"), text("1h"), text("@alice"), text("Answered(yes)"),
  ] } });
});

test("show rejects a missing value, extra positional values and unknown labels", () => {
  for (const call of ['show()', 'show(1, 2)', 'show(1, ~extra=2)']) {
    const code = source(call), machine = advance(code, start(code));
    assert.equal(machine.control.kind, "error", call);
  }
});

test("after accepts an absolute time and resumes when that instant is observed", () => {
  const at = Date.parse("2026-11-07T12:00Z");
  const { team, pass } = started('after(2026-11-07T12:00Z)->wait->show', at - 60_000);
  assert.deepEqual([pass.status, pass.nextDue], ["waiting", at]);
  team.advanceTo(at - 1);
  assert.equal(team.run().status, "waiting");
  team.advanceTo(at);
  const done = team.run();
  assert.deepEqual([done.status, done.result], ["completed", text("2026-11-07T12:00:00.000Z")]);
});

test("an elapsed absolute timer is ready immediately and every still requires a duration", () => {
  const at = Date.parse("2026-11-07T12:00Z");
  assert.equal(started('after(2026-11-07T12:00Z)->wait', at + 1).pass.status, "completed");
  const invalid = started('every(2026-11-07T12:00Z)->wait', at + 1).pass;
  assert.deepEqual([invalid.status, invalid.error], ["failed", "A relative timer needs a positive duration"]);
});
