import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource, readLibrary } from "../../../src/frontend/check/index.ts";
import { referenceOptions } from "../../../src/frontend/check/node.ts";
import { checkFacts } from "../../../src/runtime/facts.ts";

const options = referenceOptions();
// `report` is also the host's type of a run's report: a library's `report` must stay the library's.
const Users = readLibrary(`pub type tier = Active | Incubating
pub type report = {repo: string, tier: tier}
pub let cadence = (r: report) => switch r.tier {
| Active => "1d"
| Incubating => "3d"
}`, "Users", options.host!, { name: "Users" });
const withUsers = { ...options, libraries: { Users } };

test("a library's type keeps its own name when the host or another library has a type of that name", () => {
  assert.ok(Users.ok, JSON.stringify(Users.diagnostics));
  const program = checkSource(`let k: Holds.kind<Users.report> = Holds.kind("page", "Users.report")
let h = Holds.held(k, "page-1")
switch Holds.sample(h) {
| Some(r) => switch r.tier {
  | Active => say(@alice, \`\${r.repo} \${Users.cadence(r)}\`)
  | Incubating => ()
  }
| None => ()
}`, withUsers);
  assert.deepEqual(program.diagnostics, []);
  const facts = checkFacts(`{repo: "LambdaLabsHQ/x", tier: Active}`, "Users.report", withUsers);
  assert.ok(facts.ok, JSON.stringify(!facts.ok && facts.diagnostics));
});
