import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VARIANT = process.env.V9_VARIANT ?? "v9";
const CONFIG_NAME = process.env.V9_CONFIG_NAME ?? "v9-low-hit-config.json";
const RESULT_NAME = process.env.V9_RESULT_NAME ?? "v9-low-hit-training.json";
const DATA_NAME = `${VARIANT}-data.json`;
const PAGE_NAME = `${VARIANT}.html`;
const AUDIT_NAME = process.env.V9_AUDIT_NAME ??
  (VARIANT === "v9" ? "v9-low-hit-training.json" : `${VARIANT}-training.json`);
const snapshot = JSON.parse(
  await readFile(path.join(root, "scripts", "data", "fc3d-full-history.json"), "utf8"),
);
const config = JSON.parse(
  await readFile(path.join(root, "lib", CONFIG_NAME), "utf8"),
);
const draws = snapshot.rows.map((row) => ({
  ...row,
  digits: row.draw.split("").map(Number),
}));

function featureTable(index, window) {
  const start = Math.max(0, index - window);
  const slice = draws.slice(start, index);
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
    for (const digit of new Set(draws[cursor].digits)) {
      if (gap[digit] === slice.length + 1) gap[digit] = distance;
    }
  }
  const previousDigits = index > 0 ? draws[index - 1].digits : [];
  const previousSet = new Set(previousDigits);
  const previousSumClass = previousDigits.reduce((sum, digit) => sum + digit, 0) % 10;
  const previousSignature = [...previousDigits].sort((a, b) => a - b).join("");
  for (let cursor = Math.max(1, start); cursor < index; cursor += 1) {
    const source = draws[cursor - 1];
    const overlap = [...new Set(source.digits)].filter((digit) => previousSet.has(digit)).length;
    const nextDigits = new Set(draws[cursor].digits);
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
  return Array.from({ length: 10 }, (_, digit) => ({
    digit,
    occurrence: occurrence[digit] / Math.max(1, slice.length * 3),
    presence: presence[digit] / Math.max(1, slice.length),
    positionalSpread: Math.max(...positional[digit]) / Math.max(1, slice.length),
    gap: gap[digit] / Math.max(1, slice.length),
    last: index > 0 && draws[index - 1].digits.includes(digit) ? 1 : 0,
    transition: transition[digit] / Math.max(1, transitionWeight),
    sumTransition: sumTransition[digit] / Math.max(1, sumTransitionCount),
    exactTransition: exactTransition[digit] / Math.max(1, exactTransitionCount),
    neighbor: previousDigits.some((value) => Math.abs(value - digit) === 1) ? 1 : 0,
  }));
}

function recommend(index, size, candidate) {
  if (candidate.family === "fixed") return candidate.pool;
  return featureTable(index, candidate.window)
    .map((item) => ({
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
    }))
    .sort((left, right) => left.score - right.score || left.digit - right.digit)
    .slice(0, size)
    .map((item) => item.digit)
    .sort((a, b) => a - b);
}

function hit(draw, pool) {
  const unique = [...new Set(draw.digits)];
  return unique.length === 3 && unique.every((digit) => pool.includes(digit));
}

function group3Covered(draw, pool) {
  const unique = [...new Set(draw.digits)];
  return unique.length === 2 && unique.every((digit) => pool.includes(digit));
}

function incrementIssue(issue) {
  const year = issue.slice(0, 4);
  const sequence = Number(issue.slice(4)) + 1;
  return `${year}${String(sequence).padStart(3, "0")}`;
}

function metric(rows, key) {
  let hits = 0;
  let miss = 0;
  let maxMiss = 0;
  for (const row of rows) {
    if (row[key]) {
      hits += 1;
      miss = 0;
    } else {
      miss += 1;
      maxMiss = Math.max(maxMiss, miss);
    }
  }
  return {
    count: rows.length,
    hits,
    misses: rows.length - hits,
    rate: hits / Math.max(1, rows.length),
    maxMiss,
    currentMiss: miss,
  };
}

function group3Metric(rows, key) {
  const group3Rows = rows.filter((row) => new Set(row.draw).size === 2);
  const covered = group3Rows.filter((row) => row[key]).length;
  return {
    count: group3Rows.length,
    covered,
    rate: covered / Math.max(1, group3Rows.length),
  };
}

const historyStartDate = config.historyStartDate ?? config.training.startDate;
const startIndex = draws.findIndex((row) => row.date >= historyStartDate);
const missStreak = { pool5: 0, pool6: 0, pool7: 0, pool8: 0 };
const history = [];
for (let index = startIndex; index < draws.length; index += 1) {
  const draw = draws[index];
  const output = { issue: draw.issue, date: draw.date, draw: draw.draw };
  for (const size of [5, 6, 7, 8]) {
    const key = `pool${size}`;
    const pool = recommend(index, size, config.selected[key].candidate);
    const isHit = hit(draw, pool);
    const isGroup3Covered = group3Covered(draw, pool);
    missStreak[key] = isHit ? 0 : missStreak[key] + 1;
    output[key] = pool.join("");
    output[`${key}Hit`] = isHit;
    output[`${key}Group3Covered`] = isGroup3Covered;
    output[`${key}MissStreak`] = missStreak[key];
  }
  history.push(output);
}

const latest = draws.at(-1);
const upcoming = {};
for (const size of [5, 6, 7, 8]) {
  const key = `pool${size}`;
  upcoming[key] = recommend(draws.length, size, config.selected[key].candidate).join("");
}
const validationRows = history.filter((row) => row.date >= config.validation.startDate);
const oneYearStart = new Date(`${latest.date}T00:00:00Z`);
oneYearStart.setUTCFullYear(oneYearStart.getUTCFullYear() - 1);
const recentRows = history.filter((row) => row.date >= oneYearStart.toISOString().slice(0, 10));
const metrics = {};
for (const size of [5, 6, 7, 8]) {
  const key = `pool${size}`;
  metrics[key] = {
    all: metric(history, `${key}Hit`),
    validation: metric(validationRows, `${key}Hit`),
    recentOneYear: metric(recentRows, `${key}Hit`),
    group3: {
      all: group3Metric(history, `${key}Group3Covered`),
      validation: group3Metric(validationRows, `${key}Group3Covered`),
      recentOneYear: group3Metric(recentRows, `${key}Group3Covered`),
    },
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  formulaVersion: config.version,
  sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
  targetIssue: incrementIssue(latest.issue),
  basedOnIssue: latest.issue,
  basedOnDate: latest.date,
  objective: "在不读取当期开奖的前提下，尽量降低组六全覆盖命中率",
  hitRule: config.hitRule,
  training: config.training,
  selection: config.selection ?? null,
  validation: config.validation,
  historyStartDate,
  dataSha256: snapshot.canonicalSha256,
  methods: Object.fromEntries(
    [5, 6, 7, 8].map((size) => [
      `pool${size}`,
      config.selected[`pool${size}`].candidate,
    ]),
  ),
  randomBaselines: { pool5: 0.06, pool6: 0.12, pool7: 0.21, pool8: 0.336 },
  recommendation: upcoming,
  history,
  metrics,
};

await mkdir(path.join(root, "pages", "audit"), { recursive: true });
await mkdir(path.join(root, "public", "audit"), { recursive: true });
await mkdir(path.join(root, "public", "assets"), { recursive: true });
for (const folder of ["pages", "public"]) {
  await writeFile(
    path.join(root, folder, DATA_NAME),
    `${JSON.stringify(payload)}\n`,
    "utf8",
  );
}
await copyFile(
  path.join(root, "scripts", "results", RESULT_NAME),
  path.join(root, "pages", "audit", AUDIT_NAME),
);
await copyFile(
  path.join(root, "pages", "audit", AUDIT_NAME),
  path.join(root, "public", "audit", AUDIT_NAME),
);
await copyFile(path.join(root, "pages", PAGE_NAME), path.join(root, "public", PAGE_NAME));
await copyFile(
  path.join(root, "pages", "assets", "v9.js"),
  path.join(root, "public", "assets", "v9.js"),
);

console.log(
  `Generated ${config.version} for ${latest.issue}: ` +
    [5, 6, 7, 8].map((size) => `${size}码 ${upcoming[`pool${size}`]}`).join(" · "),
);
