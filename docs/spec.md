# Norn language spec (draft v0)

> Status: design draft, 2026-11-06, revised 2026-11-07, 2026-11-11 and
> 2026-11-15, open to change. The request and reply model was redesigned for
> clarity: see [Changes from the first draft](#15-changes-from-the-first-draft).
> The durable state became a ledger of requests instead of a stored program
> state: see [The ledger](#16-the-ledger-2026-11-11). Whoever holds a request
> can delegate it: see [Delegation](#17-delegation-2026-11-15), and can say ahead
> of time what becomes of a kind of request: see
> [Standing policies](#19-standing-policies-2026-11-27). A local reference
> implementation (a parser, an evaluator over the ledger and a simulated
> team) runs the five §3 examples from source
> ([reference runtime](reference-runtime.md)). [xMatrix](https://xmatrix.page) is the
> first host. The language sections were drafted by Claude.
> The runtime protocol (§11) is based on research by Codex
> ([runtime research](research/runtime.md)). The formal model (§12) draws on
> two surveys ([models](research/models.md),
> [choreographies](research/choreographies.md)). The project was started at
> [Lambda Labs](https://github.com/LambdaLabsHQ).

## 1. What Norn is

Norn is a language for collaboration among many agents and many people. It
describes how a group of autonomous participants get something done together:

- who is responsible for what;
- who asks whom;
- what depends on what;
- what counts as done;
- how the work carries on when circumstances change.

Norn does not do the work itself; the participants do.

Its participants are people, and complete AI agents of any kind. They are not
model calls or tools. Every call to a participant is a *request* to someone
who decides how to do the work. They may answer late, decline, fail, or lose
the authority to act.

A person is one kind of participant, not a required step. Drafting, reviewing,
deciding, verifying and taking over failed work can all be done by agents. No
word of the language is reserved for people, so a role held by a person today
can be given to an agent by changing who the role names, and the program stays
as it is. People appear where they choose to, and where only a person can act:
providing a secret, spending money, taking an action that cannot be undone.

That places Norn one level above agent frameworks such as LangGraph, whose
nodes are model calls and functions inside one agent. It is also
*choreography, not orchestration*: there is no central conductor. Each
program belongs to a person, an agent or a document section, and waits on
others the way a team member does.

### 1.1 Motivation

A team of people and agents needs several ways to suspend work and resume it
later:

- schedules;
- event triggers, such as "on merge" or "on CI failure";
- reminders;
- "waiting for your reply";
- pull-request subscriptions;
- approval and question cards;
- "keep going until it's done".

Products usually build each of these as its own feature. None of them says
what happens when the awaited thing never comes.

In the workspace where Norn was conceived, ten days of production data showed
the cost:

- 36 of 44 decisions that were waiting on a person closed silently by default.
- About 24 agent launches failed without anyone being told.
- 13 daily schedules woke on a timer only to ask whether anything had changed.

Each case is the same relationship gone wrong: someone asks, someone answers
or doesn't, and the work goes on. A request was leaked, had nobody to handle
it, was woken by a timer instead of by its event, or was dropped on failure.
Norn expresses that relationship in a language. Each of the features above
becomes a short program, and the standard library is written in Norn itself.

## 2. Design principles

- **Programs, not graphs.** Nobody writes nodes and edges. Dependencies are a
  program's control flow and data flow.
- **Turing complete.** Safety comes from capabilities (§10), not from
  limiting what can be expressed.
- **Code is first-class content.** Programs live next to the documents they
  keep true, and are read as code.
- **Modern functional, with a syntax that reads well:**
  - immutable values;
  - everything is an expression;
  - algebraic data types and pattern matching;
  - events as streams composed with pipes;
  - a ReScript-flavoured surface close to languages models already write well.
- **Event-driven.** A program is evaluated again when something it depends on
  happens. Nothing polls.
- **The ledger is the truth.** What a team shares is a ledger of requests: who
  asked whom for what, about which thing, by when, and who holds it now. A
  program is a pure computation over that ledger (§9), so it can be read,
  previewed and changed while it runs.
- **One holder, always.** Everything somebody counts on has exactly one
  holder at any moment, and a place to go when that holder fails.
- **Towards automation.** When a step needs a person today, that is usually a
  limit of capability or infrastructure, not a property of the step. The
  language never makes a person necessary.
- **The language is separate from any host.** A host supplies participants,
  events and storage (§11). xMatrix is the first host.

## 3. A first look

```norn
// A decision with a declared default. Only the request's own deadline takes
// the recommendation: a refusal is not consent.
switch confirm(@alice, "Ship the billing probe?", ~by=2026-11-07T12:00Z)->wait {
| Answered(Yes) | NoReply => run(@auto, "Ship it as recommended: at most US$0.10")->wait
| Answered(No) => run(@auto, "Record the decision: don't ship")->wait
| other => fail(other)
}
```

```norn
// A chain of facts in the world, then an agent.
let pr = merged("acme/api#1436")->wait
switch released(Beta, ~containing=pr)->waitUntil(1d) {
| Some(release) =>
  machineUpdated(~machine="win-builder", ~atLeast=release.version)->wait
  run(@codex, "Check out acme/api on win-builder and confirm the long-path fix")->wait
| None => run(@alice, "#1436 did not reach a beta within a day: find out why")->wait
}
```

```norn
// A standing duty.
every(1d)
->or(ciFailed("acme/api"))
->forEach(_ => run(@auto, "Check production health and fix the riskiest issue")->wait)
```

```norn
// A follow-up that hands the same request over from an agent to a person.
// Handing over moves who continues; it does not undo what the agent may
// already have done, which the host still reconciles.
let q = ask(@codex, "Is the build machine still overheating?")
let reply = switch q->waitUntil(1h) {
| Some(r) => r
| None => q->handOver(@alice)->wait
}
say(doc"ops#machines", reply?)
```

```norn
// Keep going until a judged condition holds.
let rec push = () => {
  let report = run(@claude, "Move #1439 forward until it is merged and verified live")->wait?
  if judge("merged and verified live", ~about=report)->wait? {
    Answered(report)
  } else {
    prActivity("acme/api#1439")->or(after(2h))->wait
    push()
  }
}
push()?
```

## 4. Values and types

Types are inferred with Hindley–Milner inference. Only built-ins and host
interfaces carry written signatures, so ordinary programs need no annotations.
The typing rules, built-in signatures and exhaustiveness checks are in
[Types in Norn](types.md).

| Type | Literals and notes |
|---|---|
| `string`, `int`, `float`, `bool`, `unit` | As in ReScript, except that `int` has arbitrary precision: there is no 32-bit overflow. Templates are `` `…${x}…` `` and interpolate strings. |
| `time`, `duration` | `2026-11-07T12:00Z` (always with its offset); `30m`, `2h`, `1d`, `1w`. A deadline (`~by=`, `waitUntil`, `after`) takes either a time or a duration from now. |
| `participant` | `@alice`, `@codex`, `@codex:2` (one instance), `@auto` (the host picks a suitable agent). People and agents are values: they can be passed, stored and compared. Naming a participant grants nothing (§10). |
| `ref` | A reference to a host document or conversation, e.g. `doc"<id>#<section>"`, rendered as its title. |
| `list<'a>`, records, tuples, `option<'a>`, `result<'a, 'e>` | As in ReScript. |
| `request<'a>` | A durable handle to a request made of a participant. Every request verb returns one (§6.1). |
| `reply<'a>` | `Answered('a) \| Refused(string) \| NoReply \| Broke(string) \| Cancelled \| Revoked`: how a request ended. |
| `yesno` | `Yes \| No`: the answer to `confirm`. |
| `either<'a, 'b>` | `First('a) \| Second('b)`: which of two streams happened, with its value (§6.2). |
| `event<'a>`, `stream<'a>` | A fact that may hold, or occurrences that keep happening (§6.2). |
| User variants | `type choice = Ship \| Drop \| Later(duration)` |

### 4.1 Replies

A `reply` is the language's answer to autonomy. Each case names who acted
and why, and means one thing only:

| Case | Who acted | Meaning |
|---|---|---|
| `Answered(x)` | the holder | The participant asked answered, or someone they delegated the request to answered for them (§7); `x` is the answer. |
| `Refused(why)` | the participant asked | They explicitly declined. A delegate's refusal gives the request back instead (§7). |
| `NoReply` | the clock | The request's own `~by` deadline passed with no answer. Only a request made with `~by` can end this way, and the store's clock decides it (§11.1). |
| `Broke(why)` | the participant asked | They tried, and could not do it. A delegate's report gives the request back instead (§7). |
| `Cancelled` | the program | We called the request off, with `cancel`, or by ending the program (§11.1). |
| `Revoked` | the authority | The authority behind the request was lost (§10). |

- **A wait running out is not a reply.** `r->waitUntil(1h)` gives
  `option<reply<'a>>`. `None` means only that this wait ran out; the request
  stays open, and the program decides to keep waiting, `cancel` it, or
  `handOver` the same request to someone else.
- **An answer the host cannot map is not a reply.** An invalid answer to
  `confirm` or `choose`, such as a free-text "maybe", is refused at the host's
  boundary and kept as evidence. The request stays open. It never becomes
  `Refused`, and never a choice.
- **Facts and streams are not requests**, so they have no replies: waiting on
  one gives its value (§6.2).

Types make a program acknowledge every case. They cannot prove it handles
each case well, because `NoReply => ()` type-checks too. What the runtime
guarantees instead (§10, §11):

- state is visible;
- results can be checked;
- every failure has an owner.

## 5. Syntax

Norn is a subset of ReScript with a few additions. Source files use the `.norn` extension.

- **Bindings and functions:** `let x = …`, `let f = (a, ~b, ~c=default) => …`,
  `let rec`. Blocks return their last expression. Pipe with `->`.
- **Control:** `if`, `switch` with patterns, recursion. There is no `while` and
  no mutation. Repetition is `forEach` over a stream, or recursion.
- **Additions:**
  - participant and reference literals;
  - time and duration literals;
  - postfix `?`, with one rule: on a `reply` it unwraps `Answered`, on an
    `option` `Some`, on a `result` `Ok`. Anything else returns from the
    current function at once, unchanged. At the top of a program it ends the
    program: the runtime records that value as the program's result and tells
    the author (§10).

    If `e : reply<'a>`, then `e? : 'a`, and the enclosing function must itself
    return some `reply<'b>`: the other cases carry no `'a`, so they are
    returned as they are. `option` and `result` work the same way, and a
    `result` keeps its error type. That is why the `push` loop in §3 ends with
    `Answered(report)`, not `()`. `?` does not wait: on a request, write
    `r->wait?`.
- **No function colouring.** There is no `async` or `await` keyword. A built-in
  that waits may suspend, and so may any function that calls one.
- **Left out of v0:**
  - modules beyond `open Std`;
  - exceptions, mutation and classes;
  - foreign-function interop;
  - macros.

## 6. Effects

Effects are the only way a program touches the world. Each one is performed as
the program's author, and is authorized at the moment it is performed (§10).

### 6.1 Built-ins

There is one verb for each kind of request. Every verb returns a handle at
once, and nothing waits until the program says `->wait`. `~by=` is always the
request's own deadline (§11.1).

| Built-in | Waits? | Meaning |
|---|---|---|
| `ask(who, question, ~by=?, ~about=?) : request<string>` | no | Asks a person or an agent a question with a free-text answer. |
| `confirm(who, question, ~by=?, ~about=?) : request<yesno>` | no | Asks for a yes or a no. |
| `choose(who, question, [A, B], ~by=?, ~about=?) : request<'a>` | no | Asks for one of the options, which are constructors of one variant type the program declares. |
| `run(who, task, ~context=?, ~by=?, ~about=?) : request<'a>` | no | Starts a run of `who` on `task`, written in natural language. Its answer is the report. The report has the type the program uses it as: a verdict, a pull request, a list. The host tells the holder that form and refuses a report that does not fit. Where nothing decides the type, it is the host's `report`: text, changes made, evidence. |
| `judge(condition, ~about=?) : request<bool>` | no | Asks the host's judge whether a condition written in natural language holds. |

`~about` names what a request is about: a pull request, a document, a release, an earlier report. It is part of the request's identity (§9), so a request about a new version of a thing is a new request, and an answer about the old version does not stand for it.
| `r->wait : reply<'a>` | yes | Waits until the request ends. |
| `r->waitUntil(t) : option<reply<'a>>` | yes | Waits until the request ends or the time or duration `t` passes, whichever is first. `None` means only that this wait ran out; the request stays open. |
| `anyOf([a, b], ~except=?) : participant` | no | A group as one participant. A request to it is offered to all of them; whoever takes it first holds it, and nobody else does. `~except` leaves one out, as in "the reviewer is not the author". |
| `first([r1, r2]) : (request<'a>, reply<'a>)` | yes | Waits for the first of several requests to end, and gives that request with its reply. The others stay open. |
| `handOver(r, who) : request<'a>` | no | Moves the same request to another participant, with a new epoch (§12). The request keeps its `~by`. The program hands a request over; the participant it asked delegates one (§7). |
| `cancel(r) : unit` | no | Calls the request off. It ends `Cancelled` unless it has already ended. |
| `status(r) : option<reply<'a>>` | no | Looks at the request without waiting: `None` while it is open. |
| `say(to, text) : unit` | no | Posts a message to a participant or a `ref`. |
| `now() : time` | no | The time the program resumed. It is stable within one step. |
| `show(x) : string` | no | Renders a value as text for people: a time in ISO 8601, a duration as `1h` or `1d`, a participant as `@alice`, a variant by its name. |
| `fail(r) : 'b` | no | Ends the program with a reply other than `Answered` as its result (§10). |
| `ignore(x) : unit` | no | Sets a value aside on purpose. A request cannot be ignored: wait for it, hand it over, return it, or `cancel` it. |

**`judge` answers a `bool`, not a `yesno`.** `yesno` is the vocabulary a
person is offered: two named answers on a card, matched by name as
`Answered(Yes)`, so that consent is never a computed truth value. A judge does
not consent to anything; it decides whether a stated condition holds, which is
a truth value, and a program uses it as one: `if judge("merged", ~about=report)->wait? { … }`.

**A request is never dropped silently.** A `request<_>` must be waited on,
handed over, returned from a function, or `cancel`ed, and a `reply<_>` must be
inspected, propagated with `?`, ended with `fail`, returned, or `ignore`d. The
checker enforces both ([types](types.md) §6a). So a bare
`run(@codex, "Fix the build")` as a statement is an error that suggests
`->wait`. It matters because a program's open requests are cancelled when the
program ends (§11.1).

Planned next, not in v0:

- structured child programs (`spawn` and `join`) for asking several
  participants at once;
- `scope(f)` and request races (`any`). `scope` runs `f`, and every request
  started inside it is cancelled when `f` ends, loses an `any`, or passes its
  deadline (§12). They need durable scopes in the runtime first.

### 6.2 Facts and occurrences

These are two different kinds of waiting, kept apart on purpose. Neither is a
request, so neither has a reply: nobody answers, refuses or breaks a fact.

Which facts and streams exist is up to the host (§11). The ones below are
examples from the xMatrix host; only `every`, `after` and `never` are part of
the language.

- **`event<'a>` is a fact that may already hold.** Examples:
  - `merged("owner/repo#n")`
  - `released(Beta, ~containing=pr)`
  - `machineUpdated(~machine="win-builder", ~atLeast=version)`
  - `replied(messageRef, ~from=?)`
  - `runEnded(runRef)`

  Waiting for a fact that already holds returns at once. The host observes the
  fact and registers the wait as one step, so a change cannot slip between
  observing "false" and starting to wait.
- **`stream<'a>` is occurrences that keep happening.** Examples:
  - `every(d)`, whose ticks fall every `d` from when the program started:
    work between two ticks does not push the next one back, and ticks that
    passed while the program was busy are not made up
  - `every(d, ~from=t)`, the same beat counted from the time `t`: the first
    tick is at `t`, as in `every(7d, ~from=2026-11-16T09:00Z)` for every
    Monday at nine
  - `after(t)`, which happens once, at a time or after a duration from now;
    both give the `time` they fired
  - `ciFailed("owner/repo")`
  - `prActivity("owner/repo#n")`
  - `docChanged(ref)`
  - `message(ref, ~from=?)`
  - host app events

  `s->wait` returns the next occurrence after the program starts listening.
- **Waiting gives the value itself.** `merged(pr)->wait : pr`, and
  `after(1h)->wait : time`. `x->waitUntil(t) : option<'a>` is `None` if `t`
  passes first.
- **Losing authority** while waiting on a fact or a stream ends the program as
  `Revoked` (§10). There is no reply for the program to inspect, because the
  program itself, not a request, lost its authority.

Streams compose:

- `a->or(b) : stream<either<'a, 'b>>` happens when either does, and keeps the
  value and where it came from: `First(x)` from `a`, `Second(y)` from `b`.
  Nesting keeps every value: `a->or(b)->or(c)` gives
  `either<either<'a, 'b>, 'c>`.
- `map` and `filter` transform and select occurrences.
- `s->gather : stream<list<'a>>` occurs when `s` does, with every occurrence
  of `s` that has arrived and is not yet taken, oldest first. A loop that
  gathers is handed each of what arrived while it worked, not only the
  latest: `every(1d)->or(ciFailed("acme/api")->gather)->forEach(…)`.
- `never()` is a stream with no occurrences.
- `forEach` handles every occurrence until the program ends. Its handler
  returns `()` or a `reply`. `Answered(_)` or `()` takes the next occurrence;
  any other reply is reported to the author, and the loop goes on. To end the
  program, the handler calls `fail`. What arrives while
  the previous occurrence is still being handled is not lost and does not
  pile up: the default is to coalesce. When the handler has finished, the
  loop handles once more, with the latest value, or under `gather` with all
  of them. A timer's ticks that passed are not made up. Running them one
  after another or concurrently is declared on the `forEach`; the reference
  runtime implements neither yet.

An occurrence caused by the program's own effects never wakes that same
program. That is the guard against loops, and it needs no count limit.

### 6.3 Actions

Some things need no judgement when the time comes: a post that was written
and approved yesterday goes out at nine. Starting an agent run for that
spends a model on pressing a button, and makes the post depend on an agent
being there. `Actions` is the standard capability through which a program has
the host do one thing in a connected app, with nobody in between. It is the
outgoing counterpart of `Events`: one interface, no app names in the
language, and application libraries (`X`, `Gmail`) written in Norn on top.

An action is done in two requests, both of the host:

| Built-in | Meaning |
|---|---|
| `Actions.action(app, name) : Actions.action<'i, 'o>` | Names an action of a connected app. No effect. The checker reads `'i` and `'o` against the app's connector manifest. |
| `Actions.prepare(action, input, ~by=?, ~about=?) : request<Actions.prepared<'o>>` | Fixes exactly what will be done, and has the host admit it. Nothing is done yet. |
| `Actions.perform(prepared, ~by=?) : request<'o>` | Does what was prepared, once. Its answer is what the action gives back. |

```norn
type post = {account: string, text: string}
type posted = {url: string}
let postAction: Actions.action<post, posted> = Actions.action("x", "post")

let ready = Actions.prepare(postAction, {account: "@acme", text: "Stop pasting API keys."})->wait?
after(2026-11-24T01:00Z)->wait
Actions.perform(ready)->wait
```

An application library gives the same thing its own words, so a program
reads `X.preparePost("@acme", text)` and `X.publish(ready)`.

- **Two requests, because admitting and doing happen at different times.**
  What an action may do without asking is the host's policy for that app, not
  the program's: one host lets its author's programs post freely, another
  puts every post in front of a person. `prepare` is where that policy is
  met, with the input fixed, so whoever admits it sees exactly what will be
  done. `perform` is when it is done. Between them the program is free to
  wait for a time, a beat or an event, in the words it already has. A person
  can therefore admit a week of posts in one sitting and each goes out in its
  slot, with nobody awake.
- **The replies** (§4.1):

  | | `prepare` | `perform` |
  |---|---|---|
  | `Answered(x)` | admitted; `x` is the prepared action | done; `x` is what the action gave back |
  | `Refused(why)` | the host's policy, or whoever it asked, declined | the admission no longer holds, or it was already performed |
  | `Broke(why)` | it cannot be prepared: bad input, the app is not connected | it failed, or its outcome is not known |
  | `NoReply` | `~by` passed and nobody had decided | `~by` passed before it was done |

- **At most once.** A prepared action is performed once: a second `perform`
  of it is `Refused`. Both requests are ledger entries, so a later pass, an
  edit or an upgrade finds them again and does nothing twice (§9). When the
  host cannot tell whether the action happened, because the app's answer was
  lost, the reply is `Broke` and the host does not try again: a program that
  wants a second attempt prepares a new action, which is admitted anew.
- **A prepared action is not a credential.** It is a value only `prepare`
  answers, it names its request, and it is good only in the ledger that
  holds that request. Authority stays current (§10): the host admits
  `perform` only while what was admitted still holds, such as the same
  connection, the same account and an approver who may still approve.
  Otherwise the reply is `Refused`, and nothing is done.
- **The host holds these requests**, so they are nobody's to delegate or to
  hand over. `cancel` calls one off; a prepared action that was never
  performed is void when the program ends.
- **A read changes nothing, so nobody admits it.** `Actions.read(action, input)`
  asks the app something (a query, a count, a list) and is answered at once with
  the program author's own access to that app; only an action the connector
  declares as a read can be read. It lets a program look before it asks anyone:
  a check every half hour costs no agent run, and only an answer that says
  something is wrong asks someone to act.
- **Requests are made where the program runs.** `List.map` and the stream
  combinators take pure functions, so several actions are prepared with a
  recursive function, as several questions are asked.

### 6.4 Holds

Events say what happened; some things are simply so for as long as they are:
a site's domain and languages, a product's tier, whether a connector is still
granted. `Holds` is the standard capability for what holds now
(`interfaces/holds.norn`). A Space names its kinds of facts as types in its own
libraries, and a host says what holds for each thing of a kind.

- **Facts flow; code is pinned.** A changed value reaches the program without
  anyone adopting it, as an occurrence does. What a program does with it is
  its code, which changes only by an edit.
- **A program samples.** `Holds.sample(h)` reads what holds once, in the scope
  that asks, and the ledger records what it read. Every later pass of that
  scope reads the same, so a round at work is never changed under it, and the
  next round reads what holds then.
- **Membership is a stream.** `Holds.members(kind)` gives each thing as it
  starts or stops having the kind; a loop over it begins with the whole set.
  `Holds.changes(h)` gives each new value of one thing. A value the host holds
  quietly, such as one the program's own work wrote back, occurs on neither, so
  a program does not wake itself.
- **`Std.each`** keeps one branch per thing that has a kind, for as long as it
  has it. It is written in Norn on `forEach(~each=Together, ~per=…)`: under
  `~per`, a newer occurrence in a partition takes the place of that
  partition's round and cancels what it left open, and other partitions go on.

```norn
open Std
type site = {domain: string}
each(Holds.kind("page", "site"), h =>
  every(1d)->forEach(~key="daily", _ => switch Holds.sample(h) {
  | Some(s) => ignore(run(@claude, `Report on ${s.domain}`)->wait)
  | None => ()
  }))
```

A **fact block** is how a Page states a fact: a block whose header names a
type (`norn 1 facts Products.site`) and whose body is a value of it. The body
holds only values: literals, lists, tuples, records and constructors of them.
It has no names, functions, participants or effects, so reading one runs no
code and carries nobody's authority. `checkFacts` checks a block against its
type and gives the value.

## 7. Where programs live

A program lives next to what it keeps true. In xMatrix that is a `norn` block in
a Page section or a message.

- **Starting is explicit.** A program starts through a host's admission step,
  the same one that admits other work. Code quoted in a document, or shown as
  an example, is content, not a running program.
- **The host shows each running program where it lives**, in words. For
  example: "waiting for Alice's answer, due 11-07 12:00 UTC; with no reply,
  the recommendation".
- **The participant being asked sees the same request**, with who is asking
  and its `~by` deadline. They can answer it, refuse it, or report that they
  could not do it. A message such as an ETA is a message: it does not move the
  deadline, which belongs to the program text.
- **The participant being asked can delegate it** to one participant, who
  answers it for them: a person who cannot judge a question passes it to an
  agent who can, or an agent passes to its person a decision it should not
  make. The participant asked is the one the program named, handed the
  request over to, or who took it from a group.
  - It stays the same request, with the same question, form and `~by`, under
    a new epoch (§12). The program does not see it: a reply carries no name,
    so a delegated request looks to the program like one whose holder asked
    someone and passed the answer on, which a holder could always do. What
    changes is the record: the ledger says who answered, and for whom.
  - Only the holder delegates, and only once: the delegate answers, or gives
    the request back. A delegate's `Refused` or `Broke` gives it back to
    whoever delegated it and ends nothing, because only the participant asked
    can decline the request or fail it (§4.1). Whoever delegated it can take
    it back while it is open, and then answer it themselves.
  - A request is never delegated to a participant it leaves out, such as the
    `~except` of the group it was offered to, which holds after one of the
    group has taken it. The host admits a delegation only when the program's
    author may ask that participant and the participant may see the request
    (§10). The judge's judgements are not delegated.
  - The program stays in charge: its `handOver` or `cancel` ends a delegation,
    and the request's deadline passes as it would have.
- **The participant being asked can decide ahead of time.** A *standing
  policy* says what becomes of a kind of request whenever one is asked of
  its participant, with nobody there:

  ```norn
  type secretUse = {secret: string, conversation: string}
  let policy = (r: secretUse) =>
    if r.conversation == "patrol" && r.secret == "database-read" { AnswerWith(Yes) }
    else if r.secret == "database-migrate" { Mine }
    else { Delegate(@auditor) }
  ```

  - It is a program that binds `policy` to a function from what the request
    is about to a `standing<'a>`. The host supplies the record type as
    `asked`; the example writes it out to be read on its own:

    | The policy decides | What the host does, as the participant's own move |
    |---|---|
    | `AnswerWith(x)` | answers the request with `x`, as its participant |
    | `Decline(why)` | refuses it, as its participant |
    | `Delegate(who)` | delegates it to `who`, under the rules above: `who` answers it or gives it back |
    | `Mine` | nothing: the request waits for its participant, as without a policy |

  - **A policy has no effect.** It asks nobody, says nothing and waits for
    nothing, and it reads only what the request is about. The same request is
    therefore decided the same way every time, a policy can be shown what it
    would decide before it is admitted, and words in a request cannot move a
    policy that does not read them. Where a judgement is wanted, the policy
    names who makes it with `Delegate`, and that participant answers as a
    delegate does.
  - **A host says which kinds of request a policy may decide**, each by two
    types: the record such a request is about, which the policy sees as
    `asked`, and what answers it. The checker checks the policy against
    them, so a policy cannot answer a yes-or-no with text or read a field
    the kind does not have, and it decides every request of the kind.
  - **The request does not change.** The program that asked sees a reply, and
    a reply carries no name. The ledger records who answered and for whom, as
    it does for a delegate: here, that the participant's policy did.
  - **A policy that cannot decide decides nothing.** One that fails, or whose
    answer does not fit the request, leaves the request with its participant.
    A request is never lost to a policy.
  - A policy stands for its participant only (§10). It is not a way for a
    program to answer its own requests, and it gives nobody the participant's
    other authority.
- **Shared functions live in a standard library** written in Norn and opened
  with `open Std`.

## 8. The standard library, in Norn

Higher-level features are functions, not product features:

```norn
let remind = (who, text, ~at) => {
  after(at)->wait
  ask(who, text)->wait
}

let decide = (who, question, ~options, ~recommend, ~by) =>
  switch choose(who, `${question}\nRecommended: ${recommend->show}. No answer by ${by->show} means the recommendation.`, options, ~by)->wait {
  | Answered(choice) => choice
  | NoReply => recommend             // the declared default, and only when nobody replied in time
  | other => fail(other)
  }

let followUp = (who, text, ~within, ~escalateTo) => {
  let q = ask(who, text)
  switch q->waitUntil(within) {
  | Some(reply) => reply
  | None => q->handOver(escalateTo)->wait
  }
}

let schedule = (~every as period, ~on=never(), task) =>
  every(period)->or(on)->forEach(_ => run(@auto, task)->wait)

// Work that repeats: a round every period counted from a time, and at once
// when `on` occurs. `who` does it; when that does not end in an answer,
// `otherwise` is asked the same once, and a round that still fails is reported.
let routine = (~every as period, ~from, ~on=never(), ~who=@auto, ~otherwise, ~by=8h, task) =>
  every(period, ~from)->or(on)->forEach(_ =>
    switch run(who, task, ~by)->wait {
    | Answered(report) => Answered(report)
    | _ => run(otherwise, task, ~by)->wait
    })

let digest = (who, ~every as period) =>
  schedule(~every=period, `Tell ${who->show} what changed since they last looked; say nothing if nothing changed`)

// Every reply, in the order the requests were given. They were made before
// this is called, so they are open together.
let rec all = requests =>
  switch requests {
  | [] => []
  | [request, ...rest] =>
    let reply = request->wait
    [reply, ...all(rest)]
  }
```

Common features of agent products reduce to these functions:

- cron-like schedules → `schedule`, or `routine` when the round has a time of the week and someone to fall back on;
- event triggers → `schedule(~on=…)` or `forEach`;
- reminders → `remind`;
- "waiting for your reply" → `ask(…)->wait`;
- PR subscriptions → `prActivity(…)->forEach`;
- approval cards → `confirm`, issued by the host;
- decisions with defaults → `decide`;
- escalation → `followUp`;
- "keep going until it's done" → the `push` loop in §3.

## 9. Execution model

The durable state of a team's work is a **ledger of requests**. A program
stores nothing of its own: no stack, no snapshot, no position.

- **A pass.** Whenever something a program depends on is recorded (a request
  ends, a fact is established, a stream occurs, a deadline passes), the
  program is evaluated from the top against the ledger. Where it makes a
  request the ledger already holds, it gets that request back. Where it waits
  on something that has happened, it gets the recorded result and goes on.
  Where it waits on something that has not happened, the pass ends. The
  requests the pass reached and the ledger lacks are opened.
- **Every input is recorded.** When a wait began, how it ended, what a
  `status` read saw and what was said are ledger entries. A later pass
  therefore takes the same path, and a crash, a restart or a second worker is
  only another pass.
- **Identity.** A request is the same request when the program asks the same
  participant for the same thing: verb, participant as the program names it,
  text and labels other than `~by`. Who holds it now, after a handover or a
  delegation, is not part of it. Identical requests are told apart by their
  order of evaluation.
- **Waiting is not a primitive.** It is what an open request looks like from
  the side of whoever asked.

The ledger belongs to the host, not to the language: a request made in
conversation, by a card or by a schedule is the same kind of entry as one a
program makes. §11.2 gives the rules for changing a program while it runs.

## 10. Safety and authority

- **Capabilities, not restrictions.** A program reaches the world only through
  §6. It cannot open sockets or read secrets. Work that needs judgement
  happens inside agent runs that `run` starts, under the agent's own
  permissions and approval policies. What it does in a connected app by
  itself (§6.3) is one of the actions the host declares, with its input
  fixed and admitted under the host's policy for that app before it is done.
- **Code can change; authority is current.** A program may be edited while it
  runs (§11.2). Every effect is admitted under the author's *current*
  grants. Authority lost during a long wait shows up as `Revoked`: as the
  reply of a request whose authority was lost, or, while the program waits on
  a fact or a stream, as the program's own result. Suspended state stores
  references to credentials, never credentials themselves.
- **Naming is not granting.** Passing `@alice` to another program does not let
  that program act as Alice. Naming an action (`Actions.action("x", "post")`)
  does nothing and admits nothing.
- **Admitting is not granting.** A prepared action stands for one action with
  one input, performed once. It gives the program nothing else in that app,
  and it stops being good when what was admitted changes (§6.3).
- **A standing policy is consent formed ahead of time.** It answers for one
  participant, so only that participant admits it, in person, and every
  change to its text is admitted again. An agent that edits a policy, or
  writes one as its owner, has proposed it: the host runs the text the
  participant admitted and no other. A policy is withdrawn at once, and a
  participant who may no longer answer a kind of request has no policy for
  it: authority is current here as everywhere.
- **Delegating is not granting.** A delegate gives the request's answer and
  nothing else: they act with none of the delegator's other authority, and
  the program still performs every effect as its author.
- **Failures surface.** A program's result is a reply to its author. A
  program that ends without success is reported to its author as a request,
  and a failure is never silence. It ends without success when:
  - its last expression is a reply other than `Answered`;
  - it calls `fail(r)`, with such a reply;
  - a `?` at its top level meets anything but `Answered`, `Some` or `Ok`;
  - it loses its authority while waiting on a fact or a stream (`Revoked`).

  The runtime records that value as the program's result. The type checker
  refuses to let a request or a reply be dropped silently
  ([types](types.md) §6a).
- **A program's own errors are not replies.** Division by zero, a bad
  argument to a built-in, or unchecked code that names something unbound end
  the program as a *program failure*, recorded with the error's text and
  reported to the author. They never become `Broke`, which only a participant
  who tried and could not gives. `fail(Answered(x))` is such an error, since
  an answer is not a failure; the checker cannot always rule it out.
- **Pure computation between waits is time-sliced** and charged to the
  author. A loop that never waits is a bug in that program, not a reason for a
  language-wide cap.
- **Defaults that spend money, contact outsiders, or cannot be undone** must
  say so: amount and scope go into the program text, where reviewers and
  tools can see them.

## 11. Runtime protocol (from the [runtime research](research/runtime.md))

The language fixes a portable kernel. Hosts implement a contract.

**The kernel owns:**

- the grammar, types and standard library;
- a versioned portable program representation and a reference evaluator;
- the host contract, which covers:
  - durable state transitions;
  - request delivery;
  - event observation;
  - time;
  - authorization results;
- a local simulated team and clock over a ledger that is plain JSON, so
  examples and restart tests run without any host;
- a deterministic failure-injection conformance suite that every host must
  pass.

**Every host must preserve:**

1. **Requests and waits have separate lifetimes.** A request is durable once its
   intent is recorded. Recording it does not mean the recipient accepted,
   started or finished.
2. **Any number of evaluations, one ledger.** A program is re-evaluated from
   the top on every pass. Two passes over the same ledger reach the same
   requests under the same identities, so a repeated or concurrent pass opens
   nothing twice, and a recipient deduplicates by that identity.
3. **Unconfirmed actions are reconciled, not repeated.** After dispatch and before
   a receipt, the host reconciles the original identity. It does not invent
   success and does not blindly repeat.
4. **Facts and occurrences are different.** See §6.2. Neither is a request,
   and waiting on one never produces a reply.
5. **Code can change and authority is current.** See §10 and §11.2. An edit
   takes effect only after its difference has been shown. It never cancels a
   request by itself.

### 11.1 Requests, replies and deadlines: the runtime contract

This is the contract the reference runtime implements, and every host after
it.

- **A request is single-assignment.** It goes from open to exactly one reply
  of §4.1. The first valid resolution committed by the request's authority
  wins. Invalid answers, and answers from a holder who no longer holds the
  request, are kept as evidence and resolve nothing.
- **`~by` is stored on the request** when its intent is recorded, as an
  absolute time on the store's clock: a duration is added to the store's time
  at that moment. It is part of the request, not of any wait on it.
- **The store's clock decides `NoReply`.** An answer committed at a store time
  strictly before `by` is `Answered` (or `Refused`, `Broke`). At `by` or
  later, the request has ended `NoReply`, whether or not any scan, alarm or
  worker has noticed yet: the reply is a function of the committed history and
  the store's clock, never of when a worker looked.
- **`handOver` keeps the request.** Same identity, same `~by`, a new epoch. The
  previous holder is told it was released.
- **Delegation keeps the request.** Same identity, same `~by`, same form, a
  new epoch, and an entry in the ledger with who delegated it, to whom, when
  and why. A delegate's `Answered` settles it; their `Refused` or `Broke`
  settles nothing and returns it to whoever delegated it, under a new epoch.
  An answer from someone whose holding has passed, the delegator's while it
  is delegated or the delegate's after it came back, is evidence. A
  delegation to a participant the request leaves out is refused. `handOver`
  ends a delegation.
- **`cancel(r)`** ends an open request `Cancelled` and tells its holder. On a
  request that has already ended it does nothing; the earlier reply stands.
- **Ending a program cancels its open requests.** However the program ends,
  every request it made that is still open ends `Cancelled`, and each holder
  is told, in the same commit that records the program's result. Work a
  holder already did is not undone.
- **Answer schemas are checked at the boundary.** `confirm` takes `Yes` or
  `No`, `choose` one of its options, `ask` any text, `run` a report, `judge`
  a `bool`. An answer outside the schema is refused to the participant, kept
  as evidence, and leaves the request open.
- **`r->wait`** suspends until the request has a reply, and returns it.
- **`r->waitUntil(t)`** stores the wait's own deadline, an absolute store
  time computed like `~by`. It returns `Some(reply)` if the request ends first,
  and `None` if the wait's deadline passes first; then the request stays open.
  When the request's `~by` comes first, or both fall at the same instant, the
  result is `Some(NoReply)`: the request ends, so the wait has its reply. A
  reply committed exactly at the wait's deadline loses: deadlines are
  exclusive.
- **Waiting on a fact or a stream** returns its value: `wait` gives `'a`,
  `waitUntil` gives `option<'a>`, and a `forEach` handler receives each
  occurrence's value itself, with no `Answered` around it. A loss of the program's authority during
  such a wait ends the program `Revoked`.
- **`or` keeps values.** `a->or(b)` delivers `First(x)` or `Second(y)`, with
  the occurrence's own value. Nesting composes: the wait's result is recorded
  with its path of `First`/`Second` constructors, so it survives a restart,
  and an occurrence recorded before a crash is delivered after it once, with
  the same value and path.

**Contract cases.** The redesign of §15 adds cases 1 to 6 to the conformance
suite, and delegation (§17) adds cases 7 to 12. Each states the input history
and the one allowed result.

1. **A deadline passes with no scan.** A request with `~by=1h`; the store's
   clock reaches 1h and nothing runs; then the holder answers. The answer is
   kept as evidence, and the request's reply is `NoReply`. A `wait` on it,
   resumed afterwards, returns `NoReply`; `status` returns `Some(NoReply)`.
2. **An old holder's reply after a handover.** `q` is held by `@codex`;
   `q->handOver(@alice)`; then `@codex` answers. The answer carries the old
   epoch, so it is kept as evidence and resolves nothing; the request is still
   open with `@alice`, and its `~by` is unchanged. `@alice`'s answer then
   resolves it.
3. **Two deadlines at the same instant.** `ask(@a, q, ~by=T)->waitUntil(T)`
   returns `Some(NoReply)`, never `None`, and the request has ended. With the
   wait's deadline strictly before `by`, it returns `None` and the request
   stays open.
4. **A request handle is dropped.** The checker refuses a program that drops
   one. A runtime given unchecked code that does so keeps the request open
   while the program runs, and cancels it when the program ends (`Cancelled`,
   holder told), like any other open request.
5. **`or` through nesting and restart.** `a->or(b)->or(c)` delivers
   `First(Second(y))` for an occurrence `y` of `b`. A crash after the
   occurrence is recorded and before the program resumes delivers the same
   value once after restart.
6. **A new version of the code is not refused.** A ledger holds no machine
   state, ABI version, store schema or code identity, so there is nothing to
   refuse (§16). A program whose text changed and which makes the same
   requests has an empty difference against its ledger: nobody is asked
   again, and nothing is cancelled. A process restart is the same pass over
   the ledger's JSON. Checkpoints and stores written by the stored-state
   runtime before 2026-11-11 are not read by anything; no migration exists.
7. **A delegate answers.** `confirm(@daniel, q)`; `@daniel` delegates it to
   `@claude:2`; then `@daniel` answers, then `@claude:2` does. `@daniel`'s
   answer is evidence and `@claude:2`'s settles the request. The ledger names
   `@claude:2` as the holder who answered and `@daniel` as the one they
   answered for, and the program's pass is the same as if `@daniel` had
   answered.
8. **The delegator takes it back.** After the delegation of case 7, `@daniel`
   takes the request back; then `@claude:2` answers under its delegated
   holding. The answer is evidence, and `@daniel`'s own answer settles the
   request.
9. **A delegate gives it back.** After the delegation of case 7, `@claude:2`
   refuses, or reports that it could not do it. Nothing is settled and
   nothing is evidence: the request is open with `@daniel` under a new epoch,
   with its `~by` unchanged. Only `@daniel`'s own refusal ends it `Refused`.
10. **The program hands a delegated request over.** `q` is held by `@daniel`
    and delegated to `@claude:2`; then `q->handOver(@alice)`. The delegation
    ends: `@claude:2`'s answer is evidence, `@daniel` cannot take the request
    back, and `@alice`'s answer settles it.
11. **An exception outlives a take.** `run(anyOf([@claude, @grok, @codex],
    ~except=@codex), task)`; `@grok` takes it. A delegation to `@codex` or
    `@codex:3` is refused; one to `@claude` is not.
12. **The deadline passes while a request is delegated.**
    `confirm(@daniel, q, ~by=1h)`, delegated to `@claude:2`; the store's
    clock reaches 1h; then `@claude:2` answers. The answer is evidence, and
    the reply is `NoReply` at 1h.

**Conformance cases.** The reference runtime has local checks for the cases
marked ✓, against its ledger and simulated team. The reference runtime
dispatches nothing, so the cases about delivery are unchecked. A
host-independent suite that every host runs is still to be written.

- ✓ a person replies after a long wait and a restart from the ledger's JSON
  on disk;
- ✓ a fact that already held before the wait;
- ✓ repeated passes, and two passes over the same ledger, open and report
  nothing twice; two processes writing one ledger at once and duplicate
  events are not checked;
- a crash between recording an intent and dispatching it;
- a crash between dispatch and receipt;
- ✓ a reply racing a deadline; a deleted source is not checked yet;
- ✓ the twelve contract cases of §11.1, with nested `or` and a delegation
  through a disk restart;
- cancellation while an agent is already running;
- ✓ permission withdrawn while waiting;
- ✓ an edited program keeps the requests it still makes, and a change of
  code that changes no request is an empty difference;
- bursts of stream events;
- ✓ pure loops that never wait fail in the open at the pass's step budget;
- ✓ handing over a request without duplicating its rights.

### 11.2 Changing a program while it runs

A plan changes while people and agents are working on it. Stopping the
program and starting again would ask everyone the same things twice.

- **The preview.** Evaluating the edited program against the ledger without
  committing gives its difference: the requests it would open, the open
  requests it no longer reaches, and the deadlines it moves. An edit is
  applied only after that difference has been shown to whoever applies it.
- **What stays.** A request the edited program still makes is the same
  request. Its holder is not asked again, and an answer already given stands.
- **A moved deadline amends.** `~by` is not part of a request's identity.
- **Nothing in flight is cancelled by an edit.** An open request the edited
  program does not reach is listed, and whoever applies the edit decides for
  each one whether to cancel it or leave it open. One left open rejoins the
  program if a later pass reaches it. This rule exists because turning two
  parallel requests into a sequence would otherwise cancel the second and
  issue it again later.
- **A changed text is a new request.** A request without `~key` is found by
  what it asks of whom; whoever applies the edit may declare that it continues
  an existing one, and the declaration is a ledger entry.
- **A key names a slot, not a consent.** `ask`, `confirm`, `choose`, `run` and
  `judge` take `~key`: the request is then found by its scope and key alone, so
  the preview shows an edit to it as a revision of that slot. An answer holds
  only for the terms it answered: its text, options, participant, `~about`,
  `~context` and `form`. When the program asks a keyed slot on other terms, the
  old request is superseded: an open one is cancelled, an answered one keeps its
  answer in the ledger, and a new request is opened in its place. A card is
  never rewritten in place. `~by` is not a term, so moving it amends.
- **An upgrade is an edit.** A new version of the language, the evaluator or
  the standard library is applied the same way. A program whose difference is
  not empty stops with a notice to its author, and does not go on silently.
- **One request per address in a scope.** The address of a request is its
  scope and either its key or what it asks of whom; evaluation order is never
  part of it. Two requests at one address in one scope, whether open together
  or one after the other, are a program error. A program that asks the same
  thing more than once gives each request its own `~key` (an attempt number in
  a recursion, for example) or asks it in its own scope (each round of a
  `forEach` is one). The checker refuses two such requests when both are
  written with literals (`same-request`). A ledger started before this rule
  keeps numbering repeats so its program goes on, and each pass reports them.

**What this costs.** A pass reads the whole history of its program, and the
evaluator must give the same result across versions, or upgrades must be
checked program by program. A standing duty settles each occurrence on its
own, so finished occurrences need not be evaluated again; the reference
implementation does not do that yet.

## 12. The formal model underneath (proposed)

Two surveys informed this section. The model survey is
[research/models.md](research/models.md) and the choreography survey is
[research/choreographies.md](research/choreographies.md). Their conclusions
agree.

**Since 2026-11-11 the durable state is the ledger of §9, not a stored
continuation.** The points below about effects, single-assignment requests,
CALM and the adopted rules still describe the semantics. What changed is
where the truth lives: a continuation is rebuilt by each pass, and nothing
depends on storing one.

**Core: one-shot algebraic effects over a ledger of single-assignment
requests.**

- **Effects.** Every suspension is an effect, and the host is the outermost
  handler. Continuations are delimited, not `call/cc`, and one-shot, as in
  OCaml 5. Higher-level policies are ordinary handlers in the standard library
  (`escalating`, `decide`). Agents write direct-style code; handlers live in
  reviewed library code.
- **Virtual actors.** Each running program instance is a single-threaded actor
  with its own identity and state, so no conductor exists. The coordination
  protocol exposes two shared constructs; host resources such as documents
  retain their own concurrency rules:
  - **Durable single-assignment requests.** A request goes from `Pending` to
    exactly one reply (§4.1). A resolution must match the request's
    current epoch, reply schema and authority; the first valid resolution
    committed by its authority wins. Invalid or stale replies are evidence,
    not contenders. Resolution, cancellation and handover are serialized by
    that same authority.
  - **Pushed events.**
- **Where coordination is needed.** The [CALM theorem](https://arxiv.org/abs/1901.01930)
  relates coordination-free consistency to logical monotonicity. Immutable
  observations, such as evidence that a PR was merged, can accumulate without
  retracting earlier observations. Examples of non-monotone decisions here
  include:
  - "no answer by T";
  - a declared default;
  - the winner of an `any`;
  - `cancel`;
  - `handOver`, and a delegation.

  This is not an exhaustive list or a proof that the whole runtime is
  coordination-free. Admission, current permissions, revocation and resource
  invariants may also require authoritative ordering. Each such decision is
  committed by the authority for its scope; an actor cannot settle another
  authority's policy merely by observing an event.
- **Code identity.** Code is not pinned. An edit is applied through its
  difference against the ledger (§11.2).

**Rules adopted from the surveys:**

1. **Structured cancellation.** `scope(f)` cancels every request started
   inside `f` when `f` returns, loses an `any`, or passes its deadline. This
   is the same idea as Orc pruning, YAWL cancel regions and leaving a
   statechart state. This is a logical, persistent scope: a durable program
   instance outlives the process or agent turn that created it. Ending that
   creator's turn does not end the program's scope or its reminders. Leaving
   the logical scope withdraws authority and requests cancellation; it does
   not prove that an external participant has stopped or undo prior effects.
2. **A change of holder is fenced.**
   - `handOver(r, who)`, made by the program, and a delegation, made by the
     holder (§7), keep the same request and increase its epoch.
   - A resolution or capability that carries an old epoch is refused.
   - The previous holder is told it was released.
3. **Reply and holder-change notices are durable.** A reply creates
   a durable notification intent for affected participants. A handover or a
   delegation creates a notice of the change of holder, and a delegation is
   also told to the program's author; neither ends the request. Delivery
   respects current access and availability. Failed or suppressed delivery is
   visible to the responsible owner rather than counted as delivered; the
   protocol cannot guarantee that an offline person has read a notice.
4. **Correlation keys.** Every wait names exactly what it waits for: a request
   identity, or a PR, SHA or release. A later, unrelated message can never
   satisfy it.
5. **Effect rows inform review, not authorization.** The inferred operation
   families (`ask`, `confirm`, `choose`, `run`, `say`, …) and statically known targets are shown before
   a program starts. Dynamically selected participants still require runtime
   resolution. An effect row neither grants a capability nor replaces the
   host's current permission and epoch checks at each effect.
6. **Dry runs.** A handler with a simulated clock and scripted answers runs a
   program before it is committed. That is how a person sees "if nobody
   answers, at 12:00 this happens".

**Choreographies are a view, not the core.** Choreographic programming gives
a global narrative; some calculi prove deadlock freedom under their specified
projection and execution assumptions. Those guarantees do not automatically
apply to this language's external participants. Only the program's own role runs
code: people, agents and external systems cannot run projected programs.
Timeouts, refusal, revocation, handover and durable waits are still research
topics there. Norn therefore keeps the effects core and borrows the
choreographic view:

- each participant's card, prompt and reply schema is generated from the
  program;
- answers that break that schema are refused at the boundary and kept as
  evidence; the request stays open (§11.1);
- a running instance can be drawn as a sequence diagram.

A `choreo` block could later be a library over effects. Choreographic
projection can be written as effect handlers, but effects cannot be built
from projection.

## 13. Open questions

1. **Concurrency.** Do structured child programs (`spawn`/`join`) belong in v0?
   Should multi-shot resumption be exposed at all? The current answer is no:
   child requests get distinct identities instead.
2. **Activation.** How exactly do hosts admit and stop programs, and what does
   an edit do to a running instance?
3. **Decentralization.**
   - (a) Each scope has one authority, and authorities co-operate through
     authenticated messages. This is the current assumption.
   - (b) Waiting programs live on participants' own machines.
4. **Identity under edits.** How the checker finds requests whose computed
   texts can be identical before a pass does.
5. **Concrete syntax details.**
   - Time literals.
   - `?` on nested replies.
   - Which `forEach` policy is the default.
6. **Standing delegation.** Answered in part by standing policies (§7, §19):
   a participant decides a kind of request ahead of time. Still open:
   whether a delegate may delegate again, and whether a program needs a way
   to say that one request must be answered by the participant it asks, in
   person, whatever their policy says.

## 14. Non-goals

- **Not an agent framework.** How one agent thinks belongs to that agent.
- **Not a general-purpose language.** No I/O, packages or network access
  inside the language.
- **Not tied to one vendor, one agent harness or one host.**

## 15. Changes from the first draft

The first draft of this spec (2026-11-06) used one word for several things.
Daniel, the project's owner, found its syntax and semantics too ambiguous to
read reliably, so the surface was redesigned around one rule: **one word, one
meaning; a name says who acted and why.** The runtime's semantics were
reviewed with Codex. Old programs do not check or run under the new names.

| First draft | Now | Why |
|---|---|---|
| `outcome<'a> = Done \| Declined \| Failed \| TimedOut \| Cancelled \| Revoked` | `reply<'a> = Answered \| Refused \| NoReply \| Broke \| Cancelled \| Revoked`, for requests only | `Done` read as "the work is done" for a mere answer; `Failed` mixed "they could not" with program failure; facts and streams had outcomes nobody could give. |
| `TimedOut` | `NoReply`, only for the request's own `~by`; a wait that runs out is `None` | `TimedOut` meant "withdrawn" after `ask` and "still open" after `request`: one word, two outcomes. |
| `~until=` on `ask`, `run` and `wait` | `~by=` on the request; `r->waitUntil(t)` for a wait | Two deadlines with one name; a handover could not say which deadline it kept. |
| `ask` and `run` waited; `request` and `start` returned handles | every verb returns a `request<'a>`, and waiting is always `->wait` | Two spellings of each request, with different timeout semantics. |
| `request(who, text)`, `start(who, task)` | removed: `ask`, `run` | Redundant once every verb returns a handle. |
| `ask(…, ~options=[A, B])` | `choose(who, question, [A, B])` | One verb whose answer type changed with a label. |
| a user `type yes = Yes \| No` for approvals | `confirm(…) : request<yesno>`, built-in `yesno` | Approval is the most common request; it needs no declaration. |
| `wait(x, ~until=?)` | `x->wait`, `x->waitUntil(t)` | The label changed the result's meaning. |
| `wait` on a fact or stream gave `outcome<'a>` | it gives `'a`; `waitUntil` gives `option<'a>` | Nobody answers or refuses a fact. |
| `merge(a, b)`; `or(a, b) : stream<unit>` | `a->or(b) : stream<either<'a, 'b>>` | `or` threw values away and `merge` kept them: two composers for one idea. |
| `judge(…) : outcome<bool>`, waiting | `judge(…) : request<bool>`, waited explicitly | Like every other request. |
| `fail(outcome)` | `fail(reply)` | Follows the rename. |
| dropped outcomes refused | dropped requests and replies refused | The runtime cancels a program's open requests when it ends, so a dropped handle is a silent cancellation. |
| the holder could give an ETA that moved the deadline | the deadline is the program's; an ETA is a message | A deadline that the waited-on party can move has no single meaning. |
| host fact `replied(ref, ~by=participant)` | `replied(ref, ~from=participant)` | `~by` now always means a request's deadline. |

## 16. The ledger (2026-11-11)

Daniel set the goal as a language for collaboration among many agents and
many people, and said that neither waiting nor people need be at its base.
Three things changed.

| Before | Now | Why |
|---|---|---|
| A program was a stored machine state, resumed at its suspension point | A program is a pure computation over the ledger of requests, evaluated from the top on every pass (§9) | The truth was readable only by the same runtime version; a team had nothing in common to look at |
| Code was pinned; an edit started a new instance | A program can be edited while it runs, through a shown difference (§11.2) | Plans change while work is in progress, and starting again asks people twice |
| A checkpoint of an older machine ABI was refused | An upgrade is an edit with a difference that should be empty | A language that changes weekly cannot strand every program that waits for days |
| Only a program's requests were requests | A request made in conversation, by a card or by a schedule is the same ledger entry | Each of those had its own rules for who is told when it ends |
| People were the natural holders of decisions | A person is one kind of participant and never a required step (§1) | Needing a person is usually a limit of capability, and the language should not fix that limit in place |

The reference runtime's stored-state driver and its stores were removed once
the playground and the contract suite ran on the ledger runtime
(`src/runtime/ledger.ts`).

## 17. Delegation (2026-11-15)

An agent asked Daniel to confirm a cleanup of production data. He could not
judge it, asked another agent, and wanted that agent's answer to count. Only he
could answer the card, so the agent decided in the conversation and did the
work while the request stayed open, and the request's declared default would
have recorded the opposite when its deadline passed. Until then only the
program could move a request; the participant asked could answer it, refuse
it or report that they could not do it.

| Before | Now | Why |
|---|---|---|
| Only the program changed who holds a request: `handOver`, or a take from `anyOf` | The holder can delegate it once; the delegate answers or gives it back, and the delegator can take it back (§7) | Whom to ask is the asker's choice, but who answers for me is mine. Without it, a person who cannot judge a question clicks what someone else decided, and the ledger records a consent they never formed, or the work goes around the request |
| `Answered`, `Refused` and `Broke` all named the participant asked | `Answered` names the holder, who may be a delegate answering for the participant asked; `Refused` and `Broke` remain the participant asked's alone (§4.1) | A refusal or a failure is attributed to whoever the program asked, never to a stand-in |
| `~except` was applied only when one of a group took the request | The exception is kept on the request, and no delegation reaches it | Delegation must not undo a separation of duties the program stated |
| §12 called `handOver` delegation | `handOver` is the asker's move; delegation is the holder's | One word, one meaning (§15) |

**What it leaves sound.** The change adds no syntax and no type. A reply
carries no name, so a program cannot tell a delegate's answer from its
holder's, and the replies a program can receive are the ones it could receive
before: a holder could always ask someone and pass the answer on. A request's
identity names the participant the program asked, not whoever holds it, so
every pass finds a delegated request again and opens nothing twice. A
delegation is the same fenced change of holder as a handover or a take, so a
request still has one holder and ends with one reply, and its `~by` and form
do not change. What changes is the record: the ledger now says that a
delegate answered, and for whom.

## 18. Actions (2026-11-23)

Daniel wanted to approve a batch of short videos when he had the time and
have them posted three a day afterwards, whether or not any agent was
running. The posting itself was already the host's work, but a program could
only reach it through an agent run: §10 said a program "cannot send mail",
and the host asked for approval at the moment of posting, so someone had to
be there at each slot.

| Before | Now | Why |
|---|---|---|
| A program touched a connected app only through `run` | `Actions.prepare` and `Actions.perform` ask the host itself (§6.3) | Doing what was already decided needs no judgement, and should not depend on an agent being there |
| Outside events came in through `Events`; nothing went out | `Actions` is the outgoing standard capability, checked against the same connector manifests | One interface each way keeps app names and business verbs out of the language |
| A host's approval was asked when the action ran | The input is fixed and admitted by `prepare`; `perform` does it later | Whoever approves sees exactly what will be done, once, ahead of time; the time it is done is the program's to say with `after`, `every` or an event |
| `Refused` and `Broke` named a participant | For a request of the host they name the host: it declined, or it could not | The same six replies, and still one meaning each |

**What it leaves sound.** A request of the host is a request like any other:
one holder, one reply, an identity made of what is asked, so every pass finds
it again and opens nothing twice. An action is therefore done at most once
however often the program is evaluated, edited or upgraded. Programs stay
pure: `Actions.action` computes a name, and the two effects are requests the
ledger records. The checker treats them as effects, so a pure callback cannot
make one, and as requests, so neither can be dropped.

## 19. Standing policies (2026-11-27)

A check of a production database ran every three days, at night. Each run
needed a secret that a person had to approve at that moment, and nobody was
awake: the approval timed out and the check went without its data. The
approval was a request asked of a person, and the only moves they had were
made one request at a time (§17).

| Before | Now | Why |
|---|---|---|
| The participant asked could answer, refuse or delegate a request once it had reached them | A standing policy decides a kind of request ahead of time: answer it, decline it, delegate it, or leave it (§7) | "Who answers for me is mine" (§17) should not need me to be there. A person approves a kind of thing once, as they approve a week of posts in one sitting (§18) |
| Open question 6 asked whether a kind of request could be delegated in advance | A policy's `Delegate(who)` is that, and it is one of four decisions | Delegating everything is rarely wanted: some requests are safe to answer, some need another's judgement, and some stay with the person |
| A host's approvals were its own cards, each with its own rules | An approval a host asks of a participant is a request, and a policy decides it like any other | One way to be asked, so one way to say ahead of time what the answer is |

**Why a pure function and not a program that waits for requests.** A program
that listened for requests and answered them would be Norn as it is: a
stream, a loop, an effect that answers. It would also hold state, could miss
a request or answer one twice, and could be told things: a model deciding
inside it reads the asker's reason, and the asker wrote it. A function of
what the request is about has none of that. It is the same shape as the
admission policy a host evaluates before it dispatches a request, turned
around: that one decides about requests a program makes, this one about
requests a participant is asked.

**What it leaves sound.** A policy adds one built-in type and no effect. A
request decided by a policy has one holder and ends with one reply, as
before, and the program that asked cannot tell. `Delegate` is delegation,
with its rules: once, to one participant, never to one the request leaves
out. A policy never widens what its participant may do, because the host
carries each decision out as that participant's move and admits it as it
would admit the move made by hand. And a person is still never necessary and
never bypassed: no policy means every request waits for its participant, and
`Mine` says so for the ones that should.
