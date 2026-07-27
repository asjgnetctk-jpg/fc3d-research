import { mkdir, writeFile } from "node:fs/promises";

const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const FETCH_START = "2024-04-01";
const TRAIN_START = "2024-07-28";
const TRAIN_END = "2025-07-27";
const TEST_START = "2025-07-28";
const TEST_END = "2026-07-27";
const WINDOWS = [3, 5, 7, 10, 14, 20, 30, 45, 60, 90];
const HALF_LIVES = [2, 3, 5, 8, 13, 21];
const SEED = 20260728;
const CANDIDATES = 180000;
const KEEP = 500;

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

function ewma(history, halfLife) {
  const decay = Math.exp(Math.log(0.5) / halfLife);
  const rows = history.slice(-120).reverse();
  const totals = Array(10).fill(0);
  let totalWeight = 0;
  rows.forEach((row, age) => {
    const weight = decay ** age;
    totalWeight += weight;
    const seen = new Set(row.digits);
    for (const digit of DIGITS) if (seen.has(digit)) totals[digit] += weight;
  });
  return totals.map((value) => value / totalWeight);
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

function neighborLast(history) {
  const last = new Set(history.at(-1).digits);
  return DIGITS.map(
    (digit) =>
      Number(last.has((digit + 9) % 10)) + Number(last.has((digit + 1) % 10)),
  );
}

function transition(history, lookback) {
  const rows = history.slice(-lookback);
  const last = new Set(rows.at(-1).digits);
  const hits = Array(10).fill(0);
  let weightTotal = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = new Set(rows[index - 1].digits);
    let similarity = 0;
    for (const digit of last) if (previous.has(digit)) similarity += 1;
    if (!similarity) continue;
    weightTotal += similarity;
    const current = new Set(rows[index].digits);
    for (const digit of current) hits[digit] += similarity;
  }
  return hits.map((value) => (weightTotal ? value / weightTotal : 0));
}

const featureNames = [
  ...WINDOWS.map((window) => `presence${window}`),
  ...WINDOWS.map((window) => `occurrence${window}`),
  ...HALF_LIVES.map((halfLife) => `ewma${halfLife}`),
  "gap",
  ...[10, 20, 30, 60].flatMap((window) =>
    [0, 1, 2].map((position) => `position${position + 1}_${window}`),
  ),
  "last1",
  "last2",
  "last3",
  "neighborLast",
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
    ...HALF_LIVES.map((halfLife) => zscore(ewma(history, halfLife))),
    zscore(gaps(history)),
    ...[10, 20, 30, 60].flatMap((window) =>
      [0, 1, 2].map((position) =>
        zscore(positionFrequency(history, window, position)),
      ),
    ),
    zscore(presence(history, 1)),
    zscore(presence(history, 2)),
    zscore(presence(history, 3)),
    zscore(neighborLast(history)),
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

function randomCandidate(random) {
  const weights = Array(featureNames.length).fill(0);
  const active = 2 + Math.floor(random() * 10);
  for (let index = 0; index < active; index += 1) {
    const feature = Math.floor(random() * weights.length);
    weights[feature] += [-3, -2, -1, 1, 2, 3][Math.floor(random() * 6)];
  }
  return {
    weights,
    rank: Math.floor(random() * 6),
  };
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

function hitSeries(rows, candidate) {
  return rows.map((row) => row.digits.includes(pick(row.featureMatrix, candidate)));
}

function metrics(hits) {
  let hitsCount = 0;
  let currentMiss = 0;
  let maxMiss = 0;
  let maxStart = 0;
  let currentStart = 0;
  hits.forEach((hit, index) => {
    if (hit) {
      hitsCount += 1;
      currentMiss = 0;
    } else {
      if (currentMiss === 0) currentStart = index;
      currentMiss += 1;
      if (currentMiss > maxMiss) {
        maxMiss = currentMiss;
        maxStart = currentStart;
      }
    }
  });
  return {
    count: hits.length,
    hits: hitsCount,
    rate: hitsCount / hits.length,
    maxMiss,
    maxMissStartIndex: maxStart,
    maxMissEndIndex: maxStart + maxMiss - 1,
  };
}

function segmentWorst(hits, size = 90) {
  let worst = 0;
  for (let start = 0; start < hits.length; start += size) {
    worst = Math.max(worst, metrics(hits.slice(start, start + size)).maxMiss);
  }
  return worst;
}

function trainMetrics(rows, candidate) {
  const hits = hitSeries(rows, candidate);
  const overall = metrics(hits);
  return {
    ...overall,
    segmentWorst: segmentWorst(hits),
    firstHalfMaxMiss: metrics(hits.slice(0, Math.floor(hits.length / 2))).maxMiss,
    secondHalfMaxMiss: metrics(hits.slice(Math.floor(hits.length / 2))).maxMiss,
  };
}

function compare(left, right) {
  return (
    left.train.maxMiss - right.train.maxMiss ||
    left.train.segmentWorst - right.train.segmentWorst ||
    Math.max(left.train.firstHalfMaxMiss, left.train.secondHalfMaxMiss) -
      Math.max(right.train.firstHalfMaxMiss, right.train.secondHalfMaxMiss) ||
    right.train.hits - left.train.hits ||
    left.id - right.id
  );
}

function describe(candidate) {
  return {
    rank: candidate.rank + 1,
    weights: candidate.weights
      .map((weight, index) => ({ feature: featureNames[index], weight }))
      .filter((row) => row.weight),
  };
}

async function fetchDraws() {
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${TEST_END}` +
    "&pageNo=1&pageSize=1000&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/3.0)",
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
  return { draws, requestUrl };
}

function integrity(draws) {
  const duplicateIssues = draws
    .filter((row, index) => draws.findIndex((other) => other.issue === row.issue) !== index)
    .map((row) => row.issue);
  const invalid = draws.filter(
    (row) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !/^\d+$/.test(row.issue) ||
      row.digits.length !== 3 ||
      row.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9),
  );
  return {
    fetchedCount: draws.length,
    duplicateIssues: [...new Set(duplicateIssues)],
    invalidRows: invalid.length,
    passed: duplicateIssues.length === 0 && invalid.length === 0,
  };
}

async function main() {
  const { draws, requestUrl } = await fetchDraws();
  const checked = integrity(draws);
  if (!checked.passed) throw new Error(`integrity-failed:${JSON.stringify(checked)}`);

  const rows = [];
  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    if (row.date < TRAIN_START || row.date > TEST_END) continue;
    rows.push({
      ...row,
      featureMatrix: featureMatrix(draws.slice(0, index)),
    });
  }
  const train = rows.filter((row) => row.date >= TRAIN_START && row.date <= TRAIN_END);
  const test = rows.filter((row) => row.date >= TEST_START && row.date <= TEST_END);
  if (train.length < 300 || test.length < 300) {
    throw new Error(`insufficient-samples train=${train.length} test=${test.length}`);
  }

  const random = mulberry32(SEED);
  const finalists = [];
  for (let id = 0; id < CANDIDATES; id += 1) {
    const candidate = { id, ...randomCandidate(random) };
    const entry = { ...candidate, train: trainMetrics(train, candidate) };
    if (finalists.length < KEEP || compare(entry, finalists.at(-1)) < 0) {
      finalists.push(entry);
      finalists.sort(compare);
      if (finalists.length > KEEP) finalists.pop();
    }
  }

  const selected = finalists[0];
  const selectedTestPredictions = test.map((row) => pick(row.featureMatrix, selected));
  const selectedTestHits = test.map((row, index) =>
    row.digits.includes(selectedTestPredictions[index]),
  );
  const selectedTest = metrics(selectedTestHits);
  let selectedMissStreak = 0;
  const selectedTestRows = test.map((row, index) => {
    selectedMissStreak = selectedTestHits[index] ? 0 : selectedMissStreak + 1;
    return {
      date: row.date,
      issue: row.issue,
      dan: selectedTestPredictions[index],
      draw: row.draw,
      hit: selectedTestHits[index],
      missStreak: selectedMissStreak,
    };
  });
  const longestRows = test.slice(
    selectedTest.maxMissStartIndex,
    selectedTest.maxMissEndIndex + 1,
  );
  const diagnosticFinalists = finalists.map((candidate) => ({
    id: candidate.id,
    train: candidate.train,
    test: metrics(hitSeries(test, candidate)),
    method: describe(candidate),
  }));
  const exploratoryBest = [...diagnosticFinalists].sort(
    (left, right) =>
      left.test.maxMiss - right.test.maxMiss ||
      right.test.hits - left.test.hits ||
      compare(left, right),
  )[0];

  const result = {
    version: "V3-independent-search-1",
    createdAt: new Date().toISOString(),
    source: {
      provider: "中国福利彩票官网",
      requestUrl,
      integrity: checked,
    },
    protocol: {
      seed: SEED,
      candidates: CANDIDATES,
      finalistCount: KEEP,
      trainingRange: { start: TRAIN_START, end: TRAIN_END, count: train.length },
      untouchedTestRange: { start: TEST_START, end: TEST_END, count: test.length },
      selectionRule:
        "只按训练期最长连续未中、分段稳定性、命中数排序选出唯一公式，再原封不动检验后一整年。",
    },
    selected: {
      method: describe(selected),
      train: selected.train,
      test: {
        ...selectedTest,
        longestMiss:
          longestRows.length > 0
            ? {
                length: selectedTest.maxMiss,
                startIssue: longestRows[0].issue,
                startDate: longestRows[0].date,
                endIssue: longestRows.at(-1).issue,
                endDate: longestRows.at(-1).date,
              }
            : null,
      },
      testRows: selectedTestRows,
    },
    diagnosticOnly: {
      warning:
        "以下项目查看测试期后才知道，只用于诊断，不得替代上方预先选定公式，也不得作为独立检验成绩。",
      bestAmongTrainingFinalistsAfterLookingAtTest: exploratoryBest,
    },
  };

  await mkdir("scripts/results", { recursive: true });
  await mkdir("pages/audit", { recursive: true });
  await writeFile(
    "scripts/results/v3-independent-year.json",
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "pages/audit/v3-independent-dan-20250728-20260727.json",
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  const csvRows = [
    ["日期", "期号", "独胆推荐", "开奖号", "命中", "连续未中"],
    ...selectedTestRows.map((row) => [
      row.date,
      row.issue,
      row.dan,
      row.draw,
      row.hit ? "中" : "未中",
      row.missStreak,
    ]),
  ];
  await writeFile(
    "pages/audit/v3-independent-dan-20250728-20260727.csv",
    `\uFEFF${csvRows.map((row) => row.join(",")).join("\n")}\n`,
    "utf8",
  );
  console.log(JSON.stringify(result, null, 2));
}

await main();
