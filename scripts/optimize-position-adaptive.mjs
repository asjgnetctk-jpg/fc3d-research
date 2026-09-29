import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const grid = JSON.parse(await readFile(path.join(root, "work", "position-causal-grid-results.json"), "utf8"));
const WARMUP = 500;
const windows = [30, 60, 120, 250];
const shrinkages = [20, 50, 100];

function pools(probabilities, size, mask) {
  return probabilities.map((values, position) => values.map((probability, digit) => ({ probability, digit }))
    .sort((a, b) => ((mask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
    .slice(0, size).map((item) => item.digit));
}

function summarize(hits) {
  let total = 0, miss = 0, maxMiss = 0;
  for (const hit of hits) {
    if (hit) { total += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: hits.length, hits: total, rate: hits.length ? total / hits.length : 0, maxMiss, currentMiss: miss };
}

function adaptive(candidateHits, window, shrinkage, baseline, initialHistories = null) {
  const histories = candidateHits.map((_, index) => [...(initialHistories?.[index] ?? [])]);
  const selected = [];
  const output = [];
  for (let day = 0; day < candidateHits[0].length; day += 1) {
    const scores = histories.map((history, index) => {
      const recent = history.slice(-window);
      const hits = recent.filter(Boolean).length;
      const rate = (hits + shrinkage * baseline) / (recent.length + shrinkage);
      let miss = 0;
      for (let cursor = recent.length - 1; cursor >= 0 && !recent[cursor]; cursor -= 1) miss += 1;
      return { index, rate, miss };
    }).sort((a, b) => b.rate - a.rate || a.miss - b.miss || a.index - b.index);
    const winner = scores[0].index;
    selected.push(winner);
    output.push(candidateHits[winner][day]);
    histories.forEach((history, index) => history.push(candidateHits[index][day]));
  }
  return { hits: output, selected, histories };
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
    const candidateDefs = gameResult.results[size].topCandidates.slice(0, 20).map((item) => ({ config: item.config, mask: item.mask }));
    const uniqueConfigs = [...new Map(candidateDefs.map((item) => [item.config.id, item.config])).values()];
    const validationProbabilities = new Map();
    for (const config of uniqueConfigs) {
      const weights = train(rows, indexData, config, WARMUP, validationStart);
      validationProbabilities.set(config.id, validationIndexes.map((index) => predictProbabilities(rows, indexData, config, weights, index)));
    }
    const candidateValidationHits = candidateDefs.map((definition) => validationIndexes.map((index, offset) => {
      const selectedPools = pools(validationProbabilities.get(definition.config.id)[offset], size, definition.mask);
      return selectedPools.every((pool, position) => pool.includes(rows[index].digits[position]));
    }));
    const baseline = (size / 10) ** 3;
    const options = [];
    for (const window of windows) for (const shrinkage of shrinkages) {
      const outcome = adaptive(candidateValidationHits, window, shrinkage, baseline);
      const overall = summarize(outcome.hits);
      const foldLength = Math.floor(outcome.hits.length / 3);
      const folds = [0, 1, 2].map((fold) => summarize(outcome.hits.slice(fold * foldLength, fold === 2 ? outcome.hits.length : (fold + 1) * foldLength)));
      options.push({ window, shrinkage, overall, folds, worstFoldRate: Math.min(...folds.map((item) => item.rate)), validationHistories: outcome.histories });
    }
    options.sort((a, b) => b.worstFoldRate - a.worstFoldRate || b.overall.rate - a.overall.rate || a.overall.maxMiss - b.overall.maxMiss || a.window - b.window || a.shrinkage - b.shrinkage);
    const winner = options[0];
    const holdoutProbabilities = new Map();
    for (const config of uniqueConfigs) {
      const weights = train(rows, indexData, config, WARMUP, holdoutStart);
      holdoutProbabilities.set(config.id, holdoutIndexes.map((index) => predictProbabilities(rows, indexData, config, weights, index)));
    }
    const candidateHoldoutHits = candidateDefs.map((definition) => holdoutIndexes.map((index, offset) => {
      const selectedPools = pools(holdoutProbabilities.get(definition.config.id)[offset], size, definition.mask);
      return selectedPools.every((pool, position) => pool.includes(rows[index].digits[position]));
    }));
    const initialHistories = candidateValidationHits.map((hits) => hits.slice(-winner.window));
    const holdoutOutcome = adaptive(candidateHoldoutHits, winner.window, winner.shrinkage, baseline, initialHistories);
    const holdout = summarize(holdoutOutcome.hits);
    result.sizes[size] = { candidateDefs, winner: { window: winner.window, shrinkage: winner.shrinkage, overall: winner.overall, folds: winner.folds, worstFoldRate: winner.worstFoldRate }, holdout };
    console.log(`${game} ${size}码 adaptive W${winner.window}/S${winner.shrinkage}: validation ${(winner.overall.rate * 100).toFixed(2)}%, worst ${(winner.worstFoldRate * 100).toFixed(2)}%; holdout ${holdout.hits}/${holdout.count} ${(holdout.rate * 100).toFixed(2)}%, max ${holdout.maxMiss}`);
  }
  return result;
}

const output = { generatedAt: new Date().toISOString(), family: "causal-adaptive-expert-selection", games: [] };
for (const gameResult of grid.games) output.games.push(await run(gameResult));
await mkdir(path.join(root, "work"), { recursive: true });
await writeFile(path.join(root, "work", "position-adaptive-results.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
