import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const FETCH_START = "2022-01-01";
const DEV_START = "2022-04-01";
const DEV_END = "2023-07-27";
const TEST_START = "2023-07-28";
const TEST_END = "2026-07-27";
const WINDOWS = [3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120];
const POSITION_WINDOWS = [10, 20, 30, 60];
const SEED = 20260729;
const CANDIDATES = 220000;
const KEEP = 700;
const ONLINE_LIBRARY = 180;
const ONLINE_LOOKBACKS = [15, 20, 30, 45, 60, 90, 120, 180];
const VOTE_LOOKBACKS = [30, 45, 60, 90, 120, 180];
const VOTE_SIZES = [3, 5, 10, 20, 40];

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

const featureNames = [
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

function featureMatrix(history) {
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

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCandidate(random, id) {
  const weights = Array(featureNames.length).fill(0);
  const active = 1 + Math.floor(random() * 10);
  for (let index = 0; index < active; index += 1) {
    const feature = Math.floor(random() * weights.length);
    weights[feature] += [-3, -2, -1, 1, 2, 3][Math.floor(random() * 6)];
  }
  return { id, weights, rank: Math.floor(random() * 10) };
}

function pick(matrix, candidate) {
  return DIGITS.map((digit) => ({
    digit,
    score: matrix[digit].reduce(
      (sum, value, feature) => sum + value * candidate.weights[feature],
      0,
    ),
  }))
    .sort((left, right) => right.score - left.score || left.digit - right.digit)
    [candidate.rank].digit;
}

function v2Dan(history) {
  const zPresence7 = zscore(presence(history, 7));
  const zOccurrence10 = zscore(occurrence(history, 10));
  const zGap = zscore(gaps(history));
  return DIGITS.map((digit) => ({
    digit,
    score: -2 * zPresence7[digit] + zOccurrence10[digit] - zGap[digit],
  }))
    .sort((left, right) => right.score - left.score || left.digit - right.digit)[3]
    .digit;
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

function candidateMetrics(rows, candidate) {
  const predictions = rows.map((row) => pick(row.matrix, candidate));
  const hits = rows.map((row, index) => row.digits.includes(predictions[index]));
  return { predictions, hits, metrics: metrics(hits, rows) };
}

function compareMetrics(left, right) {
  return (
    left.maxMiss - right.maxMiss ||
    right.rate - left.rate ||
    right.hits - left.hits
  );
}

function compareEntries(left, right) {
  return compareMetrics(left.dev, right.dev) || left.id - right.id;
}

function describe(candidate) {
  return {
    id: candidate.id,
    rank: candidate.rank + 1,
    weights: candidate.weights
      .map((weight, index) => ({ feature: featureNames[index], weight }))
      .filter((row) => row.weight),
  };
}

function onlineSwitch(rows, library, lookback) {
  const predictions = library.map((candidate) =>
    rows.map((row) => pick(row.matrix, candidate)),
  );
  const hits = predictions.map((series) =>
    rows.map((row, index) => row.digits.includes(series[index])),
  );
  const cumulative = hits.map((series) => {
    const output = [0];
    for (const hit of series) output.push(output.at(-1) + Number(hit));
    return output;
  });
  const chosen = [];
  for (let index = 0; index < rows.length; index += 1) {
    const start = Math.max(0, index - lookback);
    let best = 0;
    let bestRate = -1;
    let bestRecent = -1;
    for (let method = 0; method < library.length; method += 1) {
      const count = index - start;
      const priorHits = cumulative[method][index] - cumulative[method][start];
      const rate = (priorHits + 2.71) / (count + 10);
      const recentStart = Math.max(start, index - 7);
      const recent =
        cumulative[method][index] - cumulative[method][recentStart];
      if (
        rate > bestRate ||
        (rate === bestRate && recent > bestRecent) ||
        (rate === bestRate && recent === bestRecent && method < best)
      ) {
        best = method;
        bestRate = rate;
        bestRecent = recent;
      }
    }
    chosen.push({
      dan: predictions[best][index],
      methodId: library[best].id,
    });
  }
  const chosenHits = rows.map((row, index) =>
    row.digits.includes(chosen[index].dan),
  );
  return { chosen, hits: chosenHits, metrics: metrics(chosenHits, rows) };
}

function onlineVote(rows, library, lookback, voteSize) {
  const predictions = library.map((candidate) =>
    rows.map((row) => pick(row.matrix, candidate)),
  );
  const hits = predictions.map((series) =>
    rows.map((row, index) => row.digits.includes(series[index])),
  );
  const cumulative = hits.map((series) => {
    const output = [0];
    for (const hit of series) output.push(output.at(-1) + Number(hit));
    return output;
  });
  const chosen = [];
  for (let index = 0; index < rows.length; index += 1) {
    const start = Math.max(0, index - lookback);
    const count = index - start;
    const ranked = library
      .map((candidate, method) => {
        const priorHits =
          cumulative[method][index] - cumulative[method][start];
        return {
          method,
          rate: (priorHits + 2.71) / (count + 10),
          id: candidate.id,
        };
      })
      .sort(
        (left, right) =>
          right.rate - left.rate || left.id - right.id,
      )
      .slice(0, voteSize);
    const votes = Array(10).fill(0);
    for (const member of ranked) {
      votes[predictions[member.method][index]] += member.rate;
    }
    const dan = DIGITS.map((digit) => ({ digit, score: votes[digit] }))
      .sort((left, right) => right.score - left.score || left.digit - right.digit)[0]
      .digit;
    chosen.push(dan);
  }
  const chosenHits = rows.map((row, index) => row.digits.includes(chosen[index]));
  return { chosen, hits: chosenHits, metrics: metrics(chosenHits, rows) };
}

function sigmoid(value) {
  const clipped = Math.max(-20, Math.min(20, value));
  return 1 / (1 + Math.exp(-clipped));
}

function onlineLogistic(devRows, testRows, learningRate, l2, rank) {
  const weights = Array(featureNames.length + 1).fill(0);
  const trainRow = (row) => {
    for (const digit of DIGITS) {
      const values = [1, ...row.matrix[digit]];
      const score = values.reduce(
        (sum, value, feature) => sum + value * weights[feature],
        0,
      );
      const target = Number(row.digits.includes(digit));
      const error = target - sigmoid(score);
      for (let feature = 0; feature < weights.length; feature += 1) {
        weights[feature] +=
          learningRate *
          (error * values[feature] - l2 * weights[feature]);
      }
    }
  };
  for (let epoch = 0; epoch < 3; epoch += 1) {
    for (const row of devRows) trainRow(row);
  }
  const predictions = [];
  const hits = [];
  for (const row of testRows) {
    const ranking = DIGITS.map((digit) => {
      const values = [1, ...row.matrix[digit]];
      return {
        digit,
        score: values.reduce(
          (sum, value, feature) => sum + value * weights[feature],
          0,
        ),
      };
    }).sort((left, right) => right.score - left.score || left.digit - right.digit);
    const dan = ranking[rank].digit;
    predictions.push(dan);
    hits.push(row.digits.includes(dan));
    trainRow(row);
  }
  return { predictions, hits, metrics: metrics(hits, testRows) };
}

async function fetchOfficial() {
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${TEST_END}` +
    "&pageNo=1&pageSize=2000&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/4.0)",
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
      !/^\d{7}$/.test(row.issue) ||
      row.digits.length !== 3 ||
      row.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)
    ) {
      invalidRows += 1;
    }
  }
  return {
    fetched: draws.length,
    duplicateIssues,
    duplicateDates,
    invalidRows,
    passed:
      duplicateIssues.length === 0 &&
      duplicateDates.length === 0 &&
      invalidRows === 0,
  };
}

async function main() {
  const { requestUrl, draws } = await fetchOfficial();
  const integrity = validate(draws);
  if (!integrity.passed) throw new Error(`integrity:${JSON.stringify(integrity)}`);

  const rows = [];
  for (let index = 120; index < draws.length; index += 1) {
    const draw = draws[index];
    if (draw.date < DEV_START || draw.date > TEST_END) continue;
    const history = draws.slice(0, index);
    rows.push({
      ...draw,
      matrix: featureMatrix(history),
      v2Dan: v2Dan(history),
    });
  }
  const dev = rows.filter((row) => row.date >= DEV_START && row.date <= DEV_END);
  const test = rows.filter((row) => row.date >= TEST_START && row.date <= TEST_END);
  if (dev.length < 400 || test.length < 1000) {
    throw new Error(`samples dev=${dev.length} test=${test.length}`);
  }

  const random = mulberry32(SEED);
  const finalists = [];
  for (let id = 0; id < CANDIDATES; id += 1) {
    const candidate = randomCandidate(random, id);
    const evaluated = candidateMetrics(dev, candidate);
    const entry = { ...candidate, dev: evaluated.metrics };
    if (finalists.length < KEEP || compareEntries(entry, finalists.at(-1)) < 0) {
      finalists.push(entry);
      finalists.sort(compareEntries);
      if (finalists.length > KEEP) finalists.pop();
    }
  }

  const staticSelected = finalists[0];
  const staticTest = candidateMetrics(test, staticSelected);
  const finalistTests = finalists.map((candidate) => ({
    candidate,
    evaluated: candidateMetrics(test, candidate),
  }));
  const retrospectiveBest = [...finalistTests].sort((left, right) =>
    compareMetrics(left.evaluated.metrics, right.evaluated.metrics),
  )[0];

  const onlineVariants = ONLINE_LOOKBACKS.map((lookback) => ({
    lookback,
    result: onlineSwitch(test, finalists.slice(0, ONLINE_LIBRARY), lookback),
  }));
  const onlineBest = [...onlineVariants].sort((left, right) =>
    compareMetrics(left.result.metrics, right.result.metrics),
  )[0];
  const voteVariants = VOTE_LOOKBACKS.flatMap((lookback) =>
    VOTE_SIZES.map((voteSize) => ({
      lookback,
      voteSize,
      result: onlineVote(
        test,
        finalists.slice(0, ONLINE_LIBRARY),
        lookback,
        voteSize,
      ),
    })),
  );
  const voteBest = [...voteVariants].sort((left, right) =>
    compareMetrics(left.result.metrics, right.result.metrics),
  )[0];
  const logisticVariants = [0.003, 0.01, 0.03, 0.08].flatMap((learningRate) =>
    [0, 0.0001, 0.001].flatMap((l2) =>
      [0, 1, 2, 3, 4, 5].map((rank) => ({
        learningRate,
        l2,
        rank,
        result: onlineLogistic(dev, test, learningRate, l2, rank),
      })),
    ),
  );
  const logisticBest = [...logisticVariants].sort((left, right) =>
    compareMetrics(left.result.metrics, right.result.metrics),
  )[0];

  const v2Predictions = test.map((row) => row.v2Dan);
  const v2Hits = test.map((row, index) =>
    row.digits.includes(v2Predictions[index]),
  );
  const group3Hits = test.map((row) => new Set(row.digits).size === 2);
  const group3Metrics = metrics(group3Hits, test);

  const methodResults = [
    {
      key: "v2-existing",
      label: "V2现行固定公式",
      predictions: v2Predictions,
      hits: v2Hits,
      metrics: metrics(v2Hits, test),
      selectionStatus: "prior-existing",
    },
    {
      key: "development-selected-static",
      label: "开发期选定静态公式",
      predictions: staticTest.predictions,
      hits: staticTest.hits,
      metrics: staticTest.metrics,
      selectionStatus: "independent",
      method: describe(staticSelected),
    },
    {
      key: "online-switching",
      label: `在线换法（回看${onlineBest.lookback}期）`,
      predictions: onlineBest.result.chosen.map((row) => row.dan),
      hits: onlineBest.result.hits,
      metrics: onlineBest.result.metrics,
      selectionStatus: "lookback-selected-after-comparison",
      lookback: onlineBest.lookback,
    },
    {
      key: "retrospective-best-static",
      label: "三年后验最优静态公式",
      predictions: retrospectiveBest.evaluated.predictions,
      hits: retrospectiveBest.evaluated.hits,
      metrics: retrospectiveBest.evaluated.metrics,
      selectionStatus: "backfit-not-independent",
      method: describe(retrospectiveBest.candidate),
    },
    {
      key: "online-voting",
      label: `多公式动态投票（回看${voteBest.lookback}期/前${voteBest.voteSize}法）`,
      predictions: voteBest.result.chosen,
      hits: voteBest.result.hits,
      metrics: voteBest.result.metrics,
      selectionStatus: "parameters-selected-after-comparison",
      lookback: voteBest.lookback,
      voteSize: voteBest.voteSize,
    },
    {
      key: "online-logistic",
      label: `滚动在线学习（学习率${logisticBest.learningRate}/第${logisticBest.rank + 1}名）`,
      predictions: logisticBest.result.predictions,
      hits: logisticBest.result.hits,
      metrics: logisticBest.result.metrics,
      selectionStatus: "parameters-selected-after-comparison",
      learningRate: logisticBest.learningRate,
      l2: logisticBest.l2,
      rank: logisticBest.rank + 1,
    },
  ];
  const adopted = [...methodResults].sort((left, right) =>
    compareMetrics(left.metrics, right.metrics),
  )[0];

  let danMissStreak = 0;
  let group3MissStreak = 0;
  const auditRows = test.map((row, index) => {
    danMissStreak = adopted.hits[index] ? 0 : danMissStreak + 1;
    group3MissStreak = group3Hits[index] ? 0 : group3MissStreak + 1;
    return {
      date: row.date,
      issue: row.issue,
      dan: adopted.predictions[index],
      draw: row.draw,
      danHit: adopted.hits[index],
      danMissStreak,
      group3Hit: group3Hits[index],
      group3MissStreak,
    };
  });
  const canonicalRaw = test
    .map((row) => `${row.date},${row.issue},${row.draw}`)
    .join("\n");

  const report = {
    version: "V4-three-year-search-1",
    createdAt: new Date().toISOString(),
    source: {
      provider: "中国福利彩票官网",
      requestUrl,
      integrity,
      canonicalTestDataSha256: createHash("sha256")
        .update(canonicalRaw, "utf8")
        .digest("hex"),
    },
    ranges: {
      development: { start: DEV_START, end: DEV_END, count: dev.length },
      threeYearTest: { start: TEST_START, end: TEST_END, count: test.length },
    },
    search: {
      seed: SEED,
      candidates: CANDIDATES,
      finalists: KEEP,
      onlineLibrary: ONLINE_LIBRARY,
      objective: "先压低最长连续未中，再提高命中率。",
      warning:
        "后验最优和在线回看窗口均比较过三年成绩，属于真实逐期回算但不是独立前瞻验证；每一期推荐本身只使用当期之前的数据。",
    },
    methods: methodResults.map(({ predictions, hits, ...method }) => method),
    adopted: {
      key: adopted.key,
      label: adopted.label,
      metrics: adopted.metrics,
      selectionStatus: adopted.selectionStatus,
      method: adopted.method ?? null,
      lookback: adopted.lookback ?? null,
      voteSize: adopted.voteSize ?? null,
      learningRate: adopted.learningRate ?? null,
      l2: adopted.l2 ?? null,
      rank: adopted.rank ?? null,
    },
    group3: {
      rule: "每日记录组三形态；开奖号三个数字中恰有两个不同数字即命中。",
      metrics: group3Metrics,
      limitation:
        "该口径每天都选择组三，命中次数和最长未中完全由实际形态决定，无法通过换号提高。",
    },
    rows: auditRows,
  };

  const csvRows = [
    ["日期", "期号", "独胆推荐", "开奖号", "独胆命中", "独胆连续未中", "组三命中", "组三连续未中"],
    ...auditRows.map((row) => [
      row.date,
      row.issue,
      row.dan,
      row.draw,
      row.danHit ? "中" : "未中",
      row.danMissStreak,
      row.group3Hit ? "中" : "未中",
      row.group3MissStreak,
    ]),
  ];

  await mkdir("scripts/results", { recursive: true });
  await mkdir("pages/audit", { recursive: true });
  await writeFile(
    "scripts/results/v4-three-year.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "pages/audit/v4-three-year-20230728-20260727.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "pages/audit/v4-three-year-20230728-20260727.csv",
    `\uFEFF${csvRows.map((row) => row.join(",")).join("\n")}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        integrity,
        ranges: report.ranges,
        methods: report.methods,
        adopted: report.adopted,
        group3: report.group3,
      },
      null,
      2,
    ),
  );
}

await main();
