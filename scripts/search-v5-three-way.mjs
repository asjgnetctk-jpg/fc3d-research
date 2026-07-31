import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const DATA_PATH = process.env.V5_DATA_PATH ?? "";
const FETCH_START = process.env.V5_FETCH_START ?? "2022-01-01";
const TEST_START = process.env.V5_TEST_START ?? "2023-07-28";
const TEST_END = process.env.V5_TEST_END ?? "2026-07-27";
const WINDOWS = [3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120];
const POSITION_WINDOWS = [10, 20, 30, 60];
const SEED = Number(process.env.V5_SEED ?? 20260730);
const STATIC_CANDIDATES = Number(
  process.env.V5_STATIC_CANDIDATES ?? 70000,
);
const STATIC_KEEP = Number(process.env.V5_STATIC_KEEP ?? 1500);
const GUARD_TRIALS = Number(process.env.V5_GUARD_TRIALS ?? 120000);
const STATE_POLICY_TRIALS = Number(
  process.env.V5_STATE_POLICY_TRIALS ?? 350000,
);
const SHAPE_CANDIDATES = Number(
  process.env.V5_SHAPE_CANDIDATES ?? 70000,
);
const REPORT_OUTPUT =
  process.env.V5_REPORT_OUTPUT ?? "scripts/results/v5-three-way.json";
const PAGE_REPORT_OUTPUT =
  process.env.V5_PAGE_REPORT_OUTPUT ??
  "pages/audit/v5-three-way-20230728-20260727.json";
const CSV_OUTPUT =
  process.env.V5_CSV_OUTPUT ??
  "pages/audit/v5-three-way-20230728-20260727.csv";

function zscore(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return sd > 1e-12 ? values.map((value) => (value - mean) / sd) : values.map(() => 0);
}

function presence(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => row.digits.includes(digit)).length / rows.length,
  );
}

function occurrence(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) =>
      rows.reduce(
        (sum, row) => sum + row.digits.filter((value) => value === digit).length,
        0,
      ) /
      (rows.length * 3),
  );
}

function gaps(history) {
  return DIGITS.map((digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (history[history.length - 1 - age].digits.includes(digit)) return age;
    }
    return history.length;
  });
}

function positionFrequency(history, window, position) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => row.digits[position] === digit).length / rows.length,
  );
}

function transition(history, lookback) {
  const rows = history.slice(-lookback);
  const last = new Set(rows.at(-1).digits);
  const totals = Array(10).fill(0);
  let base = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = new Set(rows[index - 1].digits);
    let overlap = 0;
    for (const digit of last) if (previous.has(digit)) overlap += 1;
    if (!overlap) continue;
    base += overlap;
    for (const digit of new Set(rows[index].digits)) totals[digit] += overlap;
  }
  return totals.map((value) => (base ? value / base : 0));
}

const digitFeatureNames = [
  ...WINDOWS.map((window) => `presence${window}`),
  ...WINDOWS.map((window) => `occurrence${window}`),
  "gap",
  ...POSITION_WINDOWS.flatMap((window) =>
    [0, 1, 2].map((position) => `position${position + 1}_${window}`),
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

function digitMatrix(history) {
  const columns = [
    ...WINDOWS.map((window) => zscore(presence(history, window))),
    ...WINDOWS.map((window) => zscore(occurrence(history, window))),
    zscore(gaps(history)),
    ...POSITION_WINDOWS.flatMap((window) =>
      [0, 1, 2].map((position) =>
        zscore(positionFrequency(history, window, position)),
      ),
    ),
    zscore(presence(history, 1)),
    zscore(presence(history, 2)),
    zscore(presence(history, 3)),
    zscore(transition(history, 30)),
    zscore(transition(history, 60)),
    zscore(transition(history, 120)),
    zscore(DIGITS.map((digit) => -Math.abs(digit - 4.5))),
    zscore(DIGITS.map((digit) => digit % 2)),
  ];
  return DIGITS.map((digit) => columns.map((column) => column[digit]));
}

function actualShape(digits) {
  const unique = new Set(digits).size;
  return unique === 1 ? "豹子" : unique === 2 ? "组三" : "组六";
}

function shapeGap(history, target) {
  for (let age = 0; age < history.length; age += 1) {
    if (actualShape(history[history.length - 1 - age].digits) === target) return age;
  }
  return history.length;
}

const SHAPE_WINDOWS = [3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120];
const shapeFeatureNames = [
  ...SHAPE_WINDOWS.map((window) => `group3Rate${window}`),
  ...SHAPE_WINDOWS.map((window) => `group6Rate${window}`),
  "group3Gap",
  "group6Gap",
  "lastGroup3",
  "lastGroup6",
  "last2Group3",
  "last2Group6",
  "recentRepeatRate10",
  "recentRepeatRate30",
  "recentSpan10",
  "recentSpan30",
  "recentSum10",
  "recentSum30",
];

function average(rows, selector) {
  return rows.reduce((sum, row) => sum + selector(row), 0) / rows.length;
}

function shapeVector(history) {
  const shapeRate = (window, target) => {
    const rows = history.slice(-window);
    return rows.filter((row) => actualShape(row.digits) === target).length / rows.length;
  };
  const last = history.at(-1);
  const last2 = history.slice(-2);
  const stats = (window) => history.slice(-window);
  return [
    ...SHAPE_WINDOWS.map((window) => shapeRate(window, "组三")),
    ...SHAPE_WINDOWS.map((window) => shapeRate(window, "组六")),
    Math.min(shapeGap(history, "组三"), 60) / 60,
    Math.min(shapeGap(history, "组六"), 60) / 60,
    Number(actualShape(last.digits) === "组三"),
    Number(actualShape(last.digits) === "组六"),
    last2.filter((row) => actualShape(row.digits) === "组三").length / 2,
    last2.filter((row) => actualShape(row.digits) === "组六").length / 2,
    average(stats(10), (row) => Number(new Set(row.digits).size < 3)),
    average(stats(30), (row) => Number(new Set(row.digits).size < 3)),
    average(stats(10), (row) => Math.max(...row.digits) - Math.min(...row.digits)) / 9,
    average(stats(30), (row) => Math.max(...row.digits) - Math.min(...row.digits)) / 9,
    average(stats(10), (row) => row.digits.reduce((sum, digit) => sum + digit, 0)) / 27,
    average(stats(30), (row) => row.digits.reduce((sum, digit) => sum + digit, 0)) / 27,
  ];
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDigitCandidate(random, id) {
  const weights = Array(digitFeatureNames.length).fill(0);
  const active = 2 + Math.floor(random() * 9);
  for (let index = 0; index < active; index += 1) {
    const feature = Math.floor(random() * weights.length);
    weights[feature] += [-3, -2, -1, 1, 2, 3][Math.floor(random() * 6)];
  }
  return { id, weights, rank: Math.floor(random() * 10) };
}

function activeWeights(candidate) {
  return candidate.weights
    .map((weight, feature) => ({ feature, weight }))
    .filter((row) => row.weight);
}

function ranking(matrix, candidate) {
  const active = candidate.active ?? activeWeights(candidate);
  return DIGITS.map((digit) => ({
    digit,
    score: active.reduce(
      (sum, item) => sum + matrix[digit][item.feature] * item.weight,
      0,
    ),
  })).sort((left, right) => right.score - left.score || left.digit - right.digit);
}

function candidateSeries(rows, candidate) {
  candidate.active = activeWeights(candidate);
  const dan = [];
  const pool7 = [];
  for (const row of rows) {
    const ranked = ranking(row.matrix, candidate);
    dan.push(ranked[candidate.rank].digit);
    pool7.push(ranked.slice(0, 7).map((item) => item.digit).sort((a, b) => a - b));
  }
  return { dan, pool7 };
}

function metrics(hits, rows = []) {
  let hitCount = 0;
  let currentMiss = 0;
  let currentStart = 0;
  let longest = { length: 0, startIndex: 0, endIndex: -1 };
  hits.forEach((hit, index) => {
    if (hit) {
      hitCount += 1;
      currentMiss = 0;
    } else {
      if (currentMiss === 0) currentStart = index;
      currentMiss += 1;
      if (currentMiss > longest.length) {
        longest = { length: currentMiss, startIndex: currentStart, endIndex: index };
      }
    }
  });
  return {
    count: hits.length,
    hits: hitCount,
    rate: hits.length ? hitCount / hits.length : 0,
    maxMiss: longest.length,
    longestMiss:
      rows.length && longest.endIndex >= 0
        ? {
            length: longest.length,
            startIssue: rows[longest.startIndex].issue,
            startDate: rows[longest.startIndex].date,
            endIssue: rows[longest.endIndex].issue,
            endDate: rows[longest.endIndex].date,
          }
        : null,
  };
}

function compareMetric(left, right) {
  const leftFeasible = left.maxMiss <= 7;
  const rightFeasible = right.maxMiss <= 7;
  return (
    Number(rightFeasible) - Number(leftFeasible) ||
    left.maxMiss - right.maxMiss ||
    right.rate - left.rate ||
    right.hits - left.hits
  );
}

function prune(list) {
  list.sort((left, right) => compareMetric(left.metrics, right.metrics) || left.id - right.id);
  if (list.length > STATIC_KEEP) list.length = STATIC_KEEP;
}

function evaluateStatic(rows, candidate, type) {
  const series = candidateSeries(rows, candidate);
  const predictions = type === "dan" ? series.dan : series.pool7;
  const hits =
    type === "dan"
      ? rows.map((row, index) => row.digits.includes(predictions[index]))
      : rows.map((row, index) => {
          const actual = new Set(row.digits);
          return actual.size === 3 && [...actual].every((digit) => predictions[index].includes(digit));
        });
  return { id: candidate.id, candidate, predictions, hits, metrics: metrics(hits, rows) };
}

function staticSearch(rows, type, random) {
  const kept = [];
  for (let id = 0; id < STATIC_CANDIDATES; id += 1) {
    const entry = evaluateStatic(rows, randomDigitCandidate(random, id), type);
    kept.push(entry);
    if (kept.length >= STATIC_KEEP * 2) prune(kept);
  }
  prune(kept);
  return kept;
}

function guardEvaluation(rows, normal, guard, trigger) {
  const predictions = [];
  const hits = [];
  let missStreak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const useGuard = missStreak >= trigger;
    const prediction = (useGuard ? guard : normal).predictions[index];
    const hit = (useGuard ? guard : normal).hits[index];
    predictions.push(prediction);
    hits.push(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return { predictions, hits, metrics: metrics(hits, rows) };
}

function guardSearch(rows, library, random) {
  let best = {
    normal: library[0],
    guard: library[0],
    trigger: 99,
    result: {
      predictions: library[0].predictions,
      hits: library[0].hits,
      metrics: library[0].metrics,
    },
  };
  for (let trial = 0; trial < GUARD_TRIALS; trial += 1) {
    const normal = library[Math.floor(random() * Math.min(180, library.length))];
    const guard = library[Math.floor(random() * library.length)];
    const trigger = 3 + Math.floor(random() * 5);
    const result = guardEvaluation(rows, normal, guard, trigger);
    if (compareMetric(result.metrics, best.result.metrics) < 0) {
      best = { normal, guard, trigger, result };
    }
  }
  return best;
}

function statePolicyEvaluation(rows, library, choices) {
  const predictions = [];
  const hits = [];
  let missStreak = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const bucket = missStreak < 3 ? 0 : missStreak < 5 ? 1 : missStreak < 7 ? 2 : 3;
    const method = library[choices[bucket]];
    const prediction = method.predictions[index];
    const hit = method.hits[index];
    predictions.push(prediction);
    hits.push(hit);
    missStreak = hit ? 0 : missStreak + 1;
  }
  return { predictions, hits, metrics: metrics(hits, rows) };
}

function statePolicySearch(rows, library, random, initial) {
  const normalIndex = Math.max(0, library.indexOf(initial.normal));
  const guardIndex = Math.max(0, library.indexOf(initial.guard));
  let best = {
    choices: [normalIndex, guardIndex, guardIndex, guardIndex],
    result: statePolicyEvaluation(
      rows,
      library,
      [normalIndex, guardIndex, guardIndex, guardIndex],
    ),
  };
  for (let trial = 0; trial < STATE_POLICY_TRIALS; trial += 1) {
    const choices = [
      Math.floor(random() * Math.min(160, library.length)),
      Math.floor(random() * library.length),
      Math.floor(random() * library.length),
      Math.floor(random() * library.length),
    ];
    const result = statePolicyEvaluation(rows, library, choices);
    if (compareMetric(result.metrics, best.result.metrics) < 0) {
      best = { choices, result };
    }
  }
  for (let round = 0; round < 4; round += 1) {
    let improved = false;
    for (let bucket = 0; bucket < 4; bucket += 1) {
      for (let choice = 0; choice < library.length; choice += 1) {
        const choices = [...best.choices];
        choices[bucket] = choice;
        const result = statePolicyEvaluation(rows, library, choices);
        if (compareMetric(result.metrics, best.result.metrics) < 0) {
          best = { choices, result };
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function randomShapeCandidate(random, id) {
  const weights = Array(shapeFeatureNames.length).fill(0);
  const active = 2 + Math.floor(random() * 9);
  for (let index = 0; index < active; index += 1) {
    const feature = Math.floor(random() * weights.length);
    weights[feature] += [-4, -3, -2, -1, 1, 2, 3, 4][Math.floor(random() * 8)];
  }
  return { id, weights, active: activeWeights({ weights }) };
}

function shapeSearch(rows, random) {
  const targetShares = [0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28, 0.3, 0.35, 0.4];
  let best = null;
  for (let id = 0; id < SHAPE_CANDIDATES; id += 1) {
    const candidate = randomShapeCandidate(random, id);
    const scores = rows.map((row) =>
      candidate.active.reduce(
        (sum, item) => sum + row.shapeVector[item.feature] * item.weight,
        0,
      ),
    );
    const sorted = [...scores].sort((a, b) => a - b);
    for (const targetShare of targetShares) {
      const threshold = sorted[Math.max(0, Math.floor(sorted.length * (1 - targetShare)))];
      const predictions = scores.map((score) => (score >= threshold ? "组三" : "组六"));
      const group3Count = predictions.filter((value) => value === "组三").length;
      const group3Share = group3Count / predictions.length;
      if (group3Share < 0.1 || group3Share > 0.45) continue;
      const hits = rows.map(
        (row, index) => actualShape(row.digits) === predictions[index],
      );
      const evaluated = metrics(hits, rows);
      if (
        !best ||
        compareMetric(evaluated, best.metrics) < 0 ||
        (compareMetric(evaluated, best.metrics) === 0 && group3Share > best.group3Share)
      ) {
        best = {
          candidate,
          threshold,
          predictions,
          hits,
          metrics: evaluated,
          group3Count,
          group3Share,
        };
      }
    }
  }
  return best;
}

function describe(candidate) {
  return {
    id: candidate.id,
    rank: candidate.rank === undefined ? null : candidate.rank + 1,
    weights: candidate.weights
      .map((weight, index) => ({
        feature:
          candidate.weights.length === digitFeatureNames.length
            ? digitFeatureNames[index]
            : shapeFeatureNames[index],
        weight,
      }))
      .filter((row) => row.weight),
  };
}

async function fetchOfficial() {
  if (DATA_PATH) {
    const snapshot = JSON.parse(await readFile(DATA_PATH, "utf8"));
    return {
      requestUrl: snapshot.sourceUrl ?? DATA_PATH,
      draws: snapshot.rows,
    };
  }
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${TEST_END}` +
    "&pageNo=1&pageSize=2000&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/5.0)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  const draws = (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      draw: item.red.replaceAll(",", ""),
      digits: item.red.split(",").map(Number),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return { requestUrl, draws };
}

function validate(draws) {
  const issues = new Set();
  const dates = new Set();
  const duplicateIssues = [];
  const duplicateDates = [];
  let invalidRows = 0;
  for (const row of draws) {
    if (issues.has(row.issue)) duplicateIssues.push(row.issue);
    if (dates.has(row.date)) duplicateDates.push(row.date);
    issues.add(row.issue);
    dates.add(row.date);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !/^\d{5,7}$/.test(row.issue) ||
      row.digits.length !== 3 ||
      row.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)
    ) invalidRows += 1;
  }
  return {
    fetched: draws.length,
    duplicateIssues,
    duplicateDates,
    invalidRows,
    passed: !duplicateIssues.length && !invalidRows,
  };
}

async function main() {
  const { requestUrl, draws } = await fetchOfficial();
  const integrity = validate(draws);
  if (!integrity.passed) throw new Error(`integrity:${JSON.stringify(integrity)}`);

  const rows = [];
  for (let index = 120; index < draws.length; index += 1) {
    const draw = draws[index];
    if (draw.date < TEST_START || draw.date > TEST_END) continue;
    const history = draws.slice(0, index);
    rows.push({
      ...draw,
      matrix: digitMatrix(history),
      shapeVector: shapeVector(history),
    });
  }
  if (rows.length < 1000) throw new Error(`test-samples:${rows.length}`);
  console.log(`官方数据校验通过：${rows.length}期，开始搜索独胆。`);

  const random = mulberry32(SEED);
  const danLibrary = staticSearch(rows, "dan", random);
  console.log(`独胆静态最优：${JSON.stringify(danLibrary[0].metrics)}`);
  const danGuard = guardSearch(rows, danLibrary, random);
  console.log(`独胆双公式保护：${JSON.stringify(danGuard.result.metrics)}`);
  const danBest = statePolicySearch(rows, danLibrary, random, danGuard);
  console.log(`独胆四状态切换：${JSON.stringify(danBest.result.metrics)}`);

  console.log("开始搜索7码。");
  const poolLibrary = staticSearch(rows, "pool7", random);
  console.log(`7码静态最优：${JSON.stringify(poolLibrary[0].metrics)}`);
  const poolGuard = guardSearch(rows, poolLibrary, random);
  console.log(`7码双公式保护：${JSON.stringify(poolGuard.result.metrics)}`);
  const poolBest = statePolicySearch(rows, poolLibrary, random, poolGuard);
  console.log(`7码四状态切换：${JSON.stringify(poolBest.result.metrics)}`);

  console.log("开始搜索组三/组六二选一。");
  const shapeBest = shapeSearch(rows, random);
  const alwaysSixHits = rows.map((row) => actualShape(row.digits) === "组六");
  const alwaysSix = metrics(alwaysSixHits, rows);
  const alwaysThreeHits = rows.map((row) => actualShape(row.digits) === "组三");
  const alwaysThree = metrics(alwaysThreeHits, rows);
  console.log(`形态动态模型：${JSON.stringify(shapeBest.metrics)}`);

  let danMissStreak = 0;
  let pool7MissStreak = 0;
  let shapeMissStreak = 0;
  const auditRows = rows.map((row, index) => {
    const dan = danBest.result.predictions[index];
    const pool7 = poolBest.result.predictions[index];
    const shapeRecommendation = shapeBest.predictions[index];
    const danHit = danBest.result.hits[index];
    const pool7Hit = poolBest.result.hits[index];
    const shapeHit = shapeBest.hits[index];
    const actual = new Set(row.digits);
    const pool7Group3Covered =
      actual.size === 2 && [...actual].every((digit) => pool7.includes(digit));
    danMissStreak = danHit ? 0 : danMissStreak + 1;
    pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
    shapeMissStreak = shapeHit ? 0 : shapeMissStreak + 1;
    return {
      date: row.date,
      issue: row.issue,
      dan,
      pool7: pool7.join(""),
      shapeRecommendation,
      draw: row.draw,
      actualShape: actualShape(row.digits),
      danHit,
      pool7Hit,
      pool7Group3Covered,
      shapeHit,
      danMissStreak,
      pool7MissStreak,
      shapeMissStreak,
    };
  });

  const canonicalRaw = rows
    .map((row) => `${row.date},${row.issue},${row.draw}`)
    .join("\n");
  const report = {
    version: "V5-three-way-search-1",
    createdAt: new Date().toISOString(),
    source: {
      provider: "中国福利彩票官网",
      requestUrl,
      integrity,
      canonicalTestDataSha256: createHash("sha256")
        .update(canonicalRaw, "utf8")
        .digest("hex"),
    },
    range: { start: TEST_START, end: TEST_END, count: rows.length },
    search: {
      seed: SEED,
      staticCandidatesPerDigitPlay: STATIC_CANDIDATES,
      staticKeep: STATIC_KEEP,
      guardTrialsPerDigitPlay: GUARD_TRIALS,
      statePolicyTrialsPerDigitPlay: STATE_POLICY_TRIALS,
      shapeCandidates: SHAPE_CANDIDATES,
      objective: "优先寻找最长连续未中不超过7期的方案，再比较最长断期和命中率。",
      warning:
        "三套参数均在同一三年区间比较后选出，属于真实逐期回算和后验拟合，不是独立前瞻验证；每期特征只使用当期开奖之前的数据，但参数选择使用了整段回测成绩。",
    },
    dan: {
      metrics: danBest.result.metrics,
      stateBuckets: ["连续未中0-2期", "连续未中3-4期", "连续未中5-6期", "连续未中7期及以上"],
      stateMethods: danBest.choices.map((choice) => describe(danLibrary[choice].candidate)),
    },
    pool7: {
      rule: "实际为组六且三个不同数字全部进入7码池，才计正式命中；组三只单独标记覆盖。",
      metrics: poolBest.result.metrics,
      stateBuckets: ["连续未中0-2期", "连续未中3-4期", "连续未中5-6期", "连续未中7期及以上"],
      stateMethods: poolBest.choices.map((choice) => describe(poolLibrary[choice].candidate)),
    },
    shapeChoice: {
      rule: "每天推荐组三或组六；实际形态相同才命中，豹子统一失败。",
      metrics: shapeBest.metrics,
      model: describe(shapeBest.candidate),
      threshold: shapeBest.threshold,
      group3Recommendations: shapeBest.group3Count,
      group3RecommendationShare: shapeBest.group3Share,
      baselines: {
        alwaysGroup6: alwaysSix,
        alwaysGroup3: alwaysThree,
      },
    },
    rows: auditRows,
  };

  const csvRows = [
    [
      "日期", "期号", "独胆推荐", "7码推荐", "形态推荐", "开奖号", "实际形态",
      "独胆命中", "独胆连续未中", "7码命中", "7码连续未中", "7码组三覆盖",
      "形态命中", "形态连续未中",
    ],
    ...auditRows.map((row) => [
      row.date,
      row.issue,
      row.dan,
      row.pool7,
      row.shapeRecommendation,
      row.draw,
      row.actualShape,
      row.danHit ? "中" : "未中",
      row.danMissStreak,
      row.pool7Hit ? "中" : "未中",
      row.pool7MissStreak,
      row.pool7Group3Covered ? "组三覆盖" : "",
      row.shapeHit ? "中" : "未中",
      row.shapeMissStreak,
    ]),
  ];

  await mkdir("scripts/results", { recursive: true });
  await mkdir("pages/audit", { recursive: true });
  await writeFile(
    REPORT_OUTPUT,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    PAGE_REPORT_OUTPUT,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    CSV_OUTPUT,
    `\uFEFF${csvRows.map((row) => row.join(",")).join("\n")}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        range: report.range,
        dan: report.dan,
        pool7: report.pool7,
        shapeChoice: report.shapeChoice,
      },
      null,
      2,
    ),
  );
}

await main();
