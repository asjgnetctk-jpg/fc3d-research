import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const source = path.join(
  root,
  "scripts",
  "data",
  game === "pl3" ? "pl3-full-history.json" : "fc3d-full-history.json",
);
const payload = JSON.parse(await readFile(source, "utf8"));
const draws = payload.rows;
const config = JSON.parse(
  await readFile(path.join(root, "scripts", "config", `${game}-position-pools.json`), "utf8"),
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
  sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
  dataSha256: payload.canonicalSha256,
  formulaVersion: config.formulaVersion,
  trainingMode: config.trainingMode,
  trainingStart: TRAINING_START,
  trainingEnd: TRAINING_END,
  forwardStart: config.forwardStart,
  futureGuarantee: false,
  notice:
    `${game === "pl3" ? "体彩排列3" : "福彩3D"}定位5码、6码、7码直接使用2025-09-15至2026-09-14这一年答案搜索权重。每个位置按上期数字和当前连断状态切换公式；权重已于2026-09-14锁定，此后只记录实战结果。`,
  pools,
};

await mkdir(path.join(root, "pages", "audit"), { recursive: true });
await mkdir(path.join(root, "public", "audit"), { recursive: true });
for (const directory of ["pages", "public"]) {
  await writeFile(path.join(root, directory, `${prefix}position7-data.json`), `${JSON.stringify(output)}\n`, "utf8");
  await writeFile(
    path.join(root, directory, "audit", `${prefix}position7-model.json`),
    `${JSON.stringify({ ...output, pools: Object.fromEntries(Object.entries(pools).map(([size, item]) => [size, { ...item, history: undefined }])) }, null, 2)}\n`,
    "utf8",
  );
}
if (game === "fc3d") {
  for (const file of ["position7.html", path.join("assets", "position7.js")]) {
    await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
  }
}

console.log(
  `${game} position pools generated: ${[5, 6, 7].map((size) => `${size}码 ${positions.map((key) => pools[size].metrics[key].forward.maxMiss).join("/")}`).join(", ")}`,
);
