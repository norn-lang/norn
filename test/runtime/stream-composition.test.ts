import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, start } from "../../src/runtime/machine.ts";
import { Team } from "../../src/runtime/team.ts";
import { text, variant } from "../../src/runtime/value.ts";
import { HOUR, restarted, source, started, stream } from "./helpers.ts";

const ci = (repo = "acme/api") => stream("ciFailed", text(repo));

for (const winner of ["event", "timer"]) {
  test(`case 5: or preserves the ${winner} value across restarts before and after it is recorded, and delivers it once`, () => {
    let { team, pass } = started('never()->or(ciFailed("acme/api"))->or(after(1h))->wait');
    assert.equal(pass.status, "waiting");
    team = restarted(team);
    if (winner === "event") team.emit(ci(), text("private incident details"));
    else team.advanceTo(HOUR);
    // The process dies after the occurrence is recorded and before the program has seen it.
    team = restarted(team);
    pass = team.run();
    const expected = winner === "event" ? variant("First", variant("Second", text("private incident details"))) : variant("Second", { type: "time", value: String(HOUR) });
    assert.deepEqual([pass.status, pass.result], ["completed", expected]);
    assert.equal(pass.log.filter(step => step.kind === "waited").length, 1);
    team = restarted(team);
    pass = team.run();
    assert.deepEqual([pass.result, pass.log], [expected, []]);
  });
}

test("nested or preserves the full source constructor path", () => {
  const { team } = started('ciFailed("a")->or(ciFailed("b"))->or(never())->wait');
  team.emit(ci("b"), text("not unit"));
  assert.deepEqual(team.run().result, variant("First", variant("Second", text("not unit"))));
});

test("or preserves tagged payloads from either stream", () => {
  for (const repo of ["a", "b"]) {
    const { team } = started('ciFailed("a")->or(ciFailed("b"))->wait');
    team.emit(ci(repo), text(`incident in ${repo}`));
    assert.deepEqual(team.run().result, variant(repo === "a" ? "First" : "Second", text(`incident in ${repo}`)));
  }
});

test("never stays waiting after restart, unrelated events and repeated passes", () => {
  const first = started('never()->wait');
  assert.deepEqual([first.pass.status, first.pass.nextDue], ["waiting", null]);
  const team = restarted(first.team);
  team.advanceTo(30 * 24 * HOUR); team.emit(ci(), text("unrelated"));
  const recorded = structuredClone(team.ledger);
  for (let i = 0; i < 3; i++) {
    const pass = team.run();
    assert.deepEqual([pass.status, pass.nextDue, pass.log], ["waiting", null, []]);
  }
  assert.deepEqual(team.ledger, recorded);
});

test("never permits a deadline and empty alternatives cannot produce a spurious occurrence", () => {
  const { team, pass } = started('never()->or(never())->waitUntil(1h)');
  assert.deepEqual(pass.waiting, { targets: [], until: HOUR });
  team.advanceTo(HOUR - 1);
  assert.equal(team.run().status, "waiting");
  team.advanceTo(HOUR);
  assert.deepEqual(team.run().result, variant("None"));
});

test("forEach rearms or and passes tagged values to the handler on successive occurrences", () => {
  const { team } = started('never()->or(ciFailed("acme/api"))->forEach(x => say(@alice, show(x)))');
  for (const id of ["first", "second"]) {
    team.emit(ci(), text(id));
    assert.equal(team.run().status, "waiting");
  }
  assert.deepEqual(team.events.flatMap(event => event.kind === "said" ? [event.text] : []), ["Second(first)", "Second(second)"]);
});

test("map gives each occurrence through its function, inside or and around it, across restarts", () => {
  // Two repositories and a beat become one stream of text: what failed, or nothing on the beat.
  let { team } = started(`let both = (a, b) => a->or(b)->map(each => switch each { | First(what) => what | Second(what) => what })
let failed = repo => ciFailed(repo)->map(what => repo ++ ": " ++ what)
both(every(1h)->map(_ => "beat"), both(failed("acme/api"), failed("acme/web")))->forEach(why => say(@alice, why))`);
  const said: string[] = [];
  const run = () => { assert.equal(team.run().status, "waiting"); said.push(...team.events.flatMap(event => event.kind === "said" ? [event.text] : [])); team = restarted(team); };
  team.emit(ci("acme/web"), text("deploy failed")); run();
  team.advanceTo(HOUR); run();
  team.emit(ci(), text("tests failed")); run();
  assert.deepEqual(said, ["acme/web: deploy failed", "beat", "acme/api: tests failed"]);
  // A deadline that passes first gives None; a value that arrives is mapped inside Some.
  const waited = (emit: boolean) => {
    const run = started('ciFailed("acme/api")->map(what => "CI: " ++ what)->waitUntil(1h)');
    if (emit) run.team.emit(ci(), text("red")); else run.team.advanceTo(HOUR);
    return run.team.run().result;
  };
  assert.deepEqual([waited(true), waited(false)], [variant("Some", text("CI: red")), variant("None")]);
});

test("stream combinators reject non-stream arguments, wrong arity and labels", () => {
  for (const expression of [
    'never(1)', 'never(~unused=1)', 'or()', 'or(never())', 'or(never(), 1)',
    'or(never(), merged("p"))', 'or(never(), never(), never())', 'or(never(), never(), ~unused=1)',
    'merge(never())', 'merge(never(), never(), never())', 'merge(never(), never(), ~unused=1)',
  ]) {
    const code = source(expression);
    assert.equal(advance(code, start(code)).control.kind, "error", expression);
  }
});

test("nothing can be made to occur on never, a timer or a composite stream, or to hold as one", () => {
  const team = new Team(source("()"));
  for (const name of ["or", "never", "after", "every", "map", "filter"]) {
    assert.throws(() => team.emit({ type: "source", kind: "stream", name, args: [], labels: {} }, text("forged")), /occur needs a stream of the host/);
  }
  assert.throws(() => team.emit(text("not a source"), text("forged")), /occur needs a stream of the host/);
  assert.deepEqual([team.ledger.occurrences, team.ledger.facts], [[], {}]);
});
