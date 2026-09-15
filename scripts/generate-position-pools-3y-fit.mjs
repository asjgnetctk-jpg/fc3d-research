import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payload = JSON.parse(await readFile(path.join(root, "scripts/data/fc3d-full-history.json"), "utf8"));
const draws = payload.rows;
const latest = draws.at(-1);
const config = JSON.parse(await readFile(path.join(root, "scripts/config/fc3d-position-pools-3y-fit.json"), "utf8"));
const start = config.fitStart;
const end = config.fitEnd;
const positions = ["hundreds", "tens", "units"];

function incrementIssue(issue) { return String(Number(issue) + 1).padStart(issue.length, "0"); }
function contextAt(index, position) { return draws.slice(index - 3, index).map((row) => row.digits[position]).join(""); }
function rankDigits(rows, fallback = Array.from({ length: 10 }, (_, digit) => digit)) {
  const counts = Array(10).fill(0);
  for (const row of rows) counts[row.actual]++;
  return Array.from({ length: 10 }, (_, digit) => digit)
    .sort((a, b) => counts[b] - counts[a] || fallback.indexOf(a) - fallback.indexOf(b));
}
function metric(rows, key) {
  let hits = 0, streak = 0, maxMiss = 0;
  for (const row of rows) {
    if (row[key]) { hits++; streak = 0; } else { streak++; maxMiss = Math.max(maxMiss, streak); }
  }
  return { count: rows.length, hits, rate: hits / rows.length, maxMiss, currentMiss: streak };
}

function trainPosition(size, position) {
  const rows = [];
  for (let index = 3; index < draws.length; index++) {
    const draw = draws[index];
    if (draw.date < start) continue;
    rows.push({ index, issue: draw.issue, date: draw.date, draw: draw.draw, actual: draw.digits[position] });
  }
  const saved = config.formula.byPoolSize[size][positions[position]];
  const fallback = [...saved.fallbackOrder].map(Number);
  const tables = new Map(Object.entries(saved.transitionPools).map(([context, value]) => [context, [...value].map(Number)]));
  const history = rows.map((row) => {
    const pool = tables.get(contextAt(row.index, position)) ?? fallback.slice(0, size).sort((a, b) => a - b);
    return { issue: row.issue, date: row.date, draw: row.draw, pool: pool.join(""), hit: pool.includes(row.actual) };
  });
  const nextContext = contextAt(draws.length, position);
  const recommendation = tables.get(nextContext) ?? fallback.slice(0, size).sort((a, b) => a - b);
  return { history, recommendation: recommendation.join(""), fallback: fallback.join(""), tables: Object.fromEntries([...tables].map(([key, value]) => [key, value.join("")])) };
}

const pools = {};
const audits = {};
for (const size of [5, 6, 7]) {
  const trained = positions.map((_, position) => trainPosition(size, position));
  const history = trained[0].history.map((base, index) => {
    const row = { issue: base.issue, date: base.date, draw: base.draw, phase: base.date <= end ? "answer-fit" : "locked-forward" };
    for (let position = 0; position < 3; position++) {
      const key = positions[position], source = trained[position].history[index];
      row[`${key}Pool`] = source.pool;
      row[`${key}Hit`] = source.hit;
    }
    return row;
  });
  const streaks = { hundreds: 0, tens: 0, units: 0 };
  for (const row of history) for (const key of positions) {
    streaks[key] = row[`${key}Hit`] ? 0 : streaks[key] + 1;
    row[`${key}MissStreak`] = streaks[key];
  }
  const recommendation = { targetIssue: incrementIssue(latest.issue), basedOnIssue: latest.issue, basedOnDate: latest.date };
  const metrics = {};
  for (let position = 0; position < 3; position++) {
    const key = positions[position];
    recommendation[`${key}Pool`] = trained[position].recommendation;
    metrics[key] = {
      fit: metric(history.filter((row) => row.date <= end), `${key}Hit`),
      forward: metric(history.filter((row) => row.date > end), `${key}Hit`),
    };
  }
  pools[size] = { poolSize: size, recommendation, metrics, history };
  audits[size] = config.formula.byPoolSize[size];
}

const output = {
  generatedAt: new Date().toISOString(), game: "fc3d", sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
  dataSha256: payload.canonicalSha256, formulaVersion: config.formulaVersion, fitStart: start, fitEnd: end, forwardStart: "2026-09-15",
  futureGuarantee: false,
  notice: "近3年答案参与选参：按每个位置此前3期数字形成状态，并从该状态的历史后继数字中选择号码池。公式已于2026-09-14锁定；此后开奖号只计实战，不再参与改写公式。",
  pools,
};
const audit = { ...output, pools: Object.fromEntries(Object.entries(pools).map(([size, item]) => [size, { ...item, history: undefined }])), formula: { ...config.formula, byPoolSize: audits } };

await mkdir(path.join(root, "pages/audit"), { recursive: true });
await mkdir(path.join(root, "public/audit"), { recursive: true });
for (const directory of ["pages", "public"]) {
  await writeFile(path.join(root, directory, "position7-data.json"), `${JSON.stringify(output)}\n`, "utf8");
  await writeFile(path.join(root, directory, "audit/position7-model.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
}
for (const file of ["position7.html", path.join("assets", "position7.js")]) await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
console.log([5, 6, 7].map((size) => `${size}码 ${positions.map((key) => `${(pools[size].metrics[key].fit.rate * 100).toFixed(2)}%/断${pools[size].metrics[key].fit.maxMiss}`).join(" ")}`).join("\n"));
