import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSource } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { compile } from "../../src/runtime/code.ts";
import { deliverEvent, hold, holdKind } from "../../src/runtime/ledger.ts";
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

test("each -> spawn -> Events.events exposes the nested stream in pass.listening and dispatches on event arrival", () => {
  const source = `open Std
type service = {project: string}
type issue = {summary: string}
let issues: Events.kind<issue> = Events.kind("sentry", "issue.created")
each(~key="services", Holds.kind("page", "service"), h => switch Holds.sample(h) {
| Some(start) =>
  let sentry = spawn(() =>
    Events.events(issues, ~source=\`sentry:\${start.project}\`)->forEach(~key="pushed", ~each=Queue, e => switch Holds.sample(h) {
    | Some(s) => ignore(run(@claude, \`Fix \${s.project}: \${e.data.summary}\`)->wait)
    | None => ()
    }))
  every(6h)->forEach(~key="pulled", _ => ())
  ignore(sentry->wait)
| None => ()
})`;
  const checked = checkSource(source, referenceOptions());
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  const { team } = started(compile(checked.program!, { std }));
  const SERVICE = holdKind("page", "service");
  hold(team.ledger, SERVICE, "page-1", { type: "record", fields: { project: text("billing-api") } }, 0);

  const first = team.run();
  assert.equal(first.status, "waiting");
  const sentryStreams = first.listening.filter(s => s.name === "Events.events");
  assert.equal(sentryStreams.length, 1, "nested spawn Events.events stream must surface in pass.listening");
  assert.deepEqual(sentryStreams[0]!.labels.source, text("sentry:billing-api"));

  const delivery = deliverEvent(team.ledger, {
    app: "sentry", kind: "issue.created", source: "sentry:billing-api", id: "evt-1",
    data: { type: "record", fields: { summary: text("Issue 42 created") } },
  }, 1_000, { matchSources: sentryStreams });
  assert.equal(delivery.delivered, true);

  team.advanceTo(1_000);
  const afterEvent = team.run();
  assert.equal(afterEvent.status, "waiting");
  assert.deepEqual(runs(team), ["Fix billing-api: Issue 42 created"]);
  assert.equal(afterEvent.listening.filter(s => s.name === "Events.events").length, 1,
    "Events.events stream remains listened to while its Queue handler is in flight");

  hold(team.ledger, SERVICE, "page-1", null, 2_000);
  team.advanceTo(2_000);
  const afterRetract = team.run();
  assert.equal(afterRetract.listening.filter(s => s.name === "Events.events").length, 0,
    "retracting the held fact cancels the branch and drops its nested Events.events stream");
});

test("sibling spawn does not inherit scope or loop stack when an earlier spawn suspends inside forEach", () => {
  const source = `open Std
type site = {domain: string}
let overview = spawn(~key="overview", () =>
  every(1d, ~from=2026-11-26T15:00:00Z)->forEach(~key="overview", _ =>
    ignore(run(@claude, "Overview", ~by=4h)->wait)))
let reports = spawn(~key="reports", () =>
  each(Holds.kind("page", "site"), h =>
    every(1d, ~from=2026-11-26T14:22:00Z)->forEach(~key="round", _ => switch Holds.sample(h) {
    | Some(s) => ignore(run(@claude, \`Report \${s.domain}\`, ~by=8h)->wait)
    | None => ()
    })))
ignore(all([overview, reports]))`;
  const checked = checkSource(source, referenceOptions());
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  const code = compile(checked.program!, { std });
  const t = (iso: string) => Date.parse(iso);
  const { team } = started(code, t("2026-11-26T14:00:00Z"));
  hold(team.ledger, SITE, "page-a", site("a.example"), t("2026-11-26T14:00:00Z"));
  hold(team.ledger, SITE, "page-b", site("b.example"), t("2026-11-26T14:00:00Z"));

  const init = team.run();
  assert.equal(init.status, "waiting");
  assert.equal(init.nextDue, t("2026-11-26T14:22:00Z"));

  // At 14:22, reports opens requests for both held sites.
  team.advanceTo(t("2026-11-26T14:22:00Z"));
  const at1422 = team.run();
  assert.deepEqual(runs(team), ["Report a.example", "Report b.example"]);
  assert.equal(at1422.nextDue, t("2026-11-26T15:00:00Z"));

  // At 15:00, overview suspends inside its active forEach round while reports' requests are still open.
  // reports must remain in root scope (not duplicated under overview, and not unreached/cancelled).
  team.advanceTo(t("2026-11-26T15:00:00Z"));
  const at1500 = team.run();
  assert.equal(at1500.unreached.length, 0, "reports spawn must not become unreached when overview suspends in forEach");
  assert.deepEqual(runs(team), ["Overview", "Report a.example", "Report b.example"]);
  const spawnReqs = Object.values(team.ledger.requests).filter(r => r.verb === "spawn");
  assert.equal(spawnReqs.length, 2, "must not create a duplicate nested reports spawn");
  assert.deepEqual(spawnReqs.map(r => r.openedBy), ["root", "root"]);

  // Answer overview and both report requests, then advance to the next day's reports tick.
  team.advanceTo(t("2026-11-26T15:05:00Z"));
  for (const req of team.open.filter(r => r.verb === "run")) {
    reply(team, req, answered(report("ok")));
  }
  const settled = team.run();
  assert.equal(settled.nextDue, t("2026-11-27T14:22:00Z"));

  team.advanceTo(t("2026-11-27T14:22:00Z"));
  team.run();
  assert.deepEqual(runs(team), ["Report a.example", "Report b.example"]);
});

test("Together (Std.each) isolates scope, loop, and within deadline stacks across sibling branches", () => {
  const source = `open Std
type site = {domain: string}
each(Holds.kind("page", "site"), h => switch Holds.sample(h) {
| Some(s) =>
  if s.domain == "a.example" {
    every(1d)->forEach(~key="round", _ => within(1h, () => ignore(run(@claude, "Slow A", ~by=8h)->wait)))
  } else {
    every(1d)->forEach(~key="round", _ => ignore(run(@claude, "Normal B", ~by=8h)->wait))
  }
| None => ()
})`;
  const checked = checkSource(source, referenceOptions());
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  const { team } = started(compile(checked.program!, { std }), 0);
  hold(team.ledger, SITE, "page-a", site("a.example"), 0);
  hold(team.ledger, SITE, "page-b", site("b.example"), 0);

  team.run();
  team.advanceTo(DAY);
  team.run();
  const openRuns = team.open.filter(r => r.verb === "run");
  assert.deepEqual(openRuns.map(r => r.text).sort(), ["Normal B", "Slow A"]);
  const reqA = openRuns.find(r => r.text === "Slow A")!;
  const reqB = openRuns.find(r => r.text === "Normal B")!;
  assert.equal(reqA.by, DAY + HOUR, "branch A is clamped by its own within(1h)");
  assert.equal(reqB.by, DAY + 8 * HOUR, "branch B must not inherit branch A's within(1h) deadline");
  assert.ok(!reqB.scope?.includes(reqA.scope ?? ""), "branch B must keep its own scope independent of branch A");
});
