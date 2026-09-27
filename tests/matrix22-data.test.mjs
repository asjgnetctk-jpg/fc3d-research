import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const data = JSON.parse(await readFile(new URL("../pages/heat-data.json", import.meta.url), "utf8"));
const v7 = JSON.parse(await readFile(new URL("../pages/data.json", import.meta.url), "utf8"));
const shape = (value) => {
  const unique = new Set(value).size;
  return unique === 3 ? "组六" : unique === 2 ? "组三" : "豹子";
};

test("matrix22 publishes exactly 22 unique straight numbers", () => {
  const numbers = data.matrix22.numbers.map((row) => row.number);
  if (data.matrix22.status === "等待当期热度，尚未推荐") {
    assert.equal(numbers.length, 0);
    assert.equal(data.matrix22.heatSnapshot, null);
    return;
  }
  assert.equal(numbers.length, 22);
  assert.equal(new Set(numbers).size, 22);
  for (const value of numbers) assert.match(value, /^\d{3}$/);
});

test("matrix22 structure and replay marks are derived from the listed numbers", () => {
  const counts = { "组六": 0, "组三": 0, "豹子": 0 };
  for (const row of data.matrix22.numbers) {
    assert.equal(row.shape, shape(row.number));
    counts[row.shape] += 1;
  }
  const expected = data.matrix22.numbers.length === 22
    ? { "组六": 16, "组三": 6, "豹子": 0 }
    : { "组六": 0, "组三": 0, "豹子": 0 };
  assert.deepEqual(counts, expected);
  assert.deepEqual(data.matrix22.structure, { group6: expected["组六"], group3: expected["组三"], triple: expected["豹子"] });
  for (const row of data.matrix22.replayRows) {
    assert.equal(row.hit, row.numbers.includes(row.draw));
    assert.equal(row.numbers.length, 22);
  }
  assert.equal(data.matrix22.replay.hits, data.matrix22.replayRows.filter((row) => row.hit).length);
  assert.equal(data.matrix22.replay.count, data.matrix22.replayRows.length);
});

test("matrix22 forward ledger is finalized only from official draw rows", () => {
  const official = new Map(v7.history.map((row) => [String(row.issue), row]));
  for (const row of data.matrix22.liveRows) {
    assert.ok(official.has(String(row.issue)));
    assert.equal(row.draw, official.get(String(row.issue)).draw);
    assert.equal(row.hit, row.numbers.includes(row.draw));
  }
  const currentVersionRows = data.matrix22.liveRows.filter((row) => row.version === data.matrix22.modelVersion);
  assert.equal(data.matrix22.live.count, currentVersionRows.length);
  assert.equal(data.matrix22.live.hits, currentVersionRows.filter((row) => row.hit).length);
});
