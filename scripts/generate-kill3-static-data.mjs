import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const windowYears = game === "pl3" ? 3 : 5;
const dailyWindowYears = 7;
const streakPolicy = { threshold: 5, windowYears: 7, ranks: [3, 0, 17, 11] };
const modularFormulas = [
  [0, 0, 0, 0, 6, 0, 0, 0, 8, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
  [0, 0, 0, 0, 0, 0, 0, 8, 0, 0],
  [0, 0, 0, 0, 0, 3, 0, 0, 1, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 9],
];
const source = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
const draws = source.rows;
const combinations = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 9; b++) for (let c = b + 1; c < 10; c++) combinations.push([a, b, c]);

function incrementIssue(issue) { return String(Number(issue) + 1).padStart(issue.length, "0"); }
function subtractYears(date, years) { return `${Number(date.slice(0, 4)) - years}${date.slice(4)}`; }
function addDays(date, days) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function lowerBound(date) { let lo = 0, hi = draws.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (draws[mid].date < date) lo = mid + 1; else hi = mid; } return lo; }
function cycleStart(date) { const year = Number(date.slice(0, 4)); return `${date.slice(5) >= "07-30" ? year : year - 1}-07-30`; }
function success(kills, digits) { return digits.every((digit) => !kills.includes(Number(digit))); }
function metric(rows) {
  let hits = 0, miss = 0, maxMiss = 0;
  for (const row of rows) { if (row.hit) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); } }
  return { count: rows.length, hits, rate: rows.length ? hits / rows.length : 0, maxMiss, currentMiss: miss };
}
function chooseKills(start, end) {
  const training = draws.filter((row) => row.date >= start && row.date <= end);
  return combinations.map((kills) => {
    const rows = training.map((row) => ({ hit: success(kills, row.digits) }));
    return { kills, metrics: metric(rows) };
  }).sort((a, b) => b.metrics.rate - a.metrics.rate || a.metrics.maxMiss - b.metrics.maxMiss || a.kills.join("").localeCompare(b.kills.join("")))[0];
}

const prefixes = combinations.map((kills) => {
  const values = new Uint32Array(draws.length + 1);
  for (let i = 0; i < draws.length; i++) values[i + 1] = values[i] + Number(success(kills, draws[i].digits));
  return values;
});
function rankDaily(date, years = dailyWindowYears) {
  const start = lowerBound(subtractYears(date, years)), end = lowerBound(date);
  const ranking = combinations.map((kills, index) => ({ kills, index, hits: prefixes[index][end] - prefixes[index][start] }))
    .sort((a, b) => b.hits - a.hits || a.index - b.index);
  return { ranking, start, end };
}
function chooseStreak(date, missStreak) {
  const { ranking, start, end } = rankDaily(date, streakPolicy.windowYears);
  const rank = missStreak < streakPolicy.threshold ? 0 : streakPolicy.ranks[(missStreak - streakPolicy.threshold) % streakPolicy.ranks.length];
  const selected = ranking[rank];
  const training = draws.slice(start, end).map((row) => ({ hit: success(selected.kills, row.digits) }));
  return { kills: selected.kills, metrics: metric(training), trainingStart: draws[start]?.date, trainingEnd: draws[end - 1]?.date, policyRank: rank };
}
function chooseModular(index, issue) {
  const previous = draws[index - 1].digits, previous2 = draws[index - 2].digits;
  const vector = [...previous, ...previous2, previous.reduce((sum, digit) => sum + digit, 0), Math.max(...previous) - Math.min(...previous), Number(issue.slice(-3)), 1];
  const kills = [];
  for (const weights of modularFormulas) {
    const value = ((weights.reduce((sum, weight, feature) => sum + weight * vector[feature], 0) % 10) + 10) % 10;
    if (!kills.includes(value)) kills.push(value);
    if (kills.length === 3) break;
  }
  for (let digit = 0; kills.length < 3; digit++) if (!kills.includes(digit)) kills.push(digit);
  return { kills };
}

const locks = new Map();
function lockFor(date) {
  const start = cycleStart(date);
  if (!locks.has(start)) {
    const trainingEnd = `${Number(start.slice(0, 4))}-07-29`;
    const trainingStart = subtractYears(start, windowYears);
    locks.set(start, { cycleStart: start, cycleEnd: `${Number(start.slice(0, 4)) + 1}-07-29`, trainingStart, trainingEnd, ...chooseKills(trainingStart, trainingEnd) });
  }
  return locks.get(start);
}

const history = [];
let miss = 0;
for (let index = lowerBound("2021-07-30"); index < draws.length; index++) {
  const row = draws[index];
  const model = game === "fc3d" ? chooseModular(index, row.issue) : lockFor(row.date);
  const hit = success(model.kills, row.digits);
  miss = hit ? 0 : miss + 1;
  history.push({ issue: row.issue, date: row.date, draw: row.draw, kills: model.kills.join(""), hit, missStreak: miss, phase: row.date >= "2026-07-30" ? "live" : row.date >= "2025-07-30" ? "independent" : "development" });
}
const latest = draws.at(-1), currentLock = game === "fc3d" ? chooseModular(draws.length, incrementIssue(latest.issue)) : lockFor(latest.date);
const independent = history.filter((row) => row.date >= "2025-07-30" && row.date <= "2026-07-29");
const live = history.filter((row) => row.date >= "2026-07-30");
const output = {
  generatedAt: new Date().toISOString(), game,
  sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`, dataSha256: source.canonicalSha256,
  formulaVersion: game === "fc3d" ? "KILL3-MODULAR-PREV2-V1" : `KILL3-ANNUAL-${windowYears}Y-LOCKED`, trainingWindowYears: game === "fc3d" ? null : windowYears,
  calculationMode: game === "fc3d" ? "daily" : "annual",
  definition: "每天给出3个建议排除数字；开奖号百、十、个位均未出现这3个数字才算命中，任一位置出现即算未中。",
  futureGuarantee: false, theoreticalRate: 0.343,
  notice: game === "fc3d" ? "福彩3D采用锁定的前两期开奖数字与已知目标期号模运算公式，每期计算3个杀码。公式仅由2021-07-30至2025-07-29开发段筛选；2025-07-30至2026-07-29为未参与筛选的独立确认段，之后为实战留出段。逐期计算只使用当期开奖前已知信息；历史表现不保证未来。" : `体彩排列3采用${windowYears}年窗口，每年7月30日仅用此前开奖选出历史命中率最高的3个杀码，随后锁定一年。开发段用于选择窗口，2025-07-30至2026-07-29为未参与窗口选择的独立确认段；历史表现不保证未来。`,
  recommendation: { targetIssue: incrementIssue(latest.issue), basedOnIssue: latest.issue, basedOnDate: latest.date, kills: currentLock.kills.join(""), validFor: game === "fc3d" ? "仅适用于下一期，开奖后重新计算" : `本组参数锁定至 ${currentLock.cycleEnd}` },
  metrics: { rollingAll: metric(history.filter((row) => row.date <= "2026-07-29")), independent: metric(independent), live: metric(live), currentTraining: game === "fc3d" ? metric(history.filter((row) => row.phase === "development")) : currentLock.metrics },
  modularFormulas: game === "fc3d" ? modularFormulas : undefined,
  locks: game === "fc3d" ? [] : [...locks.values()].map((lock) => ({ ...lock, kills: lock.kills.join("") })), history,
};

await mkdir(path.join(root, "pages", "audit"), { recursive: true });
await mkdir(path.join(root, "public", "audit"), { recursive: true });
for (const directory of ["pages", "public"]) {
  await writeFile(path.join(root, directory, `${prefix}kill3-data.json`), `${JSON.stringify(output)}\n`, "utf8");
  await writeFile(path.join(root, directory, "audit", `${prefix}kill3-model.json`), `${JSON.stringify({ ...output, history: undefined }, null, 2)}\n`, "utf8");
}
if (game === "fc3d") for (const file of ["kill3.html", path.join("assets", "kill3.js"), path.join("assets", "game-switch.js"), "styles.css"]) await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
console.log(`${game} kill3 ${output.recommendation.kills}: independent ${output.metrics.independent.hits}/${output.metrics.independent.count}, live ${output.metrics.live.hits}/${output.metrics.live.count}`);
