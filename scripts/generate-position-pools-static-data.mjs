import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const modelVariant = process.env.POSITION_MODEL === "joint" ? "joint" : "legacy";
const variantPrefix = modelVariant === "joint" ? "joint-" : "";
const source = path.join(
  root,
  "scripts",
  "data",
  game === "pl3" ? "pl3-full-history.json" : "fc3d-full-history.json",
);
const payload = JSON.parse(await readFile(source, "utf8"));
const draws = payload.rows;
const config = JSON.parse(
  await readFile(path.join(root, "scripts", "config", `${game}-position-pools${modelVariant === "joint" ? "-joint" : ""}.json`), "utf8"),
);
const TRAINING_START = config.trainingStart;
const TRAINING_END = config.trainingEnd;
const REPLAY_START = TRAINING_START;
const MIN_HISTORY = 120;
const positions = ["hundreds", "tens", "units"];

function incrementIssue(issue) {
  return String(Number(issue) + 1).padStart(issue.length, "0");
}

function positionFrequency(history, position, window) {
  const rows = history.slice(-window);
  const counts = Array(10).fill(0);
  for (const row of rows) counts[row.digits[position]] += 1;
  return counts.map((count) => count / rows.length);
}

function positionGaps(history, position) {
  return Array.from({ length: 10 }, (_, digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (history[history.length - 1 - age].digits[position] === digit) {
        return Math.min(age, 60) / 60;
      }
    }
    return 1;
  });
}

function features(history, position) {
  const frequencies = {};
  for (const window of [5, 10, 20, 30, 60, 120]) {
    frequencies[window] = positionFrequency(history, position, window);
  }
  return {
    frequencies,
    gaps: positionGaps(history, position),
    last: history.at(-1).digits[position],
  };
}

function poolFromFeature(feature, method, poolSize = 7) {
  return Array.from({ length: 10 }, (_, digit) => ({
    digit,
    score:
      feature.frequencies[method.longWindow][digit] * method.longWeight +
      feature.frequencies[method.shortWindow][digit] * method.shortWeight +
      feature.gaps[digit] * method.gapWeight +
      Number(digit === feature.last) * method.lastWeight,
  }))
    .sort((a, b) => b.score - a.score || a.digit - b.digit)
    .slice(0, poolSize)
    .map((item) => item.digit)
    .sort((a, b) => a - b);
}

function candidates() {
  const output = [];
  let id = 0;
  for (const longWindow of [20, 30, 60, 120]) {
    for (const shortWindow of [5, 10, 20]) {
      for (const longWeight of [-2, 1, 2]) {
        for (const shortWeight of [-1, 0, 1]) {
          for (const gapWeight of [-2, -1, 0, 1, 2]) {
            for (const lastWeight of [-1, 0, 1]) {
              output.push({
                id: `p7-${++id}`,
                longWindow,
                shortWindow,
                longWeight,
                shortWeight,
                gapWeight,
                lastWeight,
              });
            }
          }
        }
      }
    }
  }
  return output;
}

function metric(rows, key) {
  let hits = 0;
  let streak = 0;
  let maxMiss = 0;
  for (const row of rows) {
    if (row[key]) {
      hits += 1;
      streak = 0;
    } else {
      streak += 1;
      maxMiss = Math.max(maxMiss, streak);
    }
  }
  return {
    count: rows.length,
    hits,
    rate: rows.length ? hits / rows.length : 0,
    maxMiss,
    currentMiss: streak,
    targetMet: rows.length > 0 && maxMiss <= 1,
  };
}

function jointMetrics(rows) {
  const count = rows.length;
  const positionHits = Object.fromEntries(
    positions.map((key) => [key, rows.reduce((sum, row) => sum + Number(row[`${key}Hit`]), 0)]),
  );
  const hitCounts = rows.map((row) =>
    positions.reduce((sum, key) => sum + Number(row[`${key}Hit`]), 0),
  );
  const allThreeHits = hitCounts.filter((value) => value === 3).length;
  const exactlyTwoHits = hitCounts.filter((value) => value === 2).length;
  const exactlyOneHits = hitCounts.filter((value) => value === 1).length;
  const zeroHits = hitCounts.filter((value) => value === 0).length;
  const aloneDragHits = Object.fromEntries(
    positions.map((key) => [
      key,
      rows.filter((row) => !row[`${key}Hit`] && positions.filter((item) => item !== key).every((item) => row[`${item}Hit`])).length,
    ]),
  );
  let currentAllMiss = 0;
  let maxAllMiss = 0;
  let currentAllHit = 0;
  let longestAllHit = 0;
  for (const value of hitCounts) {
    if (value === 3) {
      currentAllHit += 1;
      longestAllHit = Math.max(longestAllHit, currentAllHit);
      currentAllMiss = 0;
    } else {
      currentAllMiss += 1;
      maxAllMiss = Math.max(maxAllMiss, currentAllMiss);
      currentAllHit = 0;
    }
  }
  const rates = Object.fromEntries(
    positions.map((key) => [key, count ? positionHits[key] / count : 0]),
  );
  const allThreeRate = count ? allThreeHits / count : 0;
  const exactlyTwoRate = count ? exactlyTwoHits / count : 0;
  const aloneDragRate = count
    ? Object.values(aloneDragHits).reduce((sum, value) => sum + value, 0) / count
    : 0;
  const independentProduct = rates.hundreds * rates.tens * rates.units;
  return {
    count,
    positionHits,
    positionRates: rates,
    allThreeHits,
    allThreeRate,
    exactlyTwoHits,
    exactlyTwoRate,
    mismatchRate: exactlyTwoRate,
    exactlyOneHits,
    exactlyOneRate: count ? exactlyOneHits / count : 0,
    zeroHits,
    zeroHitRate: count ? zeroHits / count : 0,
    aloneDragHits,
    aloneDragRates: Object.fromEntries(
      positions.map((key) => [key, count ? aloneDragHits[key] / count : 0]),
    ),
    singlePositionDragRate: aloneDragRate,
    longestAllHit,
    maxAllMiss,
    currentAllMiss,
    syncEfficiency: independentProduct ? allThreeRate / independentProduct : 0,
    score:
      0.55 * allThreeRate +
      0.15 * exactlyTwoRate +
      0.10 * rates.hundreds +
      0.10 * rates.tens +
      0.10 * rates.units -
      0.20 * aloneDragRate,
  };
}

const featureRows = [0, 1, 2].map(() => []);
for (let index = MIN_HISTORY; index < draws.length; index += 1) {
  const row = draws[index];
  if (row.date < REPLAY_START) continue;
  const history = draws.slice(0, index);
  for (let position = 0; position < 3; position += 1) {
    featureRows[position].push({
      issue: row.issue,
      date: row.date,
      draw: row.draw,
      actual: row.digits[position],
      feature: features(history, position),
    });
  }
}

const methods = candidates();
function evaluateAdaptive(rows, normals, defenses, collect = false) {
  let hits = 0;
  let streak = 0;
  let maxMiss = 0;
  const defenseRows = Array.from({ length: 10 }, () => []);
  for (const row of rows) {
    const stateDigit = row.feature.last;
    if (collect && streak) {
      defenseRows[stateDigit].push(row);
    }
    const method = streak
      ? defenses[stateDigit] ?? normals[stateDigit]
      : normals[stateDigit];
    const hit = poolFromFeature(row.feature, method).includes(row.actual);
    if (hit) {
      hits += 1;
      streak = 0;
    } else {
      streak += 1;
      maxMiss = Math.max(maxMiss, streak);
    }
  }
  return { hits, maxMiss, currentMiss: streak, defenseRows };
}

function bestForRows(rows, fallback) {
  if (!rows.length) return fallback;
  let best = null;
  for (const method of methods) {
    let hits = 0;
    for (const row of rows) {
      if (poolFromFeature(row.feature, method).includes(row.actual)) hits += 1;
    }
    if (!best || hits > best.hits) best = { method, hits };
    if (hits === rows.length) break;
  }
  return best.method;
}

function selectMethod(position) {
  const rows = featureRows[position].filter(
    (row) => row.date >= TRAINING_START && row.date <= TRAINING_END,
  );
  const normalRows = Array.from({ length: 10 }, () => []);
  for (const row of rows) normalRows[row.feature.last].push(row);
  const normals = normalRows.map((bucket) => bestForRows(bucket, methods[0]));
  const defenses = [...normals];
  for (let round = 0; round < 6; round += 1) {
    const replay = evaluateAdaptive(rows, normals, defenses, true);
    for (let previousDigit = 0; previousDigit < 10; previousDigit += 1) {
      defenses[previousDigit] = bestForRows(
        replay.defenseRows[previousDigit],
        defenses[previousDigit],
      );
    }
  }
  const result = evaluateAdaptive(rows, normals, defenses);
  return {
    normals,
    defenses,
    hits: result.hits,
    maxMiss: result.maxMiss,
    currentMiss: result.currentMiss,
  };
}

const replayRows = featureRows.map((rows) =>
  rows.filter((row) => row.date >= REPLAY_START),
);
const latest = draws.at(-1);
function buildPoolResult(poolSize, poolConfig) {
  const selected = positions.map((key) => poolConfig.methods[key]);
  const streaks = [0, 0, 0];
  const fullHistory = replayRows[0].map((base, index) => {
    const result = {
      issue: base.issue,
      date: base.date,
      draw: base.draw,
      phase: base.date <= TRAINING_END ? "training-selection" : "locked-forward",
    };
    for (let position = 0; position < 3; position += 1) {
      const row = replayRows[position][index];
      const chosenMethod = streaks[position]
        ? selected[position].defenses[row.feature.last]
        : selected[position].normals[row.feature.last];
      const pool = poolFromFeature(row.feature, chosenMethod, poolSize);
      const hit = pool.includes(row.actual);
      streaks[position] = hit ? 0 : streaks[position] + 1;
      const key = positions[position];
      result[`${key}Pool`] = pool.join("");
      result[`${key}Hit`] = hit;
      result[`${key}MissStreak`] = streaks[position];
    }
    result.allHit = positions.every((key) => result[`${key}Hit`]);
    return result;
  });

  const recommendation = {
    targetIssue: incrementIssue(latest.issue),
    basedOnIssue: latest.issue,
    basedOnDate: latest.date,
  };
  for (let position = 0; position < 3; position += 1) {
    recommendation[`${positions[position]}Pool`] = poolFromFeature(
      features(draws, position),
      streaks[position]
        ? selected[position].defenses[draws.at(-1).digits[position]]
        : selected[position].normals[draws.at(-1).digits[position]],
      poolSize,
    ).join("");
  }

  const metrics = {};
  for (const key of positions) {
    metrics[key] = {
      training: metric(fullHistory.filter((row) => row.date <= TRAINING_END), `${key}Hit`),
      forward: metric(fullHistory.filter((row) => row.date >= config.forwardStart), `${key}Hit`),
    };
  }
  metrics.all = {
    overall: metric(fullHistory, "allHit"),
    training: metric(fullHistory.filter((row) => row.date <= TRAINING_END), "allHit"),
    forward: metric(fullHistory.filter((row) => row.date >= config.forwardStart), "allHit"),
  };
  metrics.joint = jointMetrics(fullHistory);
  metrics.windows = Object.fromEntries(
    [30, 100, 300, 500].map((window) => [window, jointMetrics(fullHistory.slice(-window))]),
  );
  return {
    poolSize,
    recommendation,
    methods: poolConfig.methods,
    metrics,
    history: fullHistory,
  };
}

const pools = Object.fromEntries(
  [5, 6, 7].map((size) => [size, buildPoolResult(size, config.pools[size])]),
);

const output = {
  generatedAt: new Date().toISOString(),
  game,
  modelVariant,
  sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
  dataSha256: payload.canonicalSha256,
  formulaVersion: config.formulaVersion,
  trainingMode: config.trainingMode,
  candidateFormulaCount: config.candidateFormulaCount ?? null,
  compressionSourceCandidateCount: config.compressionSourceCandidateCount ?? null,
  compressionValidatedThrough: config.compressionValidatedThrough ?? null,
  trainingStart: TRAINING_START,
  trainingEnd: TRAINING_END,
  forwardStart: config.forwardStart,
  futureGuarantee: false,
  notice: modelVariant === "joint"
    ? `${game === "pl3" ? "体彩排列3" : "福彩3D"}联合定位5码、6码、7码分别使用独立权重，优先提高同一期三位全中率与同步效率，并惩罚错位率；权重已于2026-09-14锁定，此后只记录实战结果。${config.candidateFormulaCount ? ` 当前压缩公式库为${config.candidateFormulaCount}套。` : ""}`
    : `${game === "pl3" ? "体彩排列3" : "福彩3D"}原定位5码、6码、7码使用2025-09-15至2026-09-14一年答案搜索各位置权重；权重已于2026-09-14锁定，此后只记录实战结果。${config.candidateFormulaCount ? ` 当前压缩公式库为${config.candidateFormulaCount}套。` : ""}`,
  optimizationObjective: config.optimizationObjective ?? null,
  pools,
};

await mkdir(path.join(root, "pages", "audit"), { recursive: true });
await mkdir(path.join(root, "public", "audit"), { recursive: true });
for (const directory of ["pages", "public"]) {
  await writeFile(path.join(root, directory, `${prefix}${variantPrefix}position7-data.json`), `${JSON.stringify(output)}\n`, "utf8");
  await writeFile(
    path.join(root, directory, "audit", `${prefix}${variantPrefix}position7-model.json`),
    `${JSON.stringify({ ...output, pools: Object.fromEntries(Object.entries(pools).map(([size, item]) => [size, { ...item, history: undefined }])) }, null, 2)}\n`,
    "utf8",
  );
}
if (game === "fc3d" && modelVariant === "legacy") {
  for (const file of ["position7.html", path.join("assets", "position7.js"), "styles.css"]) {
    await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
  }
}

console.log(
  `${game} ${modelVariant} position pools generated: ${[5, 6, 7].map((size) => `${size}码 ${positions.map((key) => pools[size].metrics[key].forward.maxMiss).join("/")}`).join(", ")}`,
);
