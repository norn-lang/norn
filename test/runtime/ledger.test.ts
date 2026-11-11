import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/frontend/parser.ts";
import { checkSource, elaborate } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { compile } from "../../src/runtime/code.ts";
import { emptyLedger, establish, evaluate, occur, settle, type Ledger, type Reply } from "../../src/runtime/ledger.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";

const HOUR = 3_600_000;
function program(source: string) {
  const parsed = parse(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return compile(parsed.program);
}
const open = (ledger: Ledger) => Object.values(ledger.requests).filter(r => r.reply === null);
const asked = (ledger: Ledger) => Object.values(ledger.requests).map(r => `${r.holder}: ${r.text}`);
const answered = (value: Value): Reply => ({ tag: "Answered", value });
const report = (body: string): Value => ({ type: "record", fields: { text: text(body) } });

const decision = `switch confirm(@alice, "Ship the probe?", ~by=1h)->wait {
| Answered(Yes) | NoReply => run(@auto, "Ship it")->wait
| Answered(No) => run(@auto, "Record: don't ship")->wait
| other => fail(other)
}`;

test("a program is a pure function of the ledger: a second pass changes nothing", () => {
  const code = program(decision), ledger = emptyLedger();
  const first = evaluate(code, ledger, 0);
  assert.equal(first.status, "waiting");
  assert.deepEqual(asked(ledger), ["@alice: Ship the probe?"]);
  assert.equal(first.nextDue, HOUR);
  const before = structuredClone(ledger);
  // A crash, a restart or a competing worker is just another pass.
  assert.deepEqual(evaluate(code, ledger, 10).opened, []);
  assert.deepEqual(ledger, before);

  const [question] = open(ledger);
  assert.ok(settle(ledger, question.id, "@alice", answered(variant("Yes")), 20));
  assert.deepEqual(evaluate(code, ledger, 20).opened.map(r => r.text), ["Ship it"]);
  const [work] = open(ledger);
  settle(ledger, work.id, "@auto", answered(report("shipped")), 30);
  const last = evaluate(code, ledger, 30);
  assert.equal(last.status, "completed");
  assert.deepEqual(open(ledger), []);
});

test("silence has the declared consequence, decided by the ledger's clock", () => {
  const code = program(decision), ledger = emptyLedger();
  evaluate(code, ledger, 0);
  assert.deepEqual(evaluate(code, ledger, HOUR - 1).opened, []);
  const pass = evaluate(code, ledger, HOUR);
  assert.deepEqual(pass.opened.map(r => r.text), ["Ship it"]);
  assert.equal(Object.values(ledger.requests)[0].reply?.tag, "NoReply");
});

test("requests that do not depend on each other are open together", () => {
  const code = program(`let api = run(@claude, "Build the API")
let client = run(@codex, "Build the client")
let a = api->wait?
let b = client->wait?
run(@grok, \`Integrate \${a.text} with \${b.text}\`)->wait`);
  const ledger = emptyLedger();
  assert.equal(evaluate(code, ledger, 0).opened.length, 2);
  const [api, client] = open(ledger);
  settle(ledger, client.id, "@codex", answered(report("client v1")), 5);
  assert.deepEqual(evaluate(code, ledger, 5).opened, []); // Still needs the API.
  settle(ledger, api.id, "@claude", answered(report("api v1")), 9);
  assert.deepEqual(evaluate(code, ledger, 9).opened.map(r => r.text), ["Integrate api v1 with client v1"]);
});

test("asking again in a loop is a new request each time", () => {
  const code = program(`let rec until = () => switch ask(@alice, "Is it fixed?")->wait {
| Answered("yes") => Answered("fixed")
| _ => until()
}
until()`);
  const ledger = emptyLedger();
  evaluate(code, ledger, 0);
  settle(ledger, open(ledger)[0].id, "@alice", answered(text("not yet")), 1);
  evaluate(code, ledger, 1);
  assert.equal(Object.keys(ledger.requests).length, 2);
  settle(ledger, open(ledger)[0].id, "@alice", answered(text("yes")), 2);
  assert.equal(evaluate(code, ledger, 2).status, "completed");
  assert.equal(Object.keys(ledger.requests).length, 2);
});

test("a plan edited while it runs keeps every request it still makes", () => {
  const v1 = program(`confirm(@alice, "Ship?")->wait?
run(@codex, "Ship it")->wait`);
  const ledger = emptyLedger();
  evaluate(v1, ledger, 0);
  const question = structuredClone(open(ledger)[0]);

  const v2 = program(`let notes = run(@grok, "Draft the release notes")
confirm(@alice, "Ship?")->wait?
run(@codex, \`Ship it with \${(notes->wait?).text}\`)->wait`);
  // The preview shows who would newly be asked and who would be left behind, and writes nothing.
  const before = structuredClone(ledger);
  const preview = evaluate(v2, ledger, 50, { commit: false });
  assert.deepEqual(preview.opened.map(r => `${r.holder}: ${r.text}`), ["@grok: Draft the release notes"]);
  assert.deepEqual(preview.unreached, []);
  assert.deepEqual(ledger, before);

  evaluate(v2, ledger, 50);
  assert.deepEqual(ledger.requests[question.id], question); // Alice is not asked twice.
  assert.equal(open(ledger).length, 2);
});

test("an edit never cancels work in progress by itself", () => {
  const parallel = program(`let a = run(@claude, "Part one")
let b = run(@codex, "Part two")
a->wait?
b->wait`);
  const ledger = emptyLedger();
  evaluate(parallel, ledger, 0);
  const two = structuredClone(Object.values(ledger.requests).find(r => r.holder === "@codex")!);

  const sequential = program(`let a = run(@claude, "Part one")
a->wait?
let b = run(@codex, "Part two")
b->wait`);
  const preview = evaluate(sequential, ledger, 10, { commit: false });
  assert.deepEqual(preview.unreached.map(r => r.text), ["Part two"]); // Shown to the author, who decides.
  evaluate(sequential, ledger, 10);
  assert.equal(ledger.requests[two.id].reply, null);
  assert.equal(ledger.requests[two.id].detached, true);

  settle(ledger, Object.values(ledger.requests).find(r => r.holder === "@claude")!.id, "@claude", answered(report("one")), 20);
  const pass = evaluate(sequential, ledger, 20);
  assert.deepEqual(pass.opened, []); // The program reaches part two again and finds it already open.
  assert.deepEqual(ledger.requests[two.id], two);
});

test("a change of code identity that changes no request is an empty difference", () => {
  const ledger = emptyLedger();
  const original = program(decision);
  evaluate(original, ledger, 0);
  const upgraded = program(`// Reformatted by a newer toolchain.\n${decision}\n`);
  assert.notEqual(upgraded.id, original.id); // A ledger holds no code identity to refuse.
  const pass = evaluate(upgraded, ledger, 5, { commit: false });
  assert.deepEqual([pass.opened, pass.unreached, pass.cancelled, pass.rescheduled], [[], [], [], []]);
});

test("moving a deadline amends the same request", () => {
  const ledger = emptyLedger();
  evaluate(program(`confirm(@alice, "Ship?", ~by=1h)->wait`), ledger, 0);
  const pass = evaluate(program(`confirm(@alice, "Ship?", ~by=2h)->wait`), ledger, 10);
  assert.deepEqual(pass.opened, []);
  assert.deepEqual(pass.rescheduled.map(r => [r.from, r.to]), [[HOUR, 2 * HOUR]]);
});

test("a wait that runs out, a handover and a late answer from the old holder", () => {
  const code = program(`let q = ask(@codex, "Still overheating?")
let reply = switch q->waitUntil(1h) {
| Some(r) => r
| None => q->handOver(@alice)->wait
}
say(doc"ops#machines", reply?)`);
  const ledger = emptyLedger();
  evaluate(code, ledger, 0);
  const id = open(ledger)[0].id;
  evaluate(code, ledger, HOUR);
  assert.deepEqual([ledger.requests[id].holder, ledger.requests[id].epoch], ["@alice", 1]);
  assert.equal(settle(ledger, id, "@codex", answered(text("no")), HOUR + 1), false);
  assert.deepEqual(ledger.evidence.map(e => e.reason), ["Not the request's holder"]); // Kept, and settles nothing.
  assert.ok(settle(ledger, id, "@alice", answered(text("cooled down")), HOUR + 2));
  const pass = evaluate(code, ledger, HOUR + 2);
  assert.deepEqual(pass.said, [{ to: `doc"ops#machines"`, text: "cooled down" }]);
  assert.equal(pass.status, "completed");
  assert.deepEqual(evaluate(code, ledger, HOUR + 3).said, []); // Said once.
});

test("a standing duty re-arms from the ledger and reports a failed round to its author", () => {
  const code = program(`every(1d)->forEach(_ => run(@auto, "Daily round")->wait)`);
  const ledger = emptyLedger();
  const DAY = 24 * HOUR;
  assert.equal(evaluate(code, ledger, 0).nextDue, DAY);
  evaluate(code, ledger, DAY);
  settle(ledger, open(ledger)[0].id, "@auto", { tag: "Broke", reason: "no quota" }, DAY + 5);
  const pass = evaluate(code, ledger, DAY + 5);
  assert.equal(pass.status, "waiting");
  assert.equal(pass.nextDue, 2 * DAY + 5);
  assert.equal(Object.keys(ledger.entries).filter(k => k.startsWith("report:")).length, 1);
});

test("two deadlines at one instant: the request's own comes first, and an answer at the wait's deadline loses", () => {
  const both = emptyLedger(), same = program(`ask(@alice, "Ready?", ~by=1h)->waitUntil(1h)`);
  evaluate(same, both, 0);
  assert.equal(settle(both, open(both)[0].id, "@alice", answered(text("yes")), HOUR), false);
  assert.deepEqual(evaluate(same, both, HOUR).result, variant("Some", variant("NoReply")));

  const late = emptyLedger(), shorter = program(`let q = ask(@alice, "Ready?", ~by=2h)
switch q->waitUntil(1h) { | None => cancel(q) | Some(_) => () }`);
  evaluate(shorter, late, 0);
  const id = open(late)[0].id;
  assert.ok(settle(late, id, "@alice", answered(text("yes")), HOUR)); // Answered, but the wait had already run out.
  const pass = evaluate(shorter, late, HOUR);
  assert.equal(pass.status, "completed");
  assert.equal(late.requests[id].reply?.tag, "Answered"); // cancel on an ended request does nothing.
});

test("an answer outside the request's form is refused and the request stays open", () => {
  const ledger = emptyLedger();
  evaluate(program(`type plan = Ship | Drop
choose(@alice, "Which?", [Ship, Drop])->wait`), ledger, 0);
  const id = open(ledger)[0].id;
  assert.equal(settle(ledger, id, "@alice", answered(variant("Delay")), 1), false);
  assert.equal(ledger.requests[id].reply, null);
  assert.ok(settle(ledger, id, "@alice", answered(variant("Drop")), 2));
});

test("a fact may already hold; a stream gives the first occurrence after the wait began, with its source", () => {
  const code = program(`let pr = merged("acme/api#1")->wait
ciFailed("acme/api")->or(prActivity("acme/api#1"))->wait`);
  const ledger = emptyLedger();
  const sources = program(`(merged("acme/api#1"), ciFailed("acme/api"), prActivity("acme/api#1"))`);
  const [merged, ci, activity] = (evaluate(sources, emptyLedger(), 0).result as Extract<Value, {type: "list" | "tuple"}>).values;
  occur(ledger, ci, text("before the wait"), 1);
  establish(ledger, merged, text("abc123"), 2);
  assert.equal(evaluate(code, ledger, 3).status, "waiting");
  occur(ledger, activity, text("review"), 4);
  occur(ledger, ci, text("lint"), 5);
  assert.deepEqual(evaluate(code, ledger, 6).result, variant("Second", text("review")));
});

test("a program that never waits fails in the open", () => {
  const pass = evaluate(program(`let rec spin = n => spin(n + 1)\nspin(0)`), emptyLedger(), 0, { commit: true, steps: 50_000 });
  assert.equal(pass.status, "failed");
  assert.match(pass.error!, /too long/);
});

test("known limit: identical requests are told apart only by their order", () => {
  const ledger = emptyLedger();
  evaluate(program(`ask(@alice, "OK?")->wait?
run(@codex, "Go")->wait`), ledger, 0);
  settle(ledger, open(ledger)[0].id, "@alice", answered(text("ok for stage one")), 1);
  // The edit puts another identical question in front. It takes over the old answer.
  const pass = evaluate(program(`let early = ask(@alice, "OK?")->wait?
ask(@alice, "OK?")->wait?
run(@codex, \`Go: \${early}\`)->wait`), ledger, 2);
  assert.deepEqual(pass.opened.map(r => r.text), ["OK?"]);
  // Hence the rule for the checker: two requests that can be identical must be told apart by ~about or a name.
});

test("a run's report must have the form the program uses it as, and an earlier holding's answer does not count", () => {
  const source = `type verdict = Sound | Flawed(string)
let review = run(@codex, "Find what does not hold")
switch review->waitUntil(1h) {
| Some(Answered(Sound)) => say(@claude, "sound")
| Some(Answered(Flawed(why))) => say(@claude, why)
| Some(other) => fail(other)
| None => ignore(review->handOver(@grok)->handOver(@codex)->wait)
}`;
  const checked = checkSource(source, referenceOptions());
  assert.deepEqual(checked.diagnostics, []);
  const code = compile(elaborate(checked.program!, checked.reports));
  const ledger = emptyLedger();
  evaluate(code, ledger, 0);
  const id = open(ledger)[0].id;
  assert.equal(ledger.requests[id].form?.text, "verdict");
  assert.equal(settle(ledger, id, "@codex", answered(report("looks fine")), 1), false);
  assert.match(ledger.evidence[0].reason, /^The report must be verdict: expected one of Sound, Flawed/);
  // The request leaves @codex and comes back: an answer given under the first holding is evidence only.
  evaluate(code, ledger, HOUR);
  assert.deepEqual([ledger.requests[id].holder, ledger.requests[id].epoch], ["@codex", 2]);
  assert.equal(settle(ledger, id, "@codex", answered(variant("Sound")), HOUR + 1, 0), false);
  assert.ok(settle(ledger, id, "@codex", answered(variant("Flawed", text("no owner on failure"))), HOUR + 2, 2));
});
