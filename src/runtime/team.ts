// A simulated team for tests and the playground: one program, its ledger and a
// virtual clock. Whoever drives it plays the participants and the world. It
// never starts an agent or contacts a service.
import type { Code } from "./code.ts";
import { emptyLedger, establish, occur, settle, settleDue, slices, type Ledger, type LedgerRequest, type Pass, type Reply, type Step } from "./ledger.ts";
import type { Value } from "./value.ts";

/** What happened, in order. A request is shown as it was at that moment. */
export type TeamEvent = { at: number } & (
  | { kind: "offered"; request: LedgerRequest }
  /** The holder is told how the request ended. */
  | { kind: "closed"; request: LedgerRequest; reply: Reply }
  /** `handedOver`: the previous holder is released, and the next one offered the same request. */
  | Extract<Step, { kind: "handedOver" | "said" | "waiting" | "waited" | "handlerFailed" }>
  | { kind: "ended"; status: "completed" | "failed"; result: Value | null; error: string | null }
);
/** What the program's author is told: a `forEach` handler that failed, or the program ending without success (spec §10). */
export interface Notice { at: number; about: "handler" | "program"; reply: Value | null; error: string | null }

function instant(at: number): number {
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("The clock counts nonnegative safe integer milliseconds");
  return at;
}

export class Team {
  readonly code: Code;
  readonly ledger: Ledger;
  readonly events: TeamEvent[] = [];
  readonly notices: Notice[] = [];
  /** The author's authority, read afresh by every pass. */
  permitted = true;
  private clock: number;

  /** With `ledger`, takes up a program where another process left it: the ledger is all that crosses a restart. */
  constructor(code: Code, options: { now?: number; ledger?: Ledger } = {}) {
    this.code = code;
    this.clock = instant(options.now ?? 0);
    this.ledger = options.ledger ?? emptyLedger(this.clock);
    this.advanceTo(this.clock); // Deadlines that passed while no process ran are told now.
  }
  get now(): number { return this.clock; }
  get open(): LedgerRequest[] { return Object.values(this.ledger.requests).filter(request => request.reply === null); }

  /** Moves the clock. Requests whose `~by` it reaches end `NoReply` whether or not a pass follows. */
  advanceTo(at: number): void {
    if (instant(at) < this.clock) throw new Error("Simulation time cannot move backwards");
    this.clock = at;
    for (const request of settleDue(this.ledger, at)) this.events.push({ kind: "closed", at: request.by!, request: { ...request }, reply: request.reply! });
  }
  /** A participant's reply. False when it settled nothing; the reason is the ledger's last piece of evidence. */
  reply(id: string, holder: string, reply: Reply): boolean {
    const accepted = settle(this.ledger, id, holder, reply, this.clock);
    if (accepted) this.events.push({ kind: "closed", at: this.clock, request: { ...this.ledger.requests[id] }, reply });
    return accepted;
  }
  /** Makes a fact hold, or records one occurrence of a stream. */
  emit(source: Value, value: Value): void {
    if (source.type === "source" && source.kind === "fact") establish(this.ledger, source, value, this.clock);
    else occur(this.ledger, source, value, this.clock);
  }

  /** One pass of the program over the ledger as it is now. */
  run(): Pass {
    const pass = this.slices();
    for (;;) {
      const slice = pass.next();
      if (slice.done) return slice.value;
    }
  }
  /** The same pass, yielding between slices of computation. Nothing else may be done to the team until it finishes. */
  *slices(): Generator<undefined, Pass> {
    const over = this.ledger.ended !== null, at = this.clock;
    const pass = yield* slices(this.code, this.ledger, at, { authorize: () => this.permitted });
    for (const step of pass.log) {
      if (step.kind === "opened") this.events.push({ kind: "offered", at, request: step.request });
      else if (step.kind === "closed") this.events.push({ ...step, at, request: { ...this.ledger.requests[step.id] } });
      else if (step.kind === "waited") this.events.push(step);
      else this.events.push({ ...step, at });
      if (step.kind === "handlerFailed") this.notices.push({ at, about: "handler", reply: step.reply, error: null });
    }
    if (!over && pass.status !== "waiting") {
      this.events.push({ kind: "ended", at, status: pass.status, result: pass.result, error: pass.error });
      if (pass.status === "failed") this.notices.push({ at, about: "program", reply: pass.result, error: pass.error });
    }
    return pass;
  }
}
