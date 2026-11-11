# Reference machine and simulated host

> Since 2026-11-11 the durable state of Norn is a ledger of requests, and a
> program is a pure computation over it (spec §9, §11.2). The ledger runtime
> is `src/runtime/ledger.ts`; see [The ledger runtime](#the-ledger-runtime)
> below. The stored-state driver described first (`Runtime`, `DurableStore`,
> the SQLite and memory stores, `SimulatedHost`) still runs the playground and
> most tests, and is removed once they run on the ledger runtime.

For the session-local memory adapter and `open Std`, see the
[browser runtime](browser-runtime.md). SQLite remains the Node persistence
adapter; importing the browser entry does not load it.

The reference machine executes the versioned AST in `src/frontend/ast.ts`.
`compile` pins its JSON document by SHA-256 and assigns deterministic node IDs.
The canonical AST is stored immutably by its hash. `Runtime.restore` reloads
that artifact rather than reparsing source with a newer parser. The compiler
also freezes a private AST copy so later caller mutations cannot change pinned
code. The machine stores control, continuation frames and lexical environments
as JSON; closures contain a code node ID and environment ID. No native function
or native stack is persisted. Reload the same code identity and machine ABI to
resume it. Freezing and numbering use explicit work stacks for deep trees.
Restoration hashes the original stored JSON bytes without running them through
a newer writer, so whitespace changes cannot replace an existing identity.

`advance` evaluates a finite time slice. Exhausting that slice yields a ready
machine, not a failed program. Tail calls discard completed sequence frames, and
unreachable environments are collected before checkpointing. Integers are
arbitrary precision decimal strings; floating values use explicit strings so
negative zero survives JSON. Non-finite arithmetic results fail visibly.

The machine supports immutable bindings, mutually recursive functions, labelled
arguments/defaults, variants, records, lists, tuples, interpolation,
expressions, guards, patterns, pipes, short-circuiting and function-local `?`.
Its `Effect` value is a suspension description, not permission to perform an
action.

`Runtime` drives that machine through `DurableStore`. Participant requests,
request assignment changes, waits and outgoing messages are committed with the
continuation under the checkpoint revision check. A worker that loses the check
cannot dispatch its abandoned intents. Temporary host/policy/storage failures
propagate without changing a checkpoint. Program errors commit an explicit
`{kind: "error", message}` machine state and an `execution.failed` notification
whose arguments are `{kind: "program-error", message}`. They never become
participant `Broke` replies. `fail(Answered(x))` is also a program error.
Request answers and wait outcomes are independent, including after timeouts and
handover. The host's `Policy` is required and is consulted for effects; a real
transport must check current permissions again at delivery.

`SimulatedHost` never starts an agent or contacts an external service. It shares
a `VirtualClock` injected into the SQLite store, advanced by `advanceTo`, and
scripted replies go through the same request ID/epoch checks. Use `reply` and
`emit` to supply inputs, then `pump` to run ready programs and expose simulated
messages. On restart, supply the same pinned code, store and current host clock;
the deadlines and subscription positions are already persisted. The store owns
observation time and persists its monotonic floor. External event timestamps
remain data. Hosts cannot pass a new clock value with a reply.

This is an incremental prototype, not the entire draft specification. Request
and event waits, tagged alternatives, one-shot timers, message effects and
scripted judging are implemented. Stream `map`/`filter`, durable structured
`scope`, configurable concurrent/coalescing stream processing, child programs,
real agent transports and host authorization integration are not implemented.
Unsupported operations fail visibly. The initial `forEach` machine helper is
sequential and rearms a relative timer after each callback; it does not claim
fixed-cadence or coalescing semantics. A production host also needs an alarm
adapter; advancing the virtual clock is not a background polling service.

An unsuccessful `forEach` handler reply (`Refused`, `Broke`, `NoReply`,
`Cancelled` or `Revoked`) atomically queues an `execution.handler_failed`
notification for the host to deliver to the program's author. Its continuation
then listens for the next occurrence. A crash cannot advance past reporting
without the notification intent, or create that intent twice for the same
checkpoint. The simulated host records only a simulated delivery receipt;
real author routing remains the production host's responsibility. Handlers receive the original event value. Unit and
`Answered(_)` rearm without a notification. Unchecked callbacks returning another
type discard the value; the typing rules reject them unless wrapped in
`ignore(x)`. `ignore` evaluates its argument and yields unit, so it can
explicitly discard an outcome as well. Calling `fail(o)` still terminates the
program and queues the terminal failure notice.

The same rule applies at the program boundary: a final unsuccessful reply
fails the program and queues its terminal notice. A function can still return
that reply for its caller to inspect; `Answered(_)` and ordinary final values
complete normally.

Every request verb (`ask`, `confirm`, `choose`, `run`, `judge`) returns a
handle. `r->wait` waits for its `reply`; `r->waitUntil(t)` returns
`Some(reply)` or `None`. The request's optional `~by` deadline closes it
`NoReply` independently of any wait. A wait timing out leaves it open;
`status(r)` remains `None` until the request actually ends. Handover retains
its original deadline and identity. Program termination cancels every request
it leaves open, including unchecked dropped handles.

An event wait returns its actual value, without `Answered`. `waitUntil` wraps
it in `Some`, or returns `None`. `or(a, b)` preserves the winning value in
`First` or `Second`, nesting those constructors through composition and
restart. `never()` persists an empty target set, without becoming runnable on
repeated scans; `never()->waitUntil(t)` can still return `None`.

The simulated host rejects invalid answers, retains them as evidence and
leaves the request open. `confirm` accepts `Yes`/`No`, `choose` an allowed
constructor, `ask` text, `judge` a boolean, and `run` the reference host's
report record `{text: string}`. An explicit `Refused` is distinct from an
invalid answer. Request authority is rechecked on resumption; losing event
observation authority ends the program `Revoked`. Policy or storage outages
still propagate without committing a program error.

Schema 8 and machine ABI `norn-cek:4` are required. Loading schema 7, restoring
an ABI 3 checkpoint or resuming an ABI 3 snapshot reports both versions and
refuses to reinterpret old semantics. A pinned AST does not bypass that fence.

`after` accepts a positive duration or an absolute time. An absolute time already
reached when the wait is registered is ready immediately; `every` continues to
require a positive duration. `show(x)` is a pure built-in, also usable as
`x->show`, with the same readable time, duration, participant and variant text
used by string interpolation.

The runtime remains separate from xMatrix's production mechanisms. No schedule,
approval, request or PR subscription has been migrated by this prototype.

## Try a simulated request

From the repository root, with Node 24 and `npm ci` already run:

```sh
node --input-type=module <<'JS'
import { parse } from './src/frontend/parser.ts';
import { compile } from './src/runtime/code.ts';
import { VirtualClock } from './src/runtime/clock.ts';
import { SqliteStore } from './src/runtime/sqlite-store.ts';
import { Runtime } from './src/runtime/runtime.ts';
import { SimulatedHost } from './src/runtime/simulated-host.ts';
import { text, variant } from './src/runtime/value.ts';

const parsed = parse('ask(@alice, "Ship?", ~by=1h)->wait');
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const clock = new VirtualClock();
const store = new SqliteStore(':memory:', clock);
try {
  const host = new SimulatedHost(store, clock);
  const runtime = new Runtime(compile(parsed.program), store, host);
  await runtime.create('demo');
  await host.pump(runtime);
  const offer = (await store.effects('demo')).find(e => e.operation === 'request.offer');
  const request = await store.request(offer.arguments.requestId);
  await host.reply(request, variant('Answered', text('yes')));
  await host.pump(runtime);
  console.log((await store.load('demo')).status); // completed
} finally {
  await store.close();
}
JS
```

To exercise expiry instead of a reply, replace the reply with `await
host.advanceTo(3_600_000)`, then pump. The request ends `NoReply` and its holder receives a
durable closure notice. The four source examples and restart/crash checks run with
`npm test`.

## The ledger runtime

`evaluate(code, ledger, now)` runs one pass: it starts the same machine from
the top, answers each effect from the ledger, and stops at the first wait
whose result is not recorded yet. It returns the requests it opened, what was
said, the open requests the program no longer reaches, the deadlines it moved
and the next time at which a pass could make progress by the clock alone. The
`Ledger` is plain JSON; no machine state is kept between passes.

- `settle(ledger, id, holder, reply, now)` records a participant's reply. A
  late answer, an answer from a former holder and an answer outside the
  request's form settle nothing and are appended to `ledger.evidence`.
- `establish` records a fact and `occur` a stream occurrence. A wait on a
  stream takes the first occurrence recorded after the wait began.
- `evaluate(code, ledger, now, {commit: false})` is the preview of spec
  §11.2: it leaves the ledger untouched.
- A request's identity is a digest of its verb, holder, arguments and labels
  other than `~by`, with its ordinal among identical requests in evaluation
  order.
- A pass that computes for more than its step budget without reaching a wait
  ends as a program failure.

Not implemented on the ledger runtime yet: authority checks and `Revoked`,
stream `map`/`filter`, declaring that an edited request continues an old one,
settling the occurrences of a standing duty separately, and dispatch.
`test/runtime/ledger.test.ts` covers the cases of spec §11.1 that do not
depend on those.
