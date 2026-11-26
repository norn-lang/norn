import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSource } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { compile } from "../../src/runtime/code.ts";
import { hold, holdKind } from "../../src/runtime/ledger.ts";
import { text, type Value } from "../../src/runtime/value.ts";
import { HOUR, answered, report, reply, started, tree } from "./helpers.ts";

const std = tree(readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8"));
const DAY = 24 * HOUR;
const site = (domain: string): Value => ({ type: "record", fields: { domain: text(domain) } });
const SITE = holdKind("page", "site");

const daily = `open Std
type site = {domain: string}
each(Holds.kind("page", "site"), h =>
  every(1d)->forEach(~key="daily", _ => switch Holds.sample(h) {
  | Some(s) => ignore(run(@claude, \`Report on \${s.domain}\`)->wait)
  | None => ()
  }))`;

function program() {
  const checked = checkSource(daily, referenceOptions());
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  return compile(checked.program!, { std });
}
const runs = (team: { open: { verb: string; text: string }[] }) => team.open.filter(r => r.verb === "run").map(r => r.text).sort();

test("each keeps one branch per thing that holds, including those that held before the program began", () => {
  const { team } = started(program());
  hold(team.ledger, SITE, "page-a", site("a.example"), 0);
  hold(team.ledger, SITE, "page-b", site("b.example"), 0);
  const pass = team.run();
  assert.equal(pass.status, "waiting");
  assert.deepEqual(pass.holding, ["page:site"]);
  assert.equal(pass.branches.length, 2);
  team.advanceTo(DAY); team.run();
  assert.deepEqual(runs(team), ["Report on a.example", "Report on b.example"]);
});

test("a changed value reaches the next round without interrupting the round at work", () => {
  const { team } = started(program());
  hold(team.ledger, SITE, "page-a", site("a.example"), 0);
  team.run();
  team.advanceTo(DAY); team.run();
  const first = team.open.find(r => r.verb === "run")!;
  hold(team.ledger, SITE, "page-a", site("a2.example"), DAY + 1);
  team.run();
  assert.deepEqual(runs(team), ["Report on a.example"]);
  reply(team, first, answered(report("done")));
  team.run();
  team.advanceTo(2 * DAY); team.run();
  assert.deepEqual(runs(team), ["Report on a2.example"]);
});

test("a thing that stops holding ends its branch and cancels what it left open; the others go on", () => {
  const { team } = started(program());
  hold(team.ledger, SITE, "page-a", site("a.example"), 0);
  hold(team.ledger, SITE, "page-b", site("b.example"), 0);
  team.run();
  team.advanceTo(DAY); team.run();
  const a = team.open.find(r => r.text === "Report on a.example")!;
  hold(team.ledger, SITE, "page-a", null, DAY + 1);
  const pass = team.run();
  assert.equal(team.ledger.requests[a.id]!.reply?.tag, "Cancelled");
  assert.deepEqual(runs(team), ["Report on b.example"]);
  assert.equal(pass.branches.length, 1);
});

test("holding the same value again records nothing, and a quiet hold wakes no one", () => {
  const { team } = started(program());
  hold(team.ledger, SITE, "page-a", site("a.example"), 0);
  const occurrences = team.ledger.occurrences.length;
  hold(team.ledger, SITE, "page-a", site("a.example"), 1);
  assert.equal(team.ledger.occurrences.length, occurrences);
  hold(team.ledger, SITE, "page-a", site("a2.example"), 2, { notify: false });
  assert.equal(team.ledger.occurrences.length, occurrences);
  assert.equal(team.ledger.holds?.["page:site"]?.["page-a"]?.value.type, "record");
});

test("Holds.kind reads its type by name, and a name the program cannot see is an error", () => {
  const misspelled = checkSource(`type site = {domain: string}
let k = Holds.kind("page", "sight")`, referenceOptions());
  assert.equal(misspelled.ok, false);
  assert.equal(misspelled.diagnostics[0]?.code, "unknown-hold-type");
  assert.match(misspelled.diagnostics[0]?.message ?? "", /unknown type sight in Holds.kind/u);
});
