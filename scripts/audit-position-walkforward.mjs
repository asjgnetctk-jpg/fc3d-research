import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = [
  ["fc3d", 5, "grid-03", 1], ["fc3d", 6, "lag2-63", 1], ["fc3d", 7, "grid-09", 5],
  ["pl3", 5, "cross-41", 1], ["pl3", 6, "ml-b2", 0], ["pl3", 7, "ml-b1", 0],
];

function summarize(items) {
  let hits = 0, miss = 0, maxMiss = 0;
  for (const hit of items) {
    if (hit) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: items.length, hits, rate: hits / items.length, maxMiss, currentMiss: miss };
}

async function evaluate(game, size, configId, mask, cadence) {
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows);
  const indexData = buildIndex(rows);
  const config = configs.find((item) => item.id === configId);
  const start = rows.length - 365;
  const hits = [];
  for (let block = start; block < rows.length; block += cadence) {
    const end = Math.min(rows.length, block + cadence);
    const weights = train(rows, indexData, config, 500, block);
    for (let index = block; index < end; index += 1) {
      const probabilities = predictProbabilities(rows, indexData, config, weights, index);
      const pools = probabilities.map((values, position) => values
        .map((probability, digit) => ({ probability, digit }))
        .sort((a, b) => ((mask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
        .slice(0, size).map((item) => item.digit));
      hits.push(pools.every((pool, position) => pool.includes(rows[index].digits[position])));
    }
  }
  return summarize(hits);
}

for (const [game, size, configId, mask] of jobs) {
  const results = {};
  for (const cadence of [10, 30, 60, 120, 365]) results[cadence] = await evaluate(game, size, configId, mask, cadence);
  console.log(JSON.stringify({ game, size, configId, mask, results }));
}
