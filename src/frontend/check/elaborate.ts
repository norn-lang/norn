/**
 * A runtime sees values, not types. `elaborate` writes the form of each
 * `run`'s report into a copy of the program as that call's `~form` argument,
 * so the request carries what its holder is asked to give back. Programs do
 * not write `~form` themselves: the checker refuses it as an unknown label.
 */
import type * as A from "../ast.ts";
import type { CheckResult } from "./infer.ts";

export function elaborate(program: A.Program, reports: CheckResult["reports"]): A.Program {
  const forms = new Map<object, string>(reports.map(({ node, form }) => [node, JSON.stringify(form)]));
  const copy = structuredClone(program);
  // The two trees are walked together, with a stack of their own: a program may be deeper than the call stack.
  const pending: [unknown, unknown][] = [[program, copy]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [original, twin] = pair;
    if (typeof original !== "object" || original === null) continue;
    const form = forms.get(original);
    if (form !== undefined) {
      const call = twin as A.Call | A.Pipe;
      call.args.push({ kind: "LabelledArg", label: "form", span: call.span, value: { kind: "StringLiteral", value: form, span: call.span } });
    }
    for (const [key, child] of Object.entries(original)) pending.push([child, (twin as Record<string, unknown>)[key]]);
  }
  return copy;
}
