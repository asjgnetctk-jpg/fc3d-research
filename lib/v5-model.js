const DIGITS = Array.from({ length: 10 }, (_, index) => index);

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

function historyHash(history, channel) {
  let seed = (2166136261 ^ Math.imul(channel + 1, 0x9e3779b1)) >>> 0;
  for (const row of history.slice(-12)) {
    for (const digit of row.digits) {
      seed = Math.imul(seed ^ (digit + 17), 16777619) >>> 0;
    }
  }
  return zscore(
    DIGITS.map((digit) => {
      let value =
        (seed ^ Math.imul(digit + 1, 0x85ebca6b) ^ Math.imul(channel + 3, 0xc2b2ae35)) >>>
        0;
      value ^= value >>> 16;
      value = Math.imul(value, 0x7feb352d) >>> 0;
      value ^= value >>> 15;
      value = Math.imul(value, 0x846ca68b) >>> 0;
      value ^= value >>> 16;
      return value / 4294967296;
    }),
  );
}

export function featureColumns(history) {
  const output = {};
  for (const window of [3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120]) {
    output[`presence${window}`] = zscore(presence(history, window));
    output[`occurrence${window}`] = zscore(occurrence(history, window));
  }
  output.gap = zscore(gaps(history));
  for (const window of [10, 20, 30, 60]) {
    for (let position = 0; position < 3; position += 1) {
      output[`position${position + 1}_${window}`] = zscore(
        positionFrequency(history, window, position),
      );
    }
  }
  output.last1 = zscore(presence(history, 1));
  output.last2 = zscore(presence(history, 2));
  output.last3 = zscore(presence(history, 3));
  output.transition30 = zscore(transition(history, 30));
  output.transition60 = zscore(transition(history, 60));
  output.transition120 = zscore(transition(history, 120));
  output.digitCenter = zscore(DIGITS.map((digit) => -Math.abs(digit - 4.5)));
  output.digitParity = zscore(DIGITS.map((digit) => digit % 2));
  for (let channel = 0; channel < 12; channel += 1) {
    output[`historyHash${channel}`] = historyHash(history, channel);
  }
  return output;
}

export function rankDigits(columns, method) {
  return DIGITS.map((digit) => ({
    digit,
    score: Object.entries(method.weights).reduce(
      (sum, [feature, weight]) => sum + columns[feature][digit] * weight,
      0,
    ),
  })).sort((left, right) => right.score - left.score || left.digit - right.digit);
}

function streakBucket(missStreak, methodCount = 4) {
  if (methodCount > 4) return Math.min(missStreak, methodCount - 1);
  return missStreak < 3 ? 0 : missStreak < 5 ? 1 : missStreak < 7 ? 2 : 3;
}

export function actualShape(digits) {
  const unique = new Set(digits).size;
  return unique === 1 ? "豹子" : unique === 2 ? "组三" : "组六";
}

function shapeGap(history, target) {
  for (let age = 0; age < history.length; age += 1) {
    if (actualShape(history[history.length - 1 - age].digits) === target) return age;
  }
  return history.length;
}

export function shapeFeatures(history) {
  const shapeWindows = [3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120];
  const shapeRate = (window, target) => {
    const rows = history.slice(-window);
    return rows.filter((row) => actualShape(row.digits) === target).length / rows.length;
  };
  const average = (rows, selector) =>
    rows.reduce((sum, row) => sum + selector(row), 0) / rows.length;
  const last = history.at(-1);
  const last2 = history.slice(-2);
  const recent10 = history.slice(-10);
  const recent30 = history.slice(-30);
  return {
    ...Object.fromEntries(
      shapeWindows.map((window) => [
        `group3Rate${window}`,
        shapeRate(window, "组三"),
      ]),
    ),
    ...Object.fromEntries(
      shapeWindows.map((window) => [
        `group6Rate${window}`,
        shapeRate(window, "组六"),
      ]),
    ),
    group3Gap: Math.min(shapeGap(history, "组三"), 60) / 60,
    group6Gap: Math.min(shapeGap(history, "组六"), 60) / 60,
    lastGroup3: Number(actualShape(last.digits) === "组三"),
    lastGroup6: Number(actualShape(last.digits) === "组六"),
    last2Group3:
      last2.filter((row) => actualShape(row.digits) === "组三").length / 2,
    last2Group6:
      last2.filter((row) => actualShape(row.digits) === "组六").length / 2,
    recentRepeatRate10: average(
      recent10,
      (row) => Number(new Set(row.digits).size < 3),
    ),
    recentRepeatRate30: average(
      recent30,
      (row) => Number(new Set(row.digits).size < 3),
    ),
    recentSpan10:
      average(
        recent10,
        (row) => Math.max(...row.digits) - Math.min(...row.digits),
      ) / 9,
    recentSpan30:
      average(
        recent30,
        (row) => Math.max(...row.digits) - Math.min(...row.digits),
      ) / 9,
    recentSum10:
      average(
        recent10,
        (row) => row.digits.reduce((sum, digit) => sum + digit, 0),
      ) / 27,
    recentSum30:
      average(
        recent30,
        (row) => row.digits.reduce((sum, digit) => sum + digit, 0),
      ) / 27,
  };
}

export function recommendV5(history, danMissStreak, pool7MissStreak, config) {
  const columns = featureColumns(history);
  const danMethod =
    config.dan.methods[streakBucket(danMissStreak, config.dan.methods.length)];
  const poolMethod =
    config.pool7.methods[
      streakBucket(pool7MissStreak, config.pool7.methods.length)
    ];
  const danRanking = rankDigits(columns, danMethod);
  const poolRanking = rankDigits(columns, poolMethod);
  const features = shapeFeatures(history);
  const shapeScore = Object.entries(config.shapeChoice.weights).reduce(
    (sum, [feature, weight]) => sum + features[feature] * weight,
    0,
  );
  return {
    dan: danRanking[danMethod.rank - 1].digit,
    pool7: poolRanking.slice(0, 7).map((row) => row.digit).sort((a, b) => a - b),
    shapePlay: shapeScore >= config.shapeChoice.threshold ? "组三" : "组六",
    shapeScore,
  };
}

export function recommendPool(history, missStreak, methods, poolSize) {
  const columns = featureColumns(history);
  const method = methods[streakBucket(missStreak, methods.length)];
  return rankDigits(columns, method)
    .slice(0, poolSize)
    .map((row) => row.digit)
    .sort((left, right) => left - right);
}

export function group3Probability(shapeScore, calibrationRows) {
  const priorMean = 0.27;
  const priorStrength = 100;
  if (!calibrationRows.length) return priorMean;

  const nearest = calibrationRows
    .slice(-1200)
    .map((row) => ({
      ...row,
      distance: Math.abs(row.score - shapeScore),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.min(160, calibrationRows.length));

  let weightedHits = 0;
  let totalWeight = 0;
  for (const row of nearest) {
    const weight = 1 / (1 + row.distance);
    weightedHits += Number(row.group3) * weight;
    totalWeight += weight;
  }

  return (priorMean * priorStrength + weightedHits) / (priorStrength + totalWeight);
}

export function group3Decision(probability) {
  return probability >= 0.27;
}
