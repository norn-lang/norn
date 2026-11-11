import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { astToJson } from "../../src/frontend/json.ts";
import { checkSource } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { compile, compileAstJson } from "../../src/runtime/code.ts";
import { text, type Value } from "../../src/runtime/value.ts";
import { HOUR, answered, open, reply, started, stream, tree } from "./helpers.ts";

const std = tree(readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8"));
const linked = (contents: string) => compile(tree(contents), { std });

test("open Std executes the same remind that passed type checking", () => {
  const checked = checkSource('open Std\nremind(@alice, "Review this", ~at=1h)', referenceOptions());
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  const { team } = started(compile(checked.program!, { std }));
  assert.deepEqual(team.ledger.requests, {});
  team.advanceTo(HOUR); team.run();
  const request = open(team);
  assert.equal(request.holder, "@alice");
  reply(team, request, answered(text("reviewed")));
  assert.equal(team.run().status, "completed");
});

test("Std followUp times out and transfers one request without changing its identity", () => {
  const { team } = started(linked('open Std\nfollowUp(@codex, "Progress?", ~within=1h, ~escalateTo=@alice)'));
  const first = open(team);
  team.advanceTo(HOUR); team.run();
  const next = open(team);
  assert.deepEqual([next.id, next.epoch, next.holder], [first.id, 1, "@alice"]);
  assert.equal(reply(team, first, answered(text("obsolete"))), false);
  reply(team, next, answered(text("current")));
  assert.equal(team.run().status, "completed");
});

test("Std functions have private lexical bindings and repeated open restores the exports", () => {
  const { team, pass } = started(linked(`
    let __norn_Std = 0
    let ask = (who, question) => Answered("wrong ask")
    open Std
    let remind = (who, question, ~at) => Answered("wrong remind")
    open Std
    remind(@alice, "Real ask", ~at=1h)
  `));
  assert.equal(pass.status, "waiting");
  team.advanceTo(HOUR); team.run();
  assert.equal(open(team).verb, "ask");
});

test("a library is linked into the code compiled with it: another library text is another program", () => {
  const program = tree('open Std\nafter(1h)->wait\nhelper()');
  const results = ["1", "2"].map(value => {
    const code = compile(program, { std: tree(`let helper = () => ${value}`) });
    const { team } = started(code);
    team.advanceTo(HOUR);
    return { id: code.id, result: team.run().result };
  });
  assert.notEqual(results[0].id, results[1].id);
  assert.deepEqual(results.map(run => run.result), [{ type: "int", value: "1" }, { type: "int", value: "2" }]);
});

test("unopened code retains its exact hash and trailing opens preserve the final value", () => {
  const plain = tree('"中文🙂"'), code = compile(plain, { std });
  assert.equal(code.ast, astToJson(plain));
  assert.equal(code.id, `sha256:${createHash("sha256").update(astToJson(plain)).digest("hex")}`);
  assert.deepEqual(started(linked('42\nopen Std')).pass.result, { type: "int", value: "42" });
  assert.throws(() => compile(tree('open Std\nremind')), /pinned library AST/);
  assert.throws(() => compileAstJson(astToJson(tree('open Std\nremind'))), /unlinked/);
});

test("generic choose options remain checked at runtime and message payloads use body", () => {
  for (const options of ["[]", "[1]", "[Ship, 1]"]) {
    const { team, pass } = started(`let helper = options => choose(@alice, "Choose", options)\nhelper(${options})->wait`);
    assert.deepEqual([pass.status, pass.error], ["failed", "choose options must be a nonempty list of constructors"], options);
    assert.deepEqual(team.ledger.requests, {});
  }
  const { team } = started('message(channel"ops")->wait->show');
  const participant: Value = { type: "participant", name: "alice", instance: null, labels: {} };
  team.emit(stream("message", { type: "ref", kind: "channel", value: "ops" }), { type: "record", fields: { from: participant, body: text("hello") } });
  assert.deepEqual(team.run().result, text("{from: @alice, body: hello}"));
});
