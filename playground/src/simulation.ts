/**
 * A program running against a simulated team, in the page. The visitor plays
 * the team: answers, refuses or breaks requests, moves the virtual clock and
 * fires the host's facts and streams. This module drives the ledger runtime
 * (`src/runtime/browser.ts`) and keeps what happened as a timeline of plain
 * data; it knows nothing of the page.
 *
 * After everything the visitor does, the program is evaluated again from the
 * top against the ledger. A pass yields between slices of computation, and
 * this module gives the page a turn there, so a program that loops without
 * waiting leaves the page responsive until the runtime's step budget ends it
 * as a program failure. Nothing here caps a program's steps.
 */
import type { Program } from "../../src/frontend/ast.ts";
import type { ReportForm } from "../../src/frontend/check/index.ts";
import { Team, compile, variant, type LedgerRequest, type Pass, type Reply, type Value, type Waiting } from "../../src/runtime/browser.ts";
import { code, either, literal, participant, quote, source, time, type Run } from "./words.ts";

/** When every simulation starts: 09:00 UTC on 7 November 2026, three hours before decide.norn's deadline. */
export const START = Date.UTC(2026, 10, 7, 9, 0);

/** `ready` while the first pass computes, `suspended` while the program waits; `revoked` is a failure whose result is `Revoked`. */
export type Status = "ready" | "suspended" | "completed" | "failed" | "revoked";

/** A request as the program made it. */
export interface RequestInfo {
  id: string;
  /** Who holds it now, as in `@alice`; `@judge` for `judge`. */
  holder: string;
  /** The verb that made it. */
  name: "ask" | "confirm" | "choose" | "run" | "judge";
  /** The question, the task or the condition. */
  text: string;
  /** The options of a `choose`; `Yes` and `No` for a `confirm`. */
  options: Value[] | null;
  /** What a `run` must report, when the program decides it; null means the host's report. */
  form: ReportForm | null;
  /** The request's own deadline (`~by`), on the ledger's clock: past it, the request ends `NoReply`. */
  by: number | null;
}

export type Entry =
  | { kind: "offered"; at: number; request: RequestInfo }
  | { kind: "handedOver"; at: number; request: RequestInfo; from: string; to: string }
  | { kind: "closed"; at: number; request: RequestInfo; outcome: Reply }
  /** An answer outside the request's form, such as an option it did not offer: kept as evidence, and the request stays open. */
  | { kind: "rejected"; at: number; request: RequestInfo; answer: string; reason: string }
  | { kind: "said"; at: number; to: string; text: string }
  /** `targets` reads after "Waiting", as in "for @alice’s answer to “…”"; `deadline` after that, as in " until 2026-11-07 12:00 UTC". */
  | { kind: "waiting"; at: number; targets: Run[]; deadline: Run[] }
  /** A wait ended by an event or a timer; the value it gave, unless that is `()` or a time. */
  | { kind: "woke"; at: number; outcome: string | null }
  /** A `waitUntil` ran out before what it waited for: only the wait ends. */
  | { kind: "elapsed"; at: number; targets: Run[]; open: boolean }
  | { kind: "fired"; at: number; source: string; mode: "fact" | "stream"; value: string }
  | { kind: "handlerFailed"; at: number; outcome: string }
  /** `outcome` is the program's result, or the text of a program error when `error` is true. */
  | { kind: "ended"; at: number; status: Exclude<Status, "ready" | "suspended">; outcome: string; error: boolean };

export interface OpenRequest extends RequestInfo {
  epoch: number;
  /** Whether the program is waiting for this request now. */
  awaited: boolean;
}

/** A fact or stream the program is waiting on now, which the visitor can fire. */
export interface AwaitedEvent {
  source: Extract<Value, { type: "source" }>;
  mode: "fact" | "stream";
}

export interface SimulationState {
  now: number;
  status: Status;
  /** A pass is under way: a long or endless loop shows here. */
  computing: boolean;
  /** What the program waits for, in words, and until when. */
  waiting: { targets: Run[]; deadline: Run[]; until: number | null } | null;
  requests: OpenRequest[];
  events: AwaitedEvent[];
  /** The earliest deadline still ahead: of the current wait, a timer it waits on, or an open request's `~by`. */
  nextDeadline: number | null;
  timeline: Entry[];
  /** The runtime itself stopped with an error: a bug to show, not an outcome of the program. */
  error: string | null;
}

export interface SimulationOptions {
  program: Program;
  std: Program;
  start?: number;
  /** Called whenever the state changes. */
  onChange?: (state: SimulationState) => void;
  /** Gives the page a turn between slices of a long pass. */
  pause?: () => Promise<void>;
}

export class Simulation {
  private readonly team: Team;
  private readonly listeners = new Set<(state: SimulationState) => void>();
  private readonly pause: () => Promise<void>;

  private readonly timeline: Entry[] = [];
  /** Requests as the timeline last told them: a handover changes the holder. */
  private readonly requests = new Map<string, RequestInfo>();
  /** How many of the team's events the timeline has told. */
  private told = 0;
  private last: Pass | null = null;
  private computing = true;
  private error: string | null = null;
  private acted = false;
  private disposed = false;
  /** Everything done to the team, one at a time: the ledger must not change while a pass is under way. */
  private tail: Promise<unknown> = Promise.resolve();
  private snapshot: SimulationState;

  private constructor(options: SimulationOptions) {
    this.team = new Team(compile(options.program, { std: options.std }), { now: options.start ?? START });
    if (options.onChange !== undefined) this.listeners.add(options.onChange);
    this.pause = options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    this.snapshot = this.current();
  }

  /** Starts a program: it runs until it first waits, or for as long as it computes. */
  static async start(options: SimulationOptions): Promise<Simulation> {
    const simulation = new Simulation(options);
    void simulation.exclusive(() => simulation.pass());
    return simulation;
  }

  /** The state as of the last change. */
  get state(): SimulationState {
    return this.snapshot;
  }

  /** Whether the visitor has done anything yet: a run nobody touched can be replaced without losing anything. */
  get touched(): boolean {
    return this.acted;
  }

  /** Calls `listener` after every change; returns a function that stops it. */
  onChanged(listener: (state: SimulationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once the program has nothing left to do until the visitor acts. */
  async settled(): Promise<void> {
    for (let tail; tail !== this.tail;) await (tail = this.tail);
  }

  /** Stops the program for good, as Restart does. */
  dispose(): void {
    this.disposed = true;
  }

  // The visitor's actions --------------------------------------------------------

  /** Answers a request as its holder. An answer outside the request's form is not taken; the timeline says so, and the request stays open. */
  answer(requestId: string, value: Value): Promise<boolean> {
    return this.reply(requestId, { tag: "Answered", value });
  }

  refuse(requestId: string, reason: string): Promise<boolean> {
    return this.reply(requestId, { tag: "Refused", reason });
  }

  broke(requestId: string, reason: string): Promise<boolean> {
    return this.reply(requestId, { tag: "Broke", reason });
  }

  private reply(requestId: string, reply: Reply): Promise<boolean> {
    return this.act(() => {
      const request = this.team.ledger.requests[requestId];
      if (request === undefined || request.reply !== null) return false;
      // The visitor answers a request offered to a group as the first of the group, who takes it.
      const accepted = this.team.reply(requestId, request.candidates?.[0] ?? request.holder, reply);
      if (!accepted) {
        const answer = reply.tag === "Answered" ? literal(reply.value) : reply.tag;
        this.timeline.push({ kind: "rejected", at: this.team.now, request: requestInfo(request), answer, reason: this.team.ledger.evidence.at(-1)!.reason });
      }
      return accepted;
    });
  }

  /** Fires a fact, which then holds, or one occurrence of a stream. */
  fire(event: Extract<Value, { type: "source" }>, value: Value): Promise<boolean> {
    return this.act(() => {
      this.team.emit(event, value);
      this.timeline.push({ kind: "fired", at: this.team.now, source: source(event), mode: event.kind, value: literal(value) });
      return true;
    });
  }

  /**
   * Moves the clock forward. Deadlines and timers on the way fire at their own
   * times, in order, and the program reacts to each before the clock goes on.
   */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const next = this.snapshot.nextDeadline;
      if (next === null || next > target || next <= this.team.now || this.disposed) break;
      await this.act(() => this.team.advanceTo(next));
    }
    if (target > this.team.now) await this.act(() => this.team.advanceTo(target));
  }

  advance(ms: number): Promise<void> {
    return this.advanceTo(this.team.now + ms);
  }

  // Running ------------------------------------------------------------------------

  /** Does what the visitor did, then lets the program react: the promise resolves once it waits or ends again. */
  private async act<T>(action: () => T): Promise<T> {
    if (this.disposed) throw new Error("This simulation has been restarted");
    this.acted = true;
    return this.exclusive(async () => {
      if (this.disposed) throw new Error("This simulation has been restarted");
      // After the runtime itself failed, nothing more is done: the page shows the error.
      if (this.error !== null) return undefined as T;
      let result: T;
      try {
        result = action();
      } catch (error) {
        this.fail(error);
        return undefined as T;
      }
      await this.pass();
      return result;
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }

  /** One pass of the program, giving the page a turn whenever it has computed for a frame. */
  private async pass(): Promise<void> {
    try {
      const pass = this.team.slices();
      let last = performance.now();
      for (;;) {
        if (this.disposed) return;
        const slice = pass.next();
        if (slice.done) {
          this.last = slice.value;
          break;
        }
        if (performance.now() - last > 12) {
          this.publish(true);
          await this.pause();
          last = performance.now();
        }
      }
      this.publish(false);
    } catch (error) {
      this.fail(error);
    }
  }

  /** The runtime failed, not the program: the page shows it, and the run stops. */
  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.publish(false);
  }

  private publish(computing: boolean): void {
    this.computing = computing;
    this.snapshot = this.current();
    if (this.disposed) return;
    for (const listener of this.listeners) listener(this.snapshot);
  }

  // Observing ----------------------------------------------------------------------

  /** Tells the team's events since the last look, in order, as timeline entries. */
  private tell(): void {
    for (const event of this.team.events.slice(this.told)) {
      const { at } = event;
      switch (event.kind) {
        case "offered": {
          const info = requestInfo(event.request);
          this.requests.set(info.id, info);
          this.timeline.push({ kind: "offered", at, request: info });
          break;
        }
        case "handedOver": {
          const moved = { ...this.requests.get(event.id)!, holder: event.to };
          this.requests.set(event.id, moved);
          this.timeline.push({ kind: "handedOver", at, request: moved, from: event.from, to: event.to });
          break;
        }
        case "closed":
          this.timeline.push({ kind: "closed", at, request: requestInfo(event.request), outcome: event.reply });
          break;
        case "said":
          this.timeline.push({ kind: "said", at, to: event.to, text: event.text });
          break;
        case "waiting":
          this.timeline.push({ kind: "waiting", at, ...this.describe(event) });
          break;
        case "waited": {
          const requested = event.targets.some((target) => target.kind === "request");
          // A waitUntil that ran out; a wake-up by an event or a timer. A request's reply has its own entry.
          if (event.value === null) this.timeline.push({ kind: "elapsed", at, targets: this.describe(event).targets, open: requested });
          else if (!requested) this.timeline.push({ kind: "woke", at, outcome: wakeValue(event.value) });
          break;
        }
        case "handlerFailed":
          this.timeline.push({ kind: "handlerFailed", at, outcome: literal(event.reply) });
          break;
        case "ended":
          this.timeline.push({ kind: "ended", at, status: status(event), ...(event.error === null ? { outcome: literal(event.result!), error: false } : { outcome: event.error, error: true }) });
          break;
      }
    }
    this.told = this.team.events.length;
  }

  /**
   * What a wait is for, in words: "for @alice’s answer to “…”", "for the next
   * ciFailed("acme/api") or until 2026-11-08 09:00 UTC", then its deadline.
   */
  private describe(wait: Waiting): { targets: Run[]; deadline: Run[] } {
    const requests: Run[][] = [];
    const events: Run[][] = [];
    const timers: Run[][] = [];
    for (const target of wait.targets) {
      if (target.kind === "request") {
        const info = this.requests.get(target.id)!;
        const holder = participant(info.holder);
        const due: Run[] = info.by === null ? [] : [", due by ", time(info.by)];
        if (info.name === "judge") requests.push(["for the judge to decide ", quote(info.text), ...due]);
        else if (info.name === "run") requests.push(["for ", holder, " to finish ", quote(info.text), ...due]);
        else requests.push(["for ", holder, "’s answer to ", quote(info.text), ...due]);
      } else if (target.kind === "timer") {
        timers.push(["until ", time(target.at)]);
      } else {
        events.push(target.kind === "fact" ? ["for ", code(source(target.source)), " to hold"] : ["for the next ", code(source(target.source))]);
      }
    }
    const parts = [...requests, ...events, ...timers];
    const targets: Run[] = parts.length === 0 ? ["on ", code("never()")] : either(parts);
    const deadline: Run[] = wait.until === null ? [] : timers.length > 0 ? [", and no later than ", time(wait.until)] : [" until ", time(wait.until)];
    return { targets, deadline };
  }

  private current(): SimulationState {
    this.tell();
    const now = this.team.now;
    const pass = this.last;
    const wait = pass?.waiting ?? null;
    const awaited = new Set(wait?.targets.flatMap((target) => (target.kind === "request" ? [target.id] : [])));
    const open = this.team.open;
    const deadlines = [...(pass?.nextDue == null ? [] : [pass.nextDue]), ...open.flatMap((request) => (request.by === null ? [] : [request.by]))].filter((at) => at > now);
    return {
      now,
      status: pass === null ? "ready" : pass.status === "waiting" ? "suspended" : status(pass),
      computing: this.computing,
      waiting: wait === null ? null : { ...this.describe(wait), until: wait.until },
      requests: open.map((request) => ({ ...requestInfo(request), epoch: request.epoch, awaited: awaited.has(request.id) })),
      events: wait === null ? [] : wait.targets.flatMap((target) => (target.kind === "fact" || target.kind === "stream" ? [{ source: target.source, mode: target.kind }] : [])),
      nextDeadline: deadlines.length === 0 ? null : Math.min(...deadlines),
      timeline: [...this.timeline],
      error: this.error,
    };
  }
}

function requestInfo(request: LedgerRequest): RequestInfo {
  return {
    id: request.id,
    holder: request.holder,
    name: request.verb as RequestInfo["name"],
    text: request.text,
    options: request.verb === "confirm" ? [variant("Yes"), variant("No")] : request.options,
    form: request.form,
    by: request.by,
  };
}

/** How a program ended: a failure whose result is `Revoked` is the loss of the author's authority. */
function status(ended: { status: "waiting" | "completed" | "failed"; result: Value | null }): "completed" | "failed" | "revoked" {
  if (ended.status === "waiting") throw new Error("The program has not ended");
  return ended.status === "failed" && ended.result?.type === "variant" && ended.result.name === "Revoked" ? "revoked" : ended.status;
}

/** What a wake-up gave, for the timeline: nothing for `()` or a time, and the path an `or` took around the value. */
function wakeValue(value: Value): string | null {
  let inner = value;
  while (inner.type === "variant" && (inner.name === "First" || inner.name === "Second") && inner.args.length === 1) inner = inner.args[0]!;
  return inner.type === "unit" || inner.type === "time" ? null : literal(value);
}
