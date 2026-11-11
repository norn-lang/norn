import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportForm } from "../../src/frontend/check/index.ts";
import { mismatch } from "../../src/runtime/form.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";

const verdict: ReportForm = {
  text: "verdict",
  form: { kind: "named", name: "verdict" },
  definitions: { verdict: { kind: "variant", constructors: [{ name: "Sound", args: [] }, { name: "Flawed", args: [{ kind: "base", name: "string" }] }] } },
};

test("a report fits its form or is refused with what does not fit", () => {
  assert.equal(mismatch(variant("Sound"), verdict), null);
  assert.equal(mismatch(variant("Flawed", text("no owner on failure")), verdict), null);
  assert.equal(mismatch(variant("Approved"), verdict), "expected one of Sound, Flawed");
  assert.equal(mismatch(variant("Flawed"), verdict), "Flawed takes 1 value");
  assert.equal(mismatch(variant("Flawed", { type: "int", value: "3" }), verdict), "expected string, found int");
  assert.equal(mismatch(text("looks fine"), verdict), "expected one of Sound, Flawed");
});

test("records, lists, tuples and host types", () => {
  const audit: ReportForm = {
    text: "(list<finding>, pr)",
    form: { kind: "tuple", elements: [{ kind: "list", element: { kind: "named", name: "finding" } }, { kind: "named", name: "pr" }] },
    definitions: { finding: { kind: "record", fields: [{ name: "file", form: { kind: "base", name: "string" } }] }, pr: { kind: "host" } },
  };
  const finding = (fields: Record<string, Value>): Value => ({ type: "record", fields });
  const report = (findings: Value[]): Value => ({ type: "tuple", values: [{ type: "list", values: findings }, text("whatever the host made")] });
  assert.equal(mismatch(report([finding({ file: text("a.ts") })]), audit), null);
  assert.equal(mismatch(report([finding({ path: text("a.ts") })]), audit), "finding needs the field file");
  assert.equal(mismatch(report([finding({ file: text("a.ts"), line: text("1") })]), audit), "expected the fields of finding: file");
});
