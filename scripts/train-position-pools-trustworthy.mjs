import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const draws = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8")).rows;
const TRAINING_START = "2021-09-15";
const TRAINING_END = "2025-09-14";
const FORWARD_START = "2025-09-15";
const MIN_HISTORY = 120;
const TOP_PER_POSITION = 25;
const positions = ["hundreds", "tens", "units"];
const folds = [
  { key: "2021-22", start: "2021-09-15", end: "2022-09-14" },
  { key: "2022-23", start: "2022-09-15", end: "2023-09-14" },
  { key: "2023-24", start: "2023-09-15", end: "2024-09-14" },
  { key: "2024-25", start: "2024-09-15", end: "2025-09-14" },
];

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

function candidates() {
  const output = [];
  let id = 0;
  for (const longWindow of [20, 30, 60, 120]) {
    for (const shortWindow of [5, 10, 20]) {
      for (const longWeight of [-2, 1, 2]) {
        for (const shortWeight of [-1, 0, 1]) {
          for (const gapWeight of [-2, -1, 0, 1, 2]) {
            for (const lastWeight of [-1, 0, 1]) {
              output.push({ id: `p7-${++id}`, longWindow, shortWindow, longWeight, shortWeight, gapWeight, lastWeight });
            }
          }
        }
      }
    }
  }
  return output;
}

function poolHit(feature, actual, method, size) {
  const pool = Array.from({ length: 10 }, (_, digit) => ({
    digit,
    score:
      feature.frequencies[method.longWindow][digit] * method.longWeight +
      feature.frequencies[method.shortWindow][digit] * method.shortWeight +
      feature.gaps[digit] * method.gapWeight +
      Number(digit === feature.last) * method.lastWeight,
  }))
    .sort((left, right) => right.score - left.score || left.digit - right.digit)
    .slice(0, size)
    .map((item) => item.digit);
  return pool.includes(actual);
}

const trainingRows = [];
for (let index = MIN_HISTORY; index < draws.length; index += 1) {
  const row = draws[index];
  if (row.date < TRAINING_START || row.date > TRAINING_END) continue;
  const fold = folds.find((item) => row.date >= item.start && row.date <= item.end);
  if (!fold) continue;
  const history = draws.slice(0, index);
  trainingRows.push({
    date: row.date,
    fold: fold.key,
    actual: row.digits,
    features: [0, 1, 2].map((position) => features(history, position)),
  });
}

const methods = candidates();
const foldIndexes = folds.map((fold) => trainingRows.map((row, index) => row.fold === fold.key ? index : -1).filter((index) => index >= 0));

function fixedMethods(method) {
  return Array.from({ length: 10 }, () => method);
}

function jointSummary(series, indexes) {
  const positionHits = [0, 0, 0];
  let all = 0;
  let exactlyTwo = 0;
  let exactlyOne = 0;
  let zero = 0;
  for (const index of indexes) {
    const hits = series.map((values) => Boolean(values[index]));
    const hitCount = hits.filter(Boolean).length;
    for (let position = 0; position < 3; position += 1) positionHits[position] += Number(hits[position]);
    if (hitCount === 3) all += 1;
    else if (hitCount === 2) exactlyTwo += 1;
    else if (hitCount === 1) exactlyOne += 1;
    else zero += 1;
  }
  const count = indexes.length;
  const positionRates = positionHits.map((value) => value / count);
  const allThreeRate = all / count;
  const exactlyTwoRate = exactlyTwo / count;
  const product = positionRates[0] * positionRates[1] * positionRates[2];
  return {
    count,
    allThreeRate,
    exactlyTwoRate,
    exactlyOneRate: exactlyOne / count,
    zeroHitRate: zero / count,
    positionRates,
    syncEfficiency: product ? allThreeRate / product : 0,
    score:
      0.55 * allThreeRate +
      0.15 * exactlyTwoRate +
      0.10 * positionRates[0] +
      0.10 * positionRates[1] +
      0.10 * positionRates[2] -
      0.20 * exactlyTwoRate,
  };
}

function rankPositionCandidates(hitMaps, position) {
  return methods.map((method) => {
    const values = hitMaps[position].get(method.id);
    const rates = foldIndexes.map((indexes) => indexes.reduce((sum, index) => sum + values[index], 0) / indexes.length);
    return { method, worst: Math.min(...rates), average: rates.reduce((sum, value) => sum + value, 0) / rates.length };
  }).sort((left, right) => right.worst - left.worst || right.average - left.average || left.method.id.localeCompare(right.method.id)).slice(0, TOP_PER_POSITION);
}

function evaluateTriple(hitMaps, chosen) {
  const series = chosen.map((item, position) => hitMaps[position].get(item.method.id));
  const foldMetrics = foldIndexes.map((indexes) => jointSummary(series, indexes));
  return {
    chosen: chosen.map((item) => item.method),
    folds: foldMetrics,
    worstAllThreeRate: Math.min(...foldMetrics.map((item) => item.allThreeRate)),
    averageAllThreeRate: foldMetrics.reduce((sum, item) => sum + item.allThreeRate, 0) / foldMetrics.length,
    worstScore: Math.min(...foldMetrics.map((item) => item.score)),
    averageScore: foldMetrics.reduce((sum, item) => sum + item.score, 0) / foldMetrics.length,
    averageSyncEfficiency: foldMetrics.reduce((sum, item) => sum + item.syncEfficiency, 0) / foldMetrics.length,
    averageMismatchRate: foldMetrics.reduce((sum, item) => sum + item.exactlyTwoRate, 0) / foldMetrics.length,
  };
}

function isBetter(left, right) {
  if (!right) return true;
  return left.worstAllThreeRate > right.worstAllThreeRate ||
    (left.worstAllThreeRate === right.worstAllThreeRate && left.averageAllThreeRate > right.averageAllThreeRate) ||
    (left.worstAllThreeRate === right.worstAllThreeRate && left.averageAllThreeRate === right.averageAllThreeRate && left.worstScore > right.worstScore) ||
    (left.worstAllThreeRate === right.worstAllThreeRate && left.averageAllThreeRate === right.averageAllThreeRate && left.worstScore === right.worstScore && left.averageScore > right.averageScore) ||
    (left.worstAllThreeRate === right.worstAllThreeRate && left.averageAllThreeRate === right.averageAllThreeRate && left.worstScore === right.worstScore && left.averageScore === right.averageScore && left.averageSyncEfficiency > right.averageSyncEfficiency);
}

function trainPool(size) {
  const hitMaps = Array.from({ length: 3 }, () => new Map());
  for (let position = 0; position < 3; position += 1) {
    for (const method of methods) {
      hitMaps[position].set(method.id, Uint8Array.from(trainingRows, (row) => poolHit(row.features[position], row.actual[position], method, size) ? 1 : 0));
    }
  }
  const top = [0, 1, 2].map((position) => rankPositionCandidates(hitMaps, position));
  let best = null;
  for (const hundreds of top[0]) {
    for (const tens of top[1]) {
      for (const units of top[2]) {
        const candidate = evaluateTriple(hitMaps, [hundreds, tens, units]);
        if (isBetter(candidate, best)) best = candidate;
      }
    }
  }
  const methodsByPosition = Object.fromEntries(positions.map((position, index) => [position, {
    normals: fixedMethods(best.chosen[index]),
    defenses: fixedMethods(best.chosen[index]),
  }]));
  console.log(`${game} 可信${size}码：最差年度全中${(best.worstAllThreeRate * 100).toFixed(2)}%，平均${(best.averageAllThreeRate * 100).toFixed(2)}%，公式 ${best.chosen.map((item) => item.id).join("/")}`);
  return { methods: methodsByPosition, trustworthySelection: best };
}

const pools = Object.fromEntries([5, 6, 7].map((size) => [size, trainPool(size)]));
const config = {
  formulaVersion: `${game.toUpperCase()}-POSITION-TRUSTWORTHY-FIXED-9-V1`,
  trainingMode: "strict-precutoff-fixed-formula-holdout",
  trainingStart: TRAINING_START,
  trainingEnd: TRAINING_END,
  forwardStart: FORWARD_START,
  candidateFormulaCount: methods.length,
  compressedFormulaCount: 9,
  optimizationObjective: {
    primary: "worst-year-same-draw-all-three-hit-rate",
    score: "0.55*allThree + 0.15*exactlyTwo + 0.10*hundreds + 0.10*tens + 0.10*units - 0.20*singlePositionDrag",
    folds,
    topCandidatesPerPosition: TOP_PER_POSITION,
    poolWeightsShared: false,
    leakageRule: `No draw dated ${FORWARD_START} or later was visible during formula selection.`,
  },
  pools,
};
const output = path.join(root, "scripts", "config", `${game}-position-pools-trustworthy.json`);
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`已写入 ${path.relative(root, output)}；独立盲测从 ${FORWARD_START} 开始。`);
