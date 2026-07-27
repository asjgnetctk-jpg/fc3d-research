const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const TRAIN_START = "2026-02-01";
const TRAIN_END = "2026-02-28";
const TEST_START = "2026-03-01";
const TEST_END = "2026-07-27";
const WINDOWS = [5, 7, 10, 14, 20, 30, 45, 60];
const HALF_LIVES = [2, 3, 5, 8, 13];
const POSITION_WINDOWS = [10, 20, 30];
const SEED = 20260728;
const CANDIDATES = 60000;
const KEEP = 300;
const ONLINE_LIBRARY_SIZE = 1200;
const ONLINE_LOOKBACKS = [10, 15, 20, 30, 45, 60, 90, 999];

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
    (digit) => rows.filter((row) => new Set(row.digits).has(digit)).length / rows.length,
  );
}

function occurrence(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.reduce(
      (sum, row) => sum + row.digits.filter((value) => value === digit).length,
      0,
    ) / (rows.length * 3),
  );
}

function ewma(history, halfLife) {
  const decay = Math.exp(Math.log(0.5) / halfLife);
  const rows = history.slice(-60).reverse();
  const totals = Array(10).fill(0);
  let totalWeight = 0;
  rows.forEach((row, age) => {
    const weight = decay ** age;
    totalWeight += weight;
    const present = new Set(row.digits);
    for (const digit of DIGITS) {
      if (present.has(digit)) totals[digit] += weight;
    }
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

function positionPeak(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map((digit) => Math.max(
    ...[0, 1, 2].map(
      (position) => rows.filter((row) => row.digits[position] === digit).length / rows.length,
    ),
  ));
}

function lastPresence(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => row.digits.includes(digit)).length / rows.length,
  );
}

function neighborLast(history) {
  const last = new Set(history.at(-1).digits);
  return DIGITS.map(
    (digit) =>
      Number(last.has((digit + 9) % 10)) + Number(last.has((digit + 1) % 10)),
  );
}

function transitionScore(history) {
  const rows = history.slice(-80);
  const last = new Set(rows.at(-1).digits);
  const totals = Array(10).fill(0);
  const bases = Array(10).fill(0);
  for (let index = 1; index < rows.length; index += 1) {
    const previous = new Set(rows[index - 1].digits);
    const current = new Set(rows[index].digits);
    let overlap = 0;
    for (const value of last) if (previous.has(value)) overlap += 1;
    if (!overlap) continue;
    for (const digit of DIGITS) {
      bases[digit] += overlap;
      if (current.has(digit)) totals[digit] += overlap;
    }
  }
  return totals.map((value, digit) => (bases[digit] ? value / bases[digit] : 0));
}

const featureNames = [
  ...WINDOWS.map((window) => `presence${window}`),
  ...WINDOWS.map((window) => `occurrence${window}`),
  ...HALF_LIVES.map((halfLife) => `ewma${halfLife}`),
  "gap",
  ...POSITION_WINDOWS.map((window) => `positionPeak${window}`),
  "last1",
  "last2",
  "last3",
  "neighborLast",
  "transition80",
  "digitCenter",
  "digitParity",
];

function features(history) {
  const columns = [
    ...WINDOWS.map((window) => zscore(presence(history, window))),
    ...WINDOWS.map((window) => zscore(occurrence(history, window))),
    ...HALF_LIVES.map((halfLife) => zscore(ewma(history, halfLife))),
    zscore(gaps(history)),
    ...POSITION_WINDOWS.map((window) => zscore(positionPeak(history, window))),
    zscore(lastPresence(history, 1)),
    zscore(lastPresence(history, 2)),
    zscore(lastPresence(history, 3)),
    zscore(neighborLast(history)),
    zscore(transitionScore(history)),
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

function randomWeights(random) {
  const weights = featureNames.map(() => 0);
  const active = 3 + Math.floor(random() * 9);
  for (let index = 0; index < active; index += 1) {
    const feature = Math.floor(random() * weights.length);
    weights[feature] += [-2, -1, 1, 2][Math.floor(random() * 4)];
  }
  return weights;
}

function rankDigits(matrix, weights) {
  return DIGITS.map((digit) => ({
    digit,
    score: matrix[digit].reduce(
      (sum, value, feature) => sum + value * weights[feature],
      0,
    ),
  }))
    .sort((left, right) => right.score - left.score || left.digit - right.digit)
    .map((row) => row.digit);
}

function v1Recommend(history) {
  const freq14 = zscore(presence(history, 14));
  const freq30 = zscore(presence(history, 30));
  const freq60 = zscore(presence(history, 60));
  const recent = zscore(ewma(history, 5));
  const gap = zscore(gaps(history));
  const peak = zscore(positionPeak(history, 30));
  const danRanking = DIGITS.map((digit) => ({
    digit,
    score: -freq14[digit],
  })).sort((left, right) => right.score - left.score || left.digit - right.digit);
  const poolRanking = DIGITS.map((digit) => ({
    digit,
    score:
      freq30[digit] -
      freq60[digit] -
      recent[digit] -
      gap[digit] +
      peak[digit],
  })).sort((left, right) => right.score - left.score || left.digit - right.digit);
  return {
    dan: danRanking[1].digit,
    pool7: poolRanking.slice(0, 7).map((row) => row.digit),
  };
}

function metrics(hits) {
  let maxMiss = 0;
  let current = 0;
  let totalHits = 0;
  for (const hit of hits) {
    if (hit) {
      totalHits += 1;
      current = 0;
    } else {
      current += 1;
      maxMiss = Math.max(maxMiss, current);
    }
  }
  return { maxMiss, hits: totalHits, count: hits.length, rate: totalHits / hits.length };
}

function monthWorst(rows, hits) {
  const months = [...new Set(rows.map((row) => row.date.slice(0, 7)))];
  return Math.max(
    ...months.map((month) =>
      metrics(hits.filter((_, index) => rows[index].date.startsWith(month))).maxMiss,
    ),
  );
}

function evaluate(rows, weights, kind, danRank = 0) {
  const hits = rows.map((row) => {
    const ranking = rankDigits(row.featureMatrix, weights);
    const actual = new Set(row.digits);
    if (kind === "dan") return actual.has(ranking[danRank]);
    const pool = new Set(ranking.slice(0, 7));
    return actual.size === 3 && [...actual].every((digit) => pool.has(digit));
  });
  return { ...metrics(hits), monthWorst: monthWorst(rows, hits) };
}

function onlineEvaluate(allRows, testRows, library, kind, lookback) {
  const predictions = library.map((candidate) =>
    allRows.map((row) => {
      const ranking = rankDigits(row.featureMatrix, candidate.weights);
      const actual = new Set(row.digits);
      if (kind === "dan") return actual.has(ranking[candidate.danRank]);
      const pool = new Set(ranking.slice(0, 7));
      return actual.size === 3 && [...actual].every((digit) => pool.has(digit));
    }),
  );
  const cumulative = predictions.map((hits) => {
    const result = [0];
    for (const hit of hits) result.push(result.at(-1) + Number(hit));
    return result;
  });
  const testIssueSet = new Set(testRows.map((row) => row.issue));
  const selectedHits = [];
  const methodChanges = [];
  let previousMethod = -1;
  for (let rowIndex = 0; rowIndex < allRows.length; rowIndex += 1) {
    if (!testIssueSet.has(allRows[rowIndex].issue)) continue;
    const start = Math.max(0, rowIndex - lookback);
    let selected = 0;
    let bestRate = -1;
    let bestRecentHits = -1;
    for (let method = 0; method < library.length; method += 1) {
      const hits = cumulative[method][rowIndex] - cumulative[method][start];
      const rate = hits / Math.max(1, rowIndex - start);
      const recentStart = Math.max(start, rowIndex - 10);
      const recentHits =
        cumulative[method][rowIndex] - cumulative[method][recentStart];
      if (
        rate > bestRate ||
        (rate === bestRate && recentHits > bestRecentHits) ||
        (rate === bestRate && recentHits === bestRecentHits && method < selected)
      ) {
        selected = method;
        bestRate = rate;
        bestRecentHits = recentHits;
      }
    }
    selectedHits.push(predictions[selected][rowIndex]);
    if (selected !== previousMethod) methodChanges.push(selectedHits.length - 1);
    previousMethod = selected;
  }
  return {
    ...metrics(selectedHits),
    monthWorst: monthWorst(testRows, selectedHits),
    methodChanges: methodChanges.length,
  };
}

function describe(weights) {
  return weights
    .map((weight, index) => ({ feature: featureNames[index], weight }))
    .filter((row) => row.weight)
    .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight));
}

async function fetchDraws() {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    "?name=3d&dayStart=2025-10-01&dayEnd=2026-07-27&pageNo=1&pageSize=400&systemType=PC";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/2.0)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  return (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: item.code,
      digits: item.red.split(",").map(Number),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function insertTop(list, candidate) {
  list.push(candidate);
  list.sort(
    (left, right) =>
      left.train.maxMiss - right.train.maxMiss ||
      left.train.monthWorst - right.train.monthWorst ||
      right.train.hits - left.train.hits,
  );
  if (list.length > KEEP) list.pop();
}

async function main() {
  const draws = await fetchDraws();
  const rows = [];
  for (let index = 60; index < draws.length; index += 1) {
    const draw = draws[index];
    if (draw.date < TRAIN_START || draw.date > TEST_END) continue;
    const prior = draws.slice(0, index);
    rows.push({
      ...draw,
      featureMatrix: features(prior),
      v1: v1Recommend(prior),
    });
  }
  const train = rows.filter((row) => row.date >= TRAIN_START && row.date <= TRAIN_END);
  const test = rows.filter((row) => row.date >= TEST_START && row.date <= TEST_END);
  if (train.length < 15 || test.length < 140) {
    throw new Error(`样本不足：训练${train.length}，检验${test.length}`);
  }

  const random = mulberry32(SEED);
  const bestDan = [];
  const bestPool = [];
  const onlineDanLibrary = [];
  const onlinePoolLibrary = [];
  for (let candidate = 0; candidate < CANDIDATES; candidate += 1) {
    const danWeights = randomWeights(random);
    const danRank = Math.floor(random() * 4);
    if (candidate < ONLINE_LIBRARY_SIZE) {
      onlineDanLibrary.push({ weights: danWeights, danRank });
    }
    insertTop(bestDan, {
      weights: danWeights,
      danRank,
      train: evaluate(train, danWeights, "dan", danRank),
    });
    const poolWeights = randomWeights(random);
    if (candidate < ONLINE_LIBRARY_SIZE) {
      onlinePoolLibrary.push({ weights: poolWeights });
    }
    insertTop(bestPool, {
      weights: poolWeights,
      train: evaluate(train, poolWeights, "pool"),
    });
  }

  const danFinalists = bestDan.map((candidate) => ({
    ...candidate,
    test: evaluate(test, candidate.weights, "dan", candidate.danRank),
  }));
  const poolFinalists = bestPool.map((candidate) => ({
    ...candidate,
    test: evaluate(test, candidate.weights, "pool"),
  }));
  const strictDan = danFinalists[0];
  const strictPool = poolFinalists[0];
  danFinalists.sort(
    (left, right) =>
      left.test.maxMiss - right.test.maxMiss ||
      left.train.maxMiss - right.train.maxMiss ||
      right.test.hits - left.test.hits,
  );
  poolFinalists.sort(
    (left, right) =>
      left.test.maxMiss - right.test.maxMiss ||
      left.train.maxMiss - right.train.maxMiss ||
      right.test.hits - left.test.hits,
  );
  const online = ONLINE_LOOKBACKS.map((lookback) => ({
    lookback,
    dan: onlineEvaluate(rows, test, onlineDanLibrary, "dan", lookback),
    pool7: onlineEvaluate(rows, test, onlinePoolLibrary, "pool", lookback),
  })).sort(
    (left, right) =>
      right.dan.rate + right.pool7.rate - (left.dan.rate + left.pool7.rate) ||
      left.dan.maxMiss + left.pool7.maxMiss - (right.dan.maxMiss + right.pool7.maxMiss),
  );
  const v1DanHits = test.map((row) => new Set(row.digits).has(row.v1.dan));
  const v1PoolHits = test.map((row) => {
    const actual = new Set(row.digits);
    return actual.size === 3 && [...actual].every((digit) => row.v1.pool7.includes(digit));
  });

  const result = {
    seed: SEED,
    candidates: CANDIDATES,
    samples: { train: train.length, test: test.length },
    baselineV1: {
      dan: { ...metrics(v1DanHits), monthWorst: monthWorst(test, v1DanHits) },
      pool7: { ...metrics(v1PoolHits), monthWorst: monthWorst(test, v1PoolHits) },
    },
    strictIndependent: {
      dan: {
        danRank: strictDan.danRank,
        train: strictDan.train,
        test: strictDan.test,
        weights: describe(strictDan.weights),
      },
      pool7: {
        train: strictPool.train,
        test: strictPool.test,
        weights: describe(strictPool.weights),
      },
    },
    exploratoryNote:
      "以下结果从训练集前300名中再次按检验集表现排序，只能用于诊断，不再属于独立检验。",
    onlineDynamicSelection: {
      note:
        "每天仅使用当期之前的命中记录，在固定方法库中选择相应回看窗口内命中率最高的方法；列表按双项命中率之和排序。",
      librarySize: ONLINE_LIBRARY_SIZE,
      variants: online,
    },
    dan: danFinalists.slice(0, 10).map((candidate) => ({
      danRank: candidate.danRank,
      train: candidate.train,
      test: candidate.test,
      weights: describe(candidate.weights),
    })),
    pool7: poolFinalists.slice(0, 10).map((candidate) => ({
      train: candidate.train,
      test: candidate.test,
      weights: describe(candidate.weights),
    })),
  };
  console.log(JSON.stringify(result, null, 2));
}

await main();
