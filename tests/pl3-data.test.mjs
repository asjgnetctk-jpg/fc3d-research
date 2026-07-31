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

  assert.equal(canonical.rows.length, 7676);
  assert.deepEqual(canonical.rows[0], {
    issue: "04001",
    date: "2004-11-14",
    draw: "192",
    digits: [1, 9, 2],
  });
  assert.equal(canonical.rows.at(-1).issue, "26201");
  assert.equal(canonical.rows.at(-1).date, "2026-07-30");
  assert.equal(data.dataIntegrity.periods, canonical.rows.length);
  assert.equal(omissions.periods, canonical.rows.length);

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

test("PL3 published streaks do not exceed the matching FC3D version", async () => {
  const [fcV7, pl3V7, fcV2, pl3V2, fcV5, pl3V5] = await Promise.all([
    json("pages/data.json"),
    json("pages/pl3-data.json"),
    json("pages/v2-data.json"),
    json("pages/pl3-v2-data.json"),
    json("pages/v5-data.json"),
    json("pages/pl3-v5-data.json"),
  ]);

  for (const play of ["dan", "pool5", "pool6", "pool7", "group3"]) {
    assert.ok(
      pl3V7.metrics[play].maxMiss <= fcV7.metrics[play].maxMiss,
      `V7 ${play}: ${pl3V7.metrics[play].maxMiss} > ${fcV7.metrics[play].maxMiss}`,
    );
  }
  for (const play of ["dan", "pool5", "pool6", "pool7"]) {
    assert.ok(
      pl3V2.metrics[play].maxMiss <= fcV2.metrics[play].maxMiss,
      `V2 ${play}: ${pl3V2.metrics[play].maxMiss} > ${fcV2.metrics[play].maxMiss}`,
    );
  }
  for (const play of ["dan", "pool7", "shape"]) {
    assert.ok(
      pl3V5.metrics[play].maxMiss <= fcV5.metrics[play].maxMiss,
      `V5 ${play}: ${pl3V5.metrics[play].maxMiss} > ${fcV5.metrics[play].maxMiss}`,
    );
  }
});
