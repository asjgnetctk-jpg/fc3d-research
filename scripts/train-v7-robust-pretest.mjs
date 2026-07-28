import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import v6 from "../lib/v6-blind-config.json" with { type: "json" };
import { featureColumns, rankDigits } from "../lib/v5-model.js";

const FETCH_START = "2009-01-01";
const FETCH_END = "2021-07-27";
const SEED = 20260801;
const CANDIDATES = 32000;
const KEEP = 1200;
const POLICY_TRIALS = 240000;
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
  const folds = foldHits.map((hits) => metrics(hits));
  return {
    folds,
    worstMaxMiss: Math.max(...folds.map((item) => item.maxMiss)),
    meanMaxMiss:
      folds.reduce((sum, item) => sum + item.maxMiss, 0) / folds.length,
    meanRate: folds.reduce((sum, item) => sum + item.rate, 0) / folds.length,
    totalHits: folds.reduce((sum, item) => sum + item.hits, 0),
    totalCount: folds.reduce((sum, item) => sum + item.count, 0),
  };
}

function compareRobust(left, right) {
  const leftTarget = left.worstMaxMiss <= 10;
  const rightTarget = right.worstMaxMiss <= 10;
  return (
    Number(rightTarget) - Number(leftTarget) ||
    left.worstMaxMiss - right.worstMaxMiss ||
    left.meanMaxMiss - right.meanMaxMiss ||
    right.meanRate - left.meanRate ||
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
  return { id, rank: 1 + Math.floor(random() * 10), weights };
}

function predictions(rows, method, type) {
  return rows.map((row) => {
    const ranked = rankDigits(row.columns, method);
    return type === "dan"
      ? ranked[method.rank - 1].digit
      : ranked.slice(0, 7).map((item) => item.digit).sort((a, b) => a - b);
  });
}

function hitSeries(rows, series, type) {
  return rows.map((row, index) => {
    if (type === "dan") return row.digits.includes(series[index]);
    const actual = new Set(row.digits);
    return (
      actual.size === 3 &&
      [...actual].every((digit) => series[index].includes(digit))
    );
  });
}

function splitHits(rows, hits) {
  return FOLDS.map((fold) =>
    hits.filter((_, index) => rows[index].fold === fold.key),
  );
}

function searchLibrary(rows, type, random) {
  const kept = [];
  const seeded = [
    ...v6[type].methods.map((method, index) => ({
      ...method,
      id: `v6-${index}`,
    })),
  ];
  for (let id = 0; id < CANDIDATES + seeded.length; id += 1) {
    const method = id < seeded.length ? seeded[id] : randomMethod(random, id);
    if (!Object.keys(method.weights).length) continue;
    const series = predictions(rows, method, type);
    const hits = hitSeries(rows, series, type);
    kept.push({
      method,
      series,
      hits,
      robust: robustSummary(splitHits(rows, hits)),
    });
    if (kept.length >= KEEP * 2) {
      kept.sort((left, right) => compareRobust(left.robust, right.robust));
      kept.length = KEEP;
    }
  }
  kept.sort((left, right) => compareRobust(left.robust, right.robust));
  kept.length = KEEP;
  return kept;
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

function searchPolicy(rows, library, random) {
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
    if (compareRobust(result.robust, best.result.robust) < 0) {
      best = { choices, result };
    }
  }
  for (let round = 0; round < 3; round += 1) {
    let improved = false;
    for (let bucket = 0; bucket < 4; bucket += 1) {
      for (let choice = 0; choice < library.length; choice += 1) {
        const choices = [...best.choices];
        choices[bucket] = choice;
        const result = evaluatePolicy(rows, library, choices);
        if (compareRobust(result.robust, best.result.robust) < 0) {
          best = { choices, result };
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

async function fetchPretest() {
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${FETCH_END}` +
    "&pageNo=1&pageSize=5000&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/7.0-robust)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  const draws = (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      digits: item.red.split(",").map(Number),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (draws.at(-1)?.date !== FETCH_END) {
    throw new Error(`pretest-boundary:${draws.at(-1)?.date}`);
  }
  return { requestUrl, draws };
}

async function main() {
  const { requestUrl, draws } = await fetchPretest();
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
  const random = randomGenerator(SEED);
  console.log(`V7隔离数据截止${draws.at(-1).date}，开始独胆多折搜索。`);
  const danLibrary = searchLibrary(rows, "dan", random);
  const dan = searchPolicy(rows, danLibrary, random);
  console.log(`独胆稳健结果：${JSON.stringify(dan.result.robust)}`);

  console.log("开始7码多折搜索。");
  const poolLibrary = searchLibrary(rows, "pool7", random);
  const pool7 = searchPolicy(rows, poolLibrary, random);
  console.log(`7码稳健结果：${JSON.stringify(pool7.result.robust)}`);

  const config = {
    version: "V7.0-robust",
    formulaLockedAt: new Date().toISOString(),
    trainingDataCutoff: FETCH_END,
    forwardStart: "2026-07-28",
    simulationStart: "2021-07-28",
    simulationEnd: "2026-07-27",
    dan: {
      methods: dan.choices.map((choice) => danLibrary[choice].method),
    },
    pool7: {
      methods: pool7.choices.map((choice) => poolLibrary[choice].method),
    },
    shapeChoice: v6.shapeChoice,
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configSha256 = createHash("sha256").update(configText, "utf8").digest("hex");
  const report = {
    version: "V7-robust-pretest-training-1",
    createdAt: new Date().toISOString(),
    isolation: {
      requestUrl,
      actualLatestDate: draws.at(-1).date,
      rowsAfterCutoffVisibleToTrainer: 0,
      passed: true,
    },
    folds: FOLDS.map((fold, index) => ({
      ...fold,
      count: rows.filter((row) => row.fold === fold.key).length,
      dan: dan.result.robust.folds[index],
      pool7: pool7.result.robust.folds[index],
    })),
    robustSummary: {
      dan: dan.result.robust,
      pool7: pool7.result.robust,
      targetMaxMiss: 10,
    },
    search: {
      seed: SEED,
      candidatesPerPlay: CANDIDATES,
      keptPerPlay: KEEP,
      policyTrials: POLICY_TRIALS,
      objective:
        "先要求三个历史验证段的最差连续未中不超过10期，再压低最差断期和平均断期，最后提高平均命中率。",
    },
    lockedConfigSha256: configSha256,
  };

  await mkdir("lib", { recursive: true });
  await mkdir("scripts/results", { recursive: true });
  await writeFile("lib/v7-robust-config.json", configText, "utf8");
  await writeFile(
    "scripts/results/v7-robust-training.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(`V7已锁定：${configSha256}`);
}

await main();
