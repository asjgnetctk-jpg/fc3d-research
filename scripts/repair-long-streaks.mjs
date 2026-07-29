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
];
const RECENT_START = "2023-07-28";
const CANDIDATES_PER_BUCKET = 12000;
const KEEP = 80;
const REPAIR_BUCKETS = [9, 8, 7];
const PLAYS = ["dan", "pool5", "pool6", "pool7"];

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

function compare(left, right) {
  return (
    left.overall.maxMiss - right.overall.maxMiss ||
    left.recentThreeYears.maxMiss - right.recentThreeYears.maxMiss ||
    right.overall.rate - left.overall.rate
  );
}

function expandMethods(methods) {
  if (methods.length > 4) return [...methods];
  return Array.from({ length: 10 }, (_, streak) => {
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
    .filter((index) => Math.min(track.missBefore[index], 9) === bucket);
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
    if (compare(result.summary, best.result.summary) < 0) {
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
    await readFile("scripts/data/fc3d-full-history.json", "utf8"),
  ).rows;
  const v7 = JSON.parse(await readFile("lib/v7-robust-config.json", "utf8"));
  const pools = JSON.parse(await readFile("lib/pool56-config.json", "utf8"));
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
    const random = randomGenerator(2026073000 + playIndex);
    let methods = methodsByPlay[play];
    const before = replay(rows, vector, methods, play).summary;
    const steps = [];
    for (const bucket of REPAIR_BUCKETS) {
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
    methodsByPlay[play] = compare(after, before) < 0 ? methods : methodsByPlay[play];
    audit[play] = {
      before,
      after: compare(after, before) < 0 ? after : before,
      accepted: compare(after, before) < 0,
      steps,
    };
    console.log(`${play}: ${JSON.stringify(audit[play])}`);
  }
  v7.version = "V7.5-streak-repair";
  v7.dan.methods = methodsByPlay.dan;
  v7.pool7.methods = methodsByPlay.pool7;
  pools.version = "pools56-streak-repair-1";
  pools.pool5.methods = methodsByPlay.pool5;
  pools.pool6.methods = methodsByPlay.pool6;
  const report = JSON.parse(
    await readFile("scripts/results/full-history-training.json", "utf8"),
  );
  report.streakRepair = {
    candidatesPerBucket: CANDIDATES_PER_BUCKET,
    repairedBuckets: REPAIR_BUCKETS,
    audit,
  };
  await writeFile(
    "lib/v7-robust-config.json",
    `${JSON.stringify(v7, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "lib/pool56-config.json",
    `${JSON.stringify(pools, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "scripts/results/full-history-training.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

await main();
