import assert from "node:assert/strict";
import { test } from "node:test";
import { elaborate } from "../../../src/frontend/check/index.ts";
import { check, describe, message, types } from "./helpers.ts";

const verdict = `type verdict = Sound | Flawed(string)\n`;

function reports(source: string) {
  const result = check(source);
  assert.deepEqual(result.diagnostics, [], describe(result.diagnostics));
  return result.reports.map(({ form }) => form);
}

test("a run reports the type the program uses its report as", () => {
  const [form] = reports(`${verdict}switch run(@codex, "Review")->wait {
| Answered(Sound) => ()
| Answered(Flawed(why)) => say(@claude, why)
| other => fail(other)
}`);
  assert.equal(form!.text, "verdict");
  assert.deepEqual(form!.form, { kind: "named", name: "verdict" });
  assert.deepEqual(form!.definitions.verdict, {
    kind: "variant",
    constructors: [{ name: "Sound", args: [] }, { name: "Flawed", args: [{ kind: "base", name: "string" }] }],
  });
});

test("where nothing decides it, a run reports the host's report, and so does run passed as a value", () => {
  assert.deepEqual(reports(`run(@auto, "Task")->wait`).map((form) => form.text), ["report"]);
  assert.deepEqual(types(`let start = run\nlet r = start(@auto, "Task")\nignore(r->wait)`).r, "request<report>");
});

test("one call has one form: a function's callers agree on what its run reports", () => {
  const helper = `${verdict}let review = who => run(who, "Review")->wait\n`;
  assert.deepEqual(reports(`${helper}switch review(@codex) { | Answered(Sound) => () | _ => () }`).map((form) => form.text), ["verdict"]);
  assert.match(
    message(`${helper}switch review(@codex) { | Answered(Sound) => () | _ => () }\nswitch review(@grok) { | Answered("ok") => () | _ => () }`, "type-mismatch"),
    /verdict/,
  );
});

test("a report is data: lists, tuples, records and the host's own types, never a function or a request", () => {
  const [form] = reports(`type finding = {file: string, lines: list<int>}
switch run(@codex, "Audit")->wait {
| Answered(([first, ..._], Some(pr))) =>
  say(@claude, first.file)
  ignore(released(Beta, ~containing=pr)->wait)
| _ => ()
}`);
  assert.equal(form!.text, "(list<finding>, option<pr>)");
  assert.deepEqual(form!.definitions.pr, { kind: "host" });
  assert.deepEqual(form!.definitions.finding, {
    kind: "record",
    fields: [{ name: "file", form: { kind: "base", name: "string" } }, { name: "lines", form: { kind: "list", element: { kind: "base", name: "int" } } }],
  });
  assert.match(message(`switch run(@codex, "Audit")->wait { | Answered(f) => ignore(f(1)) | _ => () }`, "report-form"), /holds a function/);
  // A part the program never looks at is left to the holder.
  assert.deepEqual(reports(`switch run(@codex, "List them")->wait { | Answered([]) => () | _ => () }`)[0]!.form, { kind: "list", element: { kind: "any" } });
});

test("~about takes any value on every request to a participant; ~form is not for programs to write", () => {
  reports(`let pr = merged("acme/api#1")->wait
ignore(ask(@a, "Why?", ~about=pr)->wait)
ignore(confirm(@a, "Ship?", ~about=pr)->wait)
ignore(run(@a, "Verify", ~about=pr)->wait)`);
  assert.match(message(`ignore(run(@a, "x", ~form="y")->wait)`, "unknown-label"), /no labelled argument ~form/);
});

test("elaborate writes each run's form into a copy of the program", () => {
  const source = `${verdict}let v = run(@codex, "Review")->wait\nswitch v { | Answered(Sound) => () | _ => () }`;
  const result = check(source);
  const program = result.program!;
  const before = JSON.stringify(program);
  const elaborated = JSON.stringify(elaborate(program, result.reports));
  assert.equal(JSON.stringify(program), before);
  assert.match(elaborated, /"label":"form"/);
  assert.match(elaborated, /Flawed/);
});
