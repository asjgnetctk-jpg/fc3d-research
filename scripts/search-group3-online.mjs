import { writeFile } from "node:fs/promises";
import {
  buildGroup3Examples,
  runGroup3Online,
} from "../lib/group3-online.js";

const requestUrl =
  "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=3d&dayStart=2009-01-01&dayEnd=2026-07-28" +
  "&pageNo=1&pageSize=5000&systemType=PC";

const response = await fetch(requestUrl, {
  headers: {
    Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
    "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/group3-online-search)",
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
const examples = buildGroup3Examples(draws);

function evaluate(rows) {
  const clamp = (value) => Math.max(1e-9, Math.min(1 - 1e-9, value));
  const count = rows.length;
  const baseRate = rows.filter((row) => row.group3).length / count;
  const brier =
    rows.reduce(
      (sum, row) => sum + (row.probability - Number(row.group3)) ** 2,
      0,
    ) / count;
  const logLoss =
    -rows.reduce(
      (sum, row) =>
        sum +
        (row.group3
          ? Math.log(clamp(row.probability))
          : Math.log(1 - clamp(row.probability))),
      0,
    ) / count;
  const high = rows.filter((row) => row.level === "high");
  const low = rows.filter((row) => row.level === "low");
  const highHits = high.filter((row) => row.group3).length;
  const lowHits = low.filter((row) => row.group3).length;
  let currentMiss = 0;
  let maxMiss = 0;
  for (const row of high) {
    if (row.group3) currentMiss = 0;
    else {
      currentMiss += 1;
      maxMiss = Math.max(maxMiss, currentMiss);
    }
  }
  return {
    count,
    baseRate,
    brier,
    logLoss,
    highCalls: high.length,
    highHits,
    highRate: high.length ? highHits / high.length : 0,
    highLift: high.length ? highHits / high.length - baseRate : 0,
    lowCalls: low.length,
    lowHits,
    lowRate: low.length ? lowHits / low.length : 0,
    separation:
      high.length && low.length
        ? highHits / high.length - lowHits / low.length
        : 0,
    maxRecommendedMiss: maxMiss,
  };
}

const candidates = [];
for (const featureSet of ["compact", "rates", "full"]) {
  for (const learningRate of [0.003, 0.01, 0.03, 0.06]) {
    for (const l2 of [0.0001, 0.001, 0.01, 0.05]) {
      for (const epochs of [3, 8, 16]) {
        const config = {
          version: "group3-online-1",
          featureSet,
          learningRate,
          l2,
          epochs,
          onlineStart: "2019-01-01",
        };
        const validation = runGroup3Online(
          examples,
          config,
          "2019-01-01",
          "2021-07-27",
        );
        candidates.push({
          config,
          validation: evaluate(validation.rows),
        });
      }
    }
  }
}

candidates.sort((left, right) => {
  const leftUseful =
    left.validation.separation - Math.max(0, left.validation.brier - 0.1971);
  const rightUseful =
    right.validation.separation - Math.max(0, right.validation.brier - 0.1971);
  return rightUseful - leftUseful || left.validation.brier - right.validation.brier;
});
const best = candidates[0];
const test = runGroup3Online(
  examples,
  best.config,
  "2021-07-28",
  "2026-07-28",
);
const result = {
  generatedAt: new Date().toISOString(),
  source: requestUrl,
  isolation: {
    initialTrainingEnd: "2018-12-31",
    validation: ["2019-01-01", "2021-07-27"],
    untouchedTest: ["2021-07-28", "2026-07-28"],
  },
  selected: best,
  test: evaluate(test.rows),
  topCandidates: candidates.slice(0, 12),
};
await writeFile(
  "scripts/results/group3-online-search.json",
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
await writeFile(
  "lib/group3-online-config.json",
  `${JSON.stringify(best.config, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result, null, 2));
