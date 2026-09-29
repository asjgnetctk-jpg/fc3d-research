import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOLDOUT = 365;
const VALIDATION = 730;
const WARMUP = 500;
const freqSets = [
  [5, 20, 60, 250],
  [10, 30, 120, 500],
  [20, 60, 120, 250, 500],
  [5, 10, 30, 60, 120, 500],
  [30, 90, 180, 360],
];
const transitionSets = [[60, 250], [120, 500], [30, 120, 500]];
const hyper = [
  { learningRate: 0.025, regularization: 0.03, epochs: 8 },
  { learningRate: 0.04, regularization: 0.01, epochs: 6 },
];
const configs = [];
for (const freqWindows of freqSets) for (const transitionWindows of transitionSets) for (const values of hyper) {
  configs.push({ id: `grid-${String(configs.length + 1).padStart(2, "0")}`, freqWindows, transitionWindows, ...values });
}
for (const freqWindows of [[10, 30, 120, 500], [5, 20, 60, 250], [30, 90, 180, 360]]) for (const crossTransitionWindows of [[60], [120, 500]]) for (const values of hyper) {
  configs.push({ id: `cross-${String(configs.length + 1).padStart(2, "0")}`, freqWindows, transitionWindows: [120, 500], crossTransitionWindows, ...values });
}
for (const freqWindows of [[10, 30, 120, 500], [5, 20, 60, 250], [30, 90, 180, 360]]) for (const contextTransitionWindows of [[120], [250, 500]]) for (const values of hyper) {
  configs.push({ id: `context-${String(configs.length + 1).padStart(2, "0")}`, freqWindows, transitionWindows: [120, 500], contextTransitionWindows, ...values });
}
for (const freqWindows of [[10, 30, 120, 500], [5, 20, 60, 250], [30, 90, 180, 360]]) for (const lagTwoTransitionWindows of [[120], [250, 500]]) for (const values of hyper) {
  configs.push({ id: `lag2-${String(configs.length + 1).padStart(2, "0")}`, freqWindows, transitionWindows: [120, 500], lagTwoTransitionWindows, ...values });
}
for (const freqWindows of [[10, 30, 120, 500], [5, 20, 60, 250], [30, 90, 180, 360]]) for (const deltaTransitionWindows of [[120], [250, 500]]) for (const values of hyper) {
  configs.push({ id: `delta-${String(configs.length + 1).padStart(2, "0")}`, freqWindows, transitionWindows: [120, 500], deltaTransitionWindows, ...values });
}
for (const freqWindows of freqSets) for (const values of hyper) {
  configs.push({ id: `arithmetic-${String(configs.length + 1).padStart(2, "0")}`, freqWindows, transitionWindows: [120, 500], arithmeticFeatures: true, ...values });
}

function poolFromProbabilities(probabilities, size, mask) {
  return probabilities.map((values, position) => values
    .map((probability, digit) => ({ probability, digit }))
    .sort((a, b) => ((mask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
    .slice(0, size)
    .map((item) => item.digit));
}

function summarize(items) {
  let hits = 0, miss = 0, maxMiss = 0, hitStreak = 0, maxHitStreak = 0;
  const positionHits = [0, 0, 0];
  const dragCounts = [0, 0, 0];
  let exactlyTwo = 0, exactlyOne = 0, allMiss = 0;
  for (const item of items) {
    item.hits.forEach((hit, position) => { if (hit) positionHits[position] += 1; });
    const hitCount = item.hits.filter(Boolean).length;
    if (hitCount === 2) {
      exactlyTwo += 1;
      dragCounts[item.hits.findIndex((hit) => !hit)] += 1;
    } else if (hitCount === 1) exactlyOne += 1;
    else if (hitCount === 0) allMiss += 1;
    if (item.hits.every(Boolean)) {
      hits += 1; miss = 0; hitStreak += 1; maxHitStreak = Math.max(maxHitStreak, hitStreak);
    } else {
      miss += 1; hitStreak = 0; maxMiss = Math.max(maxMiss, miss);
    }
  }
  const count = items.length;
  const rates = positionHits.map((value) => count ? value / count : 0);
  const rate = count ? hits / count : 0;
  const product = rates.reduce((value, item) => value * item, 1);
  const exactlyTwoRate = count ? exactlyTwo / count : 0;
  const dragRates = dragCounts.map((value) => count ? value / count : 0);
  const score = 0.55 * rate + 0.15 * exactlyTwoRate + 0.1 * rates[0] + 0.1 * rates[1] + 0.1 * rates[2] - 0.2 * Math.max(...dragRates);
  return { count, hits, rate, maxMiss, currentMiss: miss, maxHitStreak, positionRates: rates, exactlyTwoRate, exactlyOneRate: count ? exactlyOne / count : 0, allMissRate: count ? allMiss / count : 0, dragRates, score, syncEfficiency: product ? rate / product : 0 };
}

function evaluate(probabilityRows, rows, indexes, size, mask) {
  return summarize(indexes.map((index, offset) => {
    const pools = poolFromProbabilities(probabilityRows[offset], size, mask);
    return { hits: pools.map((pool, position) => pool.includes(rows[index].digits[position])) };
  }));
}

function foldIndexes(indexes) {
  return [0, 1, 2].map((fold) => indexes.filter((_, position) => Math.floor(position * 3 / indexes.length) === fold));
}

async function optimize(game) {
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows);
  const indexData = buildIndex(rows);
  const holdoutStart = rows.length - HOLDOUT;
  const validationStart = holdoutStart - VALIDATION;
  const validationIndexes = Array.from({ length: VALIDATION }, (_, offset) => validationStart + offset);
  const folds = foldIndexes(validationIndexes);
  const candidates = { 5: [], 6: [], 7: [] };
  for (const config of configs) {
    const weights = train(rows, indexData, config, WARMUP, validationStart);
    const probabilityRows = validationIndexes.map((index) => predictProbabilities(rows, indexData, config, weights, index));
    for (const size of [5, 6, 7]) for (let mask = 0; mask < 8; mask += 1) {
      const overall = evaluate(probabilityRows, rows, validationIndexes, size, mask);
      const foldMetrics = folds.map((indexes) => {
        const startOffset = indexes[0] - validationStart;
        return evaluate(probabilityRows.slice(startOffset, startOffset + indexes.length), rows, indexes, size, mask);
      });
      candidates[size].push({ config, mask, overall, foldMetrics, worstFoldRate: Math.min(...foldMetrics.map((item) => item.rate)) });
    }
  }
  const results = {};
  for (const size of [5, 6, 7]) {
    for (const candidate of candidates[size]) candidate.worstFoldScore = Math.min(...candidate.foldMetrics.map((item) => item.score));
    candidates[size].sort((a, b) => b.worstFoldScore - a.worstFoldScore
      || b.overall.score - a.overall.score
      || b.worstFoldRate - a.worstFoldRate
      || b.overall.rate - a.overall.rate
      || b.overall.syncEfficiency - a.overall.syncEfficiency
      || a.overall.maxMiss - b.overall.maxMiss
      || a.config.id.localeCompare(b.config.id)
      || a.mask - b.mask);
    const winner = candidates[size][0];
    const weights = train(rows, indexData, winner.config, WARMUP, holdoutStart);
    const holdoutIndexes = Array.from({ length: HOLDOUT }, (_, offset) => holdoutStart + offset);
    const holdoutProbabilities = holdoutIndexes.map((index) => predictProbabilities(rows, indexData, winner.config, weights, index));
    const holdout = evaluate(holdoutProbabilities, rows, holdoutIndexes, size, winner.mask);
    results[size] = { winner, holdout, topCandidates: candidates[size].slice(0, 20) };
    console.log(`${game} ${size}码 ${winner.config.id}/mask${winner.mask}: validation ${(winner.overall.rate * 100).toFixed(2)}%, worst ${(winner.worstFoldRate * 100).toFixed(2)}%; holdout ${holdout.hits}/${holdout.count} ${(holdout.rate * 100).toFixed(2)}%, max ${holdout.maxMiss}`);
  }
  return { game, sourceHash: payload.canonicalSha256, development: { start: rows[WARMUP].date, end: rows[validationStart - 1].date }, validation: { start: rows[validationStart].date, end: rows[holdoutStart - 1].date }, holdout: { start: rows[holdoutStart].date, end: rows.at(-1).date }, results };
}

const output = { generatedAt: new Date().toISOString(), family: "causal-grid-30x8", candidateConfigCount: configs.length, orientationCount: 8, games: [] };
for (const game of ["fc3d", "pl3"]) output.games.push(await optimize(game));
await mkdir(path.join(root, "work"), { recursive: true });
await writeFile(path.join(root, "work", "position-causal-grid-results.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
