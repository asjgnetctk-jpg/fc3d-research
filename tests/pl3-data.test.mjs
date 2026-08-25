import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(file) {
  return JSON.parse(
    await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
  );
}

test("PL3 uses the canonical archive and exactly replays displayed hit flags", async () => {
  const [canonical, data, omissions] = await Promise.all([
    json("scripts/data/pl3-full-history.json"),
    json("pages/pl3-data.json"),
    json("pages/pl3-omissions-data.json"),
  ]);

  assert.ok(canonical.rows.length >= 7676);
  assert.deepEqual(canonical.rows[0], {
    issue: "04001",
    date: "2004-11-14",
    draw: "192",
    digits: [1, 9, 2],
  });
  assert.equal(data.dataIntegrity.periods, canonical.rows.length);
  assert.equal(omissions.periods, canonical.rows.length);
  const latest = canonical.rows.at(-1);
  assert.equal(
    data.sourceUpdatedThrough,
    `${latest.date} · 第${latest.issue}期`,
  );

  for (const row of data.history) {
    const actual = [...new Set(row.draw.split("").map(Number))];
    assert.equal(row.danHit, actual.includes(row.dan), `${row.issue} dan`);
    for (const size of [5, 6, 7]) {
      const pool = row[`pool${size}`].split("").map(Number);
      assert.equal(
        row[`pool${size}Hit`],
        actual.length === 3 && actual.every((digit) => pool.includes(digit)),
        `${row.issue} pool${size}`,
      );
      assert.equal(
        row[`pool${size}Group3Covered`],
        actual.length === 2 && actual.every((digit) => pool.includes(digit)),
        `${row.issue} pool${size} group3`,
      );
    }
  }
});

function maxFromRows(rows, field) {
  return Math.max(...rows.map((row) => row[field]));
}

function maxMissFromFlags(rows, field, startDate) {
  let current = 0;
  let maximum = 0;
  for (const row of rows) {
    if (startDate && row.date < startDate) continue;
    if (row[field]) current = 0;
    else {
      current += 1;
      maximum = Math.max(maximum, current);
    }
  }
  return maximum;
}

test("PL3 published streak metrics match displayed replay rows", async () => {
  const [pl3V7, pl3V2, pl3V5] = await Promise.all([
    json("pages/pl3-data.json"),
    json("pages/pl3-v2-data.json"),
    json("pages/pl3-v5-data.json"),
  ]);

  for (const play of ["dan", "pool5", "pool6", "pool7", "group3"]) {
    const field = play === "group3" ? "shapeMissStreak" : `${play}MissStreak`;
    assert.equal(
      pl3V7.metrics[play].maxMiss,
      maxFromRows(pl3V7.history, field),
      `V7 ${play}`,
    );
  }
  for (const play of ["dan", "pool5", "pool6", "pool7"]) {
    assert.equal(
      pl3V2.actualMetrics[play].maxMiss,
      maxMissFromFlags(pl3V2.rows, `${play}Hit`),
      `V2 total ${play}`,
    );
    assert.equal(
      pl3V2.metrics[play].maxMiss,
      maxMissFromFlags(
        pl3V2.rows.filter((row) => row.date <= pl3V2.trainingEnd),
        `${play}Hit`,
        pl3V2.metrics[play].startDate,
      ),
      `V2 ${play}`,
    );
    assert.equal(
      pl3V2.forwardMetrics[play].maxMiss,
      maxMissFromFlags(
        pl3V2.rows.filter((row) => row.date > pl3V2.trainingEnd),
        `${play}Hit`,
        pl3V2.forwardMetrics[play].startDate,
      ),
      `V2 forward ${play}`,
    );
  }
  for (const play of ["dan", "pool7", "shape"]) {
    assert.equal(
      pl3V5.metrics[play].maxMiss,
      maxMissFromFlags(pl3V5.rows, `${play}Hit`),
      `V5 ${play}`,
    );
  }
});
