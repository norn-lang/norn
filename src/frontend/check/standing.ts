/**
 * Standing policies (spec §7): how a participant says ahead of time what
 * becomes of a kind of request asked of them.
 *
 * A policy is a program that binds `policy` to a pure function from what the
 * request is about to a `standing<'a>`:
 *
 * ```norn
 * let policy = r =>
 *   if r.secret == "staging-key" { AnswerWith(Yes) } else { Mine }
 * ```
 *
 * A host names each kind of request it lets a policy decide by two types: what
 * such a request is about (`asked`, a record the policy reads) and what
 * answers it. `checkStandingPolicy` checks a policy's text against them.
 */
import type * as A from "../ast.ts";
import type { CheckOptions } from "./infer.ts";
import { checkSource, type SourceCheck } from "./source.ts";

/** A kind of request a standing policy may decide. */
export interface StandingKind {
  /** What such a request is about, as a record type: `{secret: string, conversation: string}`. The policy sees it as `asked`. */
  asked: string;
  /** What answers such a request, as a type: `yesno`. */
  answer: string;
}

/**
 * The policy's text as the program a host checks and compiles: its value is
 * the `policy` function at the kind's types. The policy's own lines come
 * first and unchanged, so every diagnostic in them keeps its place.
 */
export function standingPolicySource(policy: string, kind: StandingKind): string {
  return `${policy}\nlet standing__: (asked) => standing<${kind.answer}> = policy\nstanding__\ntype asked = ${kind.asked}\n`;
}

/**
 * Checks a standing policy against a kind. Beyond its types, a policy binds
 * `policy` and has no effect: it asks nobody, says nothing and waits for
 * nothing, so it decides the same request the same way every time.
 */
export function checkStandingPolicy(policy: string, kind: StandingKind, options: CheckOptions): SourceCheck {
  const own = checkSource(policy, options);
  if (own.program === null) return own;
  const end: A.Span = { start: own.program.span.end, end: own.program.span.end };
  if (!own.bindings.some((binding) => binding.name === "policy")) {
    return { ...own, ok: false, diagnostics: [...own.diagnostics.filter((d) => d.severity === "error"), {
      severity: "error", code: "standing-policy", span: end,
      message: "a standing policy binds `policy` to its function, as in `let policy = r => Mine`",
    }] };
  }
  const checked = checkSource(standingPolicySource(policy, kind), options);
  if (checked.ok && checked.effects !== null && checked.effects.length > 0) {
    return { ...checked, ok: false, effects: null, diagnostics: [...checked.diagnostics, {
      severity: "error", code: "standing-policy", span: end,
      message: `a standing policy has no effect, and this one may ${checked.effects.map((effect) => effect.family).join(", ")}; to have someone else decide, answer Delegate(participant)`,
    }] };
  }
  return checked;
}
