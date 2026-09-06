import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const data = JSON.parse(await readFile(new URL("../pages/v9-data.json", import.meta.url), "utf8"));

function replayMetric(rows, key) {
  let hits = 0;
  let miss = 0;
  let maxMiss = 0;
  for (const row of rows) {
    if (row[key]) {
      hits += 1;
      miss = 0;
    } else {
      miss += 1;
      maxMiss = Math.max(maxMiss, miss);
    }
  }
  return { count: rows.length, hits, maxMiss, currentMiss: miss };
}

test("V9 hit flags exactly match the published pools and draws", () => {
  assert.ok(data.history.length > 7_000);
  for (const row of data.history) {
    const unique = [...new Set(row.draw.split(""))];
    for (const size of [5, 6, 7, 8]) {
      const key = `pool${size}`;
      assert.equal(row[key].length, size);
      assert.equal(new Set(row[key]).size, size);
      const expected = unique.length === 3 && unique.every((digit) => row[key].includes(digit));
      assert.equal(row[`${key}Hit`], expected, `${row.issue} ${key}`);
      const expectedGroup3 = unique.length === 2 && unique.every((digit) => row[key].includes(digit));
      assert.equal(row[`${key}Group3Covered`], expectedGroup3, `${row.issue} ${key} group3`);
    }
  }
});

test("V9 group3 coverage totals exactly replay from daily evidence", () => {
  for (const size of [5, 6, 7, 8]) {
    const key = `pool${size}`;
    const group3Rows = data.history.filter((row) => new Set(row.draw).size === 2);
    const covered = group3Rows.filter((row) => row[`${key}Group3Covered`]).length;
    assert.equal(data.metrics[key].group3.all.count, group3Rows.length);
    assert.equal(data.metrics[key].group3.all.covered, covered);
  }
});

test("V9 published metrics exactly replay from its daily evidence", () => {
  for (const size of [5, 6, 7, 8]) {
    const key = `pool${size}`;
    const actual = replayMetric(data.history, `${key}Hit`);
    const published = data.metrics[key].all;
    assert.equal(published.count, actual.count);
    assert.equal(published.hits, actual.hits);
    assert.equal(published.maxMiss, actual.maxMiss);
    assert.equal(published.currentMiss, actual.currentMiss);
  }
});
