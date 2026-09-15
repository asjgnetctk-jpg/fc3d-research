import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

for (const game of ["fc3d", "pl3"]) {
  test(`${game} positioning 7-digit pools replay exactly`, async () => {
    const prefix = game === "pl3" ? "pl3-" : "";
    const source = await readJson(
      `scripts/data/${game === "pl3" ? "pl3" : "fc3d"}-full-history.json`,
    );
    const data = await readJson(`pages/${prefix}position7-data.json`);
    const byIssue = new Map(source.rows.map((row) => [row.issue, row]));
    const streaks = { hundreds: 0, tens: 0, units: 0 };

    assert.equal(data.dataSha256, source.canonicalSha256);
    assert.equal(data.targetMaxMiss, 1);
    assert.equal(data.futureGuarantee, false);
    for (const row of data.history) {
      const actual = byIssue.get(row.issue);
      assert.ok(actual, `missing source issue ${row.issue}`);
      assert.equal(row.draw, actual.draw);
      for (const [index, key] of ["hundreds", "tens", "units"].entries()) {
        const pool = String(row[`${key}Pool`]);
        assert.equal(pool.length, 7);
        assert.equal(new Set(pool).size, 7);
        const hit = pool.includes(String(actual.digits[index]));
        assert.equal(row[`${key}Hit`], hit, `${key} hit mismatch ${row.issue}`);
        streaks[key] = hit ? 0 : streaks[key] + 1;
        assert.equal(row[`${key}MissStreak`], streaks[key]);
      }
    }
    assert.deepEqual(
      await readJson(`public/${prefix}position7-data.json`),
      data,
    );
  });
}
