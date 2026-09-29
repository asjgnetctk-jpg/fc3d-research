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
      let combinedHits = 0;
      let combinedStreak = 0;
      let combinedMaxMiss = 0;
      for (const row of result.history) {
        const actual = byIssue.get(row.issue);
        assert.ok(actual, `missing source issue ${row.issue}`);
        assert.equal(row.draw, actual.draw);
        let allHit = true;
        for (const [index, key] of ["hundreds", "tens", "units"].entries()) {
          const pool = String(row[`${key}Pool`]);
          assert.equal(pool.length, size);
          assert.equal(new Set(pool).size, size);
          const hit = pool.includes(String(actual.digits[index]));
          allHit &&= hit;
          assert.equal(row[`${key}Hit`], hit, `${size}码 ${key} hit mismatch ${row.issue}`);
          streaks[key] = hit ? 0 : streaks[key] + 1;
          assert.equal(row[`${key}MissStreak`], streaks[key]);
        }
        assert.equal(row.allHit, allHit, `${size}码 combined hit mismatch ${row.issue}`);
        if (allHit) {
          combinedHits += 1;
          combinedStreak = 0;
        } else {
          combinedStreak += 1;
          combinedMaxMiss = Math.max(combinedMaxMiss, combinedStreak);
        }
      }
      assert.deepEqual(result.metrics.all.overall, {
        count: result.history.length,
        hits: combinedHits,
        rate: combinedHits / result.history.length,
        maxMiss: combinedMaxMiss,
        currentMiss: combinedStreak,
        targetMet: result.history.length > 0 && combinedMaxMiss <= 1,
      });
      const joint = result.metrics.joint;
      assert.equal(joint.count, result.history.length);
      assert.equal(joint.allThreeHits, combinedHits);
      assert.equal(joint.exactlyTwoRate, joint.mismatchRate);
      assert.ok(Number.isFinite(joint.syncEfficiency));
      assert.ok(Number.isFinite(joint.score));
      assert.equal(
        joint.aloneDragHits.hundreds + joint.aloneDragHits.tens + joint.aloneDragHits.units,
        joint.exactlyTwoHits,
      );
      for (const window of [30, 100, 300, 500]) {
        assert.equal(result.metrics.windows[window].count, Math.min(window, result.history.length));
      }
    }
    assert.deepEqual(
      await readJson(`public/${prefix}position7-data.json`),
      data,
    );
  });
}

test("positioning pools use separately optimized formula sets", async () => {
  const config = await readJson("scripts/config/pl3-position-pools-joint.json");
  const data = await readJson("pages/pl3-joint-position7-data.json");
  const ids = new Set();
  const signatures = new Set();
  for (const [size, pool] of Object.entries(config.pools)) {
    const poolIds = new Set();
    for (const position of ["hundreds", "tens", "units"]) {
      for (const method of pool.methods[position].normals) { ids.add(method.id); poolIds.add(method.id); }
      for (const method of pool.methods[position].defenses) { ids.add(method.id); poolIds.add(method.id); }
    }
    signatures.add(`${size}:${[...poolIds].sort().join(",")}`);
  }
  assert.equal(data.candidateFormulaCount, ids.size);
  assert.equal(config.candidateFormulaCount, ids.size);
  assert.equal(signatures.size, 3);
  assert.equal(config.optimizationObjective.poolWeightsShared, false);
  assert.equal(data.modelVariant, "joint");
});

test("joint position recommendations are embedded inside the private matrix module", async () => {
  const [html, positionScript, heatScript, matrixGenerator] = await Promise.all([
    readFile("pages/position7.html", "utf8"),
    readFile("pages/assets/position7.js", "utf8"),
    readFile("pages/assets/heat.js", "utf8"),
    readFile("scripts/generate-heat-module-data.mjs", "utf8"),
  ]);
  const heatHtml = await readFile("pages/heat.html", "utf8");
  assert.doesNotMatch(html, /id="position-lock"/);
  assert.match(positionScript, /load\(\);/);
  assert.match(heatHtml, /id="heat-lock"/);
  assert.match(heatHtml, /id="private-position-recommendation"/);
  assert.match(heatScript, /position7-data\.json/);
  assert.match(heatScript, /joint-position7-data\.json/);
  assert.match(matrixGenerator, /pages\/\$\{prefix\}position7-data\.json/);
  assert.match(heatScript, /renderPrivatePosition\(7\)/);
  assert.equal((await readJson("pages/position7-data.json")).modelVariant, "legacy");
  assert.equal((await readJson("pages/joint-position7-data.json")).modelVariant, "joint");
});
