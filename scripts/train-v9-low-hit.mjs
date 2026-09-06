import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(
  await readFile(path.join(root, "scripts", "data", "fc3d-full-history.json"), "utf8"),
);
const rows = data.rows.map((row) => ({ ...row, digits: row.draw.split("").map(Number) }));
const TRAIN_END = process.env.V9_TRAIN_END ?? "2023-12-31";
const START_INDEX = 120;
const RANDOM_SAMPLES = Number(process.env.V9_RANDOM_SAMPLES ?? 2400);
const WINDOWS = [7, 14, 21, 30, 50, 80, 120, 200, 365, 730, 1200];

function combinations(values, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) {
    output.push([...prefix]);
    return output;
  }
  for (let index = start; index <= values.length - (size - prefix.length); index += 1) {
    prefix.push(values[index]);
    combinations(values, size, index + 1, prefix, output);
    prefix.pop();
  }
  return output;
}

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
    positionalSpread:
      Math.max(...positional[digit]) / Math.max(1, slice.length),
    gap: gap[digit] / Math.max(1, slice.length),
    last: index > 0 && rows[index - 1].digits.includes(digit) ? 1 : 0,
    transition: transition[digit] / Math.max(1, transitionWeight),
    sumTransition: sumTransition[digit] / Math.max(1, sumTransitionCount),
    exactTransition: exactTransition[digit] / Math.max(1, exactTransitionCount),
    neighbor: previousDigits.some((value) => Math.abs(value - digit) === 1) ? 1 : 0,
  }));
  featureCache.set(cacheKey, result);
  return result;
}

function rankPool(index, size, candidate) {
  if (candidate.family === "fixed") return candidate.pool;
  const features = featureTable(index, candidate.window);
  const scored = features.map((item) => ({
    digit: item.digit,
    score:
      candidate.occurrence * item.occurrence +
      candidate.presence * item.presence +
      candidate.spread * item.positionalSpread +
      candidate.gap * item.gap +
      candidate.last * item.last +
      (candidate.transition ?? 0) * item.transition +
      (candidate.sumTransition ?? 0) * item.sumTransition +
      (candidate.exactTransition ?? 0) * item.exactTransition +
      (candidate.neighbor ?? 0) * item.neighbor,
  }));
  scored.sort((left, right) => left.score - right.score || left.digit - right.digit);
  return scored.slice(0, size).map((item) => item.digit).sort((a, b) => a - b);
}

function hit(draw, pool) {
  const unique = [...new Set(draw.digits)];
  return unique.length === 3 && unique.every((digit) => pool.includes(digit));
}

function metrics(candidate, size, startIndex, endIndex) {
  let hits = 0;
  let miss = 0;
  let maxMiss = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    const pool = rankPool(index, size, candidate);
    if (hit(rows[index], pool)) {
      hits += 1;
      miss = 0;
    } else {
      miss += 1;
      maxMiss = Math.max(maxMiss, miss);
    }
  }
  return { count: endIndex - startIndex, hits, rate: hits / Math.max(1, endIndex - startIndex), maxMiss };
}

function candidateSet(size) {
  const candidates = combinations([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], size).map((pool) => ({
    family: "fixed",
    pool,
  }));
  let state = 0x9e3779b9 ^ size;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const pickWeight = () => [-3, -2, -1, 0, 1, 2, 3][Math.floor(random() * 7)];
  for (let sample = 0; sample < RANDOM_SAMPLES; sample += 1) {
    const occurrence = pickWeight();
    const presence = pickWeight();
    const gap = pickWeight();
    const last = pickWeight();
    candidates.push({
      family: "rolling-rank",
      window: WINDOWS[Math.floor(random() * WINDOWS.length)],
      occurrence,
      presence,
      spread: pickWeight(),
      gap,
      last,
      transition: pickWeight(),
      sumTransition: pickWeight(),
      exactTransition: pickWeight(),
      neighbor: pickWeight(),
    });
  }
  return candidates;
}

const trainEndIndex = rows.findIndex((row) => row.date > TRAIN_END);
const selected = {};
for (const size of [5, 6, 7, 8]) {
  let best = null;
  const candidates = candidateSet(size);
  for (const candidate of candidates) {
    const result = metrics(candidate, size, START_INDEX, trainEndIndex);
    if (
      !best ||
      result.rate < best.training.rate ||
      (result.rate === best.training.rate && result.maxMiss > best.training.maxMiss)
    ) {
      best = { candidate, training: result };
    }
  }
  best.validation = metrics(best.candidate, size, trainEndIndex, rows.length);
  best.all = metrics(best.candidate, size, START_INDEX, rows.length);
  selected[`pool${size}`] = best;
  console.log(
    `${size}码 train ${(best.training.rate * 100).toFixed(2)}% ` +
      `validation ${(best.validation.rate * 100).toFixed(2)}% all ${(best.all.rate * 100).toFixed(2)}%`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  version: "V9-low-hit-locked",
  objective: "minimize full-coverage hit rate",
  hitRule: "开奖号为组六，且三个不同数字全部包含在所选组合中",
  noCurrentAnswerLeakage: true,
  training: {
    startIssue: rows[START_INDEX].issue,
    startDate: rows[START_INDEX].date,
    endIssue: rows[trainEndIndex - 1].issue,
    endDate: rows[trainEndIndex - 1].date,
    count: trainEndIndex - START_INDEX,
  },
  validation: {
    startIssue: rows[trainEndIndex].issue,
    startDate: rows[trainEndIndex].date,
    endIssue: rows.at(-1).issue,
    endDate: rows.at(-1).date,
    count: rows.length - trainEndIndex,
  },
  selected,
};

await writeFile(
  path.join(root, "lib", "v9-low-hit-config.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(root, "scripts", "results", "v9-low-hit-training.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
