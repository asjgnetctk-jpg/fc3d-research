import {
  buildGroup3Examples,
} from "../lib/group3-online.js";
import { writeFile } from "node:fs/promises";

const requestUrl =
  "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=3d&dayStart=2009-01-01&dayEnd=2026-07-28" +
  "&pageNo=1&pageSize=5000&systemType=PC";
const response = await fetch(requestUrl, {
  headers: {
    Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
    "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/group3-knn)",
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

function quantile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)] ?? 0.27;
}

function probability(pool, features, featureSet, neighbors, priorStrength) {
  const nearest = pool
    .map((row) => {
      const vector = row.featureSets[featureSet];
      let distance = 0;
      for (let index = 0; index < vector.length; index += 1) {
        distance += (vector[index] - features[index]) ** 2;
      }
      return { group3: row.group3, distance: Math.sqrt(distance) };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, neighbors);
  let hits = priorStrength * 0.27;
  let total = priorStrength;
  for (const row of nearest) {
    const weight = 1 / (0.05 + row.distance);
    hits += Number(row.group3) * weight;
    total += weight;
  }
  return hits / total;
}

function run(config, outputStart, outputEnd) {
  const pool = examples.filter((row) => row.date < "2019-01-01");
  const probabilities = [];
  const rows = [];
  for (const row of examples) {
    if (row.date < "2019-01-01") continue;
    const value = probability(
      pool,
      row.featureSets[config.featureSet],
      config.featureSet,
      config.neighbors,
      config.priorStrength,
    );
    const recent = probabilities.slice(-365);
    const level =
      value >= quantile(recent, 0.8)
        ? "high"
        : value <= quantile(recent, 0.2)
          ? "low"
          : "middle";
    if (row.date >= outputStart && row.date <= outputEnd) {
      rows.push({ probability: value, level, group3: row.group3 });
    }
    probabilities.push(value);
    pool.push(row);
  }
  return rows;
}

function metrics(rows) {
  const baseRate = rows.filter((row) => row.group3).length / rows.length;
  const high = rows.filter((row) => row.level === "high");
  const low = rows.filter((row) => row.level === "low");
  const highRate = high.filter((row) => row.group3).length / high.length;
  const lowRate = low.filter((row) => row.group3).length / low.length;
  const brier =
    rows.reduce(
      (sum, row) => sum + (row.probability - Number(row.group3)) ** 2,
      0,
    ) / rows.length;
  return {
    count: rows.length,
    baseRate,
    highCalls: high.length,
    highRate,
    lowCalls: low.length,
    lowRate,
    separation: highRate - lowRate,
    brier,
  };
}

const candidates = [];
for (const featureSet of ["compact", "rates", "full"]) {
  for (const neighbors of [50, 100, 200]) {
    for (const priorStrength of [20, 50]) {
      const config = { featureSet, neighbors, priorStrength };
      candidates.push({
        config,
        validation: metrics(run(config, "2019-01-01", "2021-07-27")),
      });
    }
  }
}
candidates.sort(
  (left, right) =>
    right.validation.separation - left.validation.separation ||
    left.validation.brier - right.validation.brier,
);
const best = candidates[0];
const result = {
  generatedAt: new Date().toISOString(),
  isolation: {
    trainingEnd: "2018-12-31",
    validation: ["2019-01-01", "2021-07-27"],
    untouchedTest: ["2021-07-28", "2026-07-28"],
  },
  best,
  test: metrics(run(best.config, "2021-07-28", "2026-07-28")),
  top: candidates.slice(0, 6),
};
await writeFile(
  "scripts/results/group3-knn-search.json",
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result, null, 2));
