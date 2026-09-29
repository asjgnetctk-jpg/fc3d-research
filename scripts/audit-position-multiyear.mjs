import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = [
  ["fc3d", 5, "grid-03", 1], ["fc3d", 6, "lag2-63", 1], ["fc3d", 6, "ml-b2", 0], ["fc3d", 7, "grid-09", 5],
  ["pl3", 5, "cross-41", 1], ["pl3", 6, "ml-b2", 0], ["pl3", 7, "ml-b1", 0],
];

function summarize(hits) {
  let count = 0, miss = 0, maxMiss = 0;
  for (const hit of hits) {
    if (hit) { count += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: hits.length, hits: count, rate: count / hits.length, maxMiss, currentMiss: miss };
}

async function run(game, size, configId, mask) {
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows);
  const indexData = buildIndex(rows);
  const config = configs.find((item) => item.id === configId);
  const folds = [];
  const aggregate = [];
  for (let year = 5; year >= 1; year -= 1) {
    const start = rows.length - year * 365;
    const end = Math.min(rows.length, start + 365);
    const weights = train(rows, indexData, config, 500, start);
    const hits = [];
    for (let index = start; index < end; index += 1) {
      const probabilities = predictProbabilities(rows, indexData, config, weights, index);
      const pools = probabilities.map((values, position) => values
        .map((probability, digit) => ({ probability, digit }))
        .sort((a, b) => ((mask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
        .slice(0, size).map((item) => item.digit));
      hits.push(pools.every((pool, position) => pool.includes(rows[index].digits[position])));
    }
    aggregate.push(...hits);
    folds.push({ start: rows[start].date, end: rows[end - 1].date, ...summarize(hits) });
  }
  return { game, size, configId, mask, theoreticalRate: size ** 3 / 1000, aggregate: summarize(aggregate), folds };
}

for (const job of jobs) console.log(JSON.stringify(await run(...job)));
