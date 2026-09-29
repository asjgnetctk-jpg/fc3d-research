import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.argv[2] === "pl3" ? "pl3" : "fc3d";
const size = Number(process.argv[3] ?? 6);
const configId = process.argv[4] ?? "lag2-63";
const mask = Number(process.argv[5] ?? 1);
const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
const rows = digitRows(payload.rows);
const indexData = buildIndex(rows);
const holdoutStart = rows.length - 365;
const config = configs.find((item) => item.id === configId);
if (!config) throw new Error(`Unknown config ${configId}`);
const weights = train(rows, indexData, config, 500, holdoutStart);
const records = [];
for (let index = holdoutStart; index < rows.length; index += 1) {
  const probabilities = predictProbabilities(rows, indexData, config, weights, index);
  const pools = probabilities.map((values, position) => values
    .map((probability, digit) => ({ probability, digit }))
    .sort((a, b) => ((mask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
    .slice(0, size).map((item) => item.digit));
  records.push({ date: rows[index].date, issue: rows[index].issue, hit: pools.every((pool, position) => pool.includes(rows[index].digits[position])) });
}

function summarize(items) {
  let hits = 0, miss = 0, maxMiss = 0;
  for (const item of items) {
    if (item.hit) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: items.length, hits, rate: hits / items.length, maxMiss, currentMiss: miss };
}

console.log(JSON.stringify({ game, size, configId, mask, trainingEnd: rows[holdoutStart - 1].date, windows: Object.fromEntries([30, 100, 300, 365].map((window) => [window, summarize(records.slice(-window))])) }, null, 2));
