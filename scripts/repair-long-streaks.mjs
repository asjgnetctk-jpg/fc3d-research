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
const RECENT_START = process.env.REPAIR_RECENT_START ?? "2023-07-28";
const CANDIDATES_PER_BUCKET = Number(
  process.env.REPAIR_CANDIDATES_PER_BUCKET ?? 12000,
);
const KEEP = Number(process.env.REPAIR_KEEP ?? 80);
const REPAIR_BUCKETS = (process.env.REPAIR_BUCKETS ?? "9,8,7")
  .split(",")
  .map(Number)
  .filter(Number.isFinite);
const PLAYS = (process.env.REPAIR_PLAYS ?? "dan,pool5,pool6,pool7")
  .split(",")
  .filter(Boolean);
const DATA_PATH =
  process.env.REPAIR_DATA_PATH ?? "scripts/data/fc3d-full-history.json";
const V7_PATH = process.env.REPAIR_V7_PATH ?? "lib/v7-robust-config.json";
const POOLS_PATH =
  process.env.REPAIR_POOLS_PATH ?? "lib/pool56-config.json";
const REPORT_PATH =
  process.env.REPAIR_REPORT_PATH ??
  "scripts/results/full-history-training.json";
const SEED = Number(process.env.REPAIR_SEED ?? 2026073000);
const VERSION =
  process.env.REPAIR_VERSION ?? "V7.5-streak-repair";
const TARGET_MAX_MISS = Number(process.env.REPAIR_TARGET_MAX_MISS ?? 0);
const METHOD_STATES = Number(process.env.REPAIR_METHOD_STATES ?? 10);
const MAX_ACTIVE_FEATURES = Number(
  process.env.REPAIR_MAX_ACTIVE_FEATURES ?? 8,
);

function randomGenerator(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bucketsForPlay(play) {
  const value = process.env[`REPAIR_BUCKETS_${play.toUpperCase()}`];
  if (!value) return REPAIR_BUCKETS;
  return value.split(",").map(Number).filter(Number.isFinite);
}

function randomMethod(random, id) {
  const weights = {};
  const active =
    2 + Math.floor(random() * Math.max(1, MAX_ACTIVE_FEATURES - 1));
  for (let index = 0; index < active; index += 1) {
    const feature = FEATURES[Math.floor(random() * FEATURES.length)];
    const weight = [-4, -3, -2, -1, 1, 2, 3, 4][
      Math.floor(random() * 8)
    ];
    weights[feature] = (weights[feature] ?? 0) + weight;
    if (weights[feature] === 0) delete weights[feature];
  }
  return {
    id: `repair-${id}`,
    rank: 1 + Math.floor(random() * 10),
    weights,
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

function summary(rows, hits) {
  const recent = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].date >= RECENT_START) recent.push(hits[index]);
  }
  return {
    overall: metrics(hits),
    recentThreeYears: {
      start: RECENT_START,
      ...metrics(recent),
    },
  };
}

function streakProfile(hits) {
  let current = 0;
  let overTargetRuns = 0;
  let overTargetPenalty = 0;
  for (let index = 0; index <= hits.length; index += 1) {
    if (index < hits.length && !hits[index]) {
      current += 1;
      continue;
    }
    if (TARGET_MAX_MISS > 0 && current > TARGET_MAX_MISS) {
      overTargetRuns += 1;
      const excess = current - TARGET_MAX_MISS;
      overTargetPenalty += excess * excess;
    }
    current = 0;
  }
  return { overTargetRuns, overTargetPenalty };
}

function compareRepair(left, right) {
  const leftProfile = streakProfile(left.hits);
  const rightProfile = streakProfile(right.hits);
  return (
    left.summary.overall.maxMiss - right.summary.overall.maxMiss ||
    left.summary.recentThreeYears.maxMiss -
      right.summary.recentThreeYears.maxMiss ||
    leftProfile.overTargetPenalty - rightProfile.overTargetPenalty ||
    leftProfile.overTargetRuns - rightProfile.overTargetRuns ||
    right.summary.overall.rate - left.summary.overall.rate
  );
}

function expandMethods(methods) {
  if (methods.length > 4) {
    return Array.from(
      { length: Math.max(METHOD_STATES, methods.length) },
      (_, streak) => methods[Math.min(streak, methods.length - 1)],
    );
  }
  return Array.from({ length: METHOD_STATES }, (_, streak) => {
    const oldBucket = streak < 3 ? 0 : streak < 5 ? 1 : streak < 7 ? 2 : 3;
    return methods[oldBucket];
  });
}

function rankForRow(vector, rowIndex, method) {
  const active = Object.entries(method.weights)
    .map(([feature, weight]) => ({
      featureIndex: FEATURES.indexOf(feature),
      weight,
    }))
    .filter((item) => item.featureIndex >= 0);
  const scores = Array(10).fill(0);
  for (let digit = 0; digit < 10; digit += 1) {
    for (const item of active) {
      const offset =
        (rowIndex * FEATURES.length + item.featureIndex) * 10 + digit;
      scores[digit] += vector[offset] * item.weight;
    }
  }
  return Array.from({ length: 10 }, (_, digit) => digit).sort(
    (left, right) => scores[right] - scores[left] || left - right,
  );
}

function methodHit(rows, vector, rowIndex, method, play) {
  const ranked = rankForRow(vector, rowIndex, method);
  const digits = rows[rowIndex].digits;
  if (play === "dan") return digits.includes(ranked[method.rank - 1]);
  const size = Number(play.slice(-1));
  const pool = new Set(ranked.slice(0, size));
  const actual = [...new Set(digits)];
  return actual.length === 3 && actual.every((digit) => pool.has(digit));
}

function replay(rows, vector, methods, play) {
  const hits = new Uint8Array(rows.length);
  const missBefore = new Uint16Array(rows.length);
  let missStreak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    missBefore[index] = missStreak;
    const method = methods[Math.min(missStreak, methods.length - 1)];
    const hit = methodHit(rows, vector, index, method, play);
    hits[index] = Number(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return { hits, missBefore, summary: summary(rows, hits) };
}

function criticalIndices(track, bucket) {
  const runs = [];
  let current = [];
  for (let index = 0; index < track.hits.length; index += 1) {
    if (track.hits[index]) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push(index);
    }
  }
  if (current.length) runs.push(current);
  const threshold = Math.max(1, track.summary.overall.maxMiss - 4);
  return runs
    .filter((run) => run.length >= threshold)
    .flat()
    .filter(
      (index) =>
        Math.min(track.missBefore[index], METHOD_STATES - 1) === bucket,
    );
}

function buildVectors(draws) {
  const rows = [];
  const vector = new Float64Array((draws.length - 120) * FEATURES.length * 10);
  for (let index = 120; index < draws.length; index += 1) {
    const rowIndex = index - 120;
    const columns = featureColumns(draws.slice(0, index));
    rows.push(draws[index]);
    for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex += 1) {
      const values = columns[FEATURES[featureIndex]];
      const base = (rowIndex * FEATURES.length + featureIndex) * 10;
      for (let digit = 0; digit < 10; digit += 1) {
        vector[base + digit] = values[digit];
      }
    }
  }
  return { rows, vector };
}

function searchRepair(rows, vector, methods, play, bucket, random) {
  const baseline = replay(rows, vector, methods, play);
  const targets = criticalIndices(baseline, bucket);
  if (!targets.length) return { methods, baseline, result: baseline, targets: 0 };
  const kept = [];
  for (let id = 0; id < CANDIDATES_PER_BUCKET; id += 1) {
    const method = randomMethod(random, `${play}-${bucket}-${id}`);
    let score = 0;
    for (const index of targets) {
      if (methodHit(rows, vector, index, method, play)) {
        score += 1 + Math.max(0, baseline.missBefore[index] - bucket);
      }
    }
    kept.push({ method, score });
    if (kept.length > KEEP * 2) {
      kept.sort((left, right) => right.score - left.score);
      kept.length = KEEP;
    }
  }
  kept.sort((left, right) => right.score - left.score);
  kept.length = KEEP;
  let best = { methods, result: baseline };
  for (const candidate of kept) {
    const candidateMethods = [...methods];
    candidateMethods[bucket] = candidate.method;
    const result = replay(rows, vector, candidateMethods, play);
    if (compareRepair(result, best.result) < 0) {
      best = { methods: candidateMethods, result };
    }
  }
  return {
    ...best,
    baseline,
    targets: targets.length,
  };
}

async function main() {
  const draws = JSON.parse(
    await readFile(DATA_PATH, "utf8"),
  ).rows;
  const v7 = JSON.parse(await readFile(V7_PATH, "utf8"));
  const pools = JSON.parse(await readFile(POOLS_PATH, "utf8"));
  const { rows, vector } = buildVectors(draws);
  const methodsByPlay = {
    dan: expandMethods(v7.dan.methods),
    pool5: expandMethods(pools.pool5.methods),
    pool6: expandMethods(pools.pool6.methods),
    pool7: expandMethods(v7.pool7.methods),
  };
  const audit = {};
  for (let playIndex = 0; playIndex < PLAYS.length; playIndex += 1) {
    const play = PLAYS[playIndex];
    const random = randomGenerator(SEED + playIndex);
    let methods = methodsByPlay[play];
    const before = replay(rows, vector, methods, play).summary;
    const steps = [];
    const playBuckets = bucketsForPlay(play);
    for (const bucket of playBuckets) {
      const repaired = searchRepair(
        rows,
        vector,
        methods,
        play,
        bucket,
        random,
      );
      methods = repaired.methods;
      steps.push({
        bucket,
        criticalRows: repaired.targets,
        before: repaired.baseline.summary,
        after: repaired.result.summary,
      });
    }
    const after = replay(rows, vector, methods, play).summary;
    const originalResult = replay(
      rows,
      vector,
      methodsByPlay[play],
      play,
    );
    const repairedResult = replay(rows, vector, methods, play);
    const accepted = compareRepair(repairedResult, originalResult) < 0;
    methodsByPlay[play] = accepted ? methods : methodsByPlay[play];
    audit[play] = {
      before,
      after: accepted ? after : before,
      accepted,
      targetMaxMiss: TARGET_MAX_MISS || null,
      beforeProfile: streakProfile(originalResult.hits),
      afterProfile: streakProfile(
        accepted ? repairedResult.hits : originalResult.hits,
      ),
      steps,
    };
    console.log(`${play}: ${JSON.stringify(audit[play])}`);
  }
  v7.version = VERSION;
  v7.dan.methods = methodsByPlay.dan;
  v7.pool7.methods = methodsByPlay.pool7;
  pools.version = "pools56-streak-repair-1";
  pools.pool5.methods = methodsByPlay.pool5;
  pools.pool6.methods = methodsByPlay.pool6;
  const report = JSON.parse(
    await readFile(REPORT_PATH, "utf8"),
  );
  report.streakRepair = {
      candidatesPerBucket: CANDIDATES_PER_BUCKET,
    repairedBuckets: Object.fromEntries(
      PLAYS.map((play) => [play, bucketsForPlay(play)]),
    ),
    audit,
  };
  for (const play of PLAYS) {
    if (!report.results?.[play]) continue;
    report.results[play].metrics = audit[play].after;
    report.results[play].methods = methodsByPlay[play];
    report.results[play].repaired = true;
  }
  await writeFile(
    V7_PATH,
    `${JSON.stringify(v7, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    POOLS_PATH,
    `${JSON.stringify(pools, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

await main();
