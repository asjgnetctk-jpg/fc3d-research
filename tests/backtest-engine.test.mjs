import assert from "node:assert/strict";
import test from "node:test";

import {
  FEATURE_NAMES,
  FORMULAS_PER_SIZE,
  WINDOWS,
  WEIGHTS,
  compareHighHit,
  createEvaluator,
  formulaForSample,
  prepareRows,
} from "../lib/backtest-engine-core.mjs";

test("formula space has the documented size", () => {
  assert.equal(FORMULAS_PER_SIZE, 443_889_677);
});

test("seeded random traversal is reproducible and has no early duplicates", () => {
  const serialize = (candidate) => JSON.stringify(candidate);
  const first = Array.from({ length: 5_000 }, (_, index) =>
    serialize(formulaForSample(index, 20_260_907, "random")),
  );
  const repeated = Array.from({ length: 5_000 }, (_, index) =>
    serialize(formulaForSample(index, 20_260_907, "random")),
  );

  assert.deepEqual(first, repeated);
  assert.equal(new Set(first).size, first.length);
});

test("decoded formulas only contain supported windows and weights", () => {
  for (let index = 0; index < 1_000; index += 1) {
    const candidate = formulaForSample(index, 17, "exhaustive");
    assert.ok(WINDOWS.includes(candidate.window));
    for (const feature of FEATURE_NAMES) assert.ok(WEIGHTS.includes(candidate[feature]));
  }
});

test("fixed-pool metrics agree with an independent hit count", () => {
  const snapshot = {
    rows: [
      { draw: "012" },
      { draw: "345" },
      { draw: "004" },
      { draw: "234" },
      { draw: "678" },
      { draw: "123" },
    ],
  };
  const rows = prepareRows(snapshot);
  const evaluator = createEvaluator(rows);
  const candidate = { family: "fixed", pool: [0, 1, 2, 3, 4] };
  const actual = evaluator.metrics(candidate, 5, 0, rows.length);
  const expectedHits = rows.filter((row) => {
    const unique = [...new Set(row.digits)];
    return unique.length === 3 && unique.every((digit) => candidate.pool.includes(digit));
  }).length;

  assert.equal(actual.hits, expectedHits);
  assert.equal(actual.hits, 3);
  assert.equal(actual.count, 6);
  assert.equal(actual.maxMiss, 2);
});

test("V2 high-hit metrics use dan and pool rules independently", () => {
  const rows = prepareRows({
    rows: [
      { draw: "012" },
      { draw: "345" },
      { draw: "004" },
      { draw: "234" },
    ],
  });
  const evaluator = createEvaluator(rows);
  assert.deepEqual(
    evaluator.metricsForPlay({ family: "fixed", pool: [0] }, "dan", 0, rows.length),
    { count: 4, hits: 2, misses: 2, rate: 0.5, maxMiss: 1 },
  );
  assert.equal(
    evaluator.metricsForPlay(
      { family: "fixed", pool: [0, 1, 2, 3, 4] },
      "pool5",
      0,
      rows.length,
    ).hits,
    2,
  );
});

test("high-hit comparison prefers rate, then shorter miss streak", () => {
  const candidates = [
    { metrics: { rate: 0.3, maxMiss: 4 } },
    { metrics: { rate: 0.4, maxMiss: 7 } },
    { metrics: { rate: 0.4, maxMiss: 5 } },
  ].sort(compareHighHit);
  assert.equal(candidates[0].metrics.rate, 0.4);
  assert.equal(candidates[0].metrics.maxMiss, 5);
});
