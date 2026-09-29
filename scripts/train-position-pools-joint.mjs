import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const configPath = path.join(root, "scripts", "config", `${game}-position-pools-joint.json`);
const dataPath = path.join(root, "scripts", "data", `${game}-full-history.json`);
const config = JSON.parse(await readFile(configPath, "utf8"));
const draws = JSON.parse(await readFile(dataPath, "utf8")).rows;
const positions = ["hundreds", "tens", "units"];
const MIN_HISTORY = 120;
const WINDOWS = [30, 100, 300, 500];
const WINDOW_WEIGHTS = { 30: 0.15, 100: 0.20, 300: 0.30, 500: 0.35 };
const MISMATCH_PENALTIES = { 5: 0.05, 6: 0.08, 7: 0.12 };

function positionFrequency(history, position, window) {
  const rows = history.slice(-window);
  const counts = Array(10).fill(0);
  for (const row of rows) counts[row.digits[position]] += 1;
  return counts.map((count) => count / rows.length);
}

function positionGaps(history, position) {
  return Array.from({ length: 10 }, (_, digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (history[history.length - 1 - age].digits[position] === digit) return Math.min(age, 60) / 60;
    }
    return 1;
  });
}

function features(history, position) {
  const frequencies = {};
  for (const window of [5, 10, 20, 30, 60, 120]) frequencies[window] = positionFrequency(history, position, window);
  return { frequencies, gaps: positionGaps(history, position), last: history.at(-1).digits[position] };
}

function poolFromFeature(feature, method, poolSize) {
  return Array.from({ length: 10 }, (_, digit) => ({
    digit,
    score:
      feature.frequencies[method.longWindow][digit] * method.longWeight +
      feature.frequencies[method.shortWindow][digit] * method.shortWeight +
      feature.gaps[digit] * method.gapWeight +
      Number(digit === feature.last) * method.lastWeight,
  }))
    .sort((left, right) => right.score - left.score || left.digit - right.digit)
    .slice(0, poolSize)
    .map((item) => item.digit);
}

function jointMetrics(hitRows) {
  const count = hitRows.length;
  const positionHits = [0, 0, 0];
  const buckets = [0, 0, 0, 0];
  const drag = [0, 0, 0];
  let allHitRun = 0;
  let longestAllHit = 0;
  let missRun = 0;
  let maxAllMiss = 0;
  for (const hits of hitRows) {
    for (let position = 0; position < 3; position += 1) positionHits[position] += Number(hits[position]);
    const hitCount = hits.filter(Boolean).length;
    buckets[hitCount] += 1;
    if (hitCount === 2) {
      const missed = hits.findIndex((value) => !value);
      drag[missed] += 1;
    }
    if (hitCount === 3) {
      allHitRun += 1;
      longestAllHit = Math.max(longestAllHit, allHitRun);
      missRun = 0;
    } else {
      missRun += 1;
      maxAllMiss = Math.max(maxAllMiss, missRun);
      allHitRun = 0;
    }
  }
  const rates = positionHits.map((value) => (count ? value / count : 0));
  const allThreeRate = count ? buckets[3] / count : 0;
  const exactlyTwoRate = count ? buckets[2] / count : 0;
  const singlePositionDragRate = count ? drag.reduce((sum, value) => sum + value, 0) / count : 0;
  const independentProduct = rates[0] * rates[1] * rates[2];
  return {
    count,
    allThreeRate,
    exactlyTwoRate,
    syncEfficiency: independentProduct ? allThreeRate / independentProduct : 0,
    maxAllMiss,
    longestAllHit,
    score:
      0.55 * allThreeRate +
      0.15 * exactlyTwoRate +
      0.10 * rates[0] +
      0.10 * rates[1] +
      0.10 * rates[2] -
      0.20 * singlePositionDragRate,
  };
}

const trainingRows = [];
for (let index = MIN_HISTORY; index < draws.length; index += 1) {
  const row = draws[index];
  if (row.date < config.trainingStart || row.date > config.trainingEnd) continue;
  const history = draws.slice(0, index);
  trainingRows.push({
    issue: row.issue,
    actual: row.digits,
    features: [0, 1, 2].map((position) => features(history, position)),
  });
}

function methodsForPool(pool) {
  const byId = new Map();
  for (const position of positions) {
    for (const mode of ["normals", "defenses"]) {
      for (const method of pool.methods[position][mode]) byId.set(method.id, method);
    }
  }
  return [...byId.values()];
}

function assignmentFromPool(pool) {
  return positions.map((position) => ({
    normals: pool.methods[position].normals.map((method) => method.id),
    defenses: pool.methods[position].defenses.map((method) => method.id),
  }));
}

function optimizePool(poolSize, pool) {
  const library = methodsForPool(pool);
  const byId = new Map(library.map((method) => [method.id, method]));
  const hits = Array.from({ length: 3 }, () => new Map());
  for (let position = 0; position < 3; position += 1) {
    for (const method of library) {
      hits[position].set(method.id, Uint8Array.from(trainingRows, (row) =>
        poolFromFeature(row.features[position], method, poolSize).includes(row.actual[position]) ? 1 : 0,
      ));
    }
  }
  const assignment = assignmentFromPool(pool);
  function replay() {
    const streaks = [0, 0, 0];
    return trainingRows.map((row, rowIndex) => [0, 1, 2].map((position) => {
      const mode = streaks[position] ? "defenses" : "normals";
      const id = assignment[position][mode][row.features[position].last];
      const hit = Boolean(hits[position].get(id)[rowIndex]);
      streaks[position] = hit ? 0 : streaks[position] + 1;
      return hit;
    }));
  }
  function evaluate() {
    const replayRows = replay();
    const windows = Object.fromEntries(WINDOWS.map((window) => [window, jointMetrics(replayRows.slice(-window))]));
    let weightedScore = 0;
    let weightedAllThree = 0;
    let weightedSync = 0;
    for (const window of WINDOWS) {
      const weight = WINDOW_WEIGHTS[window];
      weightedScore += windows[window].score * weight;
      weightedAllThree += windows[window].allThreeRate * weight;
      weightedSync += windows[window].syncEfficiency * weight;
    }
    const mismatchExcess = Math.max(0, windows[500].exactlyTwoRate - windows[500].allThreeRate);
    return {
      windows,
      weightedScore,
      weightedAllThree,
      weightedSync,
      mismatchPenalty: mismatchExcess * MISMATCH_PENALTIES[poolSize],
      selectionScore: weightedScore - mismatchExcess * MISMATCH_PENALTIES[poolSize],
    };
  }
  function better(left, right) {
    const epsilon = 1e-12;
    const scoreNotWorse = left.selectionScore >= right.selectionScore - epsilon;
    const allThreeNotWorse = left.weightedAllThree >= right.weightedAllThree - epsilon;
    if (scoreNotWorse && allThreeNotWorse && (
      left.selectionScore > right.selectionScore + epsilon ||
      left.weightedAllThree > right.weightedAllThree + epsilon
    )) return true;
    return scoreNotWorse && allThreeNotWorse && left.weightedSync > right.weightedSync + epsilon;
  }

  const before = evaluate();
  let best = before;
  for (let round = 0; round < 3; round += 1) {
    let changed = 0;
    for (let position = 0; position < 3; position += 1) {
      for (const mode of ["normals", "defenses"]) {
        for (let state = 0; state < 10; state += 1) {
          const original = assignment[position][mode][state];
          let bestId = original;
          let slotBest = best;
          for (const method of library) {
            if (method.id === bestId) continue;
            assignment[position][mode][state] = method.id;
            const candidate = evaluate();
            if (better(candidate, slotBest)) {
              slotBest = candidate;
              bestId = method.id;
            }
          }
          assignment[position][mode][state] = bestId;
          if (bestId !== original) changed += 1;
          best = slotBest;
        }
      }
    }
    console.log(`${game} ${poolSize}码联合搜索第${round + 1}轮：调整${changed}项，三位全中${(best.windows[500].allThreeRate * 100).toFixed(2)}%，同步效率${best.windows[500].syncEfficiency.toFixed(3)}，评分${best.selectionScore.toFixed(5)}`);
    if (!changed) break;
  }
  for (let position = 0; position < 3; position += 1) {
    const target = pool.methods[positions[position]];
    target.normals = assignment[position].normals.map((id) => byId.get(id));
    target.defenses = assignment[position].defenses.map((id) => byId.get(id));
  }
  pool.jointOptimization = { candidateLibrarySize: library.length, before, after: best };
  return { before, after: best, librarySize: library.length };
}

const reports = {};
for (const poolSize of [5, 6, 7]) reports[poolSize] = optimizePool(poolSize, config.pools[poolSize]);
const allIds = new Set();
for (const pool of Object.values(config.pools)) {
  for (const position of positions) {
    for (const mode of ["normals", "defenses"]) {
      for (const method of pool.methods[position][mode]) allIds.add(method.id);
    }
  }
}
config.formulaVersion = `${game.toUpperCase()}-POSITION-POOLS-JOINT-OBJECTIVE-V2`;
config.trainingMode = "one-year-in-sample-joint-objective-selection";
config.candidateFormulaCount = allIds.size;
config.optimizationObjective = {
  primary: "same-draw-all-three-hit-rate-and-sync-efficiency",
  score: "0.55*allThree + 0.15*exactlyTwo + 0.10*hundreds + 0.10*tens + 0.10*units - 0.20*singlePositionDrag",
  mismatchPenalty: MISMATCH_PENALTIES,
  windows: WINDOWS,
  windowWeights: WINDOW_WEIGHTS,
  poolWeightsShared: false,
  reports,
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`已写入 ${path.relative(root, configPath)}；五码、六码、七码权重互相独立。`);
