import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the browser entry runs Std and takes a program up from its ledger without Node imports or globals", () => {
  const std = readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8");
  const bootstrap = `
    import {parse} from "./src/frontend/parser.ts";
    import {compile, Team, text} from "./src/runtime/browser.ts";
    const code = compile(parse(${JSON.stringify('open Std\nremind(@alice, "Review", ~at=1h)')}).program, {std: parse(${JSON.stringify(std)}).program});
    let team = new Team(code);
    team.run(); team.advanceTo(3600000); team.run();
    team = new Team(code, {now: team.now, ledger: JSON.parse(JSON.stringify(team.ledger))});
    const [request] = team.open;
    team.reply(request.id, request.holder, {tag: "Answered", value: text("yes")});
    export const result = JSON.stringify({status: team.run().status, process: typeof process, Buffer: typeof Buffer, require: typeof require});
  `;
  const script = `
    import {readFileSync} from 'node:fs';
    import {SourceTextModule, createContext} from 'node:vm';
    import ts from 'typescript';
    const context = createContext({TextEncoder, structuredClone});
    const cache = new Map();
    function load(url) {
      if (!cache.has(url)) {
        const source = readFileSync(new URL(url), 'utf8');
        const output = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true}}).outputText;
        cache.set(url, new SourceTextModule(output, {context, identifier: url}));
      }
      return cache.get(url);
    }
    const bootstrap = new SourceTextModule(${JSON.stringify(bootstrap)},
      {context, identifier: new URL('./browser-test.ts', 'file://' + process.cwd() + '/').href});
    await bootstrap.link((specifier, parent) => {
      if (!specifier.startsWith('.')) throw new Error('Browser imported a host module: ' + specifier);
      return load(new URL(specifier, parent.identifier).href);
    });
    await bootstrap.evaluate();
    console.log(bootstrap.namespace.result);
  `;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), input: script, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {status: "completed", process: "undefined", Buffer: "undefined", require: "undefined"});
});
