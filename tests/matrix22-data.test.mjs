import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const data = JSON.parse(await readFile(new URL("../pages/heat-data.json", import.meta.url), "utf8"));
const pl3Data = JSON.parse(await readFile(new URL("../pages/pl3-heat-data.json", import.meta.url), "utf8"));
const heatSource = JSON.parse(await readFile(new URL("../scripts/data/fc3d-17500-heat.json", import.meta.url), "utf8"));
const pl3HeatSource = JSON.parse(await readFile(new URL("../scripts/data/pl3-17500-heat.json", import.meta.url), "utf8"));
const v7 = JSON.parse(await readFile(new URL("../pages/data.json", import.meta.url), "utf8"));
const pl3V7 = JSON.parse(await readFile(new URL("../pages/pl3-data.json", import.meta.url), "utf8"));
const shape = (value) => {
  const unique = new Set(value).size;
  return unique === 3 ? "组六" : unique === 2 ? "组三" : "豹子";
};
const groupKey = (value) => String(value).padStart(3, "0").split("").sort().join("");

test("pre-draw exact-count snapshots contain three complete digit positions", () => {
  for (const source of [heatSource, pl3HeatSource]) {
    for (const snapshot of source.preDrawSnapshots.filter((row) => row.positionCounts)) {
      assert.equal(snapshot.positionCounts.length, 3);
      for (const counts of snapshot.positionCounts) {
        assert.equal(counts.length, 10);
        for (const count of counts) assert.ok(Number.isInteger(count) && count >= 0);
      }
      assert.ok(Number.isInteger(snapshot.totalSelections) && snapshot.totalSelections > 0);
      assert.match(snapshot.source, /xntzshow\.html\?issue=\d{7}$/);
    }
  }
});

test("matrix22 publishes exactly 22 unique straight numbers", () => {
  const numbers = data.matrix22.numbers.map((row) => row.number);
  if (data.matrix22.status.includes("尚未推荐")) {
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
  assert.equal(data.matrix22.liveAllVersions.count, data.matrix22.liveRows.length);
  assert.equal(data.matrix22.liveAllVersions.hits, data.matrix22.liveRows.filter((row) => row.hit).length);
  assert.ok(data.matrix22.liveRows.some((row) => row.version !== data.matrix22.modelVersion));
});

test("matrix22 coverage version uses unique groups and group-level hit marks", () => {
  const matrix = data.matrix22Coverage;
  const current = matrix.numbers.map((row) => row.number);
  assert.equal(new Set(current.map(groupKey)).size, current.length);
  for (const row of matrix.replayRows) {
    assert.equal(row.numbers.length, 22);
    assert.equal(new Set(row.numbers.map(groupKey)).size, 22);
    assert.equal(row.hit, row.numbers.some((number) => groupKey(number) === groupKey(row.draw)));
  }
  assert.equal(matrix.replay.hits, matrix.replayRows.filter((row) => row.hit).length);
  assert.equal(matrix.replay.count, matrix.replayRows.length);
});

test("PL3 matrix uses independent heat, models, replay marks and group quotas", () => {
  assert.match(pl3Data.source, /pl3-xntztablen/);
  assert.match(pl3Data.matrix22.modelVersion, /^P22\./);
  assert.match(pl3Data.matrix22Coverage.modelVersion, /^P22\./);
  const official = new Map(pl3V7.history.map((row) => [String(row.issue), row]));
  for (const row of pl3Data.matrix22.replayRows) {
    assert.equal(row.numbers.length, 22);
    assert.equal(row.hit, row.numbers.includes(row.draw));
  }
  for (const row of pl3Data.matrix22Coverage.replayRows) {
    assert.equal(row.numbers.length, 22);
    assert.equal(new Set(row.numbers.map(groupKey)).size, 22);
    assert.equal(row.hit, row.numbers.some((number) => groupKey(number) === groupKey(row.draw)));
  }
  for (const row of pl3Data.matrix22.liveRows) {
    assert.ok(official.has(String(row.issue)));
    assert.equal(row.draw, official.get(String(row.issue)).draw);
  }
  if (pl3Data.matrix22.numbers.length) {
    assert.deepEqual(pl3Data.matrix22.structure, { group6: 14, group3: 8, triple: 0 });
    assert.deepEqual(pl3Data.matrix22Coverage.structure, { group6: 16, group3: 6, triple: 0 });
  }
});
