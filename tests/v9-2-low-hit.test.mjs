import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const data = JSON.parse(await readFile(new URL("../pages/v9-2-data.json", import.meta.url), "utf8"));

test("V9.2 only publishes the locked one-year replay", () => {
  assert.ok(data.history.length >= 300 && data.history.length <= 370);
  assert.equal(data.history[0].date, data.historyStartDate);
  assert.equal(data.historyStartDate, data.validation.startDate);
  for (const row of data.history) {
    const unique = [...new Set(row.draw.split(""))];
    for (const size of [5, 6, 7, 8]) {
      const key = `pool${size}`;
      assert.equal(row[key].length, size);
      assert.equal(row[`${key}Hit`], unique.length === 3 && unique.every((digit) => row[key].includes(digit)));
      assert.equal(row[`${key}Group3Covered`], unique.length === 2 && unique.every((digit) => row[key].includes(digit)));
    }
  }
});

test("V9.2 summary exactly matches its published one-year rows", () => {
  for (const size of [5, 6, 7, 8]) {
    const key = `pool${size}`;
    const hits = data.history.filter((row) => row[`${key}Hit`]).length;
    const group3Rows = data.history.filter((row) => new Set(row.draw).size === 2);
    const covered = group3Rows.filter((row) => row[`${key}Group3Covered`]).length;
    assert.equal(data.metrics[key].all.count, data.history.length);
    assert.equal(data.metrics[key].all.hits, hits);
    assert.equal(data.metrics[key].group3.all.count, group3Rows.length);
    assert.equal(data.metrics[key].group3.all.covered, covered);
  }
});
