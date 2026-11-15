// Delegation (spec §7, and contract cases 7 to 12 of §11.1): the holder of a
// request passes it to someone who answers it for them. The program never
// sees it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { delegate, emptyLedger, evaluate, reclaim, settle, take, type Ledger } from "../../src/runtime/ledger.ts";
import { Team } from "../../src/runtime/team.ts";
import { text, variant } from "../../src/runtime/value.ts";
import { HOUR, answered, open, reply, report, restarted, source, started } from "./helpers.ts";

const DECISION = `switch confirm(@daniel, "Clean up the expired commands?", ~by=2d)->wait {
| Answered(Yes) => "clean"
| Answered(No) | NoReply => "keep"
| other => fail(other)
}`;

test("case 7: a delegate's answer settles the request, across a restart, and the delegator's is evidence", () => {
  let { team } = started(DECISION);
  const asked = open(team);
  assert.equal(team.delegate(asked.id, "@daniel", "@claude:2", "I cannot judge this; claude can"), null);
  const delegated = open(team);
  assert.deepEqual([delegated.id, delegated.holder, delegated.delegatedBy, delegated.epoch, delegated.by], [asked.id, "@claude:2", "@daniel", 1, asked.by]);
  // The program asks nothing new and does not notice.
  assert.deepEqual(team.run().opened, []);
  team = restarted(team);
  assert.equal(reply(team, asked, answered(variant("No"))), false);
  assert.deepEqual(team.ledger.evidence.map(e => [e.holder, e.reason]), [["@daniel", "Not the request's holder"]]);
  assert.ok(reply(team, delegated, answered(variant("Yes"))));
  assert.deepEqual(team.run().result, text("clean"));
  // The ledger keeps who answered, and for whom.
  const settled = team.ledger.requests[asked.id];
  assert.deepEqual([settled.holder, settled.delegatedBy, settled.reply], ["@claude:2", "@daniel", answered(variant("Yes"))]);
  assert.deepEqual(team.ledger.delegations, [
    { request: asked.id, at: 0, kind: "delegated", from: "@daniel", to: "@claude:2", reason: "I cannot judge this; claude can" },
  ]);
});

test("the program cannot tell a delegate's answer from the holder's", () => {
  const direct = started(DECISION).team;
  reply(direct, open(direct), answered(variant("Yes")));
  const viaDelegate = started(DECISION).team;
  viaDelegate.delegate(open(viaDelegate).id, "@daniel", "@claude:2");
  reply(viaDelegate, open(viaDelegate), answered(variant("Yes")));
  const [a, b] = [direct.run(), viaDelegate.run()];
  assert.deepEqual([a.status, a.result, a.log], [b.status, b.result, b.log]);
  assert.deepEqual(direct.ledger.entries, viaDelegate.ledger.entries);
});

test("case 8: the delegator takes the request back; the delegate's answer is then evidence", () => {
  const { team } = started(DECISION);
  const asked = open(team);
  team.delegate(asked.id, "@daniel", "@claude:2");
  const delegated = open(team);
  team.advanceTo(HOUR);
  assert.equal(team.reclaim(asked.id, "@claude:2"), "@claude:2 has not delegated the request");
  assert.equal(team.reclaim(asked.id, "@daniel"), null);
  const back = open(team);
  assert.deepEqual([back.holder, back.delegatedBy, back.epoch, back.by], ["@daniel", null, 2, asked.by]);
  assert.equal(settle(team.ledger, asked.id, "@claude:2", answered(variant("Yes")), HOUR, delegated.epoch), false);
  assert.equal(team.ledger.evidence.at(-1)?.reason, "Not the request's holder");
  assert.equal(team.reclaim(asked.id, "@daniel"), "@daniel has not delegated the request");
  assert.ok(reply(team, back, answered(variant("No"))));
  assert.deepEqual(team.run().result, text("keep"));
  assert.deepEqual(team.events.flatMap(event => event.kind === "delegated" || event.kind === "reclaimed" ? [[event.kind, event.at, event.from, event.to]] : []), [
    ["delegated", 0, "@daniel", "@claude:2"], ["reclaimed", HOUR, "@claude:2", "@daniel"],
  ]);
});

test("case 9: a delegate's refusal or failure gives the request back; only the holder the program chose ends it so", () => {
  for (const given of [{ tag: "Refused", reason: "Production data is not mine to judge" }, { tag: "Broke", reason: "I could not read the table" }] as const) {
    const { team } = started(DECISION);
    const asked = open(team);
    team.delegate(asked.id, "@daniel", "@claude:2");
    assert.equal(reply(team, open(team), given), false);
    const back = open(team);
    assert.deepEqual([back.holder, back.delegatedBy, back.epoch, back.reply], ["@daniel", null, 2, null]);
    assert.deepEqual(team.ledger.evidence, []);
    assert.deepEqual(team.ledger.delegations.at(-1), { request: asked.id, at: 0, kind: "returned", from: "@claude:2", to: "@daniel", reason: given.reason, reply: given });
    assert.deepEqual(team.events.at(-1), { kind: "returned", at: 0, from: "@claude:2", to: "@daniel", reason: given.reason, reply: given, request: back });
    assert.equal(team.run().status, "waiting");
    // The holder the program chose can refuse it, and that ends it.
    assert.ok(reply(team, back, { tag: "Refused", reason: "Not now" }));
    assert.deepEqual(team.run().result, variant("Refused", text("Not now")));
  }
});

test("case 10: the program's handover ends a delegation and fences the delegate", () => {
  const { team } = started(`let q = confirm(@daniel, "Clean up?")
switch q->waitUntil(1h) { | Some(r) => r | None => q->handOver(@alice)->wait }`);
  const asked = open(team);
  team.advanceTo(HOUR / 2);
  team.delegate(asked.id, "@daniel", "@claude:2");
  const delegated = open(team);
  team.advanceTo(HOUR); team.run();
  const moved = open(team);
  assert.deepEqual([moved.holder, moved.delegatedBy, moved.epoch], ["@alice", null, 2]);
  assert.equal(reply(team, delegated, answered(variant("Yes"))), false);
  assert.equal(team.reclaim(asked.id, "@daniel"), "@daniel has not delegated the request");
  assert.ok(reply(team, moved, answered(variant("No"))));
  assert.deepEqual(team.run().result, variant("Answered", variant("No")));
});

test("case 11: a group's exception holds after the request is taken, and nobody can delegate the request to it", () => {
  const ledger = emptyLedger();
  evaluate(source(`run(anyOf([@claude, @grok, @codex], ~except=@codex), "Review the migration")->wait`), ledger, 0);
  const { id } = open(ledger);
  assert.deepEqual(ledger.requests[id].excluded, ["@codex"]);
  assert.equal(delegate(ledger, id, "@grok", "@claude", 0), "Nobody of the group has taken the request yet");
  assert.ok(take(ledger, id, "@grok", 1));
  assert.deepEqual([ledger.requests[id].candidates, ledger.requests[id].excluded], [null, ["@codex"]]);
  assert.equal(delegate(ledger, id, "@grok", "@codex", 2), "The request leaves out @codex");
  assert.equal(delegate(ledger, id, "@grok", "@codex:3", 2), "The request leaves out @codex:3");
  assert.equal(delegate(ledger, id, "@grok", "@claude", 2), null);
  assert.ok(settle(ledger, id, "@claude", answered(report("Sound")), 3));
});

test("a handover puts the exception of the participant it names on the request", () => {
  const { team } = started(`let q = run(@claude, "Review the migration")
switch q->waitUntil(1h) { | Some(r) => r | None => q->handOver(anyOf([@grok, @codex], ~except=@codex))->wait }`);
  const asked = open(team);
  assert.deepEqual(asked.excluded, []);
  team.advanceTo(HOUR); team.run();
  assert.deepEqual([open(team).candidates, open(team).excluded], [["@grok"], ["@codex"]]);
  assert.ok(take(team.ledger, asked.id, "@grok", HOUR));
  assert.equal(team.delegate(asked.id, "@grok", "@codex:1"), "The request leaves out @codex:1");
});

test("case 12: a request's deadline passes while it is delegated; delegating it did not move the deadline", () => {
  const { team } = started(`confirm(@daniel, "Clean up?", ~by=1h)->wait`);
  const asked = open(team);
  team.delegate(asked.id, "@daniel", "@claude:2");
  const delegated = open(team);
  assert.equal(delegated.by, HOUR);
  team.advanceTo(HOUR);
  assert.equal(reply(team, delegated, answered(variant("Yes"))), false);
  assert.equal(team.ledger.evidence.at(-1)?.reason, "The request has already ended");
  assert.deepEqual([team.run().result, team.ledger.requests[asked.id].settledAt], [variant("NoReply"), HOUR]);
  assert.equal(team.delegate(asked.id, "@claude:2", "@daniel"), "The request has already ended");
  assert.equal(team.reclaim(asked.id, "@daniel"), "The request has already ended");
});

test("only the holder delegates, once, to one participant other than themselves; a judgement is never delegated", () => {
  const ledger = emptyLedger();
  evaluate(source(`let asked = confirm(@daniel, "Clean up?")
let judged = judge("The table is clean")
(asked->wait, judged->wait)`), ledger, 0);
  const asked = open(ledger, "confirm"), judged = open(ledger, "judge");
  const refusals: [string, string, string, { epoch?: number }][] = [
    ["@claude:2", "@grok", "Not the request's holder", {}],
    ["@daniel", "@claude:2", "Not the request's holder", { epoch: 5 }],
    ["@daniel", "@daniel", "The holder already holds the request", {}],
    ["@daniel", "@judge", "A request is delegated to one participant, as in @alice or @codex:2", {}],
    ["@daniel", "anyOf([@claude, @grok])", "A request is delegated to one participant, as in @alice or @codex:2", {}],
    ["@daniel", "claude", "A request is delegated to one participant, as in @alice or @codex:2", {}],
  ];
  for (const [from, to, why, options] of refusals) assert.equal(delegate(ledger, asked.id, from, to, 0, options), why, `${from} → ${to}`);
  assert.equal(delegate(ledger, judged.id, "@judge", "@claude", 0), "Only the host's judge decides a judgement");
  assert.equal(delegate(ledger, "request:missing#1", "@daniel", "@claude", 0), "No such request");
  assert.equal(reclaim(ledger, "request:missing#1", "@daniel", 0), "No such request");
  assert.deepEqual([ledger.delegations, ledger.requests[asked.id].holder, ledger.requests[asked.id].epoch], [[], "@daniel", 0]);
  assert.equal(delegate(ledger, asked.id, "@daniel", "@claude:2", 0, { epoch: 0 }), null);
  assert.equal(delegate(ledger, asked.id, "@claude:2", "@grok", 0), "A delegate answers the request or gives it back; they cannot delegate it again");
});

test("delegating needs the author's current authority, as any request does", () => {
  const { team } = started(DECISION);
  team.permitted = false;
  assert.equal(team.delegate(open(team).id, "@daniel", "@claude:2"), "The program's author has lost the authority to ask anyone");
  assert.equal(open(team).holder, "@daniel");
});

test("a ledger written before delegation existed is read as one in which nobody delegated anything", () => {
  const ledger = emptyLedger();
  evaluate(source(DECISION), ledger, 0);
  const older = JSON.parse(JSON.stringify(ledger)) as Partial<Ledger> & Pick<Ledger, "requests">;
  delete older.delegations;
  for (const request of Object.values(older.requests) as Partial<Ledger["requests"][string]>[]) { delete request.excluded; delete request.delegatedBy; }
  const team = new Team(source(DECISION), { ledger: older as Ledger });
  const asked = open(team);
  assert.equal(team.reclaim(asked.id, "@daniel"), "@daniel has not delegated the request");
  assert.equal(team.delegate(asked.id, "@daniel", "@claude:2"), null);
  assert.equal(reply(team, open(team), { tag: "Refused", reason: "Not mine to decide" }), false);
  assert.equal(team.delegate(asked.id, "@daniel", "@grok"), null);
  assert.ok(reply(team, open(team), answered(variant("Yes"))));
  assert.deepEqual(team.run().result, text("clean"));
  assert.deepEqual(team.ledger.delegations.map(entry => [entry.kind, entry.from, entry.to]), [
    ["delegated", "@daniel", "@claude:2"], ["returned", "@claude:2", "@daniel"], ["delegated", "@daniel", "@grok"],
  ]);
});
