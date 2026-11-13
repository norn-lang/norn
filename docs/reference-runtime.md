# Reference runtime: the ledger and a simulated team

The durable state of Norn is a ledger of requests, and a program is a pure
computation over it (spec §9, §11.2). The reference runtime is three small
modules under `src/runtime`:

- `machine.ts` executes the versioned AST of `src/frontend/ast.ts`, one time
  slice at a time, and stops at each effect;
- `ledger.ts` holds the `Ledger` and evaluates a program against it: one
  *pass*;
- `team.ts` is a simulated team with a virtual clock, for tests and the
  playground.

There is no stored machine state, no machine ABI version, no store schema and
no pinned code identity. The stored-state driver, its SQLite and memory stores
and its dispatch outbox were removed on 2026-11-11.

## The machine

`compile` gives a program's AST deterministic node IDs and a SHA-256 identity,
and links `open Std` (below). `start` and `advance` evaluate it with explicit
control, continuation frames and lexical environments, so deep programs need
no native stack. `advance` runs a finite slice; running out of it is not a
failure. Tail calls discard completed sequence frames, and unreachable
environments are collected after each slice. Integers are arbitrary-precision
decimal strings; floating values use explicit strings so negative zero
survives JSON. Non-finite arithmetic results fail visibly.

The machine supports immutable bindings, mutually recursive functions,
labelled arguments and defaults, variants, records, lists, tuples,
interpolation, guards, patterns, pipes, short-circuiting and function-local
`?`. Its `Effect` value describes what the program asks for. It is not
permission to do it, and the machine never performs it: `ledger.ts` answers
each effect and resumes the machine. A machine lives for one pass and is never
stored.

## A pass

`evaluate(code, ledger, now, options)` starts the machine from the top,
answers each effect from the ledger, and stops at the first wait whose result
is not recorded yet. Where the program makes a request the ledger holds, it
gets that request back; where it makes one the ledger lacks, the request is
opened. A request's identity is a digest of its verb, holder, arguments and
labels other than `~by`, with its ordinal among identical requests in
evaluation order. When a wait began, how it ended, what was said, what a
`status` read saw and which `forEach` handler failure was reported are ledger
entries, so a later pass takes the same path.

The `Pass` it returns says what was new:

- `status`, `result`, `error`: waiting, completed, or failed with a reply or
  with a program error's text;
- `log`: every new step in the order the program reached it (a request
  opened, handed over or closed by the program; something said; a wait begun
  or ended; a failed `forEach` handler), with `opened`, `said` and `cancelled`
  as views of it;
- `unreached`: open requests the program no longer reaches after an edit, and
  `rescheduled`: deadlines its text moved;
- `waiting`: what the wait it stopped at is for, with `or` flattened;
- `nextDue`: the earliest time at which another pass could make progress by
  the clock alone.

An opened request carries, besides its text, what it is `about` and the
`context` a `run` was given, each as a message shows it, so a host can put
them in front of whoever holds the request. `stop(ledger, now, reason)` ends
a program from outside: it cancels what the program left open and records
the program as failed with that reason, in one step.

A pass reads the ledger when it starts and writes it only when it finishes. A
pass that throws (a policy that cannot answer, for instance) leaves the ledger
exactly as it was, so a crash, a restart or a second worker is only another
pass. `evaluate(…, {commit: false})` never writes: it is the preview of spec
§11.2. `slices` is the same pass as a generator that yields between slices of
computation, for a host that must stay responsive.

**The end is recorded.** When a program completes or fails, the same commit
stores its result in `ledger.ended` and ends every request it left open
`Cancelled`. A later pass returns the recorded end and evaluates nothing.

**Program errors.** Division by zero, an unbound name, an unknown label, a
malformed `choose`, a non-positive timer, `fail(Answered(x))` and stream
`filter` (not implemented) end the program as a program failure with
the error's text. They never become `Broke`. Any other exception is the
runtime's own and propagates.

**The step budget.** A pass that computes for more than its budget (five
million machine steps by default) without reaching a wait or finishing ends
as a program failure: "The program computed for too long without waiting or
finishing". Only whole slices of computation count, so replaying a long
history of recorded effects does not use the budget up. There is no other
cap.

## Requests, facts and streams

- `settle(ledger, id, holder, reply, now, epoch?)` records a participant's reply.
  A `run` made by a checked and elaborated program carries the form of its
  report (docs/types.md §5a), and a report that does not fit is refused. With
  `epoch`, an answer given under an earlier holding of the request does not
  count. A
  late answer, an answer from someone who is not the holder and an answer
  outside the request's form settle nothing and are appended to
  `ledger.evidence`. `confirm` takes `Yes`/`No`, `choose` one of its options,
  `ask` text, `judge` a boolean, and `run` a report record `{text: string}`.
  `NoReply` cannot be given: only the clock decides it.
- `settleDue(ledger, now)` ends every open request whose `~by` has passed
  `NoReply`, at its deadline. `settle` and `evaluate` call it first, so the
  reply is a function of the recorded history and the clock, never of when a
  worker looked. A `~by` already reached when the request is recorded ends it
  at once.
- `take(ledger, id, taker, now)` gives a request offered with `anyOf` to one of
  its group; an answer from one of the group takes it in the same step.
- `establish` records a fact, which then holds; `occur` records one stream
  occurrence. Both refuse timers, `never()` and compositions. A wait on a fact
  that already holds ends at once. A wait on a stream takes the first
  occurrence recorded after the wait began.
- `r->waitUntil(t)` leaves the request open when its own deadline comes
  first; `status(r)` stays `None` until the request ends. `handOver` keeps the
  request's identity and `~by` and raises its epoch. `or` keeps the winning
  value in `First` or `Second` through nesting. `map` occurs when its stream
  does: the ledger records the stream's own value, and the function runs on
  it in every pass that reads it. `never()` never occurs, and
  `never()->waitUntil(t)` still returns `None`.
- `after` takes a positive duration or an absolute time; `every` a positive
  duration. `forEach` is sequential and re-arms after each callback; it does
  not claim a fixed cadence or coalescing.

## Authority

`options.authorize(effect)` is the author's current authority (spec §10). A
pass asks it only for effects the ledger does not hold yet: opening a
request, saying something, reading a status, cancelling, handing over, and a
wait that has not ended. What is recorded has happened and is not asked
about again.

- Authority lost at a wait on a request ends that request `Revoked`; the wait
  returns it like any other reply.
- Authority lost anywhere else, including a wait on a fact, a stream or a
  timer, ends the program as failed with `Revoked`, and the requests it left
  open end `Cancelled`.

Leaving `authorize` out means the host vouches for the whole pass. A real
transport must still check permissions again when it delivers.

## The simulated team

`Team` holds one program, its ledger and a virtual clock. It never starts an
agent or contacts a service.

- `advanceTo(at)` moves the clock forward and ends requests whose deadline it
  reaches; `reply(id, holder, reply)` answers as a participant;
  `emit(source, value)` makes a fact hold or a stream occur; `run()` is one
  pass, and `slices()` the same pass in slices.
- `permitted` is the author's authority, read by every pass.
- `events` is what happened, in order: requests offered, handed over and
  closed, things said, waits begun and ended, handler failures, the end.
- `notices` is what the author is told: each failed `forEach` handler, once,
  and the program ending without success (a reply other than `Answered`, or a
  program error).

Nothing is dispatched: an entry in `events` means the simulation shows it,
never that a recipient received it. A production host needs delivery with
reconciliation (spec §11, point 3), an alarm for `nextDue`, and a way to
serialise passes over one ledger.

**Restart.** The `Ledger` is plain JSON. Persisting it is
`JSON.stringify(team.ledger)`; taking the program up again in another process
is `new Team(code, {now, ledger: JSON.parse(text)})`. Nothing else crosses a
restart, and the same holds for a newer version of the program or the
runtime: it is evaluated against the same ledger, and its difference is what
`{commit: false}` shows.

## Browser entry and Std

`src/runtime/browser.ts` exports `compile`, the ledger functions, `Team` and
the value constructors. Its dependency graph has no Node module or global;
CI type-checks it without Node types (`tsconfig.browser.json`), and
`test/runtime/browser-import.test.ts` loads it in an isolated context that
refuses every non-relative import.

`compile(program, {std})` links `open Std` to the supplied library AST: the
library's bindings initialise once in a private lexical scope, each `open`
brings its exports into scope, and later bindings of the caller can shadow
them without changing the library's own. A program compiled with another
library text is another program. The runtime never reads a file or fetches a
dependency by itself; a program with an unlinked `open Std` is refused.

`compile(program, {sources})` names the facts and streams the program's host
supplies, so that a call of one gives a source the program can wait on:
`hostSources(host)` reads them from the host's interface file. Without it a
program may wait on the reference host's sources only.

## Try a simulated request

From the repository root, with Node 24 and `npm ci` already run:

```sh
node --input-type=module <<'JS'
import { parse } from './src/frontend/parser.ts';
import { compile } from './src/runtime/code.ts';
import { Team } from './src/runtime/team.ts';
import { show, text } from './src/runtime/value.ts';

const parsed = parse('ask(@alice, "Ship?", ~by=1h)->wait');
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const team = new Team(compile(parsed.program));
console.log(team.run().status); // waiting
const [request] = team.open;
team.reply(request.id, request.holder, { tag: 'Answered', value: text('yes') });
const pass = team.run();
console.log(pass.status, show(pass.result)); // completed Answered(yes)
console.log(JSON.stringify(team.ledger, null, 2)); // all there is to persist
JS
```

To see the deadline instead of a reply, replace the reply with
`team.advanceTo(3_600_000)`. The request ends `NoReply`, the program fails
with it, and `team.notices` holds what its author is told. The five source
examples and the contract cases run with `npm test`.

## Not implemented

Stream `map`/`filter`, structured `scope`, concurrent or coalescing stream
handlers, child programs, declaring that an edited request continues an old
one, settling the occurrences of a standing duty separately, dispatch and
delivery receipts, real agent transports, and a multi-writer protocol for the
ledger. Unsupported operations fail visibly. The runtime is separate from
xMatrix's production mechanisms: no schedule, approval, request or PR
subscription has been migrated to it.
