import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const windowYears = game === "pl3" ? 3 : 5;
const dailyWindowYears = 7;
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
function chooseDaily(date, years = dailyWindowYears) {
  const start = lowerBound(subtractYears(date, years)), end = lowerBound(date);
  let best = 0, bestHits = -1;
  for (let i = 0; i < combinations.length; i++) {
    const hits = prefixes[i][end] - prefixes[i][start];
    if (hits > bestHits) { best = i; bestHits = hits; }
  }
  const training = draws.slice(start, end).map((row) => ({ hit: success(combinations[best], row.digits) }));
  return { kills: combinations[best], metrics: metric(training), trainingStart: draws[start]?.date, trainingEnd: draws[end - 1]?.date };
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

const history = draws.filter((row) => row.date >= "2021-07-30").map((row) => {
  const model = game === "fc3d" ? chooseDaily(row.date) : lockFor(row.date), hit = success(model.kills, row.digits);
  return { issue: row.issue, date: row.date, draw: row.draw, kills: model.kills.join(""), hit, phase: row.date >= "2026-07-30" ? "live" : row.date >= "2025-07-30" ? "independent" : "development" };
});
let miss = 0;
for (const row of history) { miss = row.hit ? 0 : miss + 1; row.missStreak = miss; }
const latest = draws.at(-1), currentLock = game === "fc3d" ? chooseDaily(addDays(latest.date, 1)) : lockFor(latest.date);
const independent = history.filter((row) => row.date >= "2025-07-30" && row.date <= "2026-07-29");
const live = history.filter((row) => row.date >= "2026-07-30");
const output = {
  generatedAt: new Date().toISOString(), game,
  sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`, dataSha256: source.canonicalSha256,
  formulaVersion: game === "fc3d" ? `KILL3-DAILY-${dailyWindowYears}Y` : `KILL3-ANNUAL-${windowYears}Y-LOCKED`, trainingWindowYears: game === "fc3d" ? dailyWindowYears : windowYears,
  calculationMode: game === "fc3d" ? "daily" : "annual",
  definition: "每天给出3个建议排除数字；开奖号百、十、个位均未出现这3个数字才算命中，任一位置出现即算未中。",
  futureGuarantee: false, theoreticalRate: 0.343,
  notice: game === "fc3d" ? "福彩3D采用7年滚动窗口，每期只使用该期开奖前已经公布的数据，在120种3码组合中重新选择历史严格命中次数最高的一组。2025-07-30至2026-07-29为未参与窗口选择的独立确认段；历史表现不保证未来。" : `体彩排列3采用${windowYears}年窗口，每年7月30日仅用此前开奖选出历史命中率最高的3个杀码，随后锁定一年。开发段用于选择窗口，2025-07-30至2026-07-29为未参与窗口选择的独立确认段；历史表现不保证未来。`,
  recommendation: { targetIssue: incrementIssue(latest.issue), basedOnIssue: latest.issue, basedOnDate: latest.date, kills: currentLock.kills.join(""), validFor: game === "fc3d" ? "仅适用于下一期，开奖后重新计算" : `本组参数锁定至 ${currentLock.cycleEnd}` },
  metrics: { rollingAll: metric(history.filter((row) => row.date <= "2026-07-29")), independent: metric(independent), live: metric(live), currentTraining: currentLock.metrics },
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
