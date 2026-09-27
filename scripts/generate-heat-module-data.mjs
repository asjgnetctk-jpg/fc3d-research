import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const source = await readJson("scripts/data/fc3d-17500-heat.json");
const v7 = await readJson("pages/data.json");
const v2 = await readJson("pages/v2-data.json");
const v5 = await readJson("pages/v5-data.json");
const position = await readJson("pages/position7-data.json");
const kill3 = await readJson("pages/kill3-data.json");
const v9 = await readJson("pages/v9-data.json");
const v92 = await readJson("pages/v9-2-data.json");
let previousPayload = null;
try { previousPayload = await readJson("pages/heat-data.json"); } catch {}

const rows = source.rows.slice(-120);
const latest = rows.at(-1);
const preDrawSnapshots = source.preDrawSnapshots ?? [];
if (!latest || latest.rankings?.length !== 4) throw new Error("17500 heat data is unavailable");

const digitsOf = (number) => [Math.floor(number / 100), Math.floor(number / 10) % 10, number % 10];
const asSet = (value) => new Set(String(value ?? "").split("").map(Number));
const fraction = (number, pool) => {
  const allowed = asSet(pool);
  return digitsOf(number).filter((digit) => allowed.has(digit)).length / 3;
};
const full = (number, pool) => fraction(number, pool) === 1 ? 1 : 0;
const dan = (number, value) => digitsOf(number).filter((digit) => digit === Number(value)).length / 3;
const shape = (number) => {
  const unique = new Set(digitsOf(number)).size;
  return unique === 3 ? "组六" : unique === 2 ? "组三" : "豹子";
};
const groupKey = (number) => digitsOf(number).sort((a, b) => a - b).join("");
const byDate = (items = []) => new Map(items.map((row) => [row.date, row]));
const rowList = (data) => data.history ?? data.rows ?? [];
const expertRows = {
  v7: byDate(rowList(v7)), v2: byDate(rowList(v2)), v5: byDate(rowList(v5)),
  kill: byDate(rowList(kill3)), v9: byDate(rowList(v9)), v92: byDate(rowList(v92)),
  position5: byDate(position.pools?.["5"]?.history),
  position6: byDate(position.pools?.["6"]?.history),
  position7: byDate(position.pools?.["7"]?.history),
};

function currentPosition(size) { return position.pools?.[String(size)]?.recommendation ?? null; }
function currentSignals(heat) {
  return {
    date: heat.date, heat, v7: v7.recommendation, v2: v2.recommendation,
    v5: v5.recommendation, kill: kill3.recommendation, v9: v9.recommendation,
    v92: v92.recommendation, position5: currentPosition(5), position6: currentPosition(6), position7: currentPosition(7),
  };
}
function historicalSignals(heatRow, heatRowIndex, modelVersion) {
  const result = { date: heatRow.date, heat: modelVersion === "M22.2-native" ? source.rows[Math.max(0, heatRowIndex - 1)] : heatRow };
  for (const [name, map] of Object.entries(expertRows)) result[name] = map.get(heatRow.date);
  return result;
}
function positionFraction(number, row) {
  if (!row) return 0;
  const digits = digitsOf(number);
  return ["hundredsPool", "tensPool", "unitsPool"].reduce((sum, key, index) => sum + (asSet(row[key]).has(digits[index]) ? 1 : 0), 0) / 3;
}
function omissionScore(number, history) {
  if (!history.length) return 0;
  const digits = digitsOf(number);
  let total = 0;
  for (let positionIndex = 0; positionIndex < 3; positionIndex += 1) {
    let gap = 40;
    for (let age = 0; age < Math.min(40, history.length); age += 1) {
      if (Number(history[history.length - 1 - age].draw[positionIndex]) === digits[positionIndex]) { gap = age; break; }
    }
    total += Math.min(gap, 20) / 20;
  }
  return total / 3;
}
function heatScore(number, heatRow) {
  if (!heatRow?.rankings?.length) return 0;
  const digits = digitsOf(number);
  return digits.reduce((sum, digit, index) => {
    const rank = heatRow.rankings[index].indexOf(digit);
    return sum + (rank < 0 ? 0 : (9 - rank) / 9);
  }, 0) / 3;
}
function scoreNumber(number, signals, history, modelVersion) {
  const safePool = String(signals.kill?.kills ?? "").split("").reduce((pool, digit) => pool.replace(digit, ""), "0123456789");
  const parts = {
    "热度": 0.72 * heatScore(number, signals.heat),
    "V7": 1.15 * full(number, signals.v7?.pool5) + 0.72 * full(number, signals.v7?.pool6) + 0.42 * full(number, signals.v7?.pool7) + 0.32 * dan(number, signals.v7?.dan),
    "V2": 1.2 * full(number, signals.v2?.pool5) + 0.76 * full(number, signals.v2?.pool6) + 0.45 * full(number, signals.v2?.pool7) + 0.34 * dan(number, signals.v2?.dan),
    "V5": 0.5 * full(number, signals.v5?.pool7) + 0.28 * dan(number, signals.v5?.dan),
    "定位": modelVersion === "M22.2-native" ? 0 : 0.42 * positionFraction(number, signals.position5) + 0.38 * positionFraction(number, signals.position6) + 0.34 * positionFraction(number, signals.position7),
    "杀码": (modelVersion === "M22.2-native" ? 2.22 : 0.62) * full(number, safePool),
    "遗漏": 0.26 * omissionScore(number, history),
    "V9反向": modelVersion === "M22.2-native" ? 0 : -0.34 * full(number, signals.v9?.pool5) - 0.18 * full(number, signals.v9?.pool6) - 0.1 * full(number, signals.v9?.pool7),
    "V9.2反向": modelVersion === "M22.2-native" ? 0 : -0.32 * full(number, signals.v92?.pool5) - 0.16 * full(number, signals.v92?.pool6) - 0.08 * full(number, signals.v92?.pool7),
  };
  const agreement = [signals.v7?.pool7, signals.v2?.pool7, signals.v5?.pool7].filter(Boolean).filter((pool) => full(number, pool)).length;
  parts["专家共识"] = agreement >= 2 ? 0.28 * (agreement - 1) : 0;
  return { number: String(number).padStart(3, "0"), score: Object.values(parts).reduce((sum, value) => sum + value, 0), parts };
}
function choose22(signals, history, modelVersion) {
  const ranked = Array.from({ length: 1000 }, (_, number) => scoreNumber(number, signals, history, modelVersion)).sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
  const selected = [], groupCounts = new Map(), shapeCounts = { "组六": 0, "组三": 0, "豹子": 0 };
  const quotas = { "组六": 16, "组三": 6, "豹子": 0 };
  for (const item of ranked) {
    const itemShape = shape(Number(item.number)), key = groupKey(Number(item.number));
    const groupLimit = itemShape === "组六" ? 2 : 1;
    if (shapeCounts[itemShape] >= quotas[itemShape] || (groupCounts.get(key) ?? 0) >= groupLimit) continue;
    const contributors = Object.entries(item.parts).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
    selected.push({ number: item.number, shape: itemShape, score: Number(item.score.toFixed(4)), contributors });
    shapeCounts[itemShape] += 1;
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    if (selected.length === 22) break;
  }
  return selected;
}
function metrics(history) {
  let hits = 0, miss = 0, maxMiss = 0;
  for (const row of history) {
    if (row.hit) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: history.length, hits, rate: history.length ? hits / history.length : 0, maxMiss, currentMiss: miss };
}

const allHeat = source.rows;
const targetIssue = v7.recommendation?.targetIssue ?? v2.recommendation?.targetIssue ?? "下一期";
const targetShortIssue = String(Number(String(targetIssue).slice(-3)));
const targetHeat = preDrawSnapshots.findLast((row) => String(Number(row.issue)) === targetShortIssue) ?? null;
const modelVersion = Number(targetIssue) >= 2026261 ? "M22.2-native" : "M22.1";
const evaluationRows = [];
const replayLength = modelVersion === "M22.2-native" ? 259 : 120;
for (let index = Math.max(1, allHeat.length - replayLength); index < allHeat.length; index += 1) {
  const heatRow = allHeat[index], signals = historicalSignals(heatRow, index, modelVersion);
  if (![signals.v7, signals.v2, signals.v5, signals.kill, signals.v9, signals.v92, signals.position7].every(Boolean)) continue;
  const numbers = choose22(signals, allHeat.slice(0, index), modelVersion).map((item) => item.number);
  evaluationRows.push({ issue: heatRow.issue, date: heatRow.date, draw: heatRow.draw, numbers, hit: numbers.includes(heatRow.draw) });
}

const priorSameTarget = previousPayload?.matrix22?.targetIssue === targetIssue;
const targetHeatReady = Boolean(targetHeat);
const recommendation = priorSameTarget && previousPayload.matrix22.numbers?.length === 22 && previousPayload.matrix22.heatSnapshot
  ? previousPayload.matrix22.numbers
  : targetHeatReady
    ? choose22(currentSignals(targetHeat), allHeat, modelVersion)
    : [];
const officialRows = rowList(v7);
const officialByIssue = new Map(officialRows.map((row) => [String(row.issue), row]));
const liveRows = [...(previousPayload?.matrix22?.liveRows ?? [])]
  .filter((row) => officialByIssue.has(String(row.issue)))
  .map((row) => {
    const official = officialByIssue.get(String(row.issue));
    return { ...row, date: official.date, draw: official.draw, hit: row.numbers.includes(official.draw) };
  });
const priorRecommendation = previousPayload?.matrix22;
const officialPriorResult = officialByIssue.get(String(priorRecommendation?.targetIssue));
if (priorRecommendation?.targetIssue && priorRecommendation.numbers?.length === 22 && officialPriorResult && !liveRows.some((row) => row.issue === priorRecommendation.targetIssue)) {
  const priorNumbers = priorRecommendation.numbers.map((item) => item.number ?? item);
  liveRows.push({ issue: priorRecommendation.targetIssue, date: officialPriorResult.date, draw: officialPriorResult.draw, numbers: priorNumbers, hit: priorNumbers.includes(officialPriorResult.draw), version: priorRecommendation.modelVersion ?? "M22.1" });
}
const payload = {
  generatedAt: new Date().toISOString(), source: source.source, sourceLabel: source.sourceLabel,
  updatedThrough: source.updatedThrough, totalRecords: source.count,
  notice: recommendation.length === 22 ? "当期22组只在北京时间20:20后抓到当期热度快照才生成；生成后锁定不回改。热度来自17500用户选号排名，并非官方销量。" : "正在等待当期20:20后热度快照；抓取成功前不生成本期22组。",
  matrix22: {
    modelVersion,
    status: recommendation.length === 22 ? "当期热度抓取后锁定" : "等待当期热度，尚未推荐",
    targetIssue, basedOnIssue: v7.recommendation?.basedOnIssue ?? latest.issue, basedOnDate: v7.recommendation?.basedOnDate ?? latest.date,
    heatSnapshot: targetHeat ? { issue: targetHeat.issue, date: targetHeat.date, capturedAt: targetHeat.capturedAt, capturedAtBeijing: targetHeat.capturedAtBeijing } : null,
    numbers: recommendation, structure: recommendation.length === 22 ? { group6: 16, group3: 6, triple: 0 } : { group6: 0, group3: 0, triple: 0 }, theoreticalRate: 0.022,
    replay: metrics(evaluationRows), replayRows: evaluationRows.slice().reverse(), live: metrics(liveRows.filter((row) => row.version === modelVersion)), liveRows,
    method: modelVersion === "M22.2-native" ? "原生职责融合：V2/V5/V7负责候选覆盖；杀码执行强冲突过滤；遗漏小幅校准；当期热度必须在开奖前20:20—21:10抓取并保存快照后才能参与。历史回放仍按上一期热度计算，真实的当期热度效果只统计封盘后的前瞻记录。V9反向与定位模型继续影子评估，未证明增益前不进入正式分数。" : "九专家加权共识：正向专家投票、V9/V9.2反向过滤、热度与遗漏校准；按评分从000—999中选22组，并限制同一组选排列过度集中。",
  }, latest, history: rows.slice().reverse(),
};

await mkdir(path.join(root, "pages/assets"), { recursive: true });
await mkdir(path.join(root, "public/assets"), { recursive: true });
for (const directory of ["pages", "public"]) await writeFile(path.join(root, directory, "heat-data.json"), `${JSON.stringify(payload)}\n`, "utf8");
for (const file of ["heat.html", "styles.css", path.join("assets", "heat.js"), path.join("assets", "game-switch.js")]) await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
console.log(`matrix22 ${targetIssue}: ${recommendation.map((item) => item.number).join(" ")}; replay ${payload.matrix22.replay.hits}/${payload.matrix22.replay.count}`);
