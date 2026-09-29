import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = [
  ["fc3d", 5, "grid-03", 1], ["fc3d", 6, "lag2-63", 1], ["fc3d", 7, "grid-09", 5],
  ["pl3", 5, "cross-41", 1], ["pl3", 6, "ml-b2", 0], ["pl3", 7, "ml-b1", 0],
];
const pairs = [[0, 1], [0, 2], [1, 2]];

function pairLifts(rows, end, window) {
  const start = Math.max(0, end - window);
  return pairs.map(([left, right]) => {
    const joint = Array.from({ length: 10 }, () => Array(10).fill(1));
    const leftCounts = Array(10).fill(10), rightCounts = Array(10).fill(10);
    let total = 100;
    for (let index = start; index < end; index += 1) {
      const a = rows[index].digits[left], b = rows[index].digits[right];
      joint[a][b] += 1; leftCounts[a] += 1; rightCounts[b] += 1; total += 1;
    }
    return joint.map((line, a) => line.map((count, b) => Math.max(0.5, Math.min(2, (count / total) / ((leftCounts[a] / total) * (rightCounts[b] / total))))));
  });
}

function oriented(probabilities, mask) {
  return probabilities.map((values, position) => {
    const ranked = values.map((probability, digit) => ({ probability, digit }))
      .sort((a, b) => ((mask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit);
    const scores = Array(10);
    ranked.forEach((item, rank) => { scores[item.digit] = 10 - rank; });
    return scores;
  });
}

function jointWeight(scores, lifts, lambda, a, b, c) {
  return scores[0][a] * scores[1][b] * scores[2][c]
    * lifts[0][a][b] ** lambda * lifts[1][a][c] ** lambda * lifts[2][b][c] ** lambda;
}

function coordinatedPools(probabilities, size, mask, lifts, lambda) {
  const scores = oriented(probabilities, mask);
  const pools = scores.map((values) => values.map((score, digit) => ({ score, digit })).sort((a, b) => b.score - a.score || a.digit - b.digit).slice(0, size).map((item) => item.digit));
  for (let pass = 0; pass < 4; pass += 1) for (let position = 0; position < 3; position += 1) {
    const digitScores = Array(10).fill(0);
    for (let candidate = 0; candidate < 10; candidate += 1) {
      const local = pools.map((pool, index) => index === position ? [candidate] : pool);
      for (const a of local[0]) for (const b of local[1]) for (const c of local[2]) digitScores[candidate] += jointWeight(scores, lifts, lambda, a, b, c);
    }
    pools[position] = digitScores.map((score, digit) => ({ score, digit })).sort((a, b) => b.score - a.score || a.digit - b.digit).slice(0, size).map((item) => item.digit);
  }
  return pools;
}

function summarize(records) {
  let hits = 0, miss = 0, maxMiss = 0;
  const positionHits = [0, 0, 0], drag = [0, 0, 0];
  let exactlyTwo = 0;
  for (const item of records) {
    const count = item.filter(Boolean).length;
    item.forEach((hit, position) => { if (hit) positionHits[position] += 1; });
    if (count === 2) { exactlyTwo += 1; drag[item.findIndex((hit) => !hit)] += 1; }
    if (count === 3) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  const n = records.length, rate = hits / n, positionRates = positionHits.map((value) => value / n), exactlyTwoRate = exactlyTwo / n, dragRates = drag.map((value) => value / n);
  const score = 0.55 * rate + 0.15 * exactlyTwoRate + 0.1 * positionRates.reduce((sum, value) => sum + value, 0) - 0.2 * Math.max(...dragRates);
  return { count: n, hits, rate, maxMiss, currentMiss: miss, positionRates, exactlyTwoRate, dragRates, score };
}

async function run(game, size, configId, mask) {
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows), indexData = buildIndex(rows), config = configs.find((item) => item.id === configId);
  const holdoutStart = rows.length - 365, validationStart = holdoutStart - 730;
  const developmentWeights = train(rows, indexData, config, 500, validationStart);
  const candidates = [];
  for (const window of [120, 250, 500, 1000, validationStart]) for (const lambda of [0, 0.1, 0.25, 0.5, 1]) {
    const lifts = pairLifts(rows, validationStart, window), records = [];
    for (let index = validationStart; index < holdoutStart; index += 1) {
      const probabilities = predictProbabilities(rows, indexData, config, developmentWeights, index);
      const pools = coordinatedPools(probabilities, size, mask, lifts, lambda);
      records.push(pools.map((pool, position) => pool.includes(rows[index].digits[position])));
    }
    candidates.push({ window, lambda, metrics: summarize(records) });
  }
  candidates.sort((a, b) => b.metrics.score - a.metrics.score || b.metrics.rate - a.metrics.rate || a.metrics.maxMiss - b.metrics.maxMiss);
  const winner = candidates[0], holdoutWeights = train(rows, indexData, config, 500, holdoutStart), holdoutLifts = pairLifts(rows, holdoutStart, winner.window), records = [];
  for (let index = holdoutStart; index < rows.length; index += 1) {
    const probabilities = predictProbabilities(rows, indexData, config, holdoutWeights, index);
    const pools = coordinatedPools(probabilities, size, mask, holdoutLifts, winner.lambda);
    records.push(pools.map((pool, position) => pool.includes(rows[index].digits[position])));
  }
  return { game, size, configId, mask, winner, holdout: summarize(records), top: candidates.slice(0, 5) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) for (const job of jobs) console.log(JSON.stringify(await run(...job)));

export { pairLifts, coordinatedPools };
