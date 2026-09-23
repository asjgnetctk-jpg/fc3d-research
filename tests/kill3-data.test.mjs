import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
for (const game of ["fc3d", "pl3"]) {
  test(`${game} kill3 rows and metrics match source draws`, async () => {
    const prefix = game === "pl3" ? "pl3-" : "";
    const source = await readJson(`scripts/data/${game}-full-history.json`);
    const data = await readJson(`pages/${prefix}kill3-data.json`);
    const byIssue = new Map(source.rows.map((row) => [row.issue, row]));
    let miss = 0;
    for (const row of data.history) {
      const actual = byIssue.get(row.issue);
      assert.ok(actual);
      assert.equal(row.draw, actual.draw);
      assert.equal(row.kills.length, 3);
      assert.equal(new Set(row.kills).size, 3);
      const hit = actual.digits.every((digit) => !row.kills.includes(String(digit)));
      assert.equal(row.hit, hit);
      miss = hit ? 0 : miss + 1;
      assert.equal(row.missStreak, miss);
    }
    assert.equal(data.futureGuarantee, false);
    assert.equal(data.theoreticalRate, 0.343);
    assert.deepEqual(await readJson(`public/${prefix}kill3-data.json`), data);
  });
}
