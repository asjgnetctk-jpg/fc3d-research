import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const canonical = await readJson("scripts/data/fc3d-full-history.json");
const canonicalByIssue = new Map(canonical.rows.map((row) => [row.issue, row]));

function canonicalHash(rows) {
  return createHash("sha256")
    .update(rows.map((row) => `${row.issue},${row.date},${row.draw}`).join("\n"), "utf8")
    .digest("hex");
}

function shapeOf(draw) {
  const count = new Set(draw).size;
  return count === 1 ? "豹子" : count === 2 ? "组三" : "组六";
}

function poolHit(draw, pool) {
  const digits = [...new Set(draw)];
  return digits.length === 3 && digits.every((digit) => pool.includes(digit));
}

function group3Covered(draw, pool) {
  const digits = [...new Set(draw)];
  return digits.length === 2 && digits.every((digit) => pool.includes(digit));
}

function checkRows(rows, { dan = false, pools = [], shape = false, evaluatedShape = false }) {
  const seen = new Set();
  const streaks = Object.fromEntries([
    ...(dan ? [["dan", 0]] : []),
    ...pools.map((size) => [`pool${size}`, 0]),
  ]);
  let shapeStreak = 0;

  for (const row of rows) {
    assert.ok(!seen.has(row.issue), `duplicate published issue ${row.issue}`);
    seen.add(row.issue);
    const source = canonicalByIssue.get(row.issue);
    assert.ok(source, `published issue missing from canonical data: ${row.issue}`);
    assert.equal(row.draw, source.draw, `draw mismatch at ${row.issue}`);
    assert.equal(row.date, source.date, `date mismatch at ${row.issue}`);
    assert.equal(row.shape ?? shapeOf(row.draw), shapeOf(row.draw), `shape mismatch at ${row.issue}`);

    if (dan) {
      const hit = row.draw.includes(String(row.dan));
      assert.equal(row.danHit, hit, `dan hit mismatch at ${row.issue}`);
      streaks.dan = hit ? 0 : streaks.dan + 1;
      assert.equal(row.danMissStreak, streaks.dan, `dan streak mismatch at ${row.issue}`);
    }

    for (const size of pools) {
      const key = `pool${size}`;
      const pool = String(row[key]);
      assert.equal(pool.length, size, `${key} length mismatch at ${row.issue}`);
      assert.equal(new Set(pool).size, size, `${key} duplicate digit at ${row.issue}`);
      const hit = poolHit(row.draw, pool);
      assert.equal(row[`${key}Hit`], hit, `${key} hit mismatch at ${row.issue}`);
      if (`${key}Group3Covered` in row) {
        assert.equal(
          row[`${key}Group3Covered`],
          group3Covered(row.draw, pool),
          `${key} group3 coverage mismatch at ${row.issue}`,
        );
      }
      streaks[key] = hit ? 0 : streaks[key] + 1;
      assert.equal(row[`${key}MissStreak`], streaks[key], `${key} streak mismatch at ${row.issue}`);
    }

    if (shape) {
      const expected = row.shapePlay === shapeOf(row.draw);
      assert.equal(row.shapeHit, expected, `shape hit mismatch at ${row.issue}`);
    }
    if (evaluatedShape) {
      const expected = Boolean(row.shapeEvaluated && shapeOf(row.draw) === "组三");
      assert.equal(row.shapeHit, expected, `evaluated shape mismatch at ${row.issue}`);
      if (row.shapeEvaluated) shapeStreak = expected ? 0 : shapeStreak + 1;
      assert.equal(row.shapeMissStreak, shapeStreak, `shape streak mismatch at ${row.issue}`);
    }
  }
}

test("canonical FC3D history is complete, ordered and hash-verified", () => {
  assert.equal(canonical.rows.length, 7_746);
  assert.equal(canonical.rows[0].issue, "2004001");
  assert.equal(canonical.rows.at(-1).issue, "2026239");
  assert.equal(canonical.rows.at(-1).draw, "002");
  assert.equal(new Set(canonical.rows.map((row) => row.issue)).size, canonical.rows.length);
  assert.equal(canonicalHash(canonical.rows), canonical.canonicalSha256);
  for (let index = 1; index < canonical.rows.length; index += 1) {
    assert.ok(canonical.rows[index - 1].issue < canonical.rows[index].issue);
  }
});

test("V7, V2 and V5 published hit flags exactly replay", async () => {
  const v7 = await readJson("pages/data.json");
  const v2 = await readJson("pages/v2-data.json");
  const v5 = await readJson("pages/v5-data.json");
  assert.equal(v7.dataIntegrity.canonicalSha256, canonical.canonicalSha256);
  assert.equal(v2.dataSha256, canonical.canonicalSha256);
  assert.equal(v5.dataSha256, canonical.canonicalSha256);
  assert.equal(v5.trainingEnd, "2026-07-27");
  assert.equal(v5.forwardStart, "2026-07-28");
  checkRows(v7.history, { dan: true, pools: [5, 6, 7], evaluatedShape: true });
  checkRows(v2.rows, { dan: true, pools: [5, 6, 7] });
  checkRows(v5.rows, { dan: true, pools: [7], shape: true });
});

test("V9 and V9.2 published hit flags exactly replay", async () => {
  for (const file of ["pages/v9-data.json", "pages/v9-2-data.json"]) {
    const data = await readJson(file);
    assert.equal(data.dataSha256, canonical.canonicalSha256);
    checkRows(data.history, { pools: [5, 6, 7, 8] });
    assert.equal(data.basedOnIssue, canonical.rows.at(-1).issue);
    assert.equal(data.basedOnDate, canonical.rows.at(-1).date);
  }
});

test("generated public copies match their GitHub Pages copies", async () => {
  for (const file of [
    "omissions-data.json",
    "v2-data.json",
    "v5-data.json",
    "v9-data.json",
    "v9-2-data.json",
  ]) {
    assert.deepEqual(await readJson(`public/${file}`), await readJson(`pages/${file}`));
  }
});
