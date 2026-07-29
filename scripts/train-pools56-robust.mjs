import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import v7 from "../lib/v7-robust-config.json" with { type: "json" };
import { featureColumns, rankDigits } from "../lib/v5-model.js";

const FETCH_START = "2009-01-01";
const FETCH_END = "2021-07-27";
const CANDIDATES = 40000;
const KEEP = 1200;
const POLICY_TRIALS = 220000;
const FOLDS = [
  { key: "foldA", start: "2016-01-01", end: "2017-12-31" },
  { key: "foldB", start: "2018-01-01", end: "2019-12-31" },
  { key: "foldC", start: "2020-01-01", end: "2021-07-27" },
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

function robustSummary(foldHits) {
  const folds = foldHits.map(metrics);
  return {
    folds,
    worstMaxMiss: Math.max(...folds.map((item) => item.maxMiss)),
    meanMaxMiss:
      folds.reduce((sum, item) => sum + item.maxMiss, 0) / folds.length,
    totalHits: folds.reduce((sum, item) => sum + item.hits, 0),
    totalCount: folds.reduce((sum, item) => sum + item.count, 0),
  };
}

function compare(left, right) {
  return (
    left.worstMaxMiss - right.worstMaxMiss ||
    left.meanMaxMiss - right.meanMaxMiss ||
    right.totalHits - left.totalHits
  );
}

function randomMethod(random, id) {
  const weights = {};
  const active = 2 + Math.floor(random() * 9);
  for (let index = 0; index < active; index += 1) {
    const feature = FEATURES[Math.floor(random() * FEATURES.length)];
    const weight = [-3, -2, -1, 1, 2, 3][Math.floor(random() * 6)];
    weights[feature] = (weights[feature] ?? 0) + weight;
    if (weights[feature] === 0) delete weights[feature];
  }
  return { id, rank: 1, weights };
}

function splitHits(rows, hits) {
  return FOLDS.map((fold) =>
    hits.filter((_, index) => rows[index].fold === fold.key),
  );
}

function hitSeries(rows, method, poolSize) {
  return rows.map((row) => {
    const pool = rankDigits(row.columns, method)
      .slice(0, poolSize)
      .map((item) => item.digit);
    const actual = new Set(row.digits);
    return actual.size === 3 && [...actual].every((digit) => pool.includes(digit));
  });
}

function searchLibrary(rows, poolSize, random) {
  const kept = [];
  const seeded = v7.pool7.methods.map((method, index) => ({
    ...method,
    id: `v7-${index}`,
  }));
  for (let id = 0; id < CANDIDATES + seeded.length; id += 1) {
    const method = id < seeded.length ? seeded[id] : randomMethod(random, id);
    if (!Object.keys(method.weights).length) continue;
    const hits = hitSeries(rows, method, poolSize);
    kept.push({
      method,
      hits,
      robust: robustSummary(splitHits(rows, hits)),
    });
    if (kept.length >= KEEP * 2) {
      kept.sort((left, right) => compare(left.robust, right.robust));
      kept.length = KEEP;
    }
    if (id > 0 && id % 10000 === 0) {
      console.log(`${poolSize}码候选：${id}/${CANDIDATES}`);
    }
  }
  kept.sort((left, right) => compare(left.robust, right.robust));
  return kept.slice(0, KEEP);
}

function evaluatePolicy(rows, library, choices) {
  const foldHits = FOLDS.map(() => []);
  for (let foldIndex = 0; foldIndex < FOLDS.length; foldIndex += 1) {
    let missStreak = 0;
    rows.forEach((row, rowIndex) => {
      if (row.fold !== FOLDS[foldIndex].key) return;
      const bucket =
        missStreak < 3 ? 0 : missStreak < 5 ? 1 : missStreak < 7 ? 2 : 3;
      const hit = library[choices[bucket]].hits[rowIndex];
      foldHits[foldIndex].push(hit);
      missStreak = hit ? 0 : missStreak + 1;
    });
  }
  return { foldHits, robust: robustSummary(foldHits) };
}

function searchPolicy(rows, library, random, poolSize) {
  let best = {
    choices: [0, 0, 0, 0],
    result: evaluatePolicy(rows, library, [0, 0, 0, 0]),
  };
  for (let trial = 0; trial < POLICY_TRIALS; trial += 1) {
    const choices = Array.from(
      { length: 4 },
      () => Math.floor(random() * library.length),
    );
    const result = evaluatePolicy(rows, library, choices);
    if (compare(result.robust, best.result.robust) < 0) {
      best = { choices, result };
    }
    if (trial > 0 && trial % 100000 === 0) {
      console.log(`${poolSize}码策略：${trial}/${POLICY_TRIALS}`);
    }
  }
  for (let round = 0; round < 3; round += 1) {
    let improved = false;
    for (let bucket = 0; bucket < 4; bucket += 1) {
      for (let choice = 0; choice < library.length; choice += 1) {
        const choices = [...best.choices];
        choices[bucket] = choice;
        const result = evaluatePolicy(rows, library, choices);
        if (compare(result.robust, best.result.robust) < 0) {
          best = { choices, result };
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

async function fetchDraws() {
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${FETCH_END}` +
    "&pageNo=1&pageSize=5000&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/pools56-search)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  return {
    requestUrl,
    draws: (payload.result ?? [])
      .map((item) => ({
        date: item.date.slice(0, 10),
        issue: String(item.code),
        digits: item.red.split(",").map(Number),
      }))
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

const { requestUrl, draws } = await fetchDraws();
if (draws.at(-1)?.date !== FETCH_END) {
  throw new Error(`training-boundary:${draws.at(-1)?.date}`);
}
const rows = [];
for (let index = 120; index < draws.length; index += 1) {
  const row = draws[index];
  const fold = FOLDS.find(
    (candidate) => row.date >= candidate.start && row.date <= candidate.end,
  );
  if (!fold) continue;
  rows.push({
    ...row,
    fold: fold.key,
    columns: featureColumns(draws.slice(0, index)),
  });
}

const results = {};
for (const poolSize of [5, 6]) {
  const random = randomGenerator(20260729 + poolSize);
  console.log(`开始${poolSize}码低断档搜索。`);
  const library = searchLibrary(rows, poolSize, random);
  const policy = searchPolicy(rows, library, random, poolSize);
  results[`pool${poolSize}`] = {
    methods: policy.choices.map((choice) => library[choice].method),
    robust: policy.result.robust,
  };
  console.log(`${poolSize}码结果：${JSON.stringify(policy.result.robust)}`);
}

const config = {
  version: "pools56-robust-1",
  trainedAt: new Date().toISOString(),
  trainingDataCutoff: FETCH_END,
  simulationStart: "2021-07-28",
  pool5: { methods: results.pool5.methods },
  pool6: { methods: results.pool6.methods },
};
const configText = `${JSON.stringify(config, null, 2)}\n`;
const report = {
  version: "pools56-robust-search-1",
  createdAt: new Date().toISOString(),
  isolation: {
    requestUrl,
    trainingDataCutoff: FETCH_END,
    rowsAfterCutoffVisibleToSearch: 0,
  },
  folds: FOLDS,
  search: {
    candidatesPerPlay: CANDIDATES,
    keptPerPlay: KEEP,
    policyTrialsPerPlay: POLICY_TRIALS,
    featureCount: FEATURES.length,
    objective:
      "先压低三个时间段中的最坏连续未中，再压低平均连续未中，最后提高命中次数。",
  },
  pool5: results.pool5.robust,
  pool6: results.pool6.robust,
  configSha256: createHash("sha256").update(configText, "utf8").digest("hex"),
};
await mkdir("scripts/results", { recursive: true });
await writeFile("lib/pool56-config.json", configText, "utf8");
await writeFile(
  "scripts/results/pool56-robust-search.json",
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
