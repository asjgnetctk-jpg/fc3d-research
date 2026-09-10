import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureColumns, rankDigits } from "../lib/v5-model.js";

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
const samples = Math.max(1, Math.floor(numberArg("samples", 5_000_000)));
const workers = Math.max(1, Math.min(Math.floor(numberArg("workers", 4)), 4, cpus().length));
const trainingStart = textArg("training-start", "2025-07-29");
const trainingEnd = textArg("training-end", "2026-07-29");
const dataPath = path.resolve(root, textArg("data", "scripts/data/fc3d-full-history.json"));
const initialConfigPath = path.resolve(root, textArg("initial", "lib/v2-one-year-config.json"));
const outputPath = path.resolve(
  root,
  textArg("output", `work/v2-adaptive5m-${play}-batch-${batch}.json`),
);
const tempDirectory = path.resolve(root, "work", `.v2-adaptive-${process.pid}-${Date.now()}`);
const benchmarks = {
  dan: {
    training: { hits: 141, count: 352, maxMiss: 5 },
    actual: { hits: 159, count: 394, maxMiss: 5 },
  },
  pool5: {
    training: { hits: 63, count: 352, maxMiss: 12 },
    actual: { hits: 64, count: 394, maxMiss: 33 },
  },
  pool6: {
    training: { hits: 79, count: 352, maxMiss: 9 },
    actual: { hits: 81, count: 394, maxMiss: 33 },
  },
  pool7: {
    training: { hits: 119, count: 352, maxMiss: 6 },
    actual: { hits: 130, count: 394, maxMiss: 8 },
  },
};
for (const metric of Object.values(benchmarks[play])) metric.rate = metric.hits / metric.count;
const benchmark = benchmarks[play];

function metricFromFlags(flags) {
  let hits = 0;
  let miss = 0;
  let maxMiss = 0;
  for (const hit of flags) {
    if (hit) {
      hits += 1;
      miss = 0;
    } else {
      miss += 1;
      maxMiss = Math.max(maxMiss, miss);
    }
  }
  return {
    count: flags.length,
    hits,
    misses: flags.length - hits,
    rate: hits / Math.max(1, flags.length),
    maxMiss,
  };
}

function runTrainer(env, workerNumber) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(root, "scripts/train-v2-one-year.mjs")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(`[线程${workerNumber}] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[线程${workerNumber}] ${chunk}`));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`训练线程${workerNumber}退出，代码${code}`)));
  });
}

function replay(snapshot, config, selectedPlay) {
  const flags = { training: [], forward: [], all: [] };
  let missStreak = 0;
  for (let index = 120; index < snapshot.rows.length; index += 1) {
    const row = snapshot.rows[index];
    if (row.date < config.trainingStart) continue;
    const history = snapshot.rows.slice(Math.max(0, index - 365), index);
    const methods = config.plays[selectedPlay].methods;
    const method = methods[Math.min(missStreak, methods.length - 1)];
    const ranking = rankDigits(featureColumns(history), method);
    const actual = [...new Set(row.digits.map(Number))];
    const hit = selectedPlay === "dan"
      ? actual.includes(ranking[method.rank - 1].digit)
      : actual.length === 3 && actual.every((digit) =>
          ranking.slice(0, Number(selectedPlay.slice(-1))).some((item) => item.digit === digit));
    flags.all.push(hit);
    flags[row.date <= config.trainingEnd ? "training" : "forward"].push(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, metricFromFlags(value)]));
}

await mkdir(tempDirectory, { recursive: true });
const baseBudget = Math.floor(samples / workers);
const remainder = samples % workers;
const startedAt = Date.now();
console.log(`V2自适应 ${play}：第${batch}批，评估${samples.toLocaleString()}个候选，${workers}线程。`);

try {
  const jobs = Array.from({ length: workers }, async (_, workerIndex) => {
    const budget = baseBudget + (workerIndex < remainder ? 1 : 0);
    const seed = 20260910 + batch * 100_003 + workerIndex * 10_007;
    const configPath = path.join(tempDirectory, `config-${workerIndex}.json`);
    const reportPath = path.join(tempDirectory, `report-${workerIndex}.json`);
    const env = {
      ...process.env,
      V2_PLAYS: play,
      V2_OBJECTIVE: "hit-rate-first",
      V2_MAX_MISS: String(benchmark.training.maxMiss),
      V2_EXHAUST_BUDGET: "true",
      V2_PROGRESS: "true",
      V2_SEARCH_BUDGET: String(budget),
      V2_SEARCH_PER_BUCKET: "5000",
      V2_KEEP_PER_BUCKET: "96",
      V2_PASSES: "1000",
      V2_HARD_PASSES: "0",
      V2_SEED: String(seed),
      V2_TRAINING_START: trainingStart,
      V2_TRAINING_END: trainingEnd,
      V2_INITIAL_CONFIG: initialConfigPath,
      V2_CONFIG_OUTPUT: configPath,
      V2_REPORT_OUTPUT: reportPath,
      V2_VERSION: "V2-adaptive-high-hit-5m",
    };
    await runTrainer(env, workerIndex + 1);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const metric = report.metrics[play].final;
    console.log(`线程${workerIndex + 1}完成：${metric.hits}/${metric.count}，${(metric.rate * 100).toFixed(2)}%，最长连断${metric.maxMiss}期。`);
    return { worker: workerIndex + 1, seed, budget, config, report, metric };
  });
  const candidates = await Promise.all(jobs);
  candidates.sort((left, right) =>
    right.metric.rate - left.metric.rate ||
    left.metric.maxMiss - right.metric.maxMiss ||
    right.metric.hits - left.metric.hits);
  const selected = candidates[0];
  const snapshotText = await readFile(dataPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  const replayMetrics = replay(snapshot, selected.config, play);
  const report = {
    generatedAt: new Date().toISOString(),
    engine: "v2-adaptive-high-hit-local-backtest-1",
    methodology: "Old-V2-style 60-state adaptive model. Candidate selection uses the stated one-year training outcomes; later rows are reported only after the model is selected.",
    warning: "Training rate is in-sample and cannot guarantee the same future rate.",
    play,
    batch,
    search: {
      requestedCandidateEvaluations: samples,
      completedCandidateEvaluations: candidates.reduce((sum, item) => sum + item.config.search.testedMethods, 0),
      workers,
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      objective: "highest training hit rate, then shortest training miss streak",
      trainingStart,
      trainingEnd,
      dataSha256: createHash("sha256").update(snapshotText).digest("hex"),
      latestIssue: snapshot.rows.at(-1).issue,
      latestDate: snapshot.rows.at(-1).date,
    },
    benchmark: {
      oldV2Training: benchmark.training,
      oldV2DisplayedActual: benchmark.actual,
    },
    selected: {
      worker: selected.worker,
      seed: selected.seed,
      training: replayMetrics.training,
      historicalForwardAfterLock: replayMetrics.forward,
      displayedRange: replayMetrics.all,
      exceedsOldV2TrainingRate: replayMetrics.training.rate > benchmark.training.rate,
      exceedsOldV2DisplayedActualRate: replayMetrics.all.rate > benchmark.actual.rate,
      promotionEligible:
        replayMetrics.training.rate > benchmark.training.rate &&
        replayMetrics.training.maxMiss <= benchmark.training.maxMiss,
      config: selected.config,
    },
    candidates: candidates.map((item) => ({
      worker: item.worker,
      seed: item.seed,
      testedMethods: item.config.search.testedMethods,
      training: item.metric,
    })),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`训练成绩：${replayMetrics.training.hits}/${replayMetrics.training.count}，${(replayMetrics.training.rate * 100).toFixed(2)}%，最长连断${replayMetrics.training.maxMiss}期。`);
  console.log(`旧V2训练基准：${benchmark.training.hits}/${benchmark.training.count}，${(benchmark.training.rate * 100).toFixed(2)}%，最长连断${benchmark.training.maxMiss}期。`);
  console.log(`晋级状态：${report.selected.promotionEligible ? "达到训练晋级线" : "未达到训练晋级线"}。`);
  console.log(`结果文件：${outputPath}`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
