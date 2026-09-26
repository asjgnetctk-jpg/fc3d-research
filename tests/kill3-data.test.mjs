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

test("fc3d modular kill formulas use only the two preceding draws and known issue", async () => {
  const source = await readJson("scripts/data/fc3d-full-history.json");
  const data = await readJson("pages/kill3-data.json");
  const byIssueIndex = new Map(source.rows.map((row, index) => [row.issue, index]));
  const calculate = (index, issue, formulas) => {
    const previous = source.rows[index - 1].digits;
    const previous2 = source.rows[index - 2].digits;
    const vector = [...previous, ...previous2, previous.reduce((sum, digit) => sum + digit, 0), Math.max(...previous) - Math.min(...previous), Number(issue.slice(-3)), 1];
    const kills = [];
    for (const weights of formulas) {
      const value = ((weights.reduce((sum, weight, feature) => sum + weight * vector[feature], 0) % 10) + 10) % 10;
      if (!kills.includes(value)) kills.push(value);
      if (kills.length === 3) break;
    }
    for (let digit = 0; kills.length < 3; digit++) if (!kills.includes(digit)) kills.push(digit);
    return kills.join("");
  };
  let miss = 0;
  for (const row of data.history) {
    const formulas = miss >= data.modularGuardPolicy.threshold ? data.modularGuardFormulas : data.modularFormulas;
    assert.equal(row.kills, calculate(byIssueIndex.get(row.issue), row.issue, formulas));
    miss = row.hit ? 0 : miss + 1;
  }
  const nextIssue = data.recommendation.targetIssue;
  const nextFormulas = miss >= data.modularGuardPolicy.threshold ? data.modularGuardFormulas : data.modularFormulas;
  assert.equal(data.recommendation.kills, calculate(source.rows.length, nextIssue, nextFormulas));
});
