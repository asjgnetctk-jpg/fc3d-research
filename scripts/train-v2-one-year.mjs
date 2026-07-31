import { readFile, writeFile } from "node:fs/promises";
import { featureColumns } from "../lib/v5-model.js";

const FEATURES = [
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
  ...Array.from({ length: 12 }, (_, channel) => `historyHash${channel}`),
];
const PLAYS = ["dan", "pool5", "pool6", "pool7"];
const METHOD_COUNT = 60;
const SEARCH_PER_BUCKET = Number(process.env.V2_SEARCH_PER_BUCKET ?? 3500);
const KEEP_PER_BUCKET = Number(process.env.V2_KEEP_PER_BUCKET ?? 48);
const PASSES = Number(process.env.V2_PASSES ?? 3);
const HARD_SEARCH_POOL = Number(process.env.V2_HARD_SEARCH_POOL ?? 40_000);
const HARD_SEARCH_DAN = Number(process.env.V2_HARD_SEARCH_DAN ?? 60_000);
const HARD_PASSES = Number(process.env.V2_HARD_PASSES ?? 5);
const SEED = Number(process.env.V2_SEED ?? 2026073002);
const CONFIG_OUTPUT =
  process.env.V2_CONFIG_OUTPUT ?? "lib/v2-one-year-config.json";
const REPORT_OUTPUT =
  process.env.V2_REPORT_OUTPUT ??
  "scripts/results/v2-one-year-training.json";
const DATA_PATH =
  process.env.V2_DATA_PATH ?? "scripts/data/fc3d-full-history.json";
const VERSION =
  process.env.V2_VERSION ?? "V2-one-year-streak-min";
const INITIAL_CONFIG_PATH = process.env.V2_INITIAL_CONFIG;
const HARD_TARGETS = {
  dan: Number(process.env.V2_TARGET_DAN ?? 5),
  pool5: Number(process.env.V2_TARGET_POOL5 ?? 10),
  pool6: Number(process.env.V2_TARGET_POOL6 ?? 7),
  pool7: Number(process.env.V2_TARGET_POOL7 ?? 5),
};

function dateYearsAgo(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function randomGenerator(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMethod(random, id) {
  const weights = {};
  const active = 2 + Math.floor(random() * 7);
  for (let index = 0; index < active; index += 1) {
    const feature = FEATURES[Math.floor(random() * FEATURES.length)];
    const weight = [-4, -3, -2, -1, 1, 2, 3, 4][
      Math.floor(random() * 8)
    ];
    weights[feature] = (weights[feature] ?? 0) + weight;
    if (weights[feature] === 0) delete weights[feature];
  }
  return {
    id: `v2-${id}`,
    rank: 1 + Math.floor(random() * 10),
    weights,
  };
}

function baselineMethod(play) {
  if (play === "dan") {
    return {
      id: "v2-baseline-dan",
      rank: 4,
      weights: {
        presence7: -2,
        occurrence10: 1,
        gap: -1,
      },
    };
  }
  return {
    id: `v2-baseline-${play}`,
    rank: 1,
    weights: {
      presence5: -1,
      presence7: 1,
      presence45: 1,
    },
  };
}

function metrics(hits) {
  let countHits = 0;
  let current = 0;
  let maxMiss = 0;
  for (const hit of hits) {
    if (hit) {
      countHits += 1;
      current = 0;
    } else {
      current += 1;
      maxMiss = Math.max(maxMiss, current);
    }
  }
  return {
    count: hits.length,
    hits: countHits,
    rate: hits.length ? countHits / hits.length : 0,
    maxMiss,
  };
}

function compare(left, right) {
  return (
    left.maxMiss - right.maxMiss ||
    right.hits - left.hits ||
    right.rate - left.rate
  );
}

function buildVectors(draws, startDate) {
  const rows = [];
  const vectors = [];
  for (let index = 120; index < draws.length; index += 1) {
    if (draws[index].date < startDate) continue;
    const history = draws.slice(Math.max(0, index - 365), index);
    const columns = featureColumns(history);
    rows.push(draws[index]);
    vectors.push(
      FEATURES.map((feature) => columns[feature]).flat(),
    );
  }
  return { rows, vectors };
}

function rankingForRow(vector, method) {
  const active = Object.entries(method.weights)
    .map(([feature, weight]) => ({
      featureIndex: FEATURES.indexOf(feature),
      weight,
    }))
    .filter((item) => item.featureIndex >= 0);
  const scores = Array(10).fill(0);
  for (let digit = 0; digit < 10; digit += 1) {
    for (const item of active) {
      scores[digit] +=
        vector[item.featureIndex * 10 + digit] * item.weight;
    }
  }
  return Array.from({ length: 10 }, (_, digit) => digit).sort(
    (left, right) => scores[right] - scores[left] || left - right,
  );
}

function methodHit(rows, vectors, rowIndex, method, play) {
  const ranking = rankingForRow(vectors[rowIndex], method);
  const actual = [...new Set(rows[rowIndex].digits)];
  if (play === "dan") {
    return actual.includes(ranking[method.rank - 1]);
  }
  const size = Number(play.slice(-1));
  const pool = new Set(ranking.slice(0, size));
  return actual.length === 3 && actual.every((digit) => pool.has(digit));
}

function replay(rows, vectors, methods, play) {
  const hits = new Uint8Array(rows.length);
  const missBefore = new Uint16Array(rows.length);
  let missStreak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    missBefore[index] = missStreak;
    const method = methods[Math.min(missStreak, methods.length - 1)];
    const hit = methodHit(rows, vectors, index, method, play);
    hits[index] = Number(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return {
    hits,
    missBefore,
    metrics: metrics(hits),
    currentMiss: missStreak,
  };
}

function targetRows(track, bucket) {
  const targets = [];
  for (let index = 0; index < track.hits.length; index += 1) {
    if (track.missBefore[index] === bucket) targets.push(index);
  }
  return targets;
}

function searchBucket(
  rows,
  vectors,
  methods,
  play,
  bucket,
  random,
  pass,
  searchCount = SEARCH_PER_BUCKET,
  keepCount = KEEP_PER_BUCKET,
) {
  const baseline = replay(rows, vectors, methods, play);
  const targets = targetRows(baseline, bucket);
  if (!targets.length) return { methods, result: baseline, targets: 0 };

  const kept = [];
  for (let id = 0; id < searchCount; id += 1) {
    const method = randomMethod(random, `${play}-${pass}-${bucket}-${id}`);
    let targetHits = 0;
    for (const index of targets) {
      if (methodHit(rows, vectors, index, method, play)) targetHits += 1;
    }
    kept.push({ method, targetHits });
    if (kept.length > keepCount * 2) {
      kept.sort((left, right) => right.targetHits - left.targetHits);
      kept.length = keepCount;
    }
  }
  kept.sort((left, right) => right.targetHits - left.targetHits);
  kept.length = keepCount;

  let best = { methods, result: baseline };
  for (const candidate of kept) {
    const candidateMethods = [...methods];
    candidateMethods[bucket] = candidate.method;
    const result = replay(rows, vectors, candidateMethods, play);
    if (compare(result.metrics, best.result.metrics) < 0) {
      best = { methods: candidateMethods, result };
    }
  }
  return { ...best, targets: targets.length };
}

async function main() {
  const snapshot = JSON.parse(
    await readFile(DATA_PATH, "utf8"),
  );
  const draws = snapshot.rows;
  const trainingEnd = draws.at(-1).date;
  const trainingStart = dateYearsAgo(trainingEnd, 1);
  const { rows, vectors } = buildVectors(draws, trainingStart);
  const initialConfig = INITIAL_CONFIG_PATH
    ? JSON.parse(await readFile(INITIAL_CONFIG_PATH, "utf8"))
    : null;
  const config = {
    version: VERSION,
    trainedAt: new Date().toISOString(),
    trainingMode: "one-year-in-sample-streak-minimization",
    trainingStart,
    trainingEnd,
    trainingStartIssue: rows[0].issue,
    trainingEndIssue: rows.at(-1).issue,
    trainingPeriods: rows.length,
    dataSha256: snapshot.canonicalSha256,
    futureGuarantee: false,
    danHardTrainingTarget: 5,
    search: {
      seed: SEED,
      methodsPerBucket: SEARCH_PER_BUCKET,
      methodBuckets: METHOD_COUNT,
      passes: PASSES,
    },
    plays: {},
  };
  const report = {
    generatedAt: config.trainedAt,
    methodology:
      "Only outcomes inside the stated one-year interval are used to select the formulas. Every row is calculated from data available before that row, but formula selection uses the same one-year outcomes, so these are in-sample training results rather than independent blind-test results.",
    rows: {},
    metrics: {},
  };

  for (let playIndex = 0; playIndex < PLAYS.length; playIndex += 1) {
    const play = PLAYS[playIndex];
    const random = randomGenerator(SEED + playIndex * 100_000);
    let methods = initialConfig?.plays?.[play]?.methods
      ? [...initialConfig.plays[play].methods]
      : Array.from({ length: METHOD_COUNT }, () => baselineMethod(play));
    const baseline = replay(rows, vectors, methods, play);
    const steps = [];

    for (let pass = 0; pass < PASSES; pass += 1) {
      const beforePass = replay(rows, vectors, methods, play);
      const highestBucket = Math.min(
        METHOD_COUNT - 1,
        Math.max(0, beforePass.metrics.maxMiss - 1),
      );
      for (let bucket = highestBucket; bucket >= 0; bucket -= 1) {
        const searched = searchBucket(
          rows,
          vectors,
          methods,
          play,
          bucket,
          random,
          pass,
        );
        methods = searched.methods;
        if (searched.targets) {
          steps.push({
            pass,
            bucket,
            targetRows: searched.targets,
            metrics: searched.result.metrics,
          });
        }
      }
      const afterPass = replay(rows, vectors, methods, play);
      if (
        compare(afterPass.metrics, beforePass.metrics) >= 0 ||
        (play === "dan" && afterPass.metrics.maxMiss <= 5)
      ) {
        break;
      }
    }

    const hardTarget = HARD_TARGETS[play];
    if (hardTarget !== undefined) {
      for (let hardPass = 0; hardPass < HARD_PASSES; hardPass += 1) {
        const beforeHardPass = replay(rows, vectors, methods, play);
        if (beforeHardPass.metrics.maxMiss <= hardTarget) break;
        for (const bucket of [
          Math.max(0, beforeHardPass.metrics.maxMiss - 1),
          Math.max(0, beforeHardPass.metrics.maxMiss - 2),
          Math.max(0, beforeHardPass.metrics.maxMiss - 3),
          hardTarget,
          Math.max(0, hardTarget - 1),
          Math.max(0, hardTarget - 2),
        ].filter((value, index, values) => values.indexOf(value) === index)) {
          const searched = searchBucket(
            rows,
            vectors,
            methods,
            play,
            bucket,
            random,
            `hard-${hardPass}`,
            play === "dan" ? HARD_SEARCH_DAN : HARD_SEARCH_POOL,
            160,
          );
          methods = searched.methods;
          if (searched.targets) {
            steps.push({
              pass: `hard-${hardPass}`,
              bucket,
              targetRows: searched.targets,
              metrics: searched.result.metrics,
            });
          }
        }
        const afterHardPass = replay(rows, vectors, methods, play);
        if (compare(afterHardPass.metrics, beforeHardPass.metrics) >= 0) break;
      }
    }

    const final = replay(rows, vectors, methods, play);
    config.plays[play] = { methods };
    report.metrics[play] = {
      baseline: baseline.metrics,
      final: final.metrics,
      currentMiss: final.currentMiss,
      hardTargetPassed:
        play === "dan" ? final.metrics.maxMiss <= 5 : true,
      steps,
    };
    report.rows[play] = rows.map((row, index) => ({
      issue: row.issue,
      date: row.date,
      draw: row.draw,
      hit: Boolean(final.hits[index]),
      missBefore: final.missBefore[index],
    }));
    console.log(
      `${play}: ${JSON.stringify({
        baseline: baseline.metrics,
        final: final.metrics,
      })}`,
    );
  }

  await writeFile(
    CONFIG_OUTPUT,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    REPORT_OUTPUT,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

await main();
