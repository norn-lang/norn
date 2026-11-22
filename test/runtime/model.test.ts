/**
 * Naive executable oracle model for Norn's pure stream algebra (Cedar/reactive-banana style).
 * Represents every stream literally as a finite trace of `(at, index, value)` occurrences
 * and computes `map`, `filter`, `filterMap`, `or`, `never`, and `wait` by direct list operations,
 * with zero caching, slicing, or ledger machinery. Used as a differential oracle against `ledger.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLedger, evaluate, occur } from "../../src/runtime/ledger.ts";
import { text, variant, type Value } from "../../src/runtime/value.ts";
import { source, stream } from "./helpers.ts";

interface ModelEvent<T> { at: number; seq: number; value: T }
type ModelStream<T> = readonly ModelEvent<T>[];

const modelNever = <T>(): ModelStream<T> => [];
const modelMap = <A, B>(s: ModelStream<A>, f: (a: A) => B): ModelStream<B> =>
  s.map(e => ({ at: e.at, seq: e.seq, value: f(e.value) }));
const modelFilter = <A>(s: ModelStream<A>, p: (a: A) => boolean): ModelStream<A> =>
  s.filter(e => p(e.value));
const modelFilterMap = <A, B>(s: ModelStream<A>, f: (a: A) => B | null): ModelStream<B> =>
  s.flatMap(e => { const v = f(e.value); return v === null ? [] : [{ at: e.at, seq: e.seq, value: v }]; });
const modelOr = <A, B>(a: ModelStream<A>, b: ModelStream<B>): ModelStream<{ side: "First"; value: A } | { side: "Second"; value: B }> =>
  [
    ...a.map(e => ({ at: e.at, seq: e.seq, sideRank: 0, value: { side: "First" as const, value: e.value } })),
    ...b.map(e => ({ at: e.at, seq: e.seq, sideRank: 1, value: { side: "Second" as const, value: e.value } })),
  ].sort((x, y) => x.at - y.at || x.sideRank - y.sideRank || x.seq - y.seq)
   .map(({ at, seq, value }) => ({ at, seq, value }));
const modelWait = <T>(s: ModelStream<T>, now: number): T | null => {
  const hit = s.find(e => e.at <= now);
  return hit ? hit.value : null;
};

/** Deterministic PRNG (Mulberry32) so randomized differential runs are 100% reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("differential oracle: filter, filterMap, map, and or match the naive model across 120 random traces", () => {
  const prog = source(`
    let a = ciFailed("a")->filter(s => s != "skip")->map(s => "A:" ++ s)
    let b = ciFailed("b")->filterMap(s => if s == "drop" { None } else { Some("B:" ++ s) })
    a->or(b)->wait
  `);
  const rand = mulberry32(20261122);
  const payloads = ["skip", "drop", "boom", "lint", "oom"];
  for (let trial = 0; trial < 120; trial++) {
    const ledger = emptyLedger(0);
    evaluate(prog, ledger, 0);
    const traceA: ModelEvent<string>[] = [];
    const traceB: ModelEvent<string>[] = [];
    let t = 0;
    const count = 1 + Math.floor(rand() * 8);
    for (let seq = 0; seq < count; seq++) {
      t += Math.floor(rand() * 30);
      const isA = rand() < 0.5;
      const payload = payloads[Math.floor(rand() * payloads.length)]!;
      if (isA) {
        occur(ledger, stream("ciFailed", text("a")), text(payload), t);
        traceA.push({ at: t, seq, value: payload });
      } else {
        occur(ledger, stream("ciFailed", text("b")), text(payload), t);
        traceB.push({ at: t, seq, value: payload });
      }
    }
    const now = t + 10;
    const pass = evaluate(prog, ledger, now);

    const expected = modelWait(
      modelOr(
        modelMap(modelFilter(traceA, s => s !== "skip"), s => `A:${s}`),
        modelFilterMap(traceB, s => s === "drop" ? null : `B:${s}`),
      ),
      now,
    );
    if (expected === null) {
      assert.equal(pass.status, "waiting", `trial ${trial}`);
    } else {
      assert.equal(pass.status, "completed", `trial ${trial}`);
      assert.deepEqual(pass.result, variant(expected.side, text(expected.value)), `trial ${trial}`);
    }
  }
});

test("algebraic laws: filterMap identity, composition, and functor map/filter equivalences hold against oracle", () => {
  const s = stream("ciFailed", text("acme/api"));
  const pIdentity = source('ciFailed("acme/api")->filterMap(x => Some(x))->wait');
  const pDirect = source('ciFailed("acme/api")->wait');
  const pComposed = source('ciFailed("acme/api")->filterMap(x => if x == "skip" { None } else { Some(x ++ "!") })->filterMap(y => if y == "bad!" { None } else { Some("ok:" ++ y) })->wait');
  const pFused = source('ciFailed("acme/api")->filterMap(x => if x == "skip" || x == "bad" { None } else { Some("ok:" ++ x ++ "!") })->wait');
  const pNeverRight = source('ciFailed("acme/api")->or(never())->map(e => switch e { | First(x) => x | Second(_) => "" })->wait');

  for (const inputs of [["skip", "bad", "good"], ["good"], ["skip", "bad"]]) {
    const runWith = (code: ReturnType<typeof source>): Value | null => {
      const ledger = emptyLedger(0);
      evaluate(code, ledger, 0);
      inputs.forEach((v, i) => occur(ledger, s, text(v), (i + 1) * 10));
      const p = evaluate(code, ledger, 100);
      return p.status === "completed" ? p.result : null;
    };
    assert.deepEqual(runWith(pIdentity), runWith(pDirect));
    assert.deepEqual(runWith(pComposed), runWith(pFused));
    assert.deepEqual(runWith(pNeverRight), runWith(pDirect));
    // And never() produces nothing against the model.
    assert.equal(modelWait(modelNever(), 100), null);
  }
});
