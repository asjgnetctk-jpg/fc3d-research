import { readFile, writeFile } from "node:fs/promises";
import { featureColumns, rankDigits } from "../lib/v5-model.js";

const DATA_PATH = "scripts/data/fc3d-full-history.json";
const REPORT_PATH = "scripts/results/full-history-training.json";
const RECENT_START = "2023-07-28";

function bucket(missStreak, methodCount) {
  if (methodCount > 4) return Math.min(missStreak, methodCount - 1);
  return missStreak < 3 ? 0 : missStreak < 5 ? 1 : missStreak < 7 ? 2 : 3;
}

function metrics(hits) {
  let countHits = 0;
  let current = 0;
  let maxMiss = 0;
  for (const hit of hits) {
    if (hit) {
      countHits += 1;
      current = 0;
    } else {
      current += 1;
      maxMiss = Math.max(maxMiss, current);
    }
  }
  return {
    count: hits.length,
    hits: countHits,
    rate: hits.length ? countHits / hits.length : 0,
    maxMiss,
  };
}

function compare(left, right) {
  return (
    left.overall.maxMiss - right.overall.maxMiss ||
    left.recentThreeYears.maxMiss - right.recentThreeYears.maxMiss ||
    right.overall.rate - left.overall.rate
  );
}

function replay(draws, methods, play) {
  const hits = [];
  const recentHits = [];
  let missStreak = 0;
  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    const method = methods[bucket(missStreak, methods.length)];
    const ranked = rankDigits(featureColumns(draws.slice(0, index)), method);
    let hit;
    if (play === "dan") {
      hit = row.digits.includes(ranked[method.rank - 1].digit);
    } else {
      const size = Number(play.slice(-1));
      const pool = ranked.slice(0, size).map((item) => item.digit);
      const unique = [...new Set(row.digits)];
      hit =
        unique.length === 3 &&
        unique.every((digit) => pool.includes(digit));
    }
    hits.push(hit);
    if (row.date >= RECENT_START) recentHits.push(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return {
    overall: metrics(hits),
    recentThreeYears: {
      start: RECENT_START,
      ...metrics(recentHits),
    },
  };
}

async function main() {
  const draws = JSON.parse(await readFile(DATA_PATH, "utf8")).rows;
  const currentV7 = JSON.parse(
    await readFile("lib/v7-robust-config.json", "utf8"),
  );
  const currentPools = JSON.parse(
    await readFile("lib/pool56-config.json", "utf8"),
  );
  const incumbentV7 = JSON.parse(
    await readFile("pages/audit/v7-locked-config.json", "utf8"),
  );
  const incumbentPools = JSON.parse(
    await readFile("pages/audit/pool56-config.json", "utf8"),
  );
  const candidates = {
    dan: {
      incumbent: incumbentV7.dan.methods,
      expanded: currentV7.dan.methods,
    },
    pool7: {
      incumbent: incumbentV7.pool7.methods,
      expanded: currentV7.pool7.methods,
    },
    pool5: {
      incumbent: incumbentPools.pool5.methods,
      expanded: currentPools.pool5.methods,
    },
    pool6: {
      incumbent: incumbentPools.pool6.methods,
      expanded: currentPools.pool6.methods,
    },
  };
  const selection = {};
  for (const [play, alternatives] of Object.entries(candidates)) {
    const incumbentMetrics = replay(draws, alternatives.incumbent, play);
    const expandedMetrics = replay(draws, alternatives.expanded, play);
    const useExpanded = compare(expandedMetrics, incumbentMetrics) < 0;
    selection[play] = {
      selected: useExpanded ? "expanded" : "incumbent",
      incumbent: incumbentMetrics,
      expanded: expandedMetrics,
      methods: useExpanded ? alternatives.expanded : alternatives.incumbent,
      final: useExpanded ? expandedMetrics : incumbentMetrics,
    };
  }

  const finalV7 = {
    ...currentV7,
    version: "V7.4-best-of-two",
    dan: { methods: selection.dan.methods },
    pool7: { methods: selection.pool7.methods },
  };
  const finalPools = {
    ...currentPools,
    version: "pools56-best-of-two-1",
    pool5: { methods: selection.pool5.methods },
    pool6: { methods: selection.pool6.methods },
  };
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  report.finalSelection = Object.fromEntries(
    Object.entries(selection).map(([play, value]) => [
      play,
      {
        selected: value.selected,
        incumbent: value.incumbent,
        expanded: value.expanded,
        final: value.final,
      },
    ]),
  );
  report.finalSelectionRule =
    "Keep the expanded model only when it improves full-history maximum miss; use recent-three-year maximum miss and hit rate as tie-breakers.";

  await writeFile(
    "lib/v7-robust-config.json",
    `${JSON.stringify(finalV7, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "lib/pool56-config.json",
    `${JSON.stringify(finalPools, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(selection).map(([play, value]) => [
          play,
          {
            selected: value.selected,
            final: value.final,
          },
        ]),
      ),
      null,
      2,
    ),
  );
}

await main();
