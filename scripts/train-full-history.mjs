import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { featureColumns } from "../lib/v5-model.js";
import { buildGroup3Examples, runGroup3Online } from "../lib/group3-online.js";

const GAME = process.env.TRAIN_GAME ?? "fc3d";
const DATA_PATH =
  process.env.TRAIN_DATA_PATH ?? "scripts/data/fc3d-full-history.json";
const INTEGRITY_PATH =
  process.env.TRAIN_INTEGRITY_PATH ??
  "scripts/results/full-history-integrity.json";
const V7_OUTPUT =
  process.env.TRAIN_V7_OUTPUT ?? "lib/v7-robust-config.json";
const POOLS_OUTPUT =
  process.env.TRAIN_POOLS_OUTPUT ?? "lib/pool56-config.json";
const GROUP3_OUTPUT =
  process.env.TRAIN_GROUP3_OUTPUT ?? "lib/group3-online-config.json";
const REPORT_OUTPUT =
  process.env.TRAIN_REPORT_OUTPUT ??
  "scripts/results/full-history-training.json";
const SEED = Number(process.env.TRAIN_SEED ?? 2026072901);
const RANDOM_METHODS = Number(process.env.TRAIN_RANDOM_METHODS ?? 24000);
const KEEP_PER_PLAY = Number(process.env.TRAIN_KEEP_PER_PLAY ?? 300);
const POLICY_TRIALS = Number(process.env.TRAIN_POLICY_TRIALS ?? 8000);
const STREAK_STATES = Number(process.env.TRAIN_STREAK_STATES ?? 10);
const RECENT_THREE_YEAR_START =
  process.env.TRAIN_RECENT_THREE_YEAR_START ?? "2023-07-28";
const MIN_HISTORY = 120;
const PLAYS = ["dan", "pool5", "pool6", "pool7"];
const FOLDS = [
  { key: "2004-2008", start: "2004-01-01", end: "2008-12-31" },
  { key: "2009-2012", start: "2009-01-01", end: "2012-12-31" },
  { key: "2013-2016", start: "2013-01-01", end: "2016-12-31" },
  { key: "2017-2020", start: "2017-01-01", end: "2020-12-31" },
  { key: "2021-2026", start: "2021-01-01", end: "2099-12-31" },
];
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

function randomGenerator(seed) {
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
  let current = 0;
  let maxMiss = 0;
  for (const hit of hits) {
    if (hit) {
      totalHits += 1;
      current = 0;
    } else {
      current += 1;
      maxMiss = Math.max(maxMiss, current);
    }
  }
  return {
    count: hits.length,
    hits: totalHits,
    rate: hits.length ? totalHits / hits.length : 0,
    maxMiss,
  };
}

function summarize(rows, hits) {
  const overall = metrics(hits);
  const recentThreeYearHits = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].date >= RECENT_THREE_YEAR_START) {
      recentThreeYearHits.push(hits[index]);
    }
  }
  const recentThreeYears = metrics(recentThreeYearHits);
  const folds = FOLDS.map((fold) => {
    const scoped = [];
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].fold === fold.key) scoped.push(hits[index]);
    }
    return { ...fold, ...metrics(scoped) };
  });
  return {
    overall,
    recentThreeYears: {
      start: RECENT_THREE_YEAR_START,
      ...recentThreeYears,
    },
    folds,
    worstFoldMaxMiss: Math.max(...folds.map((fold) => fold.maxMiss)),
    meanFoldMaxMiss:
      folds.reduce((sum, fold) => sum + fold.maxMiss, 0) / folds.length,
  };
}

function compareSummary(left, right) {
  return (
    left.overall.maxMiss - right.overall.maxMiss ||
    left.recentThreeYears.maxMiss - right.recentThreeYears.maxMiss ||
    left.worstFoldMaxMiss - right.worstFoldMaxMiss ||
    left.meanFoldMaxMiss - right.meanFoldMaxMiss ||
    right.overall.rate - left.overall.rate
  );
}

function streakBucket(missStreak) {
  return Math.min(missStreak, STREAK_STATES - 1);
}

function randomMethod(random, id) {
  const weights = {};
  const active = 2 + Math.floor(random() * 6);
  for (let index = 0; index < active; index += 1) {
    const feature = FEATURES[Math.floor(random() * FEATURES.length)];
    const weight = [-3, -2, -1, 1, 2, 3][Math.floor(random() * 6)];
    weights[feature] = (weights[feature] ?? 0) + weight;
    if (weights[feature] === 0) delete weights[feature];
  }
  return {
    id: `full-${id}`,
    rank: 1 + Math.floor(random() * 10),
    weights,
  };
}

function seedMethods(oldV7, oldPools) {
  const seeded = [];
  for (const method of oldV7.dan.methods) seeded.push(method);
  for (const method of oldV7.pool7.methods) seeded.push(method);
  for (const method of oldPools.pool5.methods) seeded.push(method);
  for (const method of oldPools.pool6.methods) seeded.push(method);
  return seeded.map((method, index) => ({
    ...method,
    id: `seed-${index}`,
  }));
}

function insertLibrary(library, entry) {
  library.push(entry);
  library.sort((left, right) => compareSummary(left.summary, right.summary));
  if (library.length > KEEP_PER_PLAY) library.length = KEEP_PER_PLAY;
}

function buildVectors(draws) {
  const rows = [];
  const vector = new Float64Array(
    (draws.length - MIN_HISTORY) * FEATURES.length * 10,
  );
  for (let index = MIN_HISTORY; index < draws.length; index += 1) {
    const rowIndex = index - MIN_HISTORY;
    const row = draws[index];
    const columns = featureColumns(draws.slice(0, index));
    const fold = FOLDS.find(
      (candidate) => row.date >= candidate.start && row.date <= candidate.end,
    );
    rows.push({ ...row, fold: fold.key });
    for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex += 1) {
      const values = columns[FEATURES[featureIndex]];
      const base = (rowIndex * FEATURES.length + featureIndex) * 10;
      for (let digit = 0; digit < 10; digit += 1) {
        vector[base + digit] = values[digit];
      }
    }
    if ((rowIndex + 1) % 1000 === 0) {
      console.log(`Feature rows: ${rowIndex + 1}/${draws.length - MIN_HISTORY}`);
    }
  }
  return { rows, vector };
}

function evaluateMethod(rows, vector, method) {
  const active = Object.entries(method.weights)
    .map(([feature, weight]) => ({
      featureIndex: FEATURES.indexOf(feature),
      weight,
    }))
    .filter((item) => item.featureIndex >= 0);
  const hits = Object.fromEntries(
    PLAYS.map((play) => [play, new Uint8Array(rows.length)]),
  );
  const scores = new Float64Array(10);
  const order = new Int8Array(10);
  const rankPosition = new Int8Array(10);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let digit = 0; digit < 10; digit += 1) {
      let score = 0;
      for (const item of active) {
        const offset =
          (rowIndex * FEATURES.length + item.featureIndex) * 10 + digit;
        score += vector[offset] * item.weight;
      }
      scores[digit] = score;
      order[digit] = digit;
    }
    for (let cursor = 1; cursor < 10; cursor += 1) {
      const digit = order[cursor];
      let previous = cursor - 1;
      while (
        previous >= 0 &&
        (scores[order[previous]] < scores[digit] ||
          (scores[order[previous]] === scores[digit] && order[previous] > digit))
      ) {
        order[previous + 1] = order[previous];
        previous -= 1;
      }
      order[previous + 1] = digit;
    }
    for (let rank = 0; rank < 10; rank += 1) {
      rankPosition[order[rank]] = rank;
    }

    const digits = rows[rowIndex].digits;
    hits.dan[rowIndex] = Number(digits.includes(order[method.rank - 1]));
    const unique = [...new Set(digits)];
    if (unique.length === 3) {
      for (const size of [5, 6, 7]) {
        hits[`pool${size}`][rowIndex] = Number(
          unique.every((digit) => rankPosition[digit] < size),
        );
      }
    }
  }
  return hits;
}

function searchLibraries(rows, vector, oldV7, oldPools) {
  const random = randomGenerator(SEED);
  const libraries = Object.fromEntries(PLAYS.map((play) => [play, []]));
  const methods = [
    ...seedMethods(oldV7, oldPools),
    ...Array.from({ length: RANDOM_METHODS }, (_, index) =>
      randomMethod(random, index),
    ),
  ];
  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index];
    if (!Object.keys(method.weights).length) continue;
    const candidateHits = evaluateMethod(rows, vector, method);
    for (const play of PLAYS) {
      insertLibrary(libraries[play], {
        method,
        hits: candidateHits[play],
        summary: summarize(rows, candidateHits[play]),
      });
    }
    if ((index + 1) % 500 === 0) {
      const leaders = PLAYS.map(
        (play) =>
          `${play}:${libraries[play][0].summary.overall.maxMiss}`,
      ).join(" ");
      console.log(`Methods: ${index + 1}/${methods.length} ${leaders}`);
    }
  }
  return { libraries, searched: methods.length };
}

function evaluatePolicy(rows, library, choices) {
  const hits = new Uint8Array(rows.length);
  let missStreak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const choice = choices[streakBucket(missStreak)];
    const hit = library[choice].hits[index];
    hits[index] = hit;
    missStreak = hit ? 0 : missStreak + 1;
  }
  return { hits, summary: summarize(rows, hits) };
}

function searchPolicy(rows, library, random) {
  const initialChoices = Array(STREAK_STATES).fill(0);
  let best = {
    choices: initialChoices,
    result: evaluatePolicy(rows, library, initialChoices),
  };
  for (let trial = 0; trial < POLICY_TRIALS; trial += 1) {
    const choices = Array.from(
      { length: STREAK_STATES },
      () => Math.floor(random() * library.length),
    );
    const result = evaluatePolicy(rows, library, choices);
    if (compareSummary(result.summary, best.result.summary) < 0) {
      best = { choices, result };
    }
  }
  for (let round = 0; round < 3; round += 1) {
    let improved = false;
    for (let bucket = 0; bucket < STREAK_STATES; bucket += 1) {
      for (let choice = 0; choice < library.length; choice += 1) {
        const choices = [...best.choices];
        choices[bucket] = choice;
        const result = evaluatePolicy(rows, library, choices);
        if (compareSummary(result.summary, best.result.summary) < 0) {
          best = { choices, result };
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function compareGroup3(left, right) {
  return (
    left.highMetrics.maxMiss - right.highMetrics.maxMiss ||
    left.brier - right.brier ||
    right.highMetrics.rate - left.highMetrics.rate
  );
}

function searchGroup3(draws) {
  const examples = buildGroup3Examples(draws);
  const candidates = [];
  const configs = [];
  for (const featureSet of ["rates", "compact", "full"]) {
    for (const learningRate of [0.001, 0.003, 0.01, 0.03]) {
      for (const l2 of [0, 0.0001, 0.001]) {
        for (const epochs of [1, 3]) {
          configs.push({
            method: "online-logistic",
            featureSet,
            learningRate,
            l2,
            epochs,
            onlineStart: "2008-01-01",
            highQuantile: 0.8,
          });
        }
      }
    }
  }
  for (const config of configs) {
    const track = runGroup3Online(
      examples,
      config,
      config.onlineStart,
    );
    const evaluated = track.rows.filter((row) => row.level === "high");
    const highMetrics = metrics(evaluated.map((row) => row.group3));
    const brier =
      track.rows.reduce(
        (sum, row) => sum + (row.probability - Number(row.group3)) ** 2,
        0,
      ) / track.rows.length;
    candidates.push({ config, track, highMetrics, brier });
  }
  candidates.sort(compareGroup3);
  return {
    searched: configs.length,
    best: candidates[0],
    leaders: candidates.slice(0, 10).map((candidate) => ({
      config: candidate.config,
      highMetrics: candidate.highMetrics,
      brier: candidate.brier,
    })),
  };
}

function configHash(config) {
  return createHash("sha256")
    .update(`${JSON.stringify(config, null, 2)}\n`, "utf8")
    .digest("hex");
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const oldV7 = JSON.parse(
    await readFile(
      process.env.TRAIN_SEED_V7 ??
        (GAME === "pl3" ? "lib/pl3-v7-config.json" : "lib/v7-robust-config.json"),
      "utf8",
    ),
  );
  const oldPools = JSON.parse(
    await readFile(
      process.env.TRAIN_SEED_POOLS ??
        (GAME === "pl3"
          ? "lib/pl3-pool56-config.json"
          : "lib/pool56-config.json"),
      "utf8",
    ),
  );
  if (GAME === "fc3d") {
    const integrityReport = JSON.parse(await readFile(INTEGRITY_PATH, "utf8"));
    if (!integrityReport.passed) throw new Error("integrity-gate-not-passed");
    if (data.canonicalSha256 !== integrityReport.canonicalSha256) {
      throw new Error("canonical-data-hash-mismatch");
    }
  }
  const draws = data.rows;
  console.log(
    `Training rows: ${draws.length}, ${draws[0].issue}-${draws.at(-1).issue}`,
  );
  const { rows, vector } = buildVectors(draws);
  const { libraries, searched } = searchLibraries(
    rows,
    vector,
    oldV7,
    oldPools,
  );
  const random = randomGenerator(SEED + 99);
  const policies = {};
  for (const play of PLAYS) {
    policies[play] = searchPolicy(rows, libraries[play], random);
    console.log(
      `${play} final: ${JSON.stringify(policies[play].result.summary.overall)}`,
    );
  }

  console.log("Searching expanding-window group-3 model");
  const group3Search = searchGroup3(draws);
  const trainedAt = new Date().toISOString();
  const common = {
    trainedAt,
    trainingMode: "full-history-expanding-replay",
    trainingDataStart: draws[0].date,
    trainingDataCutoff: draws.at(-1).date,
    trainingIssueCutoff: draws.at(-1).issue,
    forwardStartIssue: String(Number(draws.at(-1).issue) + 1),
    simulationStart: rows[0].date,
    simulationEnd: draws.at(-1).date,
    canonicalDataSha256: data.canonicalSha256,
  };
  const v7Config = {
    version: GAME === "pl3" ? "PL3-V7-adaptive10" : "V7.4-adaptive10",
    ...common,
    dan: {
      methods: policies.dan.choices.map(
        (choice) => libraries.dan[choice].method,
      ),
    },
    pool7: {
      methods: policies.pool7.choices.map(
        (choice) => libraries.pool7[choice].method,
      ),
    },
    shapeChoice: oldV7.shapeChoice,
  };
  const poolConfig = {
    version:
      GAME === "pl3" ? "PL3-pools56-adaptive10" : "pools56-adaptive10-1",
    ...common,
    pool5: {
      methods: policies.pool5.choices.map(
        (choice) => libraries.pool5[choice].method,
      ),
    },
    pool6: {
      methods: policies.pool6.choices.map(
        (choice) => libraries.pool6[choice].method,
      ),
    },
  };
  const group3Config = {
    version:
      GAME === "pl3"
        ? "PL3-group3-full-history-online"
        : "group3-full-history-online-1",
    ...common,
    ...group3Search.best.config,
  };
  const report = {
    version:
      GAME === "pl3"
        ? "pl3-full-history-training-1"
        : "full-history-training-2",
    createdAt: trainedAt,
    warning:
      "All available outcomes were used for model selection. Results are in-sample expanding replay, not an independent blind test.",
    data: {
      count: draws.length,
      first: draws[0],
      last: draws.at(-1),
      canonicalSha256: data.canonicalSha256,
      integrityReport: INTEGRITY_PATH,
    },
    search: {
      seed: SEED,
      randomRankingMethods: RANDOM_METHODS,
      seededRankingMethods: seedMethods(oldV7, oldPools).length,
      totalRankingMethods: searched,
      keptPerPlay: KEEP_PER_PLAY,
      policyTrialsPerPlay: POLICY_TRIALS,
      streakStates: STREAK_STATES,
      recentThreeYearStart: RECENT_THREE_YEAR_START,
      features: FEATURES.length,
      group3Hyperparameters: group3Search.searched,
      objective:
        "Minimize full-history maximum miss first, then recent-three-year maximum miss, then worst fold maximum miss, mean fold maximum miss, and finally maximize hit rate.",
    },
    folds: FOLDS,
    results: Object.fromEntries(
      PLAYS.map((play) => [
        play,
        {
          metrics: policies[play].result.summary,
          choices: policies[play].choices,
          methods: policies[play].choices.map(
            (choice) => libraries[play][choice].method,
          ),
        },
      ]),
    ),
    group3: {
      highRecommendationMetrics: group3Search.best.highMetrics,
      brier: group3Search.best.brier,
      config: group3Config,
      leaders: group3Search.leaders,
    },
    configHashes: {
      v7: configHash(v7Config),
      pools56: configHash(poolConfig),
      group3: configHash(group3Config),
    },
  };

  await mkdir("scripts/results", { recursive: true });
  await writeFile(
    V7_OUTPUT,
    `${JSON.stringify(v7Config, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    POOLS_OUTPUT,
    `${JSON.stringify(poolConfig, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    GROUP3_OUTPUT,
    `${JSON.stringify(group3Config, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    REPORT_OUTPUT,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report.results, null, 2));
  console.log(JSON.stringify(report.group3, null, 2));
}

await main();
