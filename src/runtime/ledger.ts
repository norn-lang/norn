// The ledger is the only durable state (spec §9, §11). A program keeps no
// snapshot: every pass evaluates it from the top against the ledger and
// reports which requests should exist now. Nothing here dispatches anything.
import type { Code } from "./code.ts";
import { advance, resume, start } from "./machine.ts";
import { projectOccurrence, type Json, type SourcePath } from "./persistence.ts";
import { eventKey } from "./runtime.ts";
import { sha256 } from "./sha256.ts";
import { equal, show, text, unit, variant, type Value } from "./value.ts";

export type Reply =
  | { tag: "Answered"; value: Value }
  | { tag: "Refused" | "Broke"; reason: string }
  | { tag: "NoReply" | "Cancelled" | "Revoked" };

export interface LedgerRequest {
  id: string;
  verb: string;
  holder: string;
  epoch: number;
  text: string;
  /** What `choose` offers; null for every other verb. */
  options: Value[] | null;
  by: number | null;
  openedAt: number;
  reply: Reply | null;
  settledAt: number | null;
  /** Open, and no longer reached by the program after an edit. Never cancelled implicitly. */
  detached: boolean;
}
/** Everything else a program consumed: when a wait began, how it ended, what was said, what a status read saw. */
export interface Entry { at: number; value: Json }
export interface Ledger {
  startedAt: number;
  requests: Record<string, LedgerRequest>;
  entries: Record<string, Entry>;
  /** Facts hold once and stay true. */
  facts: Record<string, { at: number; value: Value }>;
  /** Stream occurrences in the order the ledger recorded them; a wait takes the first one after its own beginning. */
  occurrences: { key: string; at: number; value: Value }[];
  /** Answers that settled nothing: late, from a former holder, or outside the request's form. */
  evidence: { request: string; holder: string; at: number; reply: Reply; reason: string }[];
}
export const emptyLedger = (startedAt = 0): Ledger => ({ startedAt, requests: {}, entries: {}, facts: {}, occurrences: [], evidence: [] });

export interface Pass {
  status: "waiting" | "completed" | "failed";
  result: Value | null;
  error: string | null;
  /** Requests this pass opened. */
  opened: LedgerRequest[];
  /** Open requests the program does not reach any more: the author decides, the runtime never guesses. */
  unreached: LedgerRequest[];
  /** Requests the program itself ended: `cancel`, or the program finished. */
  cancelled: string[];
  /** Requests whose deadline the program text moved. */
  rescheduled: { id: string; from: number | null; to: number | null }[];
  said: { to: string; text: string }[];
  /** The earliest time at which another pass could make progress with no new reply or fact. */
  nextDue: number | null;
}

const replyValue = (reply: Reply): Value =>
  reply.tag === "Answered" ? variant("Answered", reply.value)
    : reply.tag === "Refused" || reply.tag === "Broke" ? variant(reply.tag, text(reply.reason)) : variant(reply.tag);

function instant(value: Value | undefined, from: number): number | null {
  if (!value) return null;
  if (value.type === "time") return Number(value.value);
  if (value.type === "duration") return from + Number(value.value);
  throw new Error("A deadline needs a time or a duration");
}

/** The ledger's own clock closes requests whose `~by` has passed; no program does. */
export function settleDue(ledger: Ledger, now: number): void {
  for (const request of Object.values(ledger.requests)) {
    if (request.reply === null && request.by !== null && request.by <= now) {
      request.reply = { tag: "NoReply" }; request.settledAt = request.by;
    }
  }
}
/** The first valid answer from the current holder settles a request; anything else is kept as evidence. */
export function settle(ledger: Ledger, id: string, holder: string, reply: Reply, now: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request) return false;
  const reason = request.reply !== null ? "The request has already ended" : request.holder !== holder ? "Not the request's holder" : formError(request, reply);
  if (reason !== null) { ledger.evidence.push({ request: id, holder, at: now, reply, reason }); return false; }
  request.reply = reply; request.settledAt = now;
  return true;
}
function formError(request: LedgerRequest, reply: Reply): string | null {
  if (reply.tag === "NoReply") return "NoReply is decided only by the ledger's clock";
  if (reply.tag !== "Answered") return null;
  const answer = reply.value;
  switch (request.verb) {
    case "ask": return answer.type === "string" ? null : "The answer must be text";
    case "confirm": return answer.type === "variant" && ["Yes", "No"].includes(answer.name) && !answer.args.length ? null : "The answer must be Yes or No";
    case "choose": return request.options!.some(option => equal(option, answer)) ? null : "The answer is not one of the options";
    case "judge": return answer.type === "bool" ? null : "A judgement must be true or false";
    default: return answer.type === "record" && answer.fields.text?.type === "string" ? null : "A report must be a record with text";
  }
}
export function establish(ledger: Ledger, fact: Value, value: Value, now: number): void {
  if (fact.type !== "source" || fact.kind !== "fact") throw new Error("establish needs a fact");
  ledger.facts[eventKey(fact)] ??= { at: now, value };
}
export function occur(ledger: Ledger, stream: Value, value: Value, now: number): void {
  if (stream.type !== "source" || stream.kind !== "stream") throw new Error("occur needs a stream");
  ledger.occurrences.push({ key: eventKey(stream), at: now, value });
}

/** At one instant a request's own deadline comes first, then the wait's, then any other reply or occurrence. */
interface Candidate { at: number; value: Value; rank: 0 | 1 | 2 }

/**
 * One pass. With `commit: false` the ledger is left untouched and the result is
 * the difference the pass would make: the preview shown before an edit applies.
 */
export function evaluate(code: Code, source: Ledger, now: number, options: { commit: boolean; steps?: number } = { commit: true }): Pass {
  const ledger = options.commit ? source : structuredClone(source);
  settleDue(ledger, now);
  const pass: Pass = { status: "waiting", result: null, error: null, opened: [], unreached: [], cancelled: [], rescheduled: [], said: [], nextDue: null };
  const seen = new Map<string, number>();
  // Identity: what is asked of whom, counted in evaluation order among identical contents.
  const identity = (kind: string, content: unknown): string => {
    const digest = sha256(eventKey(content as Value)).slice(0, 16);
    const ordinal = (seen.get(kind + digest) ?? 0) + 1;
    seen.set(kind + digest, ordinal);
    return `${kind}:${digest}#${ordinal}`;
  };
  const entry = (key: string, make: () => Entry): Entry => ledger.entries[key] ??= make();
  const reached = new Set<string>();
  const due = (at: number): void => { if (at > now && (pass.nextDue === null || at < pass.nextDue)) pass.nextDue = at; };
  const machine = start(code, ledger.startedAt);

  // A pass that never reaches a wait is a bug in the program; it fails in the open instead of spinning.
  let slices = Math.ceil((options.steps ?? 5_000_000) / 10_000);
  for (;;) {
    if (slices-- <= 0) { pass.status = "failed"; pass.error = "The program computed for too long without waiting or finishing"; break; }
    advance(code, machine, 10_000);
    const control = machine.control;
    if (control.kind === "done") { pass.status = "completed"; pass.result = control.value; break; }
    if (control.kind === "error") { pass.status = "failed"; pass.error = control.message; break; }
    if (control.kind === "failed") { pass.status = "failed"; pass.result = control.outcome; break; }
    if (control.kind === "report") {
      const at = entry(identity("report", control.outcome), () => ({ at: now, value: control.outcome as unknown as Json })).at;
      resume(machine, unit, at); continue;
    }
    if (control.kind !== "effect") continue; // The slice ran out; keep evaluating.
    const { name, args, labels } = control.effect;

    if (["ask", "confirm", "choose", "run", "judge"].includes(name)) {
      const holder = name === "judge" ? "@judge" : show(args[0]);
      const question = name === "judge" ? args[0] : args[1];
      const { by: _by, ...kept } = labels;
      const id = identity("request", { name, holder, args: args.slice(name === "judge" ? 0 : 1), labels: kept });
      reached.add(id);
      let request = ledger.requests[id];
      if (!request) {
        request = ledger.requests[id] = {
          id, verb: name, holder, epoch: 0, text: question.type === "string" ? question.value : show(question),
          options: name === "choose" && args[2]?.type === "list" ? args[2].values : null,
          by: instant(labels.by, now), openedAt: now, reply: null, settledAt: null, detached: false,
        };
        pass.opened.push(request);
      } else if (request.reply === null) {
        // The deadline is not part of who is asked what: moving it amends the same request.
        const by = instant(labels.by, request.openedAt);
        if (by !== request.by) { pass.rescheduled.push({ id, from: request.by, to: by }); request.by = by; }
        request.detached = false;
      }
      resume(machine, { type: "request", id }, request.openedAt); continue;
    }

    if (name === "wait" || name === "waitUntil") {
      const key = identity("wait", { target: args[0], until: args[1] ?? null });
      const beginning = entry(`${key}/began`, () => ({ at: now, value: ledger.occurrences.length }));
      const began = beginning.at, cursor = beginning.value as number;
      let ended = ledger.entries[key];
      if (!ended) {
        const candidates: Candidate[] = [];
        const pending: { source: Value; path: SourcePath }[] = [{ source: args[0], path: [] }];
        while (pending.length) {
          const { source: target, path } = pending.pop()!;
          const occurred = (at: number, value: Value, rank: 0 | 2 = 2): void => {
            if (at <= now) candidates.push({ at, value: projectOccurrence(value as unknown as Json, path) as unknown as Value, rank });
            else due(at);
          };
          if (target.type === "request") {
            const request = ledger.requests[target.id];
            if (request?.reply) occurred(request.settledAt!, replyValue(request.reply), request.reply.tag === "NoReply" ? 0 : 2);
            else if (request?.by != null) due(request.by);
          } else if (target.type !== "source") throw new Error("wait needs a request, a fact or a stream");
          else if (target.name === "or") pending.push({ source: target.args[1], path: [...path, "Second"] }, { source: target.args[0], path: [...path, "First"] });
          else if (target.name === "after" || target.name === "every") {
            const at = instant(target.args[0], began)!;
            occurred(at, { type: "time", value: String(at) });
          } else if (target.kind === "fact") {
            const fact = ledger.facts[eventKey(target)];
            if (fact) occurred(Math.max(fact.at, began), fact.value); // A fact may already hold.
          } else if (target.name !== "never") {
            const key = eventKey(target);
            const next = ledger.occurrences.find((occurrence, index) => index >= cursor && occurrence.key === key);
            if (next) occurred(next.at, next.value);
          }
        }
        const limit = name === "waitUntil" ? instant(args[1], began)! : null;
        if (limit !== null) { if (limit <= now) candidates.push({ at: limit, value: unit, rank: 1 }); else due(limit); }
        candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
        const winner = candidates[0];
        if (!winner) break; // Nothing has happened yet: this is all "waiting" means.
        const value = name === "waitUntil" ? (winner.rank === 1 ? variant("None") : variant("Some", winner.value)) : winner.value;
        ended = ledger.entries[key] = { at: winner.at, value: value as unknown as Json };
      }
      resume(machine, ended.value as unknown as Value, Math.max(ended.at, began)); continue;
    }

    const handle = args[0]?.type === "request" ? ledger.requests[args[0].id] : undefined;
    if (name === "say") {
      const to = show(args[0]), body = args[1].type === "string" ? args[1].value : show(args[1]);
      const key = identity("say", { to, body });
      if (!ledger.entries[key]) pass.said.push({ to, text: body });
      resume(machine, unit, entry(key, () => ({ at: now, value: null })).at); continue;
    }
    if (!handle) throw new Error(`${name} needs a request of this program`);
    if (name === "status") {
      const read = entry(identity("status", { id: handle.id }), () => ({ at: now, value: (handle.reply ? variant("Some", replyValue(handle.reply)) : variant("None")) as unknown as Json }));
      resume(machine, read.value as unknown as Value, read.at); continue;
    }
    if (name === "cancel" || name === "handOver") {
      const next = name === "handOver" ? show(args[1]) : null;
      const key = identity(name, { id: handle.id, next });
      if (!ledger.entries[key] && handle.reply === null) {
        if (next === null) { handle.reply = { tag: "Cancelled" }; handle.settledAt = now; pass.cancelled.push(handle.id); }
        else { handle.holder = next; handle.epoch++; }
      }
      const at = entry(key, () => ({ at: now, value: null })).at;
      resume(machine, next === null ? unit : { type: "request", id: handle.id }, at); continue;
    }
    throw new Error(`The ledger prototype does not implement ${name}`);
  }

  for (const request of Object.values(ledger.requests)) {
    if (request.reply !== null) continue;
    if (pass.status !== "waiting") { request.reply = { tag: "Cancelled" }; request.settledAt = now; pass.cancelled.push(request.id); }
    else if (!reached.has(request.id)) { request.detached = true; pass.unreached.push(request); }
  }
  return pass;
}
