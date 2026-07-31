import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildGroup3Examples } from "../lib/group3-online.js";

const GAME = process.env.GROUP3_GAME === "pl3" ? "pl3" : "fc3d";
const DATA_PATH =
  process.env.GROUP3_DATA_PATH ??
  (GAME === "pl3"
    ? "scripts/data/pl3-full-history.json"
    : "scripts/data/fc3d-full-history.json");
const CONFIG_OUTPUT =
  process.env.GROUP3_CONFIG_OUTPUT ??
  (GAME === "pl3"
    ? "lib/pl3-group3-config.json"
    : "lib/group3-online-config.json");
const REPORT_OUTPUT =
  process.env.GROUP3_REPORT_OUTPUT ??
  (GAME === "pl3"
    ? "scripts/results/pl3-group3-knn-optimization.json"
    : "scripts/results/group3-knn-optimization.json");
const ONLINE_START = process.env.GROUP3_ONLINE_START ?? "2019-01-01";
const VALIDATION_END =
  process.env.GROUP3_VALIDATION_END ?? "2021-07-27";
const DEVELOPMENT_TWO_START =
  process.env.GROUP3_DEVELOPMENT_TWO_START ?? "2021-07-28";
const DEVELOPMENT_TWO_END =
  process.env.GROUP3_DEVELOPMENT_TWO_END ?? "2023-12-31";
const TEST_START = process.env.GROUP3_TEST_START ?? "2024-01-01";
const FEATURE_SETS = ["compact", "rates", "full"];
const NEIGHBORS = [30, 50, 100, 200];
const PRIORS = [10, 30, 50];
const QUANTILES = [0.75, 0.8, 0.85, 0.9];
const BASE_RATE = 0.27;

function quantile(values, ratio) {
  if (!values.length) return BASE_RATE;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function metric(rows) {
  const high = rows.filter((row) => row.level === "high");
  const low = rows.filter((row) => row.level === "low");
  let hits = 0;
  let miss = 0;
  let maxMiss = 0;
  for (const row of high) {
    if (row.group3) {
      hits += 1;
      miss = 0;
    } else {
      miss += 1;
      maxMiss = Math.max(maxMiss, miss);
    }
  }
  const highRate = high.length ? hits / high.length : 0;
  const lowHits = low.filter((row) => row.group3).length;
  const lowRate = low.length ? lowHits / low.length : 0;
  const baseHits = rows.filter((row) => row.group3).length;
  return {
    count: rows.length,
    baseRate: rows.length ? baseHits / rows.length : 0,
    highCalls: high.length,
    highHits: hits,
    highRate,
    highMaxMiss: maxMiss,
    lowCalls: low.length,
    lowRate,
    separation: highRate - lowRate,
    brier:
      rows.reduce(
        (sum, row) => sum + (row.probability - Number(row.group3)) ** 2,
        0,
      ) / Math.max(1, rows.length),
  };
}

function levelRows(rows, highQuantile) {
  const history = [];
  return rows.map((row) => {
    const recent = history.slice(-365);
    const high = quantile(recent, highQuantile);
    const low = quantile(recent, 0.2);
    history.push(row.probability);
    return {
      ...row,
      level:
        row.probability >= high
          ? "high"
          : row.probability <= low
            ? "low"
            : "middle",
    };
  });
}

function scope(rows, start, end) {
  return rows.filter(
    (row) => row.date >= start && (!end || row.date <= end),
  );
}

function compareValidation(left, right) {
  const leftEligible =
    left.validation.highCalls >= 80 && left.developmentTwo.highCalls >= 70;
  const rightEligible =
    right.validation.highCalls >= 80 && right.developmentTwo.highCalls >= 70;
  const leftLifts = [
    left.validation.highRate - left.validation.baseRate,
    left.developmentTwo.highRate - left.developmentTwo.baseRate,
  ];
  const rightLifts = [
    right.validation.highRate - right.validation.baseRate,
    right.developmentTwo.highRate - right.developmentTwo.baseRate,
  ];
  return (
    Number(rightEligible) - Number(leftEligible) ||
    Math.min(...rightLifts) - Math.min(...leftLifts) ||
    (rightLifts[0] + rightLifts[1]) / 2 -
      (leftLifts[0] + leftLifts[1]) / 2 ||
    Math.max(
      left.validation.highMaxMiss,
      left.developmentTwo.highMaxMiss,
    ) -
      Math.max(
        right.validation.highMaxMiss,
        right.developmentTwo.highMaxMiss,
      ) ||
    right.development.highRate - left.development.highRate ||
    left.development.brier - right.development.brier
  );
}

function hash(config) {
  return createHash("sha256")
    .update(`${JSON.stringify(config, null, 2)}\n`, "utf8")
    .digest("hex");
}

function distance(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] - right[index]) ** 2;
  }
  return Math.sqrt(sum);
}

function probabilityRows(examples, featureSet) {
  const pool = examples.filter((row) => row.date < ONLINE_START);
  const keys = [];
  const results = new Map();
  for (const neighbors of NEIGHBORS) {
    for (const priorStrength of PRIORS) {
      const key = `${neighbors}:${priorStrength}`;
      keys.push({ key, neighbors, priorStrength });
      results.set(key, []);
    }
  }
  for (const row of examples) {
    if (row.date < ONLINE_START) continue;
    const features = row.featureSets[featureSet];
    const nearest = pool
      .map((candidate) => ({
        distance: distance(candidate.featureSets[featureSet], features),
        hit: Number(candidate.group3),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, Math.max(...NEIGHBORS));
    const weightPrefix = [0];
    const hitPrefix = [0];
    for (const item of nearest) {
      const weight = 1 / (0.05 + item.distance);
      weightPrefix.push(weightPrefix.at(-1) + weight);
      hitPrefix.push(hitPrefix.at(-1) + item.hit * weight);
    }
    for (const key of keys) {
      const count = Math.min(key.neighbors, nearest.length);
      const probability =
        (key.priorStrength * BASE_RATE + hitPrefix[count]) /
        (key.priorStrength + weightPrefix[count]);
      results.get(key.key).push({
        date: row.date,
        issue: row.issue,
        probability,
        group3: row.group3,
      });
    }
    pool.push(row);
  }
  return results;
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const draws = data.rows;
  const examples = buildGroup3Examples(draws);
  const candidates = [];
  for (const featureSet of FEATURE_SETS) {
    console.log(`${GAME}: computing ${featureSet} KNN paths`);
    const paths = probabilityRows(examples, featureSet);
    for (const neighbors of NEIGHBORS) {
      for (const priorStrength of PRIORS) {
        const raw = paths.get(`${neighbors}:${priorStrength}`);
        for (const highQuantile of QUANTILES) {
          const rows = levelRows(raw, highQuantile);
          candidates.push({
            config: {
              method: "knn",
              featureSet,
              neighbors,
              priorStrength,
              onlineStart: ONLINE_START,
              highQuantile,
            },
            validation: metric(
              scope(rows, ONLINE_START, VALIDATION_END),
            ),
            developmentTwo: metric(
              scope(rows, DEVELOPMENT_TWO_START, DEVELOPMENT_TWO_END),
            ),
            development: metric(
              scope(rows, ONLINE_START, DEVELOPMENT_TWO_END),
            ),
            test: metric(scope(rows, TEST_START)),
            fullReplay: metric(rows),
          });
        }
      }
    }
  }
  candidates.sort(compareValidation);
  const selected = candidates[0];
  const trainedAt = new Date().toISOString();
  const config = {
    version: `${GAME}-group3-knn-validated-2`,
    trainedAt,
    trainingMode: "expanding-window-knn-validation-selected",
    trainingDataStart: draws[0].date,
    trainingDataCutoff: draws.at(-1).date,
    trainingIssueCutoff: draws.at(-1).issue,
    forwardStartIssue: String(Number(draws.at(-1).issue) + 1),
    simulationStart: ONLINE_START,
    simulationEnd: draws.at(-1).date,
    canonicalDataSha256: data.canonicalSha256,
    ...selected.config,
  };
  const report = {
    version: `${GAME}-group3-knn-optimization-2`,
    generatedAt: trainedAt,
    warning:
      "Hyperparameters were selected only on the two development intervals. The 2024+ test interval was not used for selection.",
    data: {
      count: draws.length,
      first: draws[0],
      last: draws.at(-1),
      canonicalSha256: data.canonicalSha256,
    },
    isolation: {
      initialTrainingEnd: "2018-12-31",
      developmentOne: [ONLINE_START, VALIDATION_END],
      developmentTwo: [DEVELOPMENT_TWO_START, DEVELOPMENT_TWO_END],
      untouchedTest: [TEST_START, draws.at(-1).date],
    },
    searched: {
      featureSets: FEATURE_SETS,
      neighbors: NEIGHBORS,
      priorStrengths: PRIORS,
      highQuantiles: QUANTILES,
      candidates: candidates.length,
      minimumDevelopmentHighCalls: [80, 70],
    },
    selected,
    leaders: candidates.slice(0, 12),
    config,
    configSha256: hash(config),
  };
  await writeFile(REPORT_OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GROUP3_APPLY === "1") {
    await writeFile(CONFIG_OUTPUT, `${JSON.stringify(config, null, 2)}\n`);
  }
  console.log(JSON.stringify({ selected, config }, null, 2));
}

await main();
