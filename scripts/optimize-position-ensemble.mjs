import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const grid = JSON.parse(await readFile(path.join(root, "work", "position-causal-grid-results.json"), "utf8"));
const WARMUP = 500;

function rankScores(values, reverse) {
  const scores = Array(10).fill(0);
  values.map((probability, digit) => ({ probability, digit }))
    .sort((a, b) => (reverse ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
    .forEach((item, index) => { scores[item.digit] = (9 - index) / 9; });
  return scores;
}

function summarize(items) {
  let hits = 0, miss = 0, maxMiss = 0;
  const positionHits = [0, 0, 0];
  for (const item of items) {
    item.hits.forEach((hit, position) => { if (hit) positionHits[position] += 1; });
    if (item.hits.every(Boolean)) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  const rate = items.length ? hits / items.length : 0;
  const positionRates = positionHits.map((value) => items.length ? value / items.length : 0);
  const product = positionRates.reduce((value, item) => value * item, 1);
  return { count: items.length, hits, rate, maxMiss, currentMiss: miss, positionRates, syncEfficiency: product ? rate / product : 0 };
}

function evaluate(rows, indexes, probabilitySets, members, size) {
  return summarize(indexes.map((index, offset) => {
    const pools = [0, 1, 2].map((position) => {
      const totals = Array(10).fill(0);
      members.forEach((member) => {
        const scores = rankScores(probabilitySets.get(member.config.id)[offset][position], Boolean(member.mask & (1 << position)));
        scores.forEach((score, digit) => { totals[digit] += score; });
      });
      return totals.map((score, digit) => ({ score, digit })).sort((a, b) => b.score - a.score || a.digit - b.digit).slice(0, size).map((item) => item.digit);
    });
    return { hits: pools.map((pool, position) => pool.includes(rows[index].digits[position])) };
  }));
}

async function run(gameResult) {
  const game = gameResult.game;
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows);
  const indexData = buildIndex(rows);
  const validationStart = rows.findIndex((row) => row.date === gameResult.validation.start);
  const holdoutStart = rows.findIndex((row) => row.date === gameResult.holdout.start);
  const validationIndexes = Array.from({ length: holdoutStart - validationStart }, (_, offset) => validationStart + offset);
  const holdoutIndexes = Array.from({ length: rows.length - holdoutStart }, (_, offset) => holdoutStart + offset);
  const result = { game, sizes: {} };
  for (const size of [5, 6, 7]) {
    const candidates = gameResult.results[size].topCandidates;
    const unique = [];
    for (const candidate of candidates) {
      if (unique.some((item) => item.config.id === candidate.config.id)) continue;
      unique.push({ config: candidate.config, mask: candidate.mask });
    }
    const validationProbabilities = new Map();
    for (const member of unique) {
      const weights = train(rows, indexData, member.config, WARMUP, validationStart);
      validationProbabilities.set(member.config.id, validationIndexes.map((index) => predictProbabilities(rows, indexData, member.config, weights, index)));
    }
    const options = [2, 3, 5, 8, 10, 15].filter((count) => count <= unique.length).map((count) => {
      const members = unique.slice(0, count);
      const overall = evaluate(rows, validationIndexes, validationProbabilities, members, size);
      const foldLength = Math.floor(validationIndexes.length / 3);
      const folds = [0, 1, 2].map((fold) => {
        const start = fold * foldLength;
        const end = fold === 2 ? validationIndexes.length : start + foldLength;
        const indexes = validationIndexes.slice(start, end);
        const probabilities = new Map([...validationProbabilities].map(([key, value]) => [key, value.slice(start, end)]));
        return evaluate(rows, indexes, probabilities, members, size);
      });
      return { count, members, overall, folds, worstFoldRate: Math.min(...folds.map((item) => item.rate)) };
    }).sort((a, b) => b.worstFoldRate - a.worstFoldRate || b.overall.rate - a.overall.rate || a.overall.maxMiss - b.overall.maxMiss || a.count - b.count);
    const winner = options[0];
    const holdoutProbabilities = new Map();
    for (const member of winner.members) {
      const weights = train(rows, indexData, member.config, WARMUP, holdoutStart);
      holdoutProbabilities.set(member.config.id, holdoutIndexes.map((index) => predictProbabilities(rows, indexData, member.config, weights, index)));
    }
    const holdout = evaluate(rows, holdoutIndexes, holdoutProbabilities, winner.members, size);
    result.sizes[size] = { winner, holdout, options: options.map(({ members, ...item }) => ({ ...item, memberIds: members.map((member) => `${member.config.id}/m${member.mask}`) })) };
    console.log(`${game} ${size}码 ensemble-${winner.count}: validation ${(winner.overall.rate * 100).toFixed(2)}%, worst ${(winner.worstFoldRate * 100).toFixed(2)}%; holdout ${holdout.hits}/${holdout.count} ${(holdout.rate * 100).toFixed(2)}%, max ${holdout.maxMiss}`);
  }
  return result;
}

const output = { generatedAt: new Date().toISOString(), family: "rank-averaged-causal-ensemble", games: [] };
for (const gameResult of grid.games) output.games.push(await run(gameResult));
await mkdir(path.join(root, "work"), { recursive: true });
await writeFile(path.join(root, "work", "position-ensemble-results.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
