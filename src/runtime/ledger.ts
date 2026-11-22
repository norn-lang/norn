// The ledger is the only durable state (spec §9, §11). A program keeps no
// snapshot: every pass evaluates it from the top against the ledger and
// reports which requests should exist now. Nothing here dispatches anything.
import type { ReportForm } from "../frontend/check/forms.ts";
import type { Code } from "./code.ts";
import { mismatch } from "./form.ts";
import { advance, resume, resumeThrough, runPure, start, type Effect, type Through } from "./machine.ts";
import { sha256 } from "./sha256.ts";
import { equal, eventKey, show, text, unit, variant, type Json, type Value } from "./value.ts";

export type Reply =
  | { tag: "Answered"; value: Value }
  | { tag: "Refused" | "Broke"; reason: string }
  | { tag: "NoReply" | "Cancelled" | "Revoked" };

export interface LedgerRequest {
  id: string;
  /**
   * Scoped pass-lookup address (identityScheme 2). Separate from the immutable
   * opaque `id` so renames via `moves` and legacy migrations never break
   * external references, cards, or holder epochs. Absent on legacy v1 requests,
   * where `id` itself serves as the lookup address.
   */
  address?: string;
  verb: string;
  holder: string;
  /** For a request offered to a group with `anyOf`: who may take it. Null once taken, and for a request to one participant. */
  candidates: string[] | null;
  /**
   * Who may never hold the request: the `~except` of the group it was offered
   * to. It stays after one of the group takes the request, and the holder
   * cannot delegate the request to anyone it names. A ledger written before
   * delegation existed lacks it, which means nobody.
   */
  excluded: string[];
  /**
   * While the request is delegated (spec §7): the holder who delegated it,
   * whom it goes back to when the delegate refuses it or cannot do it, and
   * who can take it back. Once the delegate has answered it still names on
   * whose behalf they answered. Null, or missing in a ledger written before
   * delegation existed, when nobody has delegated the request.
   */
  delegatedBy: string | null;
  epoch: number;
  text: string;
  /**
   * What the program asked of whoever takes the request, beyond their name: the
   * participant's own labels, as in `@auto(~repo="acme/app")`, each as a message
   * shows it. A host reads them when it chooses or starts the participant.
   */
  conditions: Record<string, string>;
  /** What the request is about (`~about`), as a message shows it; null when the program named nothing. */
  about: string | null;
  /** What a `run` was given to work from (`~context`), as a message shows it. */
  context: string | null;
  /** What `choose` offers; null for every other verb. */
  options: Value[] | null;
  /** What a `run` must report, when the checker decided it (docs/types.md §5a); null means the host's report. */
  form: ReportForm | null;
  by: number | null;
  openedAt: number;
  reply: Reply | null;
  settledAt: number | null;
  /** Open, and no longer reached by the program after an edit. Never cancelled implicitly. */
  detached: boolean;
}
/** Everything else a program consumed: when a wait began, how it ended, what was said, what a status read saw. */
export interface Entry { at: number; value: Json }
/** An explicit address rebinding recorded so a renamed scope or request keeps its immutable `id`. */
export interface MovedAddress { from: string; to: string; at: number }
export interface Ledger {
  /**
   * Identity scheme version:
   * - absent or `1`: legacy positional/stream-hash scheme (kept readable for unmigrated ledgers)
   * - `2`: three-layer scoped identity (`~key` + occurrence-keyed rounds + sealed rounds + `form` out of identity)
   */
  identityScheme?: 1 | 2;
  startedAt: number;
  requests: Record<string, LedgerRequest>;
  entries: Record<string, Entry>;
  /** Facts hold once and stay true. */
  facts: Record<string, { at: number; value: Value }>;
  /** Stream occurrences in the order the ledger recorded them; a wait takes the first one after its own beginning. */
  occurrences: { key: string; at: number; value: Value }[];
  /** Answers that settled nothing: late, from a former holder, or outside the request's form. */
  evidence: { request: string; holder: string; at: number; reply: Reply; reason: string }[];
  /** Every change of holder a participant made, in order; a ledger written before delegation existed lacks it. */
  delegations: Delegation[];
  /** Explicit address rebindings so renamed loops or requests continue existing ledger entries. */
  moves?: MovedAddress[];
  /** The program's result, recorded once with the cancellation of what it left open. A later pass returns it and evaluates nothing. */
  ended: { at: number; status: "completed" | "failed"; result: Value | null; error: string | null } | null;
}
/**
 * A change of holder made by a participant, not by the program (spec §7): the
 * holder delegated the request, the delegate gave it back by refusing it or
 * reporting that they could not do it, or the one who delegated it took it
 * back. The program never sees one.
 */
export interface Delegation {
  request: string;
  at: number;
  kind: "delegated" | "returned" | "reclaimed";
  from: string;
  to: string;
  /** In the participant's words: why they delegated it, or why the delegate gave it back. */
  reason: string | null;
  /** For a request given back: the delegate's refusal or report that they could not do it. */
  reply?: Extract<Reply, { tag: "Refused" | "Broke" }>;
}
export const emptyLedger = (startedAt = 0, options: { identityScheme?: 1 | 2 } = {}): Ledger => ({
  identityScheme: options.identityScheme ?? 2,
  startedAt, requests: {}, entries: {}, facts: {}, occurrences: [], evidence: [], delegations: [], ended: null,
});

/** Records an explicit address move so a renamed loop or request continues its existing ledger entry. */
export function recordMove(ledger: Ledger, from: string, to: string, at: number): void {
  if (!from || !to || from === to) throw new Error("A move requires two distinct non-empty addresses");
  (ledger.moves ??= []).push({ from, to, at });
}

type Source = Extract<Value, { type: "source" }>;
/** The `First`/`Second` constructors an `or` puts around a value, outermost first. */
type Path = ("First" | "Second")[];
/** One pure transformation or predicate step on a stream occurrence, innermost first. */
type StreamOp = { kind: "map" | "filter" | "filterMap"; fn: Value } | { kind: "wrap"; side: "First" | "Second" };
/** One thing a wait is for. */
export type Target =
  | { kind: "request"; id: string }
  | { kind: "fact" | "stream"; source: Source; path: Path; /** A stream taken with all that has arrived: `gather`. */ gathered?: true }
  | { kind: "timer"; at: number; path: Path };
interface DetailedTarget {
  target: Target;
  ops: StreamOp[];
  /** Present on `every` timers so filtered ticks can step forward cleanly. */
  timer?: { period: number; anchor: number; kind: "every" | "after" };
}
export interface Waiting { targets: Target[]; until: number | null }

/** Summary of one standing loop observed during a pass (identityScheme 2). */
export interface LoopSummary {
  key: string;
  sealedRounds: number;
  activeRound: string | null;
  nextDue: number | null;
}

/** What a pass did that the ledger did not hold yet. */
export type Step =
  /** The request as it was opened. */
  | { kind: "opened"; request: LedgerRequest }
  | { kind: "handedOver"; id: string; from: string; to: string }
  /** A request ended by something other than its holder: `cancel`, the program's end, lost authority, or a `~by` already past. */
  | { kind: "closed"; id: string; reply: Reply }
  | { kind: "said"; to: string; text: string }
  | ({ kind: "waiting" } & Waiting)
  /** A wait ended at `at`, with `value`; null when its own deadline came first. */
  | ({ kind: "waited"; at: number; value: Value | null } & Waiting)
  /** A `forEach` handler ended with a reply other than `Answered`: the author is told and the duty goes on. */
  | { kind: "handlerFailed"; reply: Value };

export interface Pass {
  status: "waiting" | "completed" | "failed";
  result: Value | null;
  error: string | null;
  /** Everything new, in the order the program reached it. The lists below are views of it. */
  log: Step[];
  /** Requests this pass opened. */
  opened: LedgerRequest[];
  /** Open requests the program does not reach any more: the author decides, the runtime never guesses. */
  unreached: LedgerRequest[];
  /** Requests the program itself ended: `cancel`, or the program finished. */
  cancelled: string[];
  /** Requests whose deadline the program text moved. */
  rescheduled: { id: string; from: number | null; to: number | null }[];
  /** Open requests whose report form the program text changed. */
  formChanged: { id: string; from: ReportForm | null; to: ReportForm | null }[];
  /** Answered requests whose recorded answer no longer fits the edited program's form. */
  incompatibleAnswers: { id: string; reason: string; form: ReportForm | null }[];
  /** All request IDs (open or answered) reached by this pass. */
  reached: string[];
  /** Loops observed during this pass (identityScheme 2). */
  loops: LoopSummary[];
  said: { to: string; text: string }[];
  /** The wait the pass stopped at. */
  waiting: Waiting | null;
  /**
   * The host's streams the program's loops take occurrences from, whether a
   * loop waits now or its handler is at work: an occurrence recorded on one of
   * them is not lost, the loop takes it when the handler has finished.
   */
  listening: Source[];
  /** The earliest time at which another pass could make progress with no new reply or fact. */
  nextDue: number | null;
}
export interface PassOptions {
  /** False gives the preview of spec §11.2: the ledger is left untouched. */
  commit?: boolean;
  /** How long a pass may compute without reaching a wait. */
  steps?: number;
  /**
   * The author's current authority for an effect the ledger does not hold yet
   * (spec §10). Without it, a waited request ends `Revoked` and anything else
   * ends the program `Revoked`. Left out, the host vouches for the whole pass.
   */
  authorize?: (effect: Effect) => boolean;
}

/** The program's own mistake, found at an effect: it ends the program as a program failure and is never a reply. */
class ProgramError extends Error {}

const VERBS = ["ask", "confirm", "choose", "run", "judge"];
const LABELS: Record<string, string[]> = {
  ask: ["by", "about"], confirm: ["by", "about"], choose: ["by", "about"], run: ["context", "by", "about", "form"], judge: ["about"],
  wait: [], waitUntil: [], cancel: [], handOver: [], status: [], say: [], first: [],
};

const replyValue = (reply: Reply): Value =>
  reply.tag === "Answered" ? variant("Answered", reply.value)
    : reply.tag === "Refused" || reply.tag === "Broke" ? variant(reply.tag, text(reply.reason)) : variant(reply.tag);

function instant(value: Value | undefined, from: number): number | null {
  if (!value) return null;
  if (value.type !== "time" && value.type !== "duration") throw new ProgramError("A deadline needs a time or a duration");
  const at = Number(value.value) + (value.type === "duration" ? from : 0);
  if (!Number.isSafeInteger(at) || at < 0) throw new ProgramError("A deadline lies outside the clock's range");
  return at;
}
function participant(value: Value | undefined): string {
  if (value?.type !== "participant") throw new ProgramError("Expected a participant");
  return show(value);
}
function external(source: Value, kind: "fact" | "stream", verb: string): string {
  if (source.type !== "source" || source.kind !== kind || COMPOSED.includes(source.name)) {
    throw new Error(`${verb} needs a ${kind} of the host, not a timer or a composition`);
  }
  return eventKey(source);
}

/** The ledger's own clock closes requests whose `~by` has passed; no program does. Returns the requests it closed. */
export function settleDue(ledger: Ledger, now: number): LedgerRequest[] {
  const closed: LedgerRequest[] = [];
  for (const request of Object.values(ledger.requests)) {
    if (request.reply === null && request.by !== null && request.by <= now) {
      request.reply = { tag: "NoReply" }; request.settledAt = request.by; closed.push(request);
    }
  }
  return closed;
}
/**
 * The first valid answer from the current holder settles a request; anything
 * else is kept as evidence. A delegate's refusal, or their report that they
 * could not do it, settles nothing either: the request goes back to whoever
 * delegated it, because only the participant the program asked can refuse it
 * or fail it (spec §4.1). True only when the request has ended.
 *
 * `epoch` is the one the answer was given under. A host passes it so that an
 * answer from an earlier holding does not count after the request has come
 * back to the same participant.
 */
export function settle(ledger: Ledger, id: string, holder: string, reply: Reply, now: number, epoch?: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request) return false;
  // An answer from one of a group takes the request for them in the same step.
  if (request.reply === null && request.candidates?.includes(holder) && (epoch === undefined || epoch === request.epoch) && formError(request, reply) === null) {
    take(ledger, id, holder, now);
    epoch = request.epoch;
  }
  const reason = request.reply !== null ? "The request has already ended"
    : request.holder !== holder || (epoch !== undefined && epoch !== request.epoch) ? "Not the request's holder" : formError(request, reply);
  if (reason !== null) { ledger.evidence.push({ request: id, holder, at: now, reply, reason }); return false; }
  const delegator = request.delegatedBy ?? null;
  if (delegator !== null && (reply.tag === "Refused" || reply.tag === "Broke")) {
    (ledger.delegations ??= []).push({ request: id, at: now, kind: "returned", from: holder, to: delegator, reason: reply.reason, reply });
    request.holder = delegator; request.delegatedBy = null; request.epoch++;
    return false;
  }
  request.reply = reply; request.settledAt = now;
  return true;
}

/** A participant as a program writes one, `@alice` or `@codex:2`: the only kind of delegate. */
const ONE_PARTICIPANT = /^@[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*(?::[0-9]+)?$/u;
/** Whether `excluded` leaves out `who`: the same participant, or any instance of an agent named without one. */
function excludes(excluded: string, who: string): boolean {
  return excluded === who || (!excluded.includes(":") && who.startsWith(`${excluded}:`));
}

/**
 * The holder delegates the request: `to` holds it and answers it for them
 * (spec §7). It stays the same request, with the same `~by` and form, under a
 * new epoch, and the program does not see the change. Returns null once it is
 * delegated, or else why it cannot be, and then nothing changes.
 *
 * `epoch`, when given, is the holding `from` acts under, as for `settle`. A
 * host admits a delegation only when the program's author may ask `to` and
 * `to` may see the request (spec §10); this function cannot know either.
 */
export function delegate(ledger: Ledger, id: string, from: string, to: string, now: number, options: { epoch?: number; reason?: string } = {}): string | null {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  const refusal = !request ? "No such request"
    : request.reply !== null ? "The request has already ended"
    : request.verb === "judge" ? "Only the host's judge decides a judgement"
    : request.candidates?.length ? "Nobody of the group has taken the request yet"
    : request.holder !== from || (options.epoch !== undefined && options.epoch !== request.epoch) ? "Not the request's holder"
    : (request.delegatedBy ?? null) !== null ? "A delegate answers the request or gives it back; they cannot delegate it again"
    : !ONE_PARTICIPANT.test(to) || to === "@judge" ? "A request is delegated to one participant, as in @alice or @codex:2"
    : to === from ? "The holder already holds the request"
    : (request.excluded ?? []).some(excluded => excludes(excluded, to)) ? `The request leaves out ${to}`
    : null;
  if (refusal !== null) return refusal;
  (ledger.delegations ??= []).push({ request: id, at: now, kind: "delegated", from, to, reason: options.reason ?? null });
  request.holder = to; request.delegatedBy = from; request.epoch++;
  return null;
}

/**
 * Whoever delegated the request takes it back while it is open, and holds it
 * again under a new epoch: an answer the delegate gives afterwards is
 * evidence. Returns null once it is back, or else why it cannot be.
 */
export function reclaim(ledger: Ledger, id: string, by: string, now: number): string | null {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  const refusal = !request ? "No such request"
    : request.reply !== null ? "The request has already ended"
    : (request.delegatedBy ?? null) !== by ? `${by} has not delegated the request`
    : null;
  if (refusal !== null) return refusal;
  (ledger.delegations ??= []).push({ request: id, at: now, kind: "reclaimed", from: request.holder, to: by, reason: null });
  request.holder = by; request.delegatedBy = null; request.epoch++;
  return null;
}
function runFormError(answer: Value, form: ReportForm | null): string | null {
  if (form === null) return answer.type === "record" && answer.fields.text?.type === "string" ? null : "A report must be a record with text";
  return mismatch(answer, form) === null ? null : `The report must be ${form.text}: ${mismatch(answer, form)}`;
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
    default: return runFormError(answer, request.form);
  }
}
/** One of a group takes a request offered with `anyOf`: from then on it has exactly that holder. False when someone else has it. */
export function take(ledger: Ledger, id: string, taker: string, now: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request || request.reply !== null || !request.candidates?.includes(taker)) return false;
  request.holder = taker; request.candidates = null; request.epoch++;
  return true;
}
function conditionsOf(who: Value | undefined): Record<string, string> {
  if (who?.type !== "participant" || who.name === "anyOf") return {};
  return Object.fromEntries(Object.entries(who.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, value]) => [label, show(value)]));
}
/** Who a group leaves out with `~except`: nobody may hold the request, by taking it or by delegation. */
function excludedOf(who: Value | undefined): string[] {
  return who?.type === "participant" && who.name === "anyOf" && who.labels.except ? [show(who.labels.except)] : [];
}
function candidatesOf(who: Value): string[] | null {
  if (who.type !== "participant" || who.name !== "anyOf") return null;
  const except = who.labels.except ? show(who.labels.except) : null;
  const group = (who.labels.of as Extract<Value, { type: "list" | "tuple" }>).values.map(show).filter(name => name !== except);
  if (!group.length) throw new ProgramError("anyOf leaves nobody to take the request");
  return [...new Set(group)];
}
/**
 * Whoever may stop the program stops it from outside: what it left open is
 * cancelled and it ends failed, in one step. Returns the requests it closed;
 * a program that has already ended keeps its result.
 */
export function stop(ledger: Ledger, now: number, reason: string): LedgerRequest[] {
  if (ledger.ended) return [];
  settleDue(ledger, now);
  const closed = Object.values(ledger.requests).filter(request => request.reply === null);
  for (const request of closed) { request.reply = { tag: "Cancelled" }; request.settledAt = now; }
  ledger.ended = { at: now, status: "failed", result: null, error: reason };
  return closed;
}
export function establish(ledger: Ledger, fact: Value, value: Value, now: number): void {
  ledger.facts[external(fact, "fact", "establish")] ??= { at: now, value };
}
export function occur(ledger: Ledger, stream: Value, value: Value, now: number): void {
  ledger.occurrences.push({ key: external(stream, "stream", "occur"), at: now, value });
}

/** Streams the language makes from others, or from the clock: nothing occurs on one of these by a host's word. */
const COMPOSED = ["or", "never", "after", "every", "map", "filter", "filterMap", "gather"];
/** The host's streams under a stream a program composed, in the order `or` gives them. */
function hostStreams(stream: Value): Source[] {
  if (stream.type !== "source" || stream.kind !== "stream") return [];
  if (stream.name === "or" || stream.name === "map" || stream.name === "filter" || stream.name === "filterMap" || stream.name === "gather") {
    return stream.args.flatMap(hostStreams);
  }
  return COMPOSED.includes(stream.name) ? [] : [stream];
}

/**
 * Strips pure functions (`map`/`filter`/`filterMap`) and `or` operand order
 * from a source descriptor so wait identity never depends on closure AST
 * positions or operand ordering.
 */
function stripSourceFunctions(value: Value): unknown {
  if (value.type !== "source") return value;
  if (value.name === "map" || value.name === "filter" || value.name === "filterMap") {
    return stripSourceFunctions(value.args[0]);
  }
  if (value.name === "or") {
    const parts = [stripSourceFunctions(value.args[0]), stripSourceFunctions(value.args[1])];
    const keys = parts.map(part => eventKey(part as Value)).sort();
    return { type: "source", kind: value.kind, name: "or", parts: keys };
  }
  if (value.name === "gather") return { type: "source", kind: value.kind, name: "gather", of: stripSourceFunctions(value.args[0]) };
  return value;
}

/** What a wait is for, with `or` flattened left to right and each leaf's pure stream ops preserved innermost-first. */
function detailedTargetsOf(ledger: Ledger, waited: Value, began: number): DetailedTarget[] {
  const results: DetailedTarget[] = [];
  const pending: { source: Value; path: Path; ops: StreamOp[]; gathered?: true }[] = [{ source: waited, path: [], ops: [] }];
  while (pending.length) {
    const { source, path, ops, gathered } = pending.pop()!;
    if (source.type === "request") {
      if (!ledger.requests[source.id]) throw new ProgramError("wait needs a request of this program");
      results.push({ target: { kind: "request", id: source.id }, ops });
    } else if (source.type !== "source") throw new ProgramError("wait needs a request, a fact or a stream");
    else if (source.name === "or") {
      pending.push(
        { source: source.args[1], path: [...path, "Second"], ops: [{ kind: "wrap", side: "Second" }, ...ops] },
        { source: source.args[0], path: [...path, "First"], ops: [{ kind: "wrap", side: "First" }, ...ops] },
      );
    } else if (source.name === "map" || source.name === "filter" || source.name === "filterMap") {
      pending.push({ source: source.args[0], path, ops: [{ kind: source.name, fn: source.args[1] }, ...ops], gathered });
    } else if (source.name === "gather") {
      const [of] = source.args;
      if (of?.type !== "source" || of.kind !== "stream" || COMPOSED.includes(of.name)) throw new ProgramError("gather takes a stream of the host, as in ciFailed(\"acme/api\")->gather");
      pending.push({ source: of, path, ops, gathered: true });
    } else if (source.name === "after" || source.name === "every") {
      const { from, ...unknown } = source.labels;
      if (source.args.length !== 1 || Object.keys(unknown).length || (from && (source.name !== "every" || from.type !== "time"))) {
        throw new ProgramError("A timer needs one positional argument; every also takes ~from, a time");
      }
      const when = source.args[0];
      if (!(source.name === "after" && when.type === "time") && (when.type !== "duration" || BigInt(when.value) <= 0n)) throw new ProgramError("A relative timer needs a positive duration");
      const period = source.name === "every" ? Number(when.value) : 0;
      const anchor = from ? Number(from.value) : ledger.startedAt;
      const at = period <= 0 ? instant(when, began)! : began < anchor ? anchor : anchor + (Math.floor((began - anchor) / period) + 1) * period;
      if (!Number.isSafeInteger(at)) throw new ProgramError("A deadline lies outside the clock's range");
      results.push({ target: { kind: "timer", at, path }, ops, timer: { period, anchor, kind: source.name } });
    } else if (source.name !== "never") {
      results.push({ target: { kind: source.kind, source, path, ...(gathered ? { gathered } : {}) }, ops });
    }
  }
  return results;
}

/** Canonical description of a stream's timer schedule, independent of `or` operand order and pure functions. */
function timerSpecOf(detailed: DetailedTarget[]): string {
  const parts = detailed
    .filter(item => item.timer !== undefined)
    .map(item => item.timer!.kind === "every"
      ? `every(${item.timer!.period},${item.timer!.anchor})`
      : `after(${item.target.kind === "timer" ? item.target.at : 0})`)
    .sort();
  return parts.join("|");
}

function hasFilterOp(detailed: DetailedTarget[]): boolean {
  return detailed.some(item => item.ops.some(op => op.kind === "filter" || op.kind === "filterMap"));
}

/** Applies a leaf target's pure `map`/`filter`/`filterMap`/`wrap` pipeline. Returns null when filtered out. */
function applyOps(code: Code, machine: ReturnType<typeof start>, rawValue: Value, ops: StreamOp[], now: number): Value | null {
  let current = rawValue;
  for (const op of ops) {
    if (op.kind === "wrap") {
      current = variant(op.side, current);
    } else if (op.kind === "map") {
      try { current = runPure(code, op.fn, current, machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
    } else if (op.kind === "filter") {
      let verdict: Value;
      try { verdict = runPure(code, op.fn, current, machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
      if (verdict.type !== "bool") throw new ProgramError("filter predicate must return a bool");
      if (!verdict.value) return null;
    } else if (op.kind === "filterMap") {
      let mapped: Value;
      try { mapped = runPure(code, op.fn, current, machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
      if (mapped.type !== "variant" || (mapped.name !== "None" && (mapped.name !== "Some" || mapped.args.length !== 1))) {
        throw new ProgramError("filterMap function must return Some(value) or None");
      }
      if (mapped.name === "None") return null;
      current = mapped.args[0];
    }
  }
  return current;
}

/**
 * The functions `map` put on the way from the stream that occurred to what a
 * wait on `waited` gives, innermost first, with the constructors `or` and
 * `waitUntil` put around the value between them. Null: no function is on the
 * way, and the wait gives the recorded value as it stands.
 */
function through(waited: Value, given: Value, name: string): { value: Value; steps: Through[] } | null {
  const steps: Through[] = [];
  const outer: Through[] = [];
  let source = waited, value = given;
  if (name === "waitUntil") {
    if (value.type !== "variant" || value.name !== "Some") return null;
    value = value.args[0]; outer.push({ wrap: "Some" });
  }
  while (source.type === "source" && (source.name === "or" || source.name === "map")) {
    if (source.name === "map") { outer.unshift({ fn: source.args[1] }); source = source.args[0]; continue; }
    if (value.type !== "variant") break;
    outer.unshift({ wrap: value.name });
    source = source.args[value.name === "First" ? 0 : 1]; value = value.args[0];
  }
  steps.push(...outer);
  return steps.some(step => "fn" in step) ? { value, steps } : null;
}

/** At one instant a request's own deadline comes first, then the wait's, then any other reply or occurrence. */
interface Candidate {
  at: number; value: Value; rank: 0 | 1 | 2;
  /** The stream it came from, and how far that stream is then taken. */
  taken?: { stream: string; next: number };
  /** Occurrence-keyed round identifier (identityScheme 2). */
  roundKey?: string;
  /** Timer instant consumed by this occurrence (identityScheme 2). */
  timerAt?: number;
  /** True when `applyOps` already ran on `value` (so `through` must not run again). */
  evaluated?: true;
}
/** Legacy v1 loop cursor. */
interface Taken { from: number; streams: Record<string, number> }
/** Scoped v2 loop checkpoint persisted under `loop:<key>`. */
interface LoopState {
  startedAt: number;
  from: number;
  streams: Record<string, number>;
  lastTimerAt: number | null;
  timerSpec: string | null;
  waitingLogged?: boolean;
  sealedRounds: number;
  sealedTimerInstants: number[];
  active: {
    roundKey: string;
    at: number;
    value: Value;
    streamTaken?: { stream: string; next: number };
    timerAt?: number;
  } | null;
}

/** Resolves an address through explicit `moved` entries (including scope prefix moves inside `kind:<scope>/...` keys). */
function resolveAddress(address: string, moves: readonly MovedAddress[] | undefined): string {
  if (!moves?.length) return address;
  const kindPrefix = /^(?:request|wait|say|status|cancel|handOver|first|report):/u.exec(address)?.[0] ?? "";
  let current = kindPrefix ? address.slice(kindPrefix.length) : address;
  const visited = new Set<string>([current]);
  for (;;) {
    let changed = false;
    for (const move of moves) {
      if (current === move.from) {
        current = move.to;
        changed = true;
      } else if (current.startsWith(`${move.from}/`)) {
        current = `${move.to}${current.slice(move.from.length)}`;
        changed = true;
      }
      if (changed) {
        if (visited.has(current)) return kindPrefix + current;
        visited.add(current);
        break;
      }
    }
    if (!changed) return kindPrefix + current;
  }
}

/**
 * One pass, yielding between slices of pure computation so a host can give
 * other work a turn. The ledger is read when the pass starts and written only
 * when it finishes, so it must not change in between; a pass that throws or is
 * abandoned leaves it as it was.
 */
export function* slices(code: Code, source: Ledger, now: number, options: PassOptions = {}): Generator<undefined, Pass> {
  const pass: Pass = {
    status: "waiting", result: null, error: null, log: [], opened: [], unreached: [], cancelled: [],
    rescheduled: [], formChanged: [], incompatibleAnswers: [], reached: [], loops: [], said: [],
    waiting: null, listening: [], nextDue: null,
  };
  if (source.ended) return { ...pass, status: source.ended.status, result: source.ended.result, error: source.ended.error };
  const ledger = structuredClone(source), log = pass.log;
  const v2 = (ledger.identityScheme ?? 1) === 2;
  settleDue(ledger, now);

  // Scoped counters (v2) or flat counters (v1).
  const scopeStack: string[] = [];
  const activeLoopStack: { storageKey: string; displayKey: string }[] = [];
  const currentScope = (): string => scopeStack.at(-1) ?? "root";
  const scopeSeen = new Map<string, Map<string, number>>();
  const loopsUsedInScope = new Map<string, Set<string>>();
  const seenIn = (scope: string): Map<string, number> => {
    let map = scopeSeen.get(scope);
    if (!map) { map = new Map(); scopeSeen.set(scope, map); }
    return map;
  };
  // Legacy flat counter map for v1 ledgers.
  const seen = seenIn("root");

  // Address lookup table for v2: maps resolved address -> LedgerRequest, preserving immutable `id`.
  const byAddress = new Map<string, LedgerRequest>();
  if (v2) {
    for (const request of Object.values(ledger.requests)) {
      const addr = resolveAddress(request.address ?? request.id, ledger.moves);
      byAddress.set(addr, request);
    }
  }
  const resolveEntryKey = (targetKey: string): string => {
    if (!v2 || !ledger.moves?.length || ledger.entries[targetKey]) return targetKey;
    for (const existingKey of Object.keys(ledger.entries)) {
      if (resolveAddress(existingKey, ledger.moves) === targetKey) return existingKey;
    }
    return targetKey;
  };

  // Identity: what is asked of whom, counted in evaluation order within the current scope.
  const identity = (kind: string, content: unknown): string => {
    const digest = sha256(eventKey(content as Value)).slice(0, 16);
    if (!v2) {
      const ordinal = (seen.get(kind + digest) ?? 0) + 1;
      seen.set(kind + digest, ordinal);
      return `${kind}:${digest}#${ordinal}`;
    }
    const scope = currentScope();
    const map = seenIn(scope);
    const ordinal = (map.get(kind + digest) ?? 0) + 1;
    map.set(kind + digest, ordinal);
    return scope === "root" ? `${kind}:${digest}#${ordinal}` : `${kind}:${scope}/${digest}#${ordinal}`;
  };
  const entry = (key: string, make: () => Entry): Entry => ledger.entries[key] ??= make();
  const reached = new Set<string>();
  const due = (at: number): void => { if (at > now && (pass.nextDue === null || at < pass.nextDue)) pass.nextDue = at; };
  const end = (status: "completed" | "failed", result: Value | null, error: string | null): null => {
    pass.status = status; pass.result = result; pass.error = error;
    return null;
  };
  const close = (request: LedgerRequest, reply: Reply, at: number): void => {
    request.reply = reply; request.settledAt = at; log.push({ kind: "closed", id: request.id, reply });
  };
  const handle = (name: string, value: Value | undefined): LedgerRequest => {
    const request = value?.type === "request" ? ledger.requests[value.id] : undefined;
    if (!request) throw new ProgramError(`${name} needs a request of this program`);
    return request;
  };
  const nextUniqueRequestId = (address: string): string => {
    const base = `request:${sha256(address).slice(0, 16)}`;
    if (!ledger.requests[base]) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`;
      if (!ledger.requests[candidate]) return candidate;
    }
  };

  const machine = start(code, ledger.startedAt);
  let lastWaitEvaluated = false;

  /** Answers one effect from the ledger, recording it first when it is new. Null: the pass stops here, waiting or ended. */
  const answer = (effect: Effect): { value: Value; at: number } | null => {
    lastWaitEvaluated = false;
    const { name, args, labels } = effect;
    for (const label of Object.keys(labels)) if (!LABELS[name]?.includes(label)) throw new ProgramError(`Unknown ${name} label ${label}`);
    // Authority is asked only for what the ledger does not hold yet: what is recorded has happened.
    const permitted = (): boolean => options.authorize?.(effect) ?? true;
    const revoked = (): null => end("failed", variant("Revoked"), null);

    if (VERBS.includes(name)) {
      const holder = name === "judge" ? "@judge" : participant(args[0]);
      const question = name === "judge" ? args[0] : args[1];
      if (args.length !== (name === "judge" ? 1 : name === "choose" ? 3 : 2) || question?.type !== "string") {
        throw new ProgramError(name === "judge" ? "judge needs a condition string" : `${name} needs a participant and text${name === "choose" ? ", and its options" : ""}`);
      }
      const choices = name === "choose" ? args[2] : null;
      if (choices && (choices.type !== "list" || !choices.values.length || choices.values.some(v => v.type !== "variant"))) {
        throw new ProgramError("choose options must be a nonempty list of constructors");
      }
      const nextForm = labels.form?.type === "string" ? JSON.parse(labels.form.value) as ReportForm : null;
      const { by: _by, form: _form, ...keptV2 } = labels;
      const { by: _by1, ...keptV1 } = labels;
      const kept = v2 ? keptV2 : keptV1;
      // The participant's own arguments count: @auto(~repo="a") and @auto(~repo="b") are asked different things.
      const address = identity("request", { name, who: name === "judge" ? null : args[0], args: args.slice(name === "judge" ? 0 : 1), labels: kept });
      const resolvedAddress = v2 ? resolveAddress(address, ledger.moves) : address;
      let request = v2 ? byAddress.get(resolvedAddress) : ledger.requests[address];

      // In v2, if an answered `run` no longer fits the edited program's new form, surface it visibly and ask anew under a reform address.
      if (v2 && request && request.reply?.tag === "Answered" && request.verb === "run") {
        const incompatibility = runFormError(request.reply.value, nextForm);
        if (incompatibility !== null) {
          pass.incompatibleAnswers.push({ id: request.id, reason: incompatibility, form: nextForm });
          const reformAddress = `${resolvedAddress}/reform:${sha256(JSON.stringify(nextForm)).slice(0, 8)}`;
          request = byAddress.get(reformAddress);
          if (!request) {
            if (!permitted()) return revoked();
            const id = nextUniqueRequestId(reformAddress);
            request = ledger.requests[id] = {
              id, address: reformAddress, verb: name, holder, candidates: name === "judge" ? null : candidatesOf(args[0]),
              excluded: name === "judge" ? [] : excludedOf(args[0]), delegatedBy: null, epoch: 0, text: question.value,
              conditions: conditionsOf(args[0]),
              about: labels.about ? show(labels.about) : null, context: labels.context ? show(labels.context) : null,
              options: choices?.type === "list" ? choices.values : null,
              form: nextForm,
              by: instant(labels.by, now), openedAt: now, reply: null, settledAt: null, detached: false,
            };
            byAddress.set(reformAddress, request);
            log.push({ kind: "opened", request: { ...request } });
          } else if (request.reply === null) {
            const by = instant(labels.by, request.openedAt);
            if (by !== request.by) { pass.rescheduled.push({ id: request.id, from: request.by, to: by }); request.by = by; }
            request.detached = false;
          }
          reached.add(request.id);
          if (request.reply === null && request.by !== null && request.by <= now) close(request, { tag: "NoReply" }, request.by);
          return { value: { type: "request", id: request.id }, at: request.openedAt };
        }
      }

      if (!request) {
        if (!permitted()) return revoked();
        const id = v2 ? nextUniqueRequestId(resolvedAddress) : address;
        request = ledger.requests[id] = {
          id, ...(v2 ? { address: resolvedAddress } : {}), verb: name, holder, candidates: name === "judge" ? null : candidatesOf(args[0]),
          excluded: name === "judge" ? [] : excludedOf(args[0]), delegatedBy: null, epoch: 0, text: question.value,
          conditions: conditionsOf(args[0]),
          about: labels.about ? show(labels.about) : null, context: labels.context ? show(labels.context) : null,
          options: choices?.type === "list" ? choices.values : null,
          form: nextForm,
          by: instant(labels.by, now), openedAt: now, reply: null, settledAt: null, detached: false,
        };
        if (v2) byAddress.set(resolvedAddress, request);
        log.push({ kind: "opened", request: { ...request } });
      } else if (request.reply === null) {
        // The deadline and form are not part of who is asked what: moving them amends the same request.
        const by = instant(labels.by, request.openedAt);
        if (by !== request.by) { pass.rescheduled.push({ id: request.id, from: request.by, to: by }); request.by = by; }
        if (v2 && JSON.stringify(request.form) !== JSON.stringify(nextForm)) {
          pass.formChanged.push({ id: request.id, from: request.form, to: nextForm });
          request.form = nextForm;
        }
        request.detached = false;
      }
      reached.add(request.id);
      // A deadline already reached when it is recorded has passed: no later scan is needed to say so.
      if (request.reply === null && request.by !== null && request.by <= now) close(request, { tag: "NoReply" }, request.by);
      return { value: { type: "request", id: request.id }, at: request.openedAt };
    }

    // --- Scoped v2 `forEach` loop with occurrence-keyed rounds & sealed rounds ---
    if (v2 && effect.loop) {
      let storageKey: string;
      let displayKey: string;
      if (effect.loop === "begins") {
        const parentScope = currentScope();
        const loopName = effect.loopKey ?? "$default";
        let used = loopsUsedInScope.get(parentScope);
        if (!used) { used = new Set(); loopsUsedInScope.set(parentScope, used); }
        if (used.has(loopName)) {
          throw new ProgramError(effect.loopKey === null
            ? "More than one unnamed forEach loop in the same scope; add ~key=\"...\" to each forEach"
            : `Duplicate forEach ~key="${effect.loopKey}" in the same scope`);
        }
        used.add(loopName);
        displayKey = parentScope === "root" ? `loop:${loopName}` : `loop:${parentScope}/${loopName}`;
        storageKey = resolveEntryKey(displayKey);
        activeLoopStack.push({ storageKey, displayKey });
      } else {
        const frame = activeLoopStack.at(-1);
        if (!frame) throw new ProgramError("Unexpected forEach continuation outside a loop");
        storageKey = frame.storageKey;
        displayKey = frame.displayKey;
      }

      const rawEntry = entry(storageKey, () => ({
        at: now,
        value: {
          startedAt: now, from: ledger.occurrences.length, streams: {}, lastTimerAt: null,
          timerSpec: null, sealedRounds: 0, sealedTimerInstants: [], active: null,
        } as unknown as Json,
      }));
      const state = structuredClone(rawEntry.value as unknown as LoopState);

      if (effect.loop === "continues") {
        // Seal the finished round atomically before checking for the next occurrence.
        scopeStack.pop();
        if (state.active) {
          state.sealedRounds += 1;
          // Advance timer beat cursor to `now` so ticks that passed while the handler worked are not made up,
          // while `every` still stays aligned to its anchor.
          state.lastTimerAt = Math.max(state.lastTimerAt ?? state.startedAt, state.active.timerAt ?? 0, now);
          if (state.active.timerAt !== undefined && !state.sealedTimerInstants.includes(state.active.timerAt)) {
            state.sealedTimerInstants.push(state.active.timerAt);
          }
          if (state.active.streamTaken) {
            const prev = state.streams[state.active.streamTaken.stream] ?? state.from;
            state.streams[state.active.streamTaken.stream] = Math.max(prev, state.active.streamTaken.next);
          }
          state.active = null;
          state.waitingLogged = false;
          ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
        }
      } else if (state.active) {
        // An in-flight round is already active: enter its scope directly without re-evaluating sealed rounds.
        const roundScope = `${displayKey}/round:${state.active.roundKey}`;
        scopeStack.push(roundScope);
        pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: state.active.roundKey, nextDue: null });
        lastWaitEvaluated = true;
        return { value: state.active.value, at: Math.max(state.active.at, state.lastTimerAt ?? state.startedAt) };
      }

      // Select the next occurrence for this loop.
      const provisionalBegan = state.lastTimerAt ?? state.startedAt;
      let detailed = detailedTargetsOf(ledger, args[0], provisionalBegan);
      const nextSpec = timerSpecOf(detailed);
      let began = provisionalBegan;
      if (state.timerSpec !== null && state.timerSpec !== nextSpec) {
        // Schedule edited: never create past rounds; next tick is strictly after max(cursor, edit_time).
        began = Math.max(provisionalBegan, now);
        state.lastTimerAt = began;
        state.timerSpec = nextSpec;
        detailed = detailedTargetsOf(ledger, args[0], began);
      } else if (state.timerSpec === null) {
        state.timerSpec = nextSpec;
      }

      if (!permitted()) return revoked();
      const targets = detailed.map(item => item.target);
      const candidates: Candidate[] = [];
      const rejectedStreamProgress = new Map<string, number>();
      let loopNextDue: number | null = null;
      const trackDue = (at: number): void => {
        due(at);
        if (at > now && (loopNextDue === null || at < loopNextDue)) loopNextDue = at;
      };

      for (const item of detailed) {
        const { target, ops, timer } = item;
        if (target.kind === "timer") {
          let tickAt = target.at;
          const period = timer?.kind === "every" ? timer.period : 0;
          // Advance past any already-sealed or filtered-out ticks up to `now`.
          let guard = 0;
          while (tickAt <= now && guard++ < 10_000) {
            if (!state.sealedTimerInstants.includes(tickAt)) {
              const transformed = applyOps(code, machine, { type: "time", value: String(tickAt) }, ops, now);
              if (transformed !== null) {
                candidates.push({ at: tickAt, value: transformed, rank: 2, roundKey: `timer@${tickAt}`, timerAt: tickAt, evaluated: true });
                break;
              }
            }
            if (period <= 0) { tickAt = Number.POSITIVE_INFINITY; break; }
            tickAt += period;
          }
          if (Number.isFinite(tickAt) && tickAt > now) trackDue(tickAt);
        } else if (target.kind === "fact") {
          const fact = ledger.facts[eventKey(target.source)];
          if (fact) {
            const transformed = applyOps(code, machine, fact.value, ops, now);
            if (transformed !== null) {
              candidates.push({ at: Math.max(fact.at, began), value: transformed, rank: 2, roundKey: `fact:${sha256(eventKey(target.source)).slice(0, 12)}`, evaluated: true });
            }
          }
        } else if (target.kind === "stream") {
          const streamKey = eventKey(target.source);
          const from = state.streams[streamKey] ?? state.from;
          const arrived = ledger.occurrences.flatMap((occurrence, index) => index >= from && occurrence.key === streamKey ? [{ ...occurrence, index }] : []);
          if (!arrived.length) continue;
          const streamDigest = sha256(streamKey).slice(0, 12);
          const lastIndex = arrived.at(-1)!.index;
          if (target.gathered) {
            // Apply inner ops before gather? In Norn `gather` only wraps a raw host stream, so ops wrap the gathered list.
            const transformed = applyOps(code, machine, { type: "list", values: arrived.map(each => each.value) }, ops, now);
            if (transformed !== null) {
              candidates.push({
                at: arrived[0].at, value: transformed, rank: 2,
                taken: { stream: streamKey, next: lastIndex + 1 },
                roundKey: `stream:${streamDigest}#${arrived[0].index}-${lastIndex}`,
                evaluated: true,
              });
            } else {
              rejectedStreamProgress.set(streamKey, lastIndex + 1);
            }
          } else {
            const matched: { at: number; index: number; value: Value }[] = [];
            for (const occurrence of arrived) {
              const transformed = applyOps(code, machine, occurrence.value, ops, now);
              if (transformed !== null) matched.push({ at: occurrence.at, index: occurrence.index, value: transformed });
            }
            if (matched.length) {
              const first = matched[0], latest = matched.at(-1)!;
              candidates.push({
                at: first.at, value: latest.value, rank: 2,
                taken: { stream: streamKey, next: lastIndex + 1 },
                roundKey: `stream:${streamDigest}#${latest.index}`,
                evaluated: true,
              });
            } else {
              rejectedStreamProgress.set(streamKey, lastIndex + 1);
            }
          }
        }
      }

      candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
      const winner = candidates[0];
      if (!winner) {
        // Advance stream cursors past rejected occurrences (filtering is non-retroactive).
        for (const [streamKey, next] of rejectedStreamProgress) {
          state.streams[streamKey] = Math.max(state.streams[streamKey] ?? state.from, next);
        }
        if (!state.waitingLogged) {
          log.push({ kind: "waiting", targets, until: null });
          state.waitingLogged = true;
        }
        ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
        pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: null, nextDue: loopNextDue });
        pass.waiting = { targets, until: null };
        return null;
      }

      if (!state.waitingLogged) log.push({ kind: "waiting", targets, until: null });
      state.waitingLogged = true;
      state.active = {
        roundKey: winner.roundKey!,
        at: winner.at,
        value: winner.value,
        ...(winner.taken ? { streamTaken: winner.taken } : {}),
        ...(winner.timerAt !== undefined ? { timerAt: winner.timerAt } : {}),
      };
      ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
      const roundScope = `${displayKey}/round:${winner.roundKey!}`;
      scopeStack.push(roundScope);
      pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: winner.roundKey!, nextDue: loopNextDue });
      log.push({ kind: "waited", targets, until: null, at: winner.at, value: winner.value });
      lastWaitEvaluated = true;
      return { value: winner.value, at: Math.max(winner.at, began) };
    }

    // --- Legacy v1 `forEach` bookkeeping (only for unmigrated v1 ledgers) ---
    const loop = !v2 && effect.loop ? `forEach:${sha256(eventKey(args[0])).slice(0, 16)}` : null;
    if (loop) {
      const handled = `${loop}/handled`;
      if (effect.loop === "continues") ledger.entries[handled] = { at: now, value: Object.fromEntries(seen) };
      else for (const [kind, count] of Object.entries((ledger.entries[handled]?.value ?? {}) as Record<string, number>)) {
        seen.set(kind, Math.max(seen.get(kind) ?? 0, count));
      }
    }

    // --- Plain `wait` / `waitUntil` (and v1 `forEach` waits) ---
    if (name === "wait" || name === "waitUntil") {
      if (args.length !== (name === "waitUntil" ? 2 : 1)) throw new ProgramError(`${name} needs a target${name === "waitUntil" ? " and a positional deadline" : ""}`);
      const targetKey = v2 ? stripSourceFunctions(args[0]) : args[0];
      const key = identity("wait", { target: targetKey, until: args[1] ?? null });
      const fresh = !ledger.entries[`${key}/began`];
      const taken = loop ? entry(`${loop}/taken`, () => ({ at: now, value: { from: ledger.occurrences.length, streams: {} } })) : null;
      const beginning = entry(`${key}/began`, () => ({ at: now, value: taken ? structuredClone(taken.value) : ledger.occurrences.length }));
      const began = beginning.at, position = beginning.value as unknown as number | Taken;
      const cursor = (stream: string): number => typeof position === "number" ? position : position.streams[stream] ?? position.from;
      let ended = ledger.entries[key];
      const detailed = detailedTargetsOf(ledger, args[0], began);
      const usePureEval = hasFilterOp(detailed);
      if (!ended) {
        const targets = detailed.map(item => item.target);
        const until = name === "waitUntil" ? instant(args[1], began)! : null;
        const lost = !permitted();
        if (lost && args[0].type !== "request") return revoked();
        if (fresh) log.push({ kind: "waiting", targets, until });
        const candidates: Candidate[] = [];
        const occurred = (at: number, value: Value, path: Path, rank: 0 | 2 = 2, from?: Candidate["taken"], alreadyWrapped = false): void => {
          if (at <= now) {
            const wrapped = alreadyWrapped ? value : path.reduceRight((inner, side) => variant(side, inner), value);
            candidates.push({ at, value: wrapped, rank, ...(from ? { taken: from } : {}), ...(alreadyWrapped ? { evaluated: true } : {}) });
          } else due(at);
        };
        for (const item of detailed) {
          const { target, ops, timer } = item;
          if (target.kind === "request") {
            const request = ledger.requests[target.id];
            if (lost && request.reply === null) close(request, { tag: "Revoked" }, now);
            if (request.reply) occurred(request.settledAt!, replyValue(request.reply), [], request.reply.tag === "NoReply" ? 0 : 2);
            else if (request.by !== null) due(request.by);
          } else if (target.kind === "timer") {
            if (!usePureEval) {
              occurred(target.at, { type: "time", value: String(target.at) }, target.path);
            } else {
              let tickAt = target.at;
              const period = timer?.kind === "every" ? timer.period : 0;
              let guard = 0;
              while (tickAt <= now && guard++ < 10_000) {
                const transformed = applyOps(code, machine, { type: "time", value: String(tickAt) }, ops, now);
                if (transformed !== null) { occurred(tickAt, transformed, target.path, 2, undefined, true); break; }
                if (period <= 0) { tickAt = Number.POSITIVE_INFINITY; break; }
                tickAt += period;
              }
              if (Number.isFinite(tickAt) && tickAt > now) due(tickAt);
            }
          } else if (target.kind === "fact") {
            const fact = ledger.facts[eventKey(target.source)];
            if (fact) {
              if (!usePureEval) occurred(Math.max(fact.at, began), fact.value, target.path);
              else {
                const transformed = applyOps(code, machine, fact.value, ops, now);
                if (transformed !== null) occurred(Math.max(fact.at, began), transformed, target.path, 2, undefined, true);
              }
            }
          } else {
            const stream = eventKey(target.source), from = cursor(stream);
            const arrived = ledger.occurrences.flatMap((occurrence, index) => index >= from && occurrence.key === stream ? [{ ...occurrence, index }] : []);
            const [next] = arrived;
            const latest = arrived.at(-1);
            if (!usePureEval) {
              if (next && target.gathered) occurred(next.at, { type: "list", values: arrived.map(each => each.value) }, target.path, 2, { stream, next: latest!.index + 1 });
              else if (next && loop) occurred(next.at, latest!.value, target.path, 2, { stream, next: latest!.index + 1 });
              else if (next) occurred(next.at, next.value, target.path, 2, { stream, next: next.index + 1 });
            } else if (next) {
              if (target.gathered) {
                const transformed = applyOps(code, machine, { type: "list", values: arrived.map(each => each.value) }, ops, now);
                if (transformed !== null) occurred(next.at, transformed, target.path, 2, { stream, next: latest!.index + 1 }, true);
              } else {
                const matched: { at: number; index: number; value: Value }[] = [];
                for (const occurrence of arrived) {
                  const transformed = applyOps(code, machine, occurrence.value, ops, now);
                  if (transformed !== null) {
                    matched.push({ at: occurrence.at, index: occurrence.index, value: transformed });
                    if (!loop) break;
                  }
                }
                if (matched.length) {
                  const picked = loop ? matched.at(-1)! : matched[0];
                  occurred(matched[0].at, picked.value, target.path, 2, { stream, next: loop ? latest!.index + 1 : picked.index + 1 }, true);
                }
              }
            }
          }
        }
        if (until !== null) { if (until <= now) candidates.push({ at: until, value: unit, rank: 1 }); else due(until); }
        candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
        const winner = candidates[0];
        if (!winner) { pass.waiting = { targets, until }; return null; }
        const elapsed = winner.rank === 1;
        const value = name === "waitUntil" ? (elapsed ? variant("None") : variant("Some", winner.value)) : winner.value;
        ended = ledger.entries[key] = { at: winner.at, value: value as unknown as Json };
        if (loop && winner.taken) {
          const stands = ledger.entries[`${loop}/taken`].value as unknown as Taken;
          ledger.entries[`${loop}/taken`] = { at: now, value: { from: stands.from, streams: { ...stands.streams, [winner.taken.stream]: winner.taken.next } } };
        }
        log.push({ kind: "waited", targets, until, at: winner.at, value: elapsed ? null : winner.value });
        if (winner.evaluated) lastWaitEvaluated = true;
      } else if (usePureEval) {
        lastWaitEvaluated = true;
      }
      return { value: ended.value as unknown as Value, at: Math.max(ended.at, began) };
    }

    if (name === "first") {
      const list = args[0];
      if (args.length !== 1 || list.type !== "list" || !list.values.length) throw new ProgramError("first needs a nonempty list of requests");
      const requests = list.values.map(value => handle(name, value));
      const key = identity("first", { ids: requests.map(request => request.id) });
      let won = ledger.entries[key];
      if (!won) {
        const lost = !permitted();
        for (const request of requests) if (lost && request.reply === null) close(request, { tag: "Revoked" }, now);
        const ended = requests.filter(request => request.reply !== null && request.settledAt! <= now).sort((a, b) => a.settledAt! - b.settledAt!);
        if (!ended.length) {
          for (const request of requests) if (request.by !== null) due(request.by);
          pass.waiting = { targets: requests.map(request => ({ kind: "request", id: request.id })), until: null };
          return null;
        }
        won = ledger.entries[key] = { at: ended[0].settledAt!, value: ended[0].id };
      }
      const winner = ledger.requests[won.value as string];
      return { value: { type: "tuple", values: [{ type: "request", id: winner.id }, replyValue(winner.reply!)] }, at: Math.max(won.at, ledger.startedAt) };
    }

    if (name === "say") {
      if (args.length !== 2 || !["participant", "ref"].includes(args[0].type) || args[1].type !== "string") throw new ProgramError("say needs a participant or a reference, and text");
      const to = show(args[0]), body = args[1].value;
      const key = identity("say", { to, body });
      if (!ledger.entries[key]) {
        if (!permitted()) return revoked();
        log.push({ kind: "said", to, text: body });
      }
      return { value: unit, at: entry(key, () => ({ at: now, value: null })).at };
    }
    if (name === "status") {
      if (args.length !== 1) throw new ProgramError("status needs one request");
      const request = handle(name, args[0]), key = identity("status", { id: request.id });
      if (!ledger.entries[key] && !permitted()) return revoked();
      const read = entry(key, () => ({ at: now, value: (request.reply ? variant("Some", replyValue(request.reply)) : variant("None")) as unknown as Json }));
      return { value: read.value as unknown as Value, at: read.at };
    }
    if (name === "cancel" || name === "handOver") {
      if (args.length !== (name === "handOver" ? 2 : 1)) throw new ProgramError(`${name} needs a request${name === "handOver" ? " and its next holder" : ""}`);
      const request = handle(name, args[0]), next = name === "handOver" ? participant(args[1]) : null;
      const key = identity(name, { id: request.id, next });
      if (!ledger.entries[key]) {
        if (!permitted()) return revoked();
        if (request.reply === null && next === null) close(request, { tag: "Cancelled" }, now);
        else if (request.reply === null) {
          log.push({ kind: "handedOver", id: request.id, from: request.holder, to: next! });
          request.holder = next!; request.candidates = candidatesOf(args[1]); request.excluded = excludedOf(args[1]);
          request.conditions = conditionsOf(args[1]); request.delegatedBy = null; request.epoch++;
        }
      }
      const at = entry(key, () => ({ at: now, value: null })).at;
      return { value: next === null ? unit : { type: "request", id: request.id }, at };
    }
    throw new Error(`The ledger runtime does not implement the effect ${name}`);
  };

  // A pass that never reaches a wait is a bug in the program; it fails in the open instead of spinning.
  let budget = Math.ceil((options.steps ?? 5_000_000) / 10_000);
  for (;;) {
    advance(code, machine, 10_000);
    const control = machine.control;
    if (control.kind === "done") { end("completed", control.value, null); break; }
    if (control.kind === "error") { end("failed", null, control.message); break; }
    if (control.kind === "failed") { end("failed", control.outcome, null); break; }
    if (control.kind === "report") {
      const key = identity("report", control.outcome);
      if (!ledger.entries[key]) log.push({ kind: "handlerFailed", reply: control.outcome });
      resume(machine, unit, entry(key, () => ({ at: now, value: control.outcome as unknown as Json })).at); continue;
    }
    if (control.kind !== "effect") {
      if (--budget <= 0) { end("failed", null, "The program computed for too long without waiting or finishing"); break; }
      yield; continue;
    }
    let resumption: { value: Value; at: number } | null;
    try { resumption = answer(control.effect); } catch (error) {
      if (!(error instanceof ProgramError)) throw error;
      end("failed", null, error.message); break;
    }
    if (!resumption) break;
    const { name, args } = control.effect;
    const mapped = !lastWaitEvaluated && (name === "wait" || name === "waitUntil") ? through(args[0], resumption.value, name) : null;
    if (mapped) resumeThrough(machine, mapped.value, mapped.steps, resumption.at);
    else resume(machine, resumption.value, resumption.at);
  }

  pass.reached = [...reached];
  if (pass.status === "waiting") pass.listening = machine.frames.flatMap(frame => frame.kind === "forEach" ? hostStreams(frame.stream) : []);
  for (const request of Object.values(ledger.requests)) {
    if (request.reply !== null) continue;
    // Ending a program cancels what it left open, in the same commit that records its result.
    if (pass.status !== "waiting") close(request, { tag: "Cancelled" }, now);
    else if (!reached.has(request.id)) { request.detached = true; pass.unreached.push(request); }
  }
  if (pass.status !== "waiting") ledger.ended = { at: now, status: pass.status, result: pass.result, error: pass.error };
  for (const step of log) {
    if (step.kind === "opened") pass.opened.push(step.request);
    else if (step.kind === "said") pass.said.push({ to: step.to, text: step.text });
    else if (step.kind === "closed" && step.reply.tag === "Cancelled") pass.cancelled.push(step.id);
  }
  if (options.commit ?? true) Object.assign(source, ledger);
  return pass;
}

/**
 * One pass. With `commit: false` the ledger is left untouched and the result is
 * the difference the pass would make.
 */
export function evaluate(code: Code, ledger: Ledger, now: number, options: PassOptions = {}): Pass {
  const pass = slices(code, ledger, now, options);
  for (;;) {
    const slice = pass.next();
    if (slice.done) return slice.value;
  }
}

/** Two-text edit preview: evaluates both old and new program texts against the same ledger without mutating it. */
export interface EditPreview {
  before: Pass;
  after: Pass;
  /** Open requests reached by both old and new texts. */
  kept: LedgerRequest[];
  /** Requests the new text would open now that the old text did not. */
  opened: LedgerRequest[];
  /** Open requests reached by the old text that the new text no longer reaches. */
  unreached: LedgerRequest[];
  /** Already-answered requests reached by the old text that the new text no longer uses. */
  answeredUnused: LedgerRequest[];
  rescheduled: { id: string; from: number | null; to: number | null }[];
  formChanged: { id: string; from: ReportForm | null; to: ReportForm | null }[];
  incompatibleAnswers: { id: string; reason: string; form: ReportForm | null }[];
  loops: {
    key: string;
    beforeNextDue: number | null;
    afterNextDue: number | null;
    sealedRounds: number;
    status: "kept" | "added" | "removed" | "rescheduled";
  }[];
  nextDue: { before: number | null; after: number | null };
  /** True when the edit makes no observable request or loop-structure difference. */
  empty: boolean;
}

export function previewEdit(beforeCode: Code, afterCode: Code, ledger: Ledger, now: number, options: PassOptions = {}): EditPreview {
  const before = evaluate(beforeCode, ledger, now, { ...options, commit: false });
  const after = evaluate(afterCode, ledger, now, { ...options, commit: false });
  const beforeReached = new Set(before.reached);
  const afterReached = new Set(after.reached);
  const beforeOpenedIds = new Set(before.opened.map(r => r.id));

  const kept: LedgerRequest[] = [];
  const unreached: LedgerRequest[] = [];
  const answeredUnused: LedgerRequest[] = [];
  for (const id of beforeReached) {
    const request = ledger.requests[id];
    if (!request) continue;
    if (afterReached.has(id)) {
      if (request.reply === null) kept.push(request);
    } else if (request.reply === null) {
      unreached.push(request);
    } else if (request.reply.tag === "Answered") {
      answeredUnused.push(request);
    }
  }
  const opened = after.opened.filter(request => !beforeOpenedIds.has(request.id));

  const beforeLoops = new Map(before.loops.map(loop => [loop.key, loop]));
  const afterLoops = new Map(after.loops.map(loop => [loop.key, loop]));
  const allLoopKeys = [...new Set([...beforeLoops.keys(), ...afterLoops.keys()])];
  const loops = allLoopKeys.map(key => {
    const b = beforeLoops.get(key);
    const a = afterLoops.get(key);
    const status: "kept" | "added" | "removed" | "rescheduled" =
      !b ? "added" : !a ? "removed" : b.nextDue !== a.nextDue ? "rescheduled" : "kept";
    return {
      key,
      beforeNextDue: b?.nextDue ?? null,
      afterNextDue: a?.nextDue ?? null,
      sealedRounds: a?.sealedRounds ?? b?.sealedRounds ?? 0,
      status,
    };
  });

  const empty =
    opened.length === 0 &&
    unreached.length === 0 &&
    answeredUnused.length === 0 &&
    after.rescheduled.length === 0 &&
    after.formChanged.length === 0 &&
    after.incompatibleAnswers.length === 0 &&
    after.cancelled.length === 0 &&
    after.said.length === 0 &&
    loops.every(loop => loop.status === "kept") &&
    before.status === after.status;

  return {
    before, after, kept, opened, unreached, answeredUnused,
    rescheduled: after.rescheduled,
    formChanged: after.formChanged,
    incompatibleAnswers: after.incompatibleAnswers,
    loops,
    nextDue: { before: before.nextDue, after: after.nextDue },
    empty,
  };
}

/** Result of a read-only migration attempt from a legacy v1 ledger to identityScheme 2. */
export type MigrationResult =
  | { ok: true; ledger: Ledger; keepLegacy: false; migratedRequests: number; migratedLoops: number }
  | { ok: false; keepLegacy: true; reason: string };

/**
 * Read-only migration prototype: converts a legacy v1 ledger into an
 * `identityScheme: 2` ledger without mutating the input. Preserves every
 * existing request's immutable `id`, `epoch`, `holder`, `delegations`, and
 * delivery fields. Fails closed (`keepLegacy: true`) whenever loop or open
 * request ownership is ambiguous.
 */
export function migrateLedger(code: Code, legacy: Ledger, now: number): MigrationResult {
  if ((legacy.identityScheme ?? 1) === 2) {
    return { ok: true, ledger: structuredClone(legacy), keepLegacy: false, migratedRequests: 0, migratedLoops: 0 };
  }
  const v1Pass = evaluate(code, legacy, now, { commit: false });
  if (v1Pass.status === "failed" && v1Pass.error) {
    return { ok: false, keepLegacy: true, reason: `Legacy pass fails before migration: ${v1Pass.error}` };
  }

  // Inspect legacy loop checkpoints.
  const legacyLoopKeys = [...new Set(
    Object.keys(legacy.entries)
      .filter(key => key.startsWith("forEach:") && (key.endsWith("/taken") || key.endsWith("/handled")))
      .map(key => key.replace(/\/(?:taken|handled)$/u, "")),
  )];
  if (legacyLoopKeys.length > 1) {
    return { ok: false, keepLegacy: true, reason: `Ambiguous ownership: ledger holds ${legacyLoopKeys.length} legacy loops; keep on v1 evaluator` };
  }

  // Probe what loop key(s) the program declares under v2 on a fresh ledger at `legacy.startedAt`.
  const probe = emptyLedger(legacy.startedAt, { identityScheme: 2 });
  const probePass = evaluate(code, probe, legacy.startedAt, { commit: false });
  if (probePass.loops.length > 1 && legacyLoopKeys.length > 0) {
    return { ok: false, keepLegacy: true, reason: "Program declares multiple loops and legacy loop ownership is ambiguous; keep on v1 evaluator" };
  }

  const migrated = structuredClone(legacy);
  migrated.identityScheme = 2;
  let migratedLoops = 0;
  let migratedRequests = 0;

  // Migrate the single unambiguous loop (if present).
  if (legacyLoopKeys.length === 1 && probePass.loops.length === 1) {
    const oldPrefix = legacyLoopKeys[0]!;
    const newLoopKey = probePass.loops[0]!.key;
    const takenEntry = legacy.entries[`${oldPrefix}/taken`];
    const takenVal = takenEntry?.value as unknown as Taken | undefined;

    // Find the latest settled wait timestamp in legacy entries to seed `lastTimerAt` accurately.
    let lastWaitAt: number | null = null;
    const sealedTimerInstants: number[] = [];
    for (const [key, item] of Object.entries(legacy.entries)) {
      if (!key.startsWith("wait:") || key.endsWith("/began")) continue;
      if (lastWaitAt === null || item.at > lastWaitAt) lastWaitAt = item.at;
      const val = item.value as unknown as Value | undefined;
      if (val && typeof val === "object") {
        const unwrapTime = (v: Value): number | null => {
          if (v.type === "time") return Number(v.value);
          if (v.type === "variant" && (v.name === "First" || v.name === "Second") && v.args.length === 1) return unwrapTime(v.args[0]);
          return null;
        };
        const t = unwrapTime(val);
        if (t !== null && !sealedTimerInstants.includes(t)) sealedTimerInstants.push(t);
      }
    }

    const openRequests = Object.values(migrated.requests).filter(r => r.reply === null && v1Pass.reached.includes(r.id));
    if (openRequests.length > 1) {
      return { ok: false, keepLegacy: true, reason: "Multiple simultaneous open requests inside a legacy loop cannot be attributed unambiguously; keep on v1 evaluator" };
    }

    const activeRequest = openRequests[0];
    let active: LoopState["active"] = null;
    if (activeRequest) {
      // Find the latest settled loop wait that started this active round.
      const waitEntries = Object.entries(legacy.entries)
        .filter(([key]) => key.startsWith("wait:") && !key.endsWith("/began"))
        .sort(([, a], [, b]) => b.at - a.at);
      const latestWait = waitEntries[0]?.[1];
      if (!latestWait) {
        return { ok: false, keepLegacy: true, reason: "Open request inside legacy loop has no triggering wait entry; keep on v1 evaluator" };
      }
      const roundKey = `migrated@${latestWait.at}`;
      active = { roundKey, at: latestWait.at, value: latestWait.value as unknown as Value };
      // Re-index this open request at its new v2 round address while keeping its immutable `id` and `epoch`.
      const roundProbe = structuredClone(migrated);
      const stateForProbe: LoopState = {
        startedAt: takenEntry?.at ?? legacy.startedAt,
        from: takenVal?.from ?? legacy.occurrences.length,
        streams: takenVal?.streams ? { ...takenVal.streams } : {},
        lastTimerAt: lastWaitAt,
        timerSpec: null,
        sealedRounds: Object.values(legacy.requests).filter(r => r.reply !== null).length,
        sealedTimerInstants,
        active,
      };
      roundProbe.entries[newLoopKey] = { at: now, value: stateForProbe as unknown as Json };
      // Temporarily hide requests so probe reveals the exact v2 address the code expects for the active request.
      roundProbe.requests = {};
      const probeRound = evaluate(code, roundProbe, now, { commit: false });
      const matching = probeRound.opened.find(r => r.verb === activeRequest.verb && r.holder === activeRequest.holder && r.text === activeRequest.text);
      if (!matching?.address) {
        return { ok: false, keepLegacy: true, reason: "Could not align open legacy loop request to a v2 round address; keep on v1 evaluator" };
      }
      activeRequest.address = matching.address;
      migratedRequests += 1;
    }

    const loopState: LoopState = {
      startedAt: takenEntry?.at ?? legacy.startedAt,
      from: takenVal?.from ?? legacy.occurrences.length,
      streams: takenVal?.streams ? { ...takenVal.streams } : {},
      lastTimerAt: lastWaitAt,
      timerSpec: null,
      sealedRounds: Object.values(legacy.requests).filter(r => r.reply !== null).length,
      sealedTimerInstants,
      active,
    };
    migrated.entries[newLoopKey] = { at: now, value: loopState as unknown as Json };
    delete migrated.entries[`${oldPrefix}/taken`];
    delete migrated.entries[`${oldPrefix}/handled`];
    migratedLoops += 1;
  } else if (legacyLoopKeys.length === 0) {
    // Non-loop program: align each reached request (open or answered) to its v2 address while preserving immutable `id`.
    const probeV2 = emptyLedger(legacy.startedAt, { identityScheme: 2 });
    probeV2.facts = structuredClone(legacy.facts);
    probeV2.occurrences = structuredClone(legacy.occurrences);
    for (const request of Object.values(migrated.requests)) {
      if (request.address) continue;
      // Top-level v1 request IDs differ from v2 only when `~form` was previously hashed into `id`.
      // Compute the v2 content digest directly from the request's fields for unambiguous single-occurrence matching.
      request.address = request.id;
    }
    // Check if evaluating under v2 re-opens anything that is already in the ledger; if so, map by (verb, holder, text, about).
    const testPass = evaluate(code, migrated, now, { commit: false });
    if (testPass.opened.length > 0) {
      const legacyByShape = new Map<string, LedgerRequest[]>();
      for (const req of Object.values(migrated.requests)) {
        const shape = `${req.verb}\0${req.holder}\0${req.text}\0${req.about ?? ""}`;
        const list = legacyByShape.get(shape) ?? [];
        list.push(req);
        legacyByShape.set(shape, list);
      }
      for (const newlyOpened of testPass.opened) {
        const shape = `${newlyOpened.verb}\0${newlyOpened.holder}\0${newlyOpened.text}\0${newlyOpened.about ?? ""}`;
        const matches = legacyByShape.get(shape) ?? [];
        if (matches.length !== 1 || !newlyOpened.address) {
          return { ok: false, keepLegacy: true, reason: `Ambiguous top-level request mapping for "${newlyOpened.text}"; keep on v1 evaluator` };
        }
        matches[0]!.address = newlyOpened.address;
        migratedRequests += 1;
      }
    }
  }

  // Final sanity check at migration instant: migrated v2 pass must not spuriously open or drop any request that v1 did not.
  const v2Check = evaluate(code, migrated, now, { commit: false });
  if (v2Check.status === "failed" && v1Pass.status !== "failed") {
    return { ok: false, keepLegacy: true, reason: `Migrated pass failed at snapshot: ${v2Check.error ?? "unknown"}` };
  }
  if (v2Check.opened.length !== v1Pass.opened.length || v2Check.unreached.length !== v1Pass.unreached.length) {
    return {
      ok: false, keepLegacy: true,
      reason: `Snapshot parity failed (v1 opened=${v1Pass.opened.length}/unreached=${v1Pass.unreached.length}, v2 opened=${v2Check.opened.length}/unreached=${v2Check.unreached.length}); keep on v1 evaluator`,
    };
  }
  return { ok: true, ledger: migrated, keepLegacy: false, migratedRequests, migratedLoops };
}

export type MigrationStep =
  | { kind: "advance"; at: number }
  | { kind: "occur"; stream: Value; value: Value; at: number }
  | { kind: "settleAll"; reply: Reply; at: number }
  | { kind: "edit"; code: Code; at: number }
  | { kind: "restart"; at: number };

export interface DispatchedRecord { step: number; at: number; id: string; verb: string; holder: string; text: string }
export interface MigrationReport {
  ok: boolean;
  migration: MigrationResult;
  legacyDispatched: DispatchedRecord[];
  migratedDispatched: DispatchedRecord[];
  differences: string[];
}

/**
 * Forward-advancing migration verifier: starts from one legacy snapshot and
 * drives both the legacy v1 evaluator and the migrated v2 evaluator through
 * clock advances, events, replies, edits, and JSON restarts, comparing actual
 * dispatched requests at every step.
 */
export function verifyMigration(initialCode: Code, legacySnapshot: Ledger, at: number, steps: readonly MigrationStep[]): MigrationReport {
  const migration = migrateLedger(initialCode, legacySnapshot, at);
  if (!migration.ok) {
    return { ok: false, migration, legacyDispatched: [], migratedDispatched: [], differences: [migration.reason] };
  }
  let legacyLedger = structuredClone(legacySnapshot);
  let migratedLedger = structuredClone(migration.ledger);
  let currentCode = initialCode;
  const legacyDispatched: DispatchedRecord[] = [];
  const migratedDispatched: DispatchedRecord[] = [];
  const differences: string[] = [];

  const runBoth = (stepIndex: number, now: number) => {
    const p1 = evaluate(currentCode, legacyLedger, now);
    const p2 = evaluate(currentCode, migratedLedger, now);
    for (const req of p1.opened) legacyDispatched.push({ step: stepIndex, at: now, id: req.id, verb: req.verb, holder: req.holder, text: req.text });
    for (const req of p2.opened) migratedDispatched.push({ step: stepIndex, at: now, id: req.id, verb: req.verb, holder: req.holder, text: req.text });
    const sig = (list: LedgerRequest[]) => list.map(r => `${r.verb}:${r.holder}:${r.text}`).sort().join("|");
    if (sig(p1.opened) !== sig(p2.opened)) {
      differences.push(`step ${stepIndex} (at ${now}): legacy opened [${sig(p1.opened)}], migrated opened [${sig(p2.opened)}]`);
    }
  };

  steps.forEach((step, index) => {
    if (step.kind === "advance") {
      runBoth(index, step.at);
    } else if (step.kind === "occur") {
      occur(legacyLedger, step.stream, step.value, step.at);
      occur(migratedLedger, step.stream, step.value, step.at);
      runBoth(index, step.at);
    } else if (step.kind === "settleAll") {
      for (const req of Object.values(legacyLedger.requests)) {
        if (req.reply === null && !req.detached) settle(legacyLedger, req.id, req.candidates?.[0] ?? req.holder, step.reply, step.at, req.epoch);
      }
      for (const req of Object.values(migratedLedger.requests)) {
        if (req.reply === null && !req.detached) settle(migratedLedger, req.id, req.candidates?.[0] ?? req.holder, step.reply, step.at, req.epoch);
      }
      runBoth(index, step.at);
    } else if (step.kind === "edit") {
      currentCode = step.code;
      runBoth(index, step.at);
    } else if (step.kind === "restart") {
      legacyLedger = JSON.parse(JSON.stringify(legacyLedger)) as Ledger;
      migratedLedger = JSON.parse(JSON.stringify(migratedLedger)) as Ledger;
      runBoth(index, step.at);
    }
  });

  return { ok: differences.length === 0, migration, legacyDispatched, migratedDispatched, differences };
}
