import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  FORMULAS_PER_SIZE,
  compareLowHit,
  createEvaluator,
  prepareRows,
} from "../lib/backtest-engine-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const next = process.argv[index + 1];
  args.set(key.slice(2), next && !next.startsWith("--") ? process.argv[++index] : "true");
}
const numberArg = (name, fallback) => Number(args.get(name) ?? fallback);
const textArg = (name, fallback) => args.get(name) ?? fallback;
const mode = textArg("mode", "random");
if (!["random", "exhaustive"].includes(mode)) throw new Error("--mode must be random or exhaustive");
const size = numberArg("size", 7);
if (![5, 6, 7, 8].includes(size)) throw new Error("--size must be 5, 6, 7, or 8");
const samples = Math.min(numberArg("samples", 100000), FORMULAS_PER_SIZE);
const startSample = numberArg("start", 0);
const workers = Math.max(1, Math.min(numberArg("workers", Math.max(1, cpus().length - 1)), cpus().length));
const keep = Math.max(10, numberArg("keep", 100));
const seed = numberArg("seed", 20260906);
const dataPath = path.resolve(root, textArg("data", "scripts/data/fc3d-full-history.json"));
const outputPath = path.resolve(root, textArg("output", `work/backtest-${size}.json`));
const snapshotText = await readFile(dataPath, "utf8");
const snapshot = JSON.parse(snapshotText);
const rows = prepareRows(snapshot);
const indexOnOrAfter = (date) => {
  const index = rows.findIndex((row) => row.date >= date);
  if (index < 0) throw new Error(`Date outside data: ${date}`);
  return index;
};
const indexAfter = (date) => {
  const index = rows.findIndex((row) => row.date > date);
  return index < 0 ? rows.length : index;
};
const ranges = {
  searchStart: indexOnOrAfter(textArg("search-start", "2019-09-05")),
  searchEnd: indexAfter(textArg("search-end", "2024-09-04")),
  developmentStart: indexOnOrAfter(textArg("development-start", "2024-09-05")),
  developmentEnd: indexAfter(textArg("development-end", "2025-09-04")),
  testStart: indexOnOrAfter(textArg("test-start", "2025-09-05")),
  testEnd: indexAfter(textArg("test-end", rows.at(-1).date)),
};
if (!(ranges.searchStart < ranges.searchEnd && ranges.searchEnd <= ranges.developmentStart && ranges.developmentStart < ranges.developmentEnd && ranges.developmentEnd <= ranges.testStart && ranges.testStart < ranges.testEnd)) {
  throw new Error("Search, development, and test ranges must be ordered and non-overlapping");
}

function runWorker(start, count) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./backtest-worker.mjs", import.meta.url), {
      workerData: {
        dataPath, start, count, seed, mode, size, keep,
        searchStart: ranges.searchStart, searchEnd: ranges.searchEnd,
      },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => code && reject(new Error(`Worker exited ${code}`)));
  });
}

const tasks = [];
let remaining = samples;
let cursor = startSample;
for (let worker = 0; worker < workers && remaining > 0; worker += 1) {
  const count = Math.ceil(remaining / (workers - worker));
  tasks.push(runWorker(cursor, count));
  cursor += count;
  remaining -= count;
}
console.log(`Searching ${samples.toLocaleString()} formulas for ${size}码 with ${tasks.length} workers...`);
const startedAt = Date.now();
const workerResults = await Promise.all(tasks);
const shortlist = workerResults.flatMap((result) => result.best).sort(compareLowHit).slice(0, keep);

const evaluator = createEvaluator(rows);
for (const item of shortlist) {
  item.development = evaluator.metrics(item.candidate, size, ranges.developmentStart, ranges.developmentEnd);
}
shortlist.sort((left, right) =>
  left.development.rate - right.development.rate ||
  right.development.maxMiss - left.development.maxMiss ||
  compareLowHit(left, right),
);
const selected = shortlist[0];
selected.test = evaluator.metrics(selected.candidate, size, ranges.testStart, ranges.testEnd);
selected.allPreTest = evaluator.metrics(selected.candidate, size, ranges.searchStart, ranges.testStart);

const dateRange = (start, end) => ({
  start: rows[start].date,
  end: rows[end - 1].date,
  startIssue: rows[start].issue,
  endIssue: rows[end - 1].issue,
  count: end - start,
});
const report = {
  generatedAt: new Date().toISOString(),
  engine: "fc3d-local-backtest-1",
  objective: "minimize group-six full-coverage historical hit rate",
  warning: "Historical optimization cannot guarantee future performance.",
  noApiCalls: true,
  noTestAnswerSelection: true,
  data: {
    path: path.relative(root, dataPath).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(snapshotText).digest("hex"),
    latestIssue: rows.at(-1).issue,
    latestDate: rows.at(-1).date,
  },
  search: {
    mode, size, seed, startSample, samples,
    formulaSpacePerSize: FORMULAS_PER_SIZE,
    workers: tasks.length,
    keep,
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    range: dateRange(ranges.searchStart, ranges.searchEnd),
  },
  development: dateRange(ranges.developmentStart, ranges.developmentEnd),
  test: dateRange(ranges.testStart, ranges.testEnd),
  selected,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Selected test: ${selected.test.hits}/${selected.test.count} (${(selected.test.rate * 100).toFixed(2)}%), max miss ${selected.test.maxMiss}`);
console.log(`Saved: ${outputPath}`);
