import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { featureColumns, rankDigits, shapeFeatures, actualShape } from "../lib/v5-model.js";

const FETCH_START = "2014-01-01";
const FETCH_END = "2021-07-27";
const DEVELOPMENT_START = "2015-01-01";
const DEVELOPMENT_END = "2020-07-27";
const VALIDATION_START = "2020-07-28";
const VALIDATION_END = "2021-07-27";
const TEST_START = "2021-07-28";
const TEST_END = "2026-07-27";
const SEED = 20260731;
const METHOD_CANDIDATES = 24000;
const KEEP = 500;
const POLICY_TRIALS = 140000;
const SHAPE_CANDIDATES = 24000;

const DIGIT_FEATURES = [
  ...[3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120].flatMap((window) => [
    `presence${window}`,
    `occurrence${window}`,
  ]),
  "gap",
  ...[10, 20, 30, 60].flatMap((window) =>
    [1, 2, 3].map((position) => `position${position}_${window}`),
  ),
  "last1",
  "last2",
  "last3",
  "transition30",
  "transition60",
  "transition120",
  "digitCenter",
  "digitParity",
];

const SHAPE_FEATURES = [
  "group3Rate3",
  "group3Rate14",
  "group3Rate60",
  "group3Rate120",
  "group6Rate90",
  "group6Rate120",
  "group6Gap",
  "lastGroup3",
  "last2Group6",
  "recentRepeatRate10",
];

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function metrics(hits) {
  let totalHits = 0;
  let currentMiss = 0;
  let maxMiss = 0;
  for (const hit of hits) {
    if (hit) {
      totalHits += 1;
      currentMiss = 0;
    } else {
      currentMiss += 1;
      maxMiss = Math.max(maxMiss, currentMiss);
    }
  }
  return {
    count: hits.length,
    hits: totalHits,
    rate: hits.length ? totalHits / hits.length : 0,
    maxMiss,
  };
}

function compareMetrics(left, right) {
  const leftTarget = left.maxMiss <= 7;
  const rightTarget = right.maxMiss <= 7;
  return (
    Number(rightTarget) - Number(leftTarget) ||
    left.maxMiss - right.maxMiss ||
    right.rate - left.rate ||
    right.hits - left.hits
  );
}

function randomMethod(random, id) {
  const weights = {};
  const active = 2 + Math.floor(random() * 8);
  for (let index = 0; index < active; index += 1) {
    const feature = DIGIT_FEATURES[Math.floor(random() * DIGIT_FEATURES.length)];
    const weight = [-3, -2, -1, 1, 2, 3][Math.floor(random() * 6)];
    weights[feature] = (weights[feature] ?? 0) + weight;
    if (weights[feature] === 0) delete weights[feature];
  }
  return { id, rank: 1 + Math.floor(random() * 10), weights };
}

function methodPredictions(rows, method, type) {
  return rows.map((row) => {
    const ranked = rankDigits(row.columns, method);
    return type === "dan"
      ? ranked[method.rank - 1].digit
      : ranked.slice(0, 7).map((item) => item.digit).sort((a, b) => a - b);
  });
}

function hitsFor(rows, predictions, type) {
  return rows.map((row, index) => {
    if (type === "dan") return row.digits.includes(predictions[index]);
    const actual = new Set(row.digits);
    return (
      actual.size === 3 &&
      [...actual].every((digit) => predictions[index].includes(digit))
    );
  });
}

function searchLibrary(rows, type, random) {
  const kept = [];
  for (let id = 0; id < METHOD_CANDIDATES; id += 1) {
    const method = randomMethod(random, id);
    const predictions = methodPredictions(rows, method, type);
    const entry = {
      method,
      metrics: metrics(hitsFor(rows, predictions, type)),
    };
    kept.push(entry);
    if (kept.length >= KEEP * 2) {
      kept.sort((left, right) => compareMetrics(left.metrics, right.metrics));
      kept.length = KEEP;
    }
  }
  kept.sort((left, right) => compareMetrics(left.metrics, right.metrics));
  kept.length = KEEP;
  return kept;
}

function policyEvaluation(rows, predictions, hitSeries, choices) {
  const selected = [];
  const hits = [];
  let missStreak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const bucket = missStreak < 3 ? 0 : missStreak < 5 ? 1 : missStreak < 7 ? 2 : 3;
    const method = choices[bucket];
    selected.push(predictions[method][index]);
    const hit = hitSeries[method][index];
    hits.push(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return { selected, hits, metrics: metrics(hits) };
}

function choosePolicy(rows, library, type, random) {
  const predictions = library.map((entry) =>
    methodPredictions(rows, entry.method, type),
  );
  const hitSeries = predictions.map((series) => hitsFor(rows, series, type));
  let best = {
    choices: [0, 0, 0, 0],
    result: policyEvaluation(rows, predictions, hitSeries, [0, 0, 0, 0]),
  };
  for (let trial = 0; trial < POLICY_TRIALS; trial += 1) {
    const choices = Array.from(
      { length: 4 },
      () => Math.floor(random() * library.length),
    );
    const result = policyEvaluation(rows, predictions, hitSeries, choices);
    if (compareMetrics(result.metrics, best.result.metrics) < 0) {
      best = { choices, result };
    }
  }
  return best;
}

function randomShapeCandidate(random, id) {
  const weights = {};
  const active = 2 + Math.floor(random() * 7);
  for (let index = 0; index < active; index += 1) {
    const feature = SHAPE_FEATURES[Math.floor(random() * SHAPE_FEATURES.length)];
    const weight = [-4, -3, -2, -1, 1, 2, 3, 4][Math.floor(random() * 8)];
    weights[feature] = (weights[feature] ?? 0) + weight;
    if (weights[feature] === 0) delete weights[feature];
  }
  return { id, weights };
}

function shapeScores(rows, candidate) {
  return rows.map((row) =>
    Object.entries(candidate.weights).reduce(
      (sum, [feature, weight]) => sum + row.shapeFeatures[feature] * weight,
      0,
    ),
  );
}

function shapeResult(rows, candidate) {
  const scores = shapeScores(rows, candidate);
  const predictions = scores.map((score) =>
    score >= candidate.threshold ? "组三" : "组六",
  );
  const hits = rows.map(
    (row, index) => actualShape(row.digits) === predictions[index],
  );
  return {
    predictions,
    hits,
    group3Share:
      predictions.filter((prediction) => prediction === "组三").length /
      predictions.length,
    metrics: metrics(hits),
  };
}

function chooseShape(development, validation, random) {
  const finalists = [];
  const shares = [0.12, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4];
  for (let id = 0; id < SHAPE_CANDIDATES; id += 1) {
    const base = randomShapeCandidate(random, id);
    const scores = shapeScores(development, base);
    const sorted = [...scores].sort((a, b) => a - b);
    for (const share of shares) {
      const threshold = sorted[Math.floor(sorted.length * (1 - share))];
      const candidate = { ...base, threshold };
      const result = shapeResult(development, candidate);
      if (result.group3Share < 0.1 || result.group3Share > 0.45) continue;
      finalists.push({ candidate, result });
      if (finalists.length >= 600) {
        finalists.sort((left, right) =>
          compareMetrics(left.result.metrics, right.result.metrics),
        );
        finalists.length = 300;
      }
    }
  }
  finalists.sort((left, right) =>
    compareMetrics(left.result.metrics, right.result.metrics),
  );
  finalists.length = Math.min(finalists.length, 300);

  return finalists
    .map((entry) => ({
      candidate: entry.candidate,
      development: entry.result.metrics,
      validationResult: shapeResult(validation, entry.candidate),
    }))
    .filter(
      (entry) =>
        entry.validationResult.group3Share >= 0.1 &&
        entry.validationResult.group3Share <= 0.45,
    )
    .sort((left, right) =>
      compareMetrics(left.validationResult.metrics, right.validationResult.metrics),
    )[0];
}

async function fetchPretestOnly() {
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${FETCH_END}` +
    "&pageNo=1&pageSize=3500&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/6.0-pretest)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  const draws = (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      draw: item.red.replaceAll(",", ""),
      digits: item.red.split(",").map(Number),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!draws.length || draws.at(-1).date > FETCH_END) {
    throw new Error(`pretest-isolation-failed:${draws.at(-1)?.date}`);
  }
  return { requestUrl, draws };
}

async function main() {
  const { requestUrl, draws } = await fetchPretestOnly();
  const rows = [];
  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    if (row.date < DEVELOPMENT_START || row.date > VALIDATION_END) continue;
    const history = draws.slice(0, index);
    rows.push({
      ...row,
      columns: featureColumns(history),
      shapeFeatures: shapeFeatures(history),
    });
  }
  const development = rows.filter(
    (row) => row.date >= DEVELOPMENT_START && row.date <= DEVELOPMENT_END,
  );
  const validation = rows.filter(
    (row) => row.date >= VALIDATION_START && row.date <= VALIDATION_END,
  );
  const random = mulberry32(SEED);

  console.log(`隔离数据：${draws[0].date}—${draws.at(-1).date}，开始选独胆。`);
  const danLibrary = searchLibrary(development, "dan", random);
  const danPolicy = choosePolicy(validation, danLibrary, "dan", random);
  console.log(`独胆前测验证：${JSON.stringify(danPolicy.result.metrics)}`);

  console.log("开始选7码。");
  const poolLibrary = searchLibrary(development, "pool7", random);
  const poolPolicy = choosePolicy(validation, poolLibrary, "pool7", random);
  console.log(`7码前测验证：${JSON.stringify(poolPolicy.result.metrics)}`);

  console.log("开始选形态二选一。");
  const shape = chooseShape(development, validation, random);
  console.log(`形态前测验证：${JSON.stringify(shape.validationResult.metrics)}`);

  const config = {
    version: "V6.0-blind",
    formulaLockedAt: new Date().toISOString(),
    trainingDataCutoff: FETCH_END,
    independentTestStart: TEST_START,
    independentTestEnd: TEST_END,
    lockDate: "2026-07-28",
    backfitStart: TEST_START,
    backfitEnd: TEST_END,
    dan: {
      methods: danPolicy.choices.map((choice) => danLibrary[choice].method),
    },
    pool7: {
      methods: poolPolicy.choices.map((choice) => poolLibrary[choice].method),
    },
    shapeChoice: {
      threshold: shape.candidate.threshold,
      weights: shape.candidate.weights,
    },
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configSha256 = createHash("sha256").update(configText, "utf8").digest("hex");
  const report = {
    version: "V6-five-year-pretest-training-1",
    createdAt: new Date().toISOString(),
    isolation: {
      requestUrl,
      requestedEnd: FETCH_END,
      actualLatestDate: draws.at(-1).date,
      testDataRowsAvailableToTrainer: 0,
      passed: draws.at(-1).date === FETCH_END,
    },
    ranges: {
      development: {
        start: DEVELOPMENT_START,
        end: DEVELOPMENT_END,
        count: development.length,
      },
      validation: {
        start: VALIDATION_START,
        end: VALIDATION_END,
        count: validation.length,
      },
      sealedTest: { start: TEST_START, end: TEST_END },
    },
    search: {
      seed: SEED,
      methodCandidates: METHOD_CANDIDATES,
      keptPerPlay: KEEP,
      policyTrials: POLICY_TRIALS,
      shapeCandidates: SHAPE_CANDIDATES,
      objective: "只根据三年前验证集：优先最长连续未中不超过7期，再压低最长未中，最后提高命中率。",
    },
    validationMetrics: {
      dan: danPolicy.result.metrics,
      pool7: poolPolicy.result.metrics,
      shape: shape.validationResult.metrics,
      shapeGroup3RecommendationShare: shape.validationResult.group3Share,
    },
    lockedConfigSha256: configSha256,
  };

  await mkdir("lib", { recursive: true });
  await mkdir("scripts/results", { recursive: true });
  await writeFile("lib/v6-blind-config.json", configText, "utf8");
  await writeFile(
    "scripts/results/v6-pretest-training.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(`V6公式已锁定，SHA256 ${configSha256}`);
}

await main();
