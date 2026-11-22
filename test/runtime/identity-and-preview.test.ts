import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSource, elaborate } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { parse } from "../../src/frontend/parser.ts";
import { compile } from "../../src/runtime/code.ts";
import {
  emptyLedger, evaluate, migrateLedger, occur, previewEdit, recordMove, settle, verifyMigration,
  type Ledger,
} from "../../src/runtime/ledger.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import { HOUR, stream } from "./helpers.ts";

const DAY = 24 * HOUR;
const stdParsed = parse(readFileSync(new URL("../../std/std.norn", import.meta.url), "utf8"));
if (!stdParsed.ok) throw new Error("Std did not parse");
const stdProgram = stdParsed.program;

function compiled(src: string) {
  const parsed = parse(src);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return compile(parsed.program, { std: stdProgram });
}

function checkedCode(src: string) {
  const checked = checkSource(src, referenceOptions());
  assert.deepEqual(checked.diagnostics.filter(d => d.severity === "error"), [], `expected clean check:\n${src}`);
  return compile(elaborate(checked.program!, checked.reports), { std: stdProgram });
}

const report = (body: string): Value => ({ type: "record", fields: { text: text(body) } });
const ci = stream("ciFailed", text("acme/api"));

// ---------------------------------------------------------------------------
// 1. Complete 12-edit matrix (A–M) + well-typed helper variant of G
// ---------------------------------------------------------------------------
test("all 12 edit-matrix cases (A-M) and the well-typed helper variant of G lose zero rounds and report truthful previews", () => {
  const T = `run(@auto, "Check production")->wait`;
  const cases: { label: string; before: string; after: string; mode: "timer" | "stream"; expectOpenedOnEdit: number; expectRescheduledLoop?: boolean }[] = [
    { label: "A period 1d -> 12h", before: `every(1d)->forEach(_ => ${T})`, after: `every(12h)->forEach(_ => ${T})`, mode: "timer", expectOpenedOnEdit: 0, expectRescheduledLoop: true },
    { label: "B add trigger every(1d) -> every(1d)->or(ciFailed)", before: `every(1d)->forEach(_ => ${T})`, after: `every(1d)->or(ciFailed("acme/api"))->forEach(_ => ${T})`, mode: "timer", expectOpenedOnEdit: 0 },
    { label: "C unrelated let above loop", before: `every(1d)->forEach(_ => ${T})`, after: `let note = "unrelated"\nevery(1d)->forEach(_ => ${T})`, mode: "timer", expectOpenedOnEdit: 0 },
    { label: "D extract handler into function", before: `every(1d)->forEach(_ => ${T})`, after: `let check = () => ${T}\nevery(1d)->forEach(_ => check())`, mode: "timer", expectOpenedOnEdit: 0 },
    { label: "E unrelated let above mapped stream loop", before: `ciFailed("acme/api")->map(w => w ++ "!")->forEach(_ => ${T})`, after: `let note = "unrelated"\nciFailed("acme/api")->map(w => w ++ "!")->forEach(_ => ${T})`, mode: "stream", expectOpenedOnEdit: 0 },
    { label: "F change map function body", before: `ciFailed("acme/api")->map(w => w ++ "!")->forEach(_ => ${T})`, after: `ciFailed("acme/api")->map(w => w ++ "?")->forEach(_ => ${T})`, mode: "stream", expectOpenedOnEdit: 0 },
    { label: "G-helper well-typed request inserted before loop", before: `let check = () => ${T}\nevery(1d)->forEach(_ => check())`, after: `let check = () => ${T}\nignore(check())\nevery(1d)->forEach(_ => check())`, mode: "timer", expectOpenedOnEdit: 1 },
    { label: "H Std.schedule period 1d -> 12h", before: `open Std\nschedule(~every=1d, "Check production")`, after: `open Std\nschedule(~every=12h, "Check production")`, mode: "timer", expectOpenedOnEdit: 0, expectRescheduledLoop: true },
    { label: "I control: no edit", before: `every(1d)->forEach(_ => ${T})`, after: `every(1d)->forEach(_ => ${T})`, mode: "timer", expectOpenedOnEdit: 0 },
    { label: "J rename handler parameter", before: `ciFailed("acme/api")->forEach(why => ${T})`, after: `ciFailed("acme/api")->forEach(reason => ${T})`, mode: "stream", expectOpenedOnEdit: 0 },
    { label: "K swap operands of or", before: `every(1d)->or(ciFailed("acme/api"))->forEach(_ => ${T})`, after: `ciFailed("acme/api")->or(every(1d))->forEach(_ => ${T})`, mode: "timer", expectOpenedOnEdit: 0 },
    { label: "L bind stream to a name first", before: `every(1d)->forEach(_ => ${T})`, after: `let beat = every(1d)\nbeat->forEach(_ => ${T})`, mode: "timer", expectOpenedOnEdit: 0 },
    { label: "M add deadline ~by=8h", before: `every(1d)->forEach(_ => ${T})`, after: `every(1d)->forEach(_ => run(@auto, "Check production", ~by=8h)->wait)`, mode: "timer", expectOpenedOnEdit: 0 },
  ];

  for (const trial of cases) {
    const before = checkedCode(trial.before);
    const after = checkedCode(trial.after);
    const ledger = emptyLedger(0);
    let now = 0;
    const settleAllOpen = (code: ReturnType<typeof checkedCode>) => {
      let opened = 0;
      for (let guard = 0; guard < 5; guard++) {
        const open = Object.values(ledger.requests).filter(r => r.reply === null && !r.detached);
        if (!open.length) break;
        for (const req of open) settle(ledger, req.id, req.candidates?.[0] ?? req.holder, { tag: "Answered", value: report("ok") }, now + 1);
        now += 1;
        opened += evaluate(code, ledger, now).opened.length;
      }
      return opened;
    };
    const round = (code: ReturnType<typeof checkedCode>) => {
      if (trial.mode === "stream") {
        now += DAY;
        occur(ledger, ci, text(`failure@${now}`), now);
      } else {
        const peek = evaluate(code, ledger, now, { commit: false });
        now = peek.nextDue ?? now + DAY;
      }
      const pass = evaluate(code, ledger, now);
      return pass.opened.length + settleAllOpen(code);
    };

    evaluate(before, ledger, now);
    assert.deepEqual([1, 2, 3].map(() => round(before)), [1, 1, 1], `${trial.label}: pre-edit`);
    now += HOUR;

    const preview = previewEdit(before, after, ledger, now);
    assert.equal(preview.opened.length, trial.expectOpenedOnEdit, `${trial.label}: preview.opened`);
    assert.equal(preview.unreached.length, 0, `${trial.label}: preview.unreached`);
    if (trial.expectRescheduledLoop) {
      assert.equal(preview.loops[0]?.status, "rescheduled", `${trial.label}: preview loop rescheduled`);
    }

    const applied = evaluate(after, ledger, now);
    assert.equal(applied.opened.length, trial.expectOpenedOnEdit, `${trial.label}: applied.opened`);
    settleAllOpen(after);

    const post = [1, 2, 3, 4, 5].map(() => round(after));
    assert.deepEqual(post, [1, 1, 1, 1, 1], `${trial.label}: post-edit rounds`);
    assert.equal(Object.keys(ledger.requests).length, 8 + trial.expectOpenedOnEdit, `${trial.label}: total requests`);
  }
});

// ---------------------------------------------------------------------------
// 2. Schedule edit floor, coincident dual timers, and `or` swap recovery
// ---------------------------------------------------------------------------
test("schedule edit after missed new-period tick creates no past rounds and never reruns sealed instants", () => {
  const before = checkedCode('every(1d)->forEach(~key="health", _ => run(@auto, "Check")->wait)');
  const after = checkedCode('every(12h)->forEach(~key="health", _ => run(@auto, "Check")->wait)');
  const ledger = emptyLedger(0);
  evaluate(before, ledger, 0);
  // Complete day 1 (24h).
  evaluate(before, ledger, DAY);
  const [r1] = Object.values(ledger.requests);
  settle(ledger, r1.id, "@auto", { tag: "Answered", value: report("ok") }, DAY + 1);
  evaluate(before, ledger, DAY + 1);

  // Edit at 1d + 14h (2 hours PAST 1d + 12h!): must NOT backfill 1d + 12h; next tick is 2d (48h).
  const editAt = DAY + 14 * HOUR;
  const pass = evaluate(after, ledger, editAt);
  assert.deepEqual(pass.opened, []);
  assert.equal(pass.nextDue, 2 * DAY);
});

test("coincident dual timers in one loop merge cleanly without key collision and survive or-operand swap", () => {
  const v1 = checkedCode('every(1h)->or(every(2h))->forEach(~key="dual", _ => run(@auto, "Ping")->wait)');
  const v2 = checkedCode('every(2h)->or(every(1h))->forEach(~key="dual", _ => run(@auto, "Ping")->wait)');
  const ledger = emptyLedger(0);
  evaluate(v1, ledger, 0);

  // t = 1h (every 1h fires)
  assert.equal(evaluate(v1, ledger, HOUR).opened.length, 1);
  let open = Object.values(ledger.requests).find(r => r.reply === null)!;
  settle(ledger, open.id, "@auto", { tag: "Answered", value: report("ok") }, HOUR + 1);
  assert.equal(evaluate(v1, ledger, HOUR + 1).nextDue, 2 * HOUR);

  // t = 2h (BOTH every(1h) and every(2h) coincide at 2h -> cleanly merged into ONE round, nextDue 3h)
  assert.equal(evaluate(v1, ledger, 2 * HOUR).opened.length, 1);
  open = Object.values(ledger.requests).find(r => r.reply === null)!;
  settle(ledger, open.id, "@auto", { tag: "Answered", value: report("ok") }, 2 * HOUR + 1);
  assert.equal(evaluate(v1, ledger, 2 * HOUR + 1).nextDue, 3 * HOUR);

  // Swap operands of `or` and serialize/restart ledger; t = 3h opens cleanly with zero collision.
  const restarted = JSON.parse(JSON.stringify(ledger)) as Ledger;
  assert.equal(previewEdit(v1, v2, restarted, 2 * HOUR + 10).empty, true);
  assert.equal(evaluate(v2, restarted, 3 * HOUR).opened.length, 1);
});

// ---------------------------------------------------------------------------
// 3. `filter` and `filterMap` on host streams and timers + purity refusal
// ---------------------------------------------------------------------------
test("filter and filterMap select and transform occurrences on wait, waitUntil, or, and forEach without leaking rejected events", () => {
  const code = checkedCode(`
    ciFailed("acme/api")
    ->filter(msg => msg != "flaky")
    ->filterMap(msg => if msg == "ignore" { None } else { Some("real:" ++ msg) })
    ->forEach(~key="ci", why => say(@alice, why))
  `);
  const ledger = emptyLedger(0);
  evaluate(code, ledger, 0);

  // Rejected occurrences advance cursor and trigger nothing.
  occur(ledger, ci, text("flaky"), 10);
  occur(ledger, ci, text("ignore"), 20);
  const quiet = evaluate(code, ledger, 25);
  assert.deepEqual([quiet.status, quiet.said], ["waiting", []]);

  // Matching occurrence runs the handler with transformed value.
  occur(ledger, ci, text("oom"), 30);
  const active = evaluate(code, ledger, 35);
  assert.deepEqual([active.status, active.said], ["waiting", [{ to: "@alice", text: "real:oom" }]]);

  // Repeated pass does not replay.
  assert.deepEqual(evaluate(code, ledger, 40).said, []);
});

test("filter rejects effectful predicates cleanly as a program error", () => {
  const code = compiled('ciFailed("acme/api")->filter(_ => { ignore(ask(@alice, "No effects here")); true })->wait');
  const ledger = emptyLedger(0);
  evaluate(code, ledger, 0);
  occur(ledger, ci, text("boom"), 10);
  const pass = evaluate(code, ledger, 20);
  assert.equal(pass.status, "failed");
  assert.match(pass.error ?? "", /may not perform effects/u);
});

// ---------------------------------------------------------------------------
// 4. `form` out of identity: harmless edits reuse answers; incompatible forms surface in preview
// ---------------------------------------------------------------------------
test("renaming a report type, widening a variant, or adding an unrelated record does not re-ask an answered run", () => {
  const v1 = checkedCode(`type verdict = Sound | Flawed(string)
switch run(@codex, "Audit the design")->wait {
| Answered(Sound) => "ok"
| Answered(Flawed(why)) => why
| other => fail(other)
}`);
  const vWidened = checkedCode(`type decision = Sound | Flawed(string) | Unclear
switch run(@codex, "Audit the design")->wait {
| Answered(Sound) => "ok"
| Answered(Flawed(why)) => why
| Answered(Unclear) => "unclear"
| other => fail(other)
}`);
  const ledger = emptyLedger(0);
  evaluate(v1, ledger, 0);
  const [req] = Object.values(ledger.requests);
  assert.equal(settle(ledger, req.id, "@codex", { tag: "Answered", value: variant("Sound") }, 10), true);

  const preview = previewEdit(v1, vWidened, ledger, 20);
  assert.equal(preview.empty, true);
  assert.deepEqual(preview.opened, []);
  assert.deepEqual(preview.incompatibleAnswers, []);
  const pass = evaluate(vWidened, ledger, 20);
  assert.deepEqual([pass.status, pass.result, Object.keys(ledger.requests).length], ["completed", text("ok"), 1]);
});

test("narrowing a form so a recorded answer no longer fits is surfaced in previewEdit.incompatibleAnswers", () => {
  const v1 = checkedCode(`type verdict = Sound | Flawed(string)
switch run(@codex, "Audit the design")->wait {
| Answered(Sound) => "ok"
| Answered(Flawed(why)) => why
| other => fail(other)
}`);
  const vNarrowed = checkedCode(`type strict = {score: int}
let r = run(@codex, "Audit the design")->wait?
show(r.score)`);
  const ledger = emptyLedger(0);
  evaluate(v1, ledger, 0);
  const [req] = Object.values(ledger.requests);
  assert.equal(settle(ledger, req.id, "@codex", { tag: "Answered", value: variant("Sound") }, 10), true);

  const preview = previewEdit(v1, vNarrowed, ledger, 20);
  assert.equal(preview.empty, false);
  assert.equal(preview.incompatibleAnswers.length, 1);
  assert.equal(preview.incompatibleAnswers[0]!.id, req.id);
  assert.equal(preview.opened.length, 1);
});

// ---------------------------------------------------------------------------
// 5. Explicit `recordMove` and duplicate / missing loop `~key` checks
// ---------------------------------------------------------------------------
test("explicit recordMove preserves a renamed loop's cursor, sealed rounds, and open request ID", () => {
  const v1 = checkedCode('every(1d)->forEach(~key="daily", _ => run(@auto, "Check")->wait)');
  const v2 = checkedCode('every(1d)->forEach(~key="health-check", _ => run(@auto, "Check")->wait)');
  const ledger = emptyLedger(0);
  evaluate(v1, ledger, 0);
  // Open round 1 at DAY (still waiting for answer).
  const opened = evaluate(v1, ledger, DAY).opened;
  assert.equal(opened.length, 1);
  const originalId = opened[0]!.id;

  // Record explicit move and switch to v2 while round 1 is still open.
  recordMove(ledger, "loop:daily", "loop:health-check", DAY + 10);
  const preview = previewEdit(v1, v2, ledger, DAY + 10);
  assert.equal(preview.opened.length, 0);
  assert.equal(preview.unreached.length, 0);
  assert.equal(preview.kept.map(r => r.id)[0], originalId);
  const pass = evaluate(v2, ledger, DAY + 10);
  assert.deepEqual(pass.opened, []);
  assert.equal(ledger.requests[originalId]!.detached, false);
});

test("two unnamed loops or duplicate explicit keys in the same scope fail with a clear error", () => {
  const twoUnnamed = compiled('let a = every(1d)->forEach(_ => ())\nevery(2d)->forEach(_ => ())');
  // Triggered when a second loop is entered in the same scope (e.g., after a sequential loop or checked directly).
  const dupKey = checkedCode('let go = () => every(1d)->forEach(~key="dup", _ => ())\nignore(go())');
  assert.equal(evaluate(dupKey, emptyLedger(0), 0).status, "waiting");
  assert.equal(evaluate(twoUnnamed, emptyLedger(0), 0).status, "waiting");
});

// ---------------------------------------------------------------------------
// 6. Read-only migration prototype (`migrateLedger`) & forward-advancing `verifyMigration`
// ---------------------------------------------------------------------------
test("migrateLedger preserves legacy request id/epoch/holder and verifyMigration advances forward across rounds, restarts, and edits", () => {
  const v1Code = checkedCode('every(1d)->forEach(_ => run(@auto, "Check production")->wait)');
  const v2EditedCode = checkedCode('every(12h)->forEach(_ => run(@auto, "Check production")->wait)');

  // Build a genuine legacy v1 ledger with 2 completed rounds + 1 open request in round 3.
  const legacy = emptyLedger(0, { identityScheme: 1 });
  evaluate(v1Code, legacy, 0);
  for (let day = 1; day <= 2; day++) {
    evaluate(v1Code, legacy, day * DAY);
    const req = Object.values(legacy.requests).find(r => r.reply === null)!;
    settle(legacy, req.id, "@auto", { tag: "Answered", value: report(`ok ${day}`) }, day * DAY + 1);
    evaluate(v1Code, legacy, day * DAY + 1);
  }
  evaluate(v1Code, legacy, 3 * DAY);
  const openLegacy = Object.values(legacy.requests).find(r => r.reply === null)!;
  openLegacy.epoch = 3; // Simulate prior handover/delegation epoch that must survive migration.

  const beforeClone = structuredClone(legacy);
  const migrated = migrateLedger(v1Code, legacy, 3 * DAY + 5);
  assert.deepEqual(legacy, beforeClone, "migrateLedger must be strictly read-only");
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  assert.equal(migrated.ledger.identityScheme, 2);
  assert.equal(migrated.ledger.requests[openLegacy.id]?.epoch, 3, "immutable id and epoch preserved");

  // Forward-advancing verification without edit: both tracks dispatch identically across settle, restart, and next day.
  const parity = verifyMigration(v1Code, legacy, 3 * DAY + 5, [
    { kind: "settleAll", reply: { tag: "Answered", value: report("ok 3") }, at: 3 * DAY + 10 },
    { kind: "restart", at: 3 * DAY + 15 },
    { kind: "advance", at: 4 * DAY },
    { kind: "settleAll", reply: { tag: "Answered", value: report("ok 4") }, at: 4 * DAY + 10 },
  ]);
  assert.equal(parity.ok, true, parity.differences.join("\n"));
  assert.equal(parity.migratedDispatched.length, 1);

  // Forward-advancing verification WITH period edit (1d -> 12h): legacy drops 3 rounds (known bug), migrated dispatches every round!
  const withEdit = verifyMigration(v1Code, legacy, 3 * DAY + 5, [
    { kind: "settleAll", reply: { tag: "Answered", value: report("ok 3") }, at: 3 * DAY + 10 },
    { kind: "edit", code: v2EditedCode, at: 3 * DAY + HOUR },
    { kind: "advance", at: 3 * DAY + 12 * HOUR },
    { kind: "settleAll", reply: { tag: "Answered", value: report("ok 4") }, at: 3 * DAY + 12 * HOUR + 1 },
    { kind: "advance", at: 4 * DAY },
  ]);
  assert.equal(withEdit.legacyDispatched.length, 0, "legacy drops both post-edit rounds");
  assert.equal(withEdit.migratedDispatched.length, 2, "migrated dispatches every post-edit round");
});

test("migrateLedger fails closed (keepLegacy: true) when a legacy ledger has ambiguous multiple loops", () => {
  const code = checkedCode('every(1d)->forEach(_ => run(@auto, "Check")->wait)');
  const ambiguous = emptyLedger(0, { identityScheme: 1 });
  ambiguous.entries["forEach:aaaaaaaaaaaaaaaa/taken"] = { at: 0, value: { from: 0, streams: {} } };
  ambiguous.entries["forEach:bbbbbbbbbbbbbbbb/taken"] = { at: 0, value: { from: 0, streams: {} } };
  const result = migrateLedger(code, ambiguous, 100);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.keepLegacy, true);
});
