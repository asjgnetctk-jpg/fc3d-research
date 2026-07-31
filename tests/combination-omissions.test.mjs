import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedCounts = {
  pool3: 120,
  pool4: 210,
  pool5: 252,
  pool6: 210,
  pool7: 120,
};

test("combination omissions exactly replay the canonical draw history", async () => {
  const [snapshot, data] = await Promise.all([
    readFile(
      new URL("../scripts/data/fc3d-full-history.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(new URL("../pages/omissions-data.json", import.meta.url), "utf8").then(
      JSON.parse,
    ),
  ]);

  assert.equal(data.periods, snapshot.rows.length);

  for (const [key, expectedCount] of Object.entries(expectedCounts)) {
    const pool = data.pools[key];
    assert.equal(pool.count, expectedCount);
    assert.equal(pool.rows.length, expectedCount);

    for (const row of pool.rows) {
      const digits = new Set([...row.combination].map(Number));
      let hits = 0;
      let currentMiss = 0;
      let maxMiss = 0;
      let lastHitIssue = null;
      let lastHitDate = null;

      for (const draw of snapshot.rows) {
        const actual = [...new Set(draw.digits)];
        const hit =
          actual.length === 3 && actual.every((digit) => digits.has(digit));
        if (hit) {
          hits += 1;
          currentMiss = 0;
          lastHitIssue = draw.issue;
          lastHitDate = draw.date;
        } else {
          currentMiss += 1;
          maxMiss = Math.max(maxMiss, currentMiss);
        }
      }

      assert.equal(row.hits, hits, `${key} ${row.combination} hits`);
      assert.equal(
        row.totalMiss,
        data.periods - hits,
        `${key} ${row.combination} totalMiss`,
      );
      assert.equal(
        row.currentMiss,
        currentMiss,
        `${key} ${row.combination} currentMiss`,
      );
      assert.equal(row.maxMiss, maxMiss, `${key} ${row.combination} maxMiss`);
      assert.equal(
        row.lastHitIssue,
        lastHitIssue,
        `${key} ${row.combination} lastHitIssue`,
      );
      assert.equal(
        row.lastHitDate,
        lastHitDate,
        `${key} ${row.combination} lastHitDate`,
      );
    }
  }
});
