import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Program } from "../../src/frontend/ast.ts";
import { parse } from "../../src/frontend/parser.ts";
import { compile, type Code } from "../../src/runtime/code.ts";
import type { Ledger, LedgerRequest, Pass, Reply } from "../../src/runtime/ledger.ts";
import { Team } from "../../src/runtime/team.ts";
import { text, type Value } from "../../src/runtime/value.ts";

export const HOUR = 3_600_000;
export function tree(contents: string): Program {
  const parsed = parse(contents);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.program;
}
export const source = (contents: string, std?: Program): Code => compile(tree(contents), { std });
/** A team whose program has run until it first waits or ends. */
export function started(program: string | Code, now = 0): { team: Team; pass: Pass } {
  const team = new Team(typeof program === "string" ? source(program) : program, { now });
  return { team, pass: team.run() };
}
export const answered = (value: Value): Reply => ({ tag: "Answered", value });
export const report = (body: string): Value => ({ type: "record", fields: { text: text(body) } });
export const stream = (name: string, ...args: Value[]): Value => ({ type: "source", kind: "stream", name, args, labels: {} });
export const fact = (name: string, args: Value[], labels: Record<string, Value> = {}): Value => ({ type: "source", kind: "fact", name, args, labels });
/** The open request made by `verb`, as it is now: a copy, so it can be used later as a stale offer. */
export function open(from: Team | Ledger, verb?: string): LedgerRequest {
  const ledger = from instanceof Team ? from.ledger : from;
  const found = Object.values(ledger.requests).filter(request => request.reply === null && (verb === undefined || request.verb === verb));
  assert.equal(found.length, 1, `Expected one open ${verb ?? "request"}: ${JSON.stringify(ledger.requests)}`);
  return { ...found[0] };
}
/** Replies as whoever held the request when `request` was read. */
export const reply = (team: Team, request: LedgerRequest, given: Reply): boolean => team.reply(request.id, request.holder, given);
/** A process restart: the ledger's JSON, written to disk and read back, is all that survives. */
export function restarted(team: Team, now = team.now): Team {
  const directory = mkdtempSync(join(tmpdir(), "norn-ledger-")), path = join(directory, "ledger.json");
  try {
    writeFileSync(path, JSON.stringify(team.ledger));
    return new Team(team.code, { now, ledger: JSON.parse(readFileSync(path, "utf8")) as Ledger });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
