import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

for (const game of ["fc3d", "pl3"]) {
  test(`${game} positioning pools replay exactly`, async () => {
    const prefix = game === "pl3" ? "pl3-" : "";
    const source = await readJson(
      `scripts/data/${game === "pl3" ? "pl3" : "fc3d"}-full-history.json`,
    );
    const data = await readJson(`pages/${prefix}position7-data.json`);
    const byIssue = new Map(source.rows.map((row) => [row.issue, row]));

    assert.equal(data.dataSha256, source.canonicalSha256);
    assert.equal(data.futureGuarantee, false);
    const poolEntries = data.pools
      ? Object.entries(data.pools)
      : [["7", data]];
    for (const [sizeText, result] of poolEntries) {
      const size = Number(sizeText);
      const streaks = { hundreds: 0, tens: 0, units: 0 };
      for (const row of result.history) {
        const actual = byIssue.get(row.issue);
        assert.ok(actual, `missing source issue ${row.issue}`);
        assert.equal(row.draw, actual.draw);
        for (const [index, key] of ["hundreds", "tens", "units"].entries()) {
          const pool = String(row[`${key}Pool`]);
          assert.equal(pool.length, size);
          assert.equal(new Set(pool).size, size);
          const hit = pool.includes(String(actual.digits[index]));
          assert.equal(row[`${key}Hit`], hit, `${size}码 ${key} hit mismatch ${row.issue}`);
          streaks[key] = hit ? 0 : streaks[key] + 1;
          assert.equal(row[`${key}MissStreak`], streaks[key]);
        }
      }
    }
    assert.deepEqual(
      await readJson(`public/${prefix}position7-data.json`),
      data,
    );
  });
}

test("pl3 compressed positioning model contains exactly 71 unique formulas", async () => {
  const config = await readJson("scripts/config/pl3-position-pools.json");
  const data = await readJson("pages/pl3-position7-data.json");
  const ids = new Set();
  for (const pool of Object.values(config.pools)) {
    for (const position of ["hundreds", "tens", "units"]) {
      for (const method of pool.methods[position].normals) ids.add(method.id);
      for (const method of pool.methods[position].defenses) ids.add(method.id);
    }
  }
  assert.equal(config.candidateFormulaCount, 71);
  assert.equal(data.candidateFormulaCount, 71);
  assert.equal(ids.size, 71);
});
