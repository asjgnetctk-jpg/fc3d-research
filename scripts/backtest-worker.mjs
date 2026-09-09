import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import {
  compareHighHit,
  compareLowHit,
  createEvaluator,
  formulaForSample,
  prepareRows,
} from "../lib/backtest-engine-core.mjs";

const snapshot = JSON.parse(await readFile(workerData.dataPath, "utf8"));
const rows = prepareRows(snapshot);
const evaluator = createEvaluator(rows);
const best = [];
const compare = workerData.objective === "high" ? compareHighHit : compareLowHit;

for (let offset = 0; offset < workerData.count; offset += 1) {
  const sample = workerData.start + offset;
  const candidate = formulaForSample(sample, workerData.seed, workerData.mode);
  const metrics = workerData.play
    ? evaluator.metricsForPlay(candidate, workerData.play, workerData.searchStart, workerData.searchEnd)
    : evaluator.metrics(candidate, workerData.size, workerData.searchStart, workerData.searchEnd);
  best.push({ sample, candidate, metrics });
  if (best.length > workerData.keep * 2) {
    best.sort(compare);
    best.length = workerData.keep;
  }
  if (
    workerData.progressEvery &&
    ((offset + 1) % workerData.progressEvery === 0 || offset + 1 === workerData.count)
  ) {
    parentPort.postMessage({ type: "progress", processed: offset + 1 });
  }
}

best.sort(compare);
best.length = Math.min(best.length, workerData.keep);
parentPort.postMessage({ type: "done", best, processed: workerData.count });
