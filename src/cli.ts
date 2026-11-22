#!/usr/bin/env node
/**
 * The `norn` command line. Run it with `npm run norn -- <command>` or
 * `node src/cli.ts <command>`; `npm link` puts `norn` on the PATH.
 */
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import {
  STACK_EXHAUSTED, astToJson, fixSource, formatDiagnostic, formatSource, isStackExhausted, parse, treeLines, type Diagnostic,
} from "./frontend/index.ts";
import { checkSource, elaborate, hostSources, readInterface, type CheckDiagnostic, type EffectSummary } from "./frontend/check/index.ts";
import { referenceHostPath, standardLibrary } from "./frontend/check/node.ts";
import { compile } from "./runtime/code.ts";
import { previewEdit, type Ledger } from "./runtime/ledger.ts";

const usage = `Usage: norn <command> [options]

Commands:
  parse [--json] <file>     Print the syntax tree of a .norn file as an outline, or as
                            norn-ast JSON on one line ('-' reads standard input)
  check [--host <file>] [--json] <path>...
                            Parse and type-check .norn files, and the .norn files under
                            directories ('-' reads standard input). Programs see the
                            host interface file given with --host, by default
                            hosts/reference.norn; that file itself is checked as an
                            interface. --json prints one JSON document with each
                            file's diagnostics and effects summary.
  preview [--host <file>] [--now <ms|iso>] [--json] --ledger <ledger.json> <before.norn> <after.norn>
                            Compare old and new program texts against a ledger without
                            modifying it, reporting kept, opened, unreached, rescheduled,
                            form-changed, incompatible-answer, and loop differences.
  fmt [--check] [--write] <file>...
                            Format .norn files canonically ('-' reads standard input)
  fix [--dry-run] [--migrate] [--host <file>] [--ledger <ledger.json>] <file>
                            Apply high-confidence mechanical fixes (and with --ledger,
                            verify empty ledger preview diff before modifying)
  help                      Show this help

Exit status: 0 without errors (warnings allowed), 1 if a file has errors,
2 on a usage or read error.
`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(usage);
        return 0;
      case "parse":
        return await parseCommand(args);
      case "check":
        return await checkCommand(args);
      case "preview":
        return await previewCommand(args);
      case "fmt":
        return await fmtCommand(args);
      case "fix":
        return await fixCommand(args);
      default:
        throw new UsageError(`unknown command '${command}'\n\n${usage}`);
    }
  } catch (error) {
    if (isStackExhausted(error)) {
      process.stderr.write(`norn: ${STACK_EXHAUSTED}\n`);
      return 1;
    }
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`norn: ${error.message.endsWith("\n") ? error.message : `${error.message}\n`}`);
    return 2;
  }
}

async function parseCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const files = args.filter((arg) => arg !== "--json");
  const option = files.find((arg) => arg.startsWith("-") && arg !== "-");
  if (option !== undefined) throw new UsageError(`unknown option '${option}' for parse`);
  const [file] = files;
  if (file === undefined || files.length > 1) throw new UsageError("parse takes exactly one file");
  const source = await read(file);
  const result = parse(source);
  if (!result.ok) {
    report(result.diagnostics, source, displayName(file));
    return 1;
  }
  if (json) {
    process.stdout.write(`${astToJson(result.program)}\n`);
  } else {
    // Written in pieces: the outline of a very deep tree is too large to hold as one string.
    let chunk = "";
    for (const line of treeLines(result.program)) {
      chunk += `${line}\n`;
      if (chunk.length >= 1 << 16) {
        process.stdout.write(chunk);
        chunk = "";
      }
    }
    process.stdout.write(chunk);
  }
  return 0;
}

interface CheckedFile {
  file: string;
  ok: boolean;
  /** A host interface file, checked as one. */
  interface: boolean;
  diagnostics: CheckDiagnostic[];
  effects: EffectSummary[] | null;
}

async function checkCommand(args: string[]): Promise<number> {
  let json = false;
  let hostOption: string | null = null;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? args[++index] : arg.slice("--host=".length);
      if (value === undefined || value === "") throw new UsageError("--host needs an interface file, as in --host hosts/reference.norn");
      if (hostOption !== null) throw new UsageError("--host is given twice");
      hostOption = value;
    } else if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option '${arg}' for check`);
    else paths.push(arg);
  }
  if (paths.length === 0) throw new UsageError("check needs at least one file or directory");

  const hostPath = hostOption ?? referenceHostPath();
  const hostName = hostOption ?? relativeName(hostPath);
  const hostSource = await read(hostPath);
  const host = readInterface(hostSource, hostName);
  const files = paths.flatMap(expand);
  const results: CheckedFile[] = [];
  const sources = new Map<string, string>();
  if (host.ok) {
    const hostReal = realPath(hostPath);
    const std = standardLibrary(host);
    for (const file of files) {
      const source = await read(file);
      const name = displayName(file);
      sources.set(name, source);
      if (file !== "-" && realPath(file) === hostReal) {
        results.push({ file: name, ok: true, interface: true, diagnostics: [...host.diagnostics], effects: null });
        continue;
      }
      const result = checkSource(source, { host, std });
      results.push({ file: name, ok: result.ok, interface: false, diagnostics: result.diagnostics, effects: result.effects });
    }
  }
  if (json) {
    const document = {
      host: { file: hostName, ok: host.ok, diagnostics: host.diagnostics.map(jsonDiagnostic) },
      files: results.map((result) => ({
        file: result.file,
        ok: result.ok,
        ...(result.interface ? { interface: true } : {}),
        diagnostics: result.diagnostics.map(jsonDiagnostic),
        effects: result.effects,
      })),
    };
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    if (!host.ok) report(host.diagnostics, hostSource, hostName);
    for (const result of results) {
      report(result.diagnostics, sources.get(result.file) ?? "", result.file);
      if (result.ok) process.stdout.write(`${result.file}: ok${result.interface ? " (host interface)" : ""}\n`);
    }
  }
  return !host.ok || results.some((result) => !result.ok) ? 1 : 0;
}

async function previewCommand(args: string[]): Promise<number> {
  let json = false;
  let hostOption: string | null = null;
  let ledgerOption: string | null = null;
  let nowOption: string | null = null;
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? args[++index] : arg.slice("--host=".length);
      if (!value) throw new UsageError("--host needs an interface file");
      hostOption = value;
    } else if (arg === "--ledger" || arg.startsWith("--ledger=")) {
      const value = arg === "--ledger" ? args[++index] : arg.slice("--ledger=".length);
      if (!value) throw new UsageError("--ledger needs a ledger JSON file");
      ledgerOption = value;
    } else if (arg === "--now" || arg.startsWith("--now=")) {
      const value = arg === "--now" ? args[++index] : arg.slice("--now=".length);
      if (!value) throw new UsageError("--now needs epoch milliseconds or an ISO-8601 timestamp");
      nowOption = value;
    } else if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option '${arg}' for preview`);
    else files.push(arg);
  }
  if (!ledgerOption || files.length !== 2) {
    throw new UsageError("preview needs --ledger <ledger.json> <before.norn> <after.norn>");
  }
  const now = nowOption === null ? Date.now()
    : /^\d+$/u.test(nowOption) ? Number(nowOption)
    : Date.parse(nowOption);
  if (!Number.isSafeInteger(now) || now < 0) throw new UsageError(`invalid --now value '${nowOption}'`);

  const hostPath = hostOption ?? referenceHostPath();
  const hostName = hostOption ?? relativeName(hostPath);
  const hostSource = await read(hostPath);
  const host = readInterface(hostSource, hostName);
  if (!host.ok) { report(host.diagnostics, hostSource, hostName); return 1; }
  const std = standardLibrary(host);
  const sources = hostSources(host);

  const [beforeSource, afterSource, ledgerText] = await Promise.all([read(files[0]!), read(files[1]!), read(ledgerOption)]);
  let ledger: Ledger;
  try { ledger = JSON.parse(ledgerText) as Ledger; } catch (error) {
    throw new UsageError(`cannot parse ledger JSON ${ledgerOption}: ${describeError(error)}`);
  }
  const beforeChecked = checkSource(beforeSource, { host, std });
  const afterChecked = checkSource(afterSource, { host, std });
  if (!beforeChecked.ok || !beforeChecked.program) { report(beforeChecked.diagnostics, beforeSource, displayName(files[0]!)); return 1; }
  if (!afterChecked.ok || !afterChecked.program) { report(afterChecked.diagnostics, afterSource, displayName(files[1]!)); return 1; }

  const beforeCode = compile(elaborate(beforeChecked.program, beforeChecked.reports), { std: std.program, sources });
  const afterCode = compile(elaborate(afterChecked.program, afterChecked.reports), { std: std.program, sources });
  const preview = previewEdit(beforeCode, afterCode, ledger, now);

  if (json) {
    process.stdout.write(`${JSON.stringify({
      empty: preview.empty,
      kept: preview.kept.map(r => ({ id: r.id, holder: r.holder, text: r.text })),
      opened: preview.opened.map(r => ({ id: r.id, holder: r.holder, text: r.text })),
      unreached: preview.unreached.map(r => ({ id: r.id, holder: r.holder, text: r.text })),
      answeredUnused: preview.answeredUnused.map(r => ({ id: r.id, holder: r.holder, text: r.text })),
      rescheduled: preview.rescheduled,
      formChanged: preview.formChanged.map(c => ({ id: c.id, from: c.from?.text ?? null, to: c.to?.text ?? null })),
      incompatibleAnswers: preview.incompatibleAnswers.map(c => ({ id: c.id, reason: c.reason, form: c.form?.text ?? null })),
      loops: preview.loops,
      nextDue: preview.nextDue,
    })}\n`);
  } else {
    const lines = [
      `preview: ${preview.empty ? "empty difference" : "changes detected"}`,
      `  requests: ${preview.kept.length} kept, ${preview.opened.length} to open, ${preview.unreached.length} unreached, ${preview.answeredUnused.length} answered-unused`,
      ...(preview.rescheduled.length ? [`  rescheduled: ${preview.rescheduled.length}`] : []),
      ...(preview.formChanged.length ? [`  form changed: ${preview.formChanged.length}`] : []),
      ...(preview.incompatibleAnswers.length ? [`  incompatible answers: ${preview.incompatibleAnswers.length}`] : []),
      ...preview.loops.map(l => `  loop ${l.key}: ${l.status} (${l.sealedRounds} sealed rounds, nextDue ${l.beforeNextDue ?? "none"} -> ${l.afterNextDue ?? "none"})`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return 0;
}

/** A diagnostic as `norn check --json` prints it: severity, code, message, span, then expected, found or missing where they apply. */
function jsonDiagnostic(diagnostic: CheckDiagnostic): object {
  const { severity, code, message, span, expected, found, missing } = diagnostic;
  return {
    severity,
    code,
    message,
    span,
    ...(expected === undefined ? {} : { expected }),
    ...(found === undefined ? {} : { found }),
    ...(missing === undefined ? {} : { missing }),
  };
}

function relativeName(path: string): string {
  const name = relative(process.cwd(), path);
  return name.startsWith("..") ? path : name;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function report(diagnostics: readonly Diagnostic[], source: string, file: string): void {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${formatDiagnostic(diagnostic, source, file)}\n\n`);
  }
}

function displayName(file: string): string {
  return file === "-" ? "<stdin>" : file;
}

/** A file, or standard input for '-'. Standard input is read as a stream: a pipe may not be readable at once. */
async function read(file: string): Promise<string> {
  try {
    if (file !== "-") return readFileSync(file, "utf8");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${describeError(error)}`);
  }
}

/** A file stays itself; a directory becomes the .norn files under it, sorted. */
function expand(path: string): string[] {
  if (path === "-") return [path];
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${describeError(error)}`);
  }
  if (!isDirectory) return [path];
  const files: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".norn")) files.push(child);
    }
  };
  walk(path);
  if (files.length === 0) throw new UsageError(`no .norn files under ${path}`);
  return files;
}

function describeError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return "no such file or directory";
  if (code === "EISDIR") return "it is a directory";
  return error instanceof Error ? error.message : String(error);
}

async function fmtCommand(args: string[]): Promise<number> {
  let check = false;
  let write = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg === "--check") check = true;
    else if (arg === "--write") write = true;
    else if (arg.startsWith("-") && arg !== "-") throw new UsageError(`unknown option '${arg}' for fmt`);
    else files.push(arg);
  }
  if (files.length === 0) throw new UsageError("fmt takes at least one file (or '-')");
  let status = 0;
  for (const file of files) {
    const source = await read(file);
    const formatted = formatSource(source);
    if (!formatted.ok) {
      report(formatted.diagnostics, source, displayName(file));
      status = 1;
      continue;
    }
    if (check) {
      if (formatted.text !== source) {
        process.stderr.write(`${displayName(file)}: not formatted\n`);
        status = 1;
      }
    } else if (write && file !== "-") {
      if (formatted.text !== source) writeFileSync(file, formatted.text, "utf8");
    } else {
      process.stdout.write(formatted.text);
    }
  }
  return status;
}

async function fixCommand(args: string[]): Promise<number> {
  let dryRun = false;
  let migrate = false;
  let hostOption: string | null = null;
  let ledgerPath: string | null = null;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--migrate") migrate = true;
    else if (arg === "--host" || arg.startsWith("--host=")) {
      hostOption = arg === "--host" ? (args[++i] ?? null) : arg.slice("--host=".length);
    } else if (arg === "--ledger" || arg.startsWith("--ledger=")) {
      ledgerPath = arg === "--ledger" ? (args[++i] ?? null) : arg.slice("--ledger=".length);
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown option '${arg}' for fix`);
    } else {
      files.push(arg);
    }
  }
  if (files.length !== 1) throw new UsageError("fix takes exactly one file");
  const file = files[0]!;
  const hostPath = hostOption ?? referenceHostPath();
  const hostSource = await read(hostPath);
  const host = readInterface(hostSource, displayName(hostPath));
  if (!host.ok) {
    report(host.diagnostics, hostSource, displayName(hostPath));
    return 1;
  }
  const std = standardLibrary(host);
  const ledger = ledgerPath ? JSON.parse(await read(ledgerPath)) as Ledger : undefined;
  const source = await read(file);
  const result = fixSource(source, { host, std, migrate, ledger });
  if (result.rejectedReason) {
    process.stderr.write(`norn: ${result.rejectedReason}\n`);
    return 1;
  }
  if (dryRun || file === "-") {
    process.stdout.write(result.source);
  } else if (result.changed) {
    writeFileSync(file, result.source, "utf8");
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
