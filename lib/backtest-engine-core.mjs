export const WINDOWS = [7, 14, 21, 30, 50, 80, 120, 200, 365, 730, 1200];
export const WEIGHTS = [-3, -2, -1, 0, 1, 2, 3];
export const FEATURE_NAMES = [
  "occurrence", "presence", "spread", "gap", "last",
  "transition", "sumTransition", "exactTransition", "neighbor",
];
export const FORMULAS_PER_SIZE = WINDOWS.length * WEIGHTS.length ** FEATURE_NAMES.length;

export function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}

export function permutationParameters(seed, modulus = FORMULAS_PER_SIZE) {
  let multiplier = ((Number(seed) >>> 0) * 2 + 1) % modulus;
  while (gcd(multiplier, modulus) !== 1) multiplier = (multiplier + 2) % modulus;
  return { multiplier, offset: ((Number(seed) >>> 0) * 2654435761) % modulus };
}

export function formulaFromIndex(rawIndex) {
  let index = Number(rawIndex);
  const window = WINDOWS[index % WINDOWS.length];
  index = Math.floor(index / WINDOWS.length);
  const candidate = { family: "rolling-rank", window };
  for (const name of FEATURE_NAMES) {
    candidate[name] = WEIGHTS[index % WEIGHTS.length];
    index = Math.floor(index / WEIGHTS.length);
  }
  return candidate;
}

export function formulaForSample(sample, seed, mode = "random") {
  if (mode === "exhaustive") return formulaFromIndex(sample % FORMULAS_PER_SIZE);
  const { multiplier, offset } = permutationParameters(seed);
  const index = (Number((BigInt(multiplier) * BigInt(sample) + BigInt(offset)) % BigInt(FORMULAS_PER_SIZE)));
  return formulaFromIndex(index);
}

export function prepareRows(snapshot) {
  return snapshot.rows.map((row) => ({
    ...row,
    digits: (row.digits ?? row.draw.split("").map(Number)).map(Number),
  }));
}

export function createEvaluator(rows) {
  const featureCache = new Map();

  function featureTable(index, window) {
    const cacheKey = `${index}:${window}`;
    if (featureCache.has(cacheKey)) return featureCache.get(cacheKey);
    const start = Math.max(0, index - window);
    const slice = rows.slice(start, index);
    const occurrence = Array(10).fill(0);
    const presence = Array(10).fill(0);
    const positional = Array.from({ length: 10 }, () => [0, 0, 0]);
    const transition = Array(10).fill(0);
    const sumTransition = Array(10).fill(0);
    const exactTransition = Array(10).fill(0);
    let transitionWeight = 0;
    let sumTransitionCount = 0;
    let exactTransitionCount = 0;
    for (const row of slice) {
      const seen = new Set();
      row.digits.forEach((digit, position) => {
        occurrence[digit] += 1;
        positional[digit][position] += 1;
        seen.add(digit);
      });
      for (const digit of seen) presence[digit] += 1;
    }
    const gap = Array(10).fill(slice.length + 1);
    for (let cursor = index - 1; cursor >= start; cursor -= 1) {
      const distance = index - cursor;
      for (const digit of new Set(rows[cursor].digits)) {
        if (gap[digit] === slice.length + 1) gap[digit] = distance;
      }
    }
    const previousDigits = index > 0 ? rows[index - 1].digits : [];
    const previousSet = new Set(previousDigits);
    const previousSumClass = previousDigits.reduce((sum, digit) => sum + digit, 0) % 10;
    const previousSignature = [...previousDigits].sort((a, b) => a - b).join("");
    for (let cursor = Math.max(1, start); cursor < index; cursor += 1) {
      const source = rows[cursor - 1];
      const overlap = [...new Set(source.digits)].filter((digit) => previousSet.has(digit)).length;
      const nextDigits = new Set(rows[cursor].digits);
      if (overlap) {
        transitionWeight += overlap;
        for (const digit of nextDigits) transition[digit] += overlap;
      }
      if (source.digits.reduce((sum, digit) => sum + digit, 0) % 10 === previousSumClass) {
        sumTransitionCount += 1;
        for (const digit of nextDigits) sumTransition[digit] += 1;
      }
      if ([...source.digits].sort((a, b) => a - b).join("") === previousSignature) {
        exactTransitionCount += 1;
        for (const digit of nextDigits) exactTransition[digit] += 1;
      }
    }
    const result = Array.from({ length: 10 }, (_, digit) => ({
      digit,
      occurrence: occurrence[digit] / Math.max(1, slice.length * 3),
      presence: presence[digit] / Math.max(1, slice.length),
      spread: Math.max(...positional[digit]) / Math.max(1, slice.length),
      gap: gap[digit] / Math.max(1, slice.length),
      last: previousDigits.includes(digit) ? 1 : 0,
      transition: transition[digit] / Math.max(1, transitionWeight),
      sumTransition: sumTransition[digit] / Math.max(1, sumTransitionCount),
      exactTransition: exactTransition[digit] / Math.max(1, exactTransitionCount),
      neighbor: previousDigits.some((value) => Math.abs(value - digit) === 1) ? 1 : 0,
    }));
    featureCache.set(cacheKey, result);
    return result;
  }

  function pool(index, size, candidate) {
    if (candidate.family === "fixed") return candidate.pool;
    const ranked = featureTable(index, candidate.window).map((item) => ({
      digit: item.digit,
      score: FEATURE_NAMES.reduce((sum, name) => sum + candidate[name] * item[name], 0),
    }));
    ranked.sort((left, right) => left.score - right.score || left.digit - right.digit);
    return ranked.slice(0, size).map((item) => item.digit).sort((a, b) => a - b);
  }

  function metrics(candidate, size, startIndex, endIndex) {
    let hits = 0;
    let miss = 0;
    let maxMiss = 0;
    for (let index = startIndex; index < endIndex; index += 1) {
      const selected = pool(index, size, candidate);
      const unique = [...new Set(rows[index].digits)];
      const hit = unique.length === 3 && unique.every((digit) => selected.includes(digit));
      if (hit) {
        hits += 1;
        miss = 0;
      } else {
        miss += 1;
        maxMiss = Math.max(maxMiss, miss);
      }
    }
    const count = endIndex - startIndex;
    return { count, hits, misses: count - hits, rate: hits / Math.max(1, count), maxMiss };
  }

  return { metrics, pool };
}

export function compareLowHit(left, right) {
  return left.metrics.rate - right.metrics.rate || right.metrics.maxMiss - left.metrics.maxMiss;
}
