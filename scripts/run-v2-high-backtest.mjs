import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  FORMULAS_PER_SIZE,
  compareHighHit,
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
const play = textArg("play", "dan");
if (!new Set(["dan", "pool5", "pool6", "pool7"]).has(play)) {
  throw new Error("--play must be dan, pool5, pool6, or pool7");
}
const batch = Math.max(1, Math.floor(numberArg("batch", 1)));
const samples = Math.min(numberArg("samples", 500_000), FORMULAS_PER_SIZE);
const startSample = numberArg("start", (batch - 1) * samples);
if (startSample < 0 || startSample + samples > FORMULAS_PER_SIZE) {
  throw new Error(
    `This batch exceeds the ${FORMULAS_PER_SIZE.toLocaleString()} unique-formula space and would repeat formulas.`,
  );
}
const workers = Math.max(1, Math.min(numberArg("workers", 2), 2, cpus().length));
const keep = Math.max(50, numberArg("keep", 200));
const seed = numberArg("seed", 20260909);
const dataPath = path.resolve(root, textArg("data", "scripts/data/fc3d-full-history.json"));
const outputPath = path.resolve(
  root,
  textArg("output", `work/v2-high-${play}-batch-${batch}.json`),
);
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

const workerProgress = [];
let lastShownPercent = -1;
function showProgress(workerIndex, processed) {
  workerProgress[workerIndex] = processed;
  const totalProcessed = workerProgress.reduce((sum, value) => sum + (value ?? 0), 0);
  const percent = Math.min(100, Math.floor((totalProcessed / samples) * 100));
  if (percent !== lastShownPercent && (percent >= lastShownPercent + 5 || percent === 100)) {
    lastShownPercent = percent;
    console.log(`进度 ${percent}%（${totalProcessed.toLocaleString()}/${samples.toLocaleString()}）`);
  }
}

function runWorker(start, count, workerIndex) {
  return new Promise((resolve, reject) => {
    workerProgress[workerIndex] = 0;
    const worker = new Worker(new URL("./backtest-worker.mjs", import.meta.url), {
      workerData: {
        dataPath,
        start,
        count,
        seed,
        mode: "random",
        play,
        objective: "high",
        keep,
        progressEvery: Math.max(1, Math.floor(count / 20)),
        searchStart: ranges.searchStart,
        searchEnd: ranges.searchEnd,
      },
    });
    worker.on("message", (message) => {
      if (message.type === "progress") {
        showProgress(workerIndex, message.processed);
      } else {
        workerProgress[workerIndex] = message.processed;
        showProgress(workerIndex, message.processed);
        resolve(message);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => code && reject(new Error(`Worker exited ${code}`)));
  });
}

const tasks = [];
let remaining = samples;
let cursor = startSample;
for (let worker = 0; worker < workers && remaining > 0; worker += 1) {
  const count = Math.ceil(remaining / (workers - worker));
  tasks.push(runWorker(cursor, count, worker));
  cursor += count;
  remaining -= count;
}
console.log(`V2高命中 ${play}：第${batch}批，搜索${samples.toLocaleString()}套公式，${tasks.length}线程。`);
const startedAt = Date.now();
const workerResults = await Promise.all(tasks);
const shortlist = workerResults
  .flatMap((result) => result.best)
  .sort(compareHighHit)
  .slice(0, keep);
const evaluator = createEvaluator(rows);
for (const item of shortlist) {
  item.development = evaluator.metricsForPlay(
    item.candidate,
    play,
    ranges.developmentStart,
    ranges.developmentEnd,
  );
}
shortlist.sort(
  (left, right) =>
    right.development.rate - left.development.rate ||
    left.development.maxMiss - right.development.maxMiss ||
    compareHighHit(left, right),
);
const selected = shortlist[0];
selected.test = evaluator.metricsForPlay(
  selected.candidate,
  play,
  ranges.testStart,
  ranges.testEnd,
);
selected.preTest = evaluator.metricsForPlay(
  selected.candidate,
  play,
  ranges.searchStart,
  ranges.testStart,
);

const dateRange = (start, end) => ({
  start: rows[start].date,
  end: rows[end - 1].date,
  startIssue: rows[start].issue,
  endIssue: rows[end - 1].issue,
  count: end - start,
});
const report = {
  generatedAt: new Date().toISOString(),
  engine: "v2-high-hit-local-backtest-1",
  objective: "maximize hit rate, then minimize maximum miss streak",
  warning: "A higher historical rate does not guarantee a higher future rate.",
  noApiCalls: true,
  noCurrentAnswerLeakage: true,
  noTestAnswerSelection: true,
  promotionEligible: false,
  promotionRule: "Compare multiple batches only on search and development results. Lock one formula before opening the independent test result.",
  play,
  batch,
  data: {
    path: path.relative(root, dataPath).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(snapshotText).digest("hex"),
    latestIssue: rows.at(-1).issue,
    latestDate: rows.at(-1).date,
  },
  search: {
    seed,
    startSample,
    samples,
    formulaSpace: FORMULAS_PER_SIZE,
    workers: tasks.length,
    keep,
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    range: dateRange(ranges.searchStart, ranges.searchEnd),
  },
  development: dateRange(ranges.developmentStart, ranges.developmentEnd),
  test: dateRange(ranges.testStart, ranges.testEnd),
  selected,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  `独立测试：${selected.test.hits}/${selected.test.count}，命中率${(selected.test.rate * 100).toFixed(2)}%，最长连断${selected.test.maxMiss}期。`,
);
console.log(`结果文件：${outputPath}`);
