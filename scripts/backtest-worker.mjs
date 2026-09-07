import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import {
  compareLowHit,
  createEvaluator,
  formulaForSample,
  prepareRows,
} from "../lib/backtest-engine-core.mjs";

const snapshot = JSON.parse(await readFile(workerData.dataPath, "utf8"));
const rows = prepareRows(snapshot);
const evaluator = createEvaluator(rows);
const best = [];

for (let offset = 0; offset < workerData.count; offset += 1) {
  const sample = workerData.start + offset;
  const candidate = formulaForSample(sample, workerData.seed, workerData.mode);
  const metrics = evaluator.metrics(candidate, workerData.size, workerData.searchStart, workerData.searchEnd);
  best.push({ sample, candidate, metrics });
  if (best.length > workerData.keep * 2) {
    best.sort(compareLowHit);
    best.length = workerData.keep;
  }
}

best.sort(compareLowHit);
best.length = Math.min(best.length, workerData.keep);
parentPort.postMessage({ best, processed: workerData.count });
