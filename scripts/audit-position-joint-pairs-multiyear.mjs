import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";
import { pairLifts, coordinatedPools } from "./optimize-position-joint-pairs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = [
  ["fc3d", 6, "lag2-63", 1, 120, 0.5],
  ["pl3", 5, "cross-41", 1, 500, 0.5],
  ["pl3", 6, "ml-b2", 0, 250, 1],
  ["pl3", 7, "ml-b1", 0, 250, 1],
];

function summarize(hits) {
  let count = 0, miss = 0, maxMiss = 0;
  for (const hit of hits) {
    if (hit) { count += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: hits.length, hits: count, rate: count / hits.length, maxMiss, currentMiss: miss };
}

async function run(game, size, configId, mask, pairWindow, lambda) {
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows), indexData = buildIndex(rows), config = configs.find((item) => item.id === configId);
  const aggregate = [], folds = [];
  for (let year = 5; year >= 1; year -= 1) {
    const start = rows.length - year * 365, end = Math.min(rows.length, start + 365);
    const weights = train(rows, indexData, config, 500, start), lifts = pairLifts(rows, start, pairWindow), hits = [];
    for (let index = start; index < end; index += 1) {
      const probabilities = predictProbabilities(rows, indexData, config, weights, index);
      const pools = coordinatedPools(probabilities, size, mask, lifts, lambda);
      hits.push(pools.every((pool, position) => pool.includes(rows[index].digits[position])));
    }
    aggregate.push(...hits);
    folds.push({ start: rows[start].date, end: rows[end - 1].date, ...summarize(hits) });
  }
  return { game, size, configId, mask, pairWindow, lambda, theoreticalRate: size ** 3 / 1000, aggregate: summarize(aggregate), folds };
}

for (const job of jobs) console.log(JSON.stringify(await run(...job)));
