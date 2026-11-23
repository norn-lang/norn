import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtinInterface, checkSource, elaborate, manifestActionForm, readLibrary, type ConnectorManifest,
} from "../../src/frontend/check/index.ts";
import { compile } from "../../src/runtime/code.ts";
import { mismatch } from "../../src/runtime/form.ts";
import { appHolder, delegate, emptyLedger, evaluate, preparedAction, settle, type Ledger, type LedgerRequest } from "../../src/runtime/ledger.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";

const host = builtinInterface();

const MANIFESTS: ConnectorManifest[] = [{
  app: "x",
  events: [],
  actions: [{
    name: "post",
    input: [{ name: "account", type: "string" }, { name: "text", type: "string" }, { name: "video", type: "string", required: false }],
    output: [{ name: "id", type: "string" }, { name: "url", type: "string" }],
  }],
}];

const LIBRARY = `/** Posts on X, through the standard Actions capability. */
pub type post = {account: string, text: string}
pub type posted = {id: string, url: string}

let postAction: Actions.action<post, posted> = Actions.action("x", "post")

/** Fixes one post and has it admitted; nothing is posted yet. */
pub let prepare = (account: string, text: string) => Actions.prepare(postAction, {account, text})
/** Posts what was prepared, once. */
pub let publish = ready => Actions.perform(ready)
`;

function build(source: string) {
  const x = readLibrary(LIBRARY, "x.norn", host, { name: "X", manifests: MANIFESTS });
  assert.equal(x.ok, true, JSON.stringify(x.diagnostics));
  const checked = checkSource(source, { host, std: null, libraries: { X: x }, manifests: MANIFESTS });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  // A library is read against the manifest as a program is.
  const misnamed = readLibrary(LIBRARY.replace(`"post")`, `"pots")`), "x.norn", host, { name: "X", manifests: MANIFESTS });
  assert.deepEqual(misnamed.diagnostics.filter(d => d.severity === "error").map(d => d.code), ["unknown-action"]);
  return { checked, code: compile(elaborate(checked.program!, checked.reports, checked.formEvidence), { libraries: { X: x.program } }) };
}
const open = (ledger: Ledger): LedgerRequest[] => Object.values(ledger.requests).filter(request => request.reply === null);
const posted = (id: string): Value => ({ type: "record", fields: { id: text(id), url: text(`https://x.com/i/status/${id}`) } });

const QUEUE = `
let ready = X.prepare("@acme", "Hello")->wait?
after(1d)->wait
let done = X.publish(ready)->wait?
done.url
`;

test("an action is prepared at once, performed when the program reaches it, and never twice", () => {
  const { code, checked } = build(QUEUE);
  assert.deepEqual(checked.effects?.map(effect => effect.family), ["wait", "act"]);
  const ledger = emptyLedger(0);

  // The host is asked to admit the action as soon as the program starts: nothing is done yet.
  const first = evaluate(code, ledger, 0);
  assert.equal(first.opened.length, 1);
  const prepare = first.opened[0]!;
  assert.equal(prepare.verb, "prepare");
  assert.equal(prepare.holder, appHolder("x"));
  assert.equal(prepare.text, "post");
  assert.deepEqual(prepare.action, { app: "x", name: "post", input: { type: "record", fields: { account: text("@acme"), text: text("Hello") } }, prepared: null });
  assert.equal(prepare.context, "{account: @acme, text: Hello}");

  // Only the request's own token admits it.
  assert.equal(settle(ledger, prepare.id, prepare.holder, { tag: "Answered", value: variant("Prepared", text("request:forged")) }, 10), false);
  assert.equal(settle(ledger, prepare.id, "@mallory", { tag: "Answered", value: preparedAction(prepare) }, 10), false);
  assert.equal(settle(ledger, prepare.id, prepare.holder, { tag: "Answered", value: preparedAction(prepare) }, 10), true);

  // Admitted a day ahead: the program waits for its time, and nothing is asked of the host meanwhile.
  const waiting = evaluate(code, ledger, 10);
  assert.equal(waiting.opened.length, 0);
  assert.equal(waiting.nextDue, 10 + 86_400_000);
  assert.equal(open(ledger).length, 0);

  // At its time the perform request is opened: it names the prepare it does.
  const due = evaluate(code, ledger, 10 + 86_400_000);
  assert.equal(due.opened.length, 1);
  const perform = due.opened[0]!;
  assert.equal(perform.verb, "perform");
  assert.equal(perform.holder, appHolder("x"));
  assert.deepEqual(perform.action, { app: "x", name: "post", input: null, prepared: prepare.id });

  // Passes made while the host is at work ask nothing again.
  for (const at of [10 + 86_400_000, 10 + 86_400_001, 10 + 90_000_000]) assert.equal(evaluate(code, ledger, at).opened.length, 0);
  assert.equal(Object.keys(ledger.requests).length, 2);

  const answer = posted("42");
  assert.equal(mismatch(answer, manifestActionForm("x", MANIFESTS[0]!.actions![0]!)), null);
  assert.equal(settle(ledger, perform.id, perform.holder, { tag: "Answered", value: answer }, 10 + 90_000_000), true);
  const end = evaluate(code, ledger, 10 + 90_000_000);
  assert.equal(end.status, "completed");
  assert.deepEqual(end.result, text("https://x.com/i/status/42"));
  // A later pass over the ended program performs nothing.
  assert.equal(evaluate(code, ledger, 10 + 99_000_000).opened.length, 0);
  assert.equal(Object.keys(ledger.requests).length, 2);
});

test("a declined or failed action is a reply the program reads, and the host's requests are nobody's to delegate", () => {
  const { code } = build(`
switch X.prepare("@acme", "Hello")->wait {
| Answered(ready) =>
  switch X.publish(ready)->wait {
  | Answered(done) => done.url
  | Broke(why) => \`not posted: \${why}\`
  | _ => "not posted"
  }
| Refused(why) => \`declined: \${why}\`
| _ => "not admitted"
}
`);
  const declined = emptyLedger(0);
  const prepare = evaluate(code, declined, 0).opened[0]!;
  assert.equal(delegate(declined, prepare.id, prepare.holder, "@alice", 1), "The host performs an action; it is nobody's to delegate");
  assert.equal(settle(declined, prepare.id, prepare.holder, { tag: "Refused", reason: "An admin declined it" }, 1), true);
  assert.deepEqual(evaluate(code, declined, 1).result, text("declined: An admin declined it"));

  const failed = emptyLedger(0);
  const admitted = evaluate(code, failed, 0).opened[0]!;
  settle(failed, admitted.id, admitted.holder, { tag: "Answered", value: preparedAction(admitted) }, 1);
  const perform = evaluate(code, failed, 1).opened[0]!;
  assert.equal(settle(failed, perform.id, perform.holder, { tag: "Broke", reason: "The outcome is uncertain; it was not tried again" }, 2), true);
  assert.deepEqual(evaluate(code, failed, 2).result, text("not posted: The outcome is uncertain; it was not tried again"));
});

test("several actions are prepared together and each is performed in its turn", () => {
  const { code } = build(`
let slots = every(8h, ~from=2026-11-24T01:00Z)
let rec drain = requests =>
  switch requests {
  | [] => ()
  | [request, ...rest] =>
    switch request->wait {
    | Answered(ready) =>
      slots->wait
      ignore(X.publish(ready)->wait)
      drain(rest)
    | _ => drain(rest)
    }
  }
// A request is made where the program runs, never inside a pure callback such as List.map's.
let rec prepareAll = posts =>
  switch posts {
  | [] => []
  | [words, ...rest] => [X.prepare("@acme", words), ...prepareAll(rest)]
  }
drain(prepareAll(["one", "two", "three"]))
`);
  const start = Date.UTC(2026, 10, 23, 12), slot = Date.UTC(2026, 10, 24, 1), hours = 3_600_000;
  const ledger = emptyLedger(start);
  // Every admission is asked for at once, so one sitting answers them all.
  const prepares = evaluate(code, ledger, start).opened;
  assert.deepEqual(prepares.map(request => [request.verb, (request.action!.input as Extract<Value, { type: "record" }>).fields.text]),
    [["prepare", text("one")], ["prepare", text("two")], ["prepare", text("three")]]);
  settle(ledger, prepares[0]!.id, prepares[0]!.holder, { tag: "Answered", value: preparedAction(prepares[0]!) }, start + 1);
  settle(ledger, prepares[1]!.id, prepares[1]!.holder, { tag: "Refused", reason: "Not this one" }, start + 2);
  settle(ledger, prepares[2]!.id, prepares[2]!.holder, { tag: "Answered", value: preparedAction(prepares[2]!) }, start + 3);
  assert.equal(evaluate(code, ledger, start + 3).nextDue, slot);

  const performed: string[] = [];
  const perform = (at: number) => {
    const [request, ...more] = evaluate(code, ledger, at).opened;
    assert.equal(more.length, 0);
    assert.equal(request!.verb, "perform");
    performed.push(request!.action!.prepared!);
    settle(ledger, request!.id, request!.holder, { tag: "Answered", value: posted(String(performed.length)) }, at);
  };
  perform(slot);
  // The declined one takes no slot: the third goes out at the next one.
  assert.equal(evaluate(code, ledger, slot + 60_000).nextDue, slot + 8 * hours);
  perform(slot + 8 * hours);
  assert.equal(evaluate(code, ledger, slot + 8 * hours).status, "completed");
  assert.deepEqual(performed, [prepares[0]!.id, prepares[2]!.id]);
});

test("the checker reads an action against its connector manifest", () => {
  const check = (source: string) => checkSource(source, { host, std: null, manifests: MANIFESTS });
  const codes = (source: string) => check(source).diagnostics.filter(d => d.severity === "error").map(d => d.code);

  assert.deepEqual(codes(`let a = Actions.action("y", "post")\nignore(a)`), ["unknown-action"]);
  assert.deepEqual(codes(`let a = Actions.action("x", "pst")\nignore(a)`), ["unknown-action"]);
  // The input gives every required field and none the action does not declare; the answer reads declared fields only.
  assert.deepEqual(codes(`type post = {account: string}\ntype posted = {id: string}\nlet a: Actions.action<post, posted> = Actions.action("x", "post")\nignore(a)`),
    ["manifest-field-mismatch"]);
  assert.deepEqual(codes(`type post = {account: string, text: string, when: time}\ntype posted = {id: string}\nlet a: Actions.action<post, posted> = Actions.action("x", "post")\nignore(a)`),
    ["manifest-field-mismatch"]);
  assert.deepEqual(codes(`type post = {account: string, text: string}\ntype posted = {id: string, likes: int}\nlet a: Actions.action<post, posted> = Actions.action("x", "post")\nignore(a)`),
    ["manifest-field-mismatch"]);
  const fits = check(`type post = {account: string, text: string, video: option<string>}\ntype posted = {url: string}\nlet a: Actions.action<post, posted> = Actions.action("x", "post")\nignore(a)`);
  assert.equal(fits.ok, true, JSON.stringify(fits.diagnostics));
  const untyped = check(`let a: Actions.action<json, json> = Actions.action("x", "post")\nignore(a)`);
  assert.equal(untyped.ok, true, JSON.stringify(untyped.diagnostics));

  // What is prepared is what is performed: the input must be the action's, and only a prepared action is performed.
  assert.ok(codes(`type post = {account: string, text: string}\ntype posted = {id: string}
let a: Actions.action<post, posted> = Actions.action("x", "post")
Actions.prepare(a, {account: "@acme"})->wait`).length > 0);
  assert.ok(codes(`Actions.perform("request:1")->wait`).length > 0);
  // A request of the host is a request: it cannot be dropped, and it is no effect for a pure callback.
  assert.ok(codes(`type post = {account: string, text: string}\ntype posted = {id: string}
let a: Actions.action<post, posted> = Actions.action("x", "post")
Actions.prepare(a, {account: "@acme", text: "Hello"})`).length > 0);
  assert.ok(codes(`type post = {account: string, text: string}\ntype posted = {id: string}
let a: Actions.action<post, posted> = Actions.action("x", "post")
every(1d)->map(_ => Actions.prepare(a, {account: "@acme", text: "Hello"}))->forEach(_ => ())`).includes("impure-callback"));
});
