import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const hasReverseModels = game === "fc3d";
const source = await readJson(`scripts/data/${game}-17500-heat.json`);
const v7 = await readJson(`pages/${prefix}data.json`);
const v2 = await readJson(`pages/${prefix}v2-data.json`);
const v5 = await readJson(`pages/${prefix}v5-data.json`);
const position = await readJson(`pages/${prefix}position7-data.json`);
const kill3 = await readJson(`pages/${prefix}kill3-data.json`);
const v9 = hasReverseModels ? await readJson("pages/v9-data.json") : { history: [], recommendation: null };
const v92 = hasReverseModels ? await readJson("pages/v9-2-data.json") : { history: [], recommendation: null };
const forwardSeed = await readJson("scripts/data/matrix22-forward-seed.json");
const outputName = `${prefix}heat-data.json`;
let previousPayload = null;
try { previousPayload = await readJson(`pages/${outputName}`); } catch {}

const rows = source.rows.slice(-120);
const latest = rows.at(-1);
const preDrawSnapshots = source.preDrawSnapshots ?? [];
if (!latest || latest.rankings?.length !== 4) throw new Error(`17500 ${game} heat data is unavailable`);

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
const stateSeries = {
  v7dan: [rowList(v7), "danHit"], v7p7: [rowList(v7), "pool7Hit"],
  v2dan: [rowList(v2), "danHit"], v2p7: [rowList(v2), "pool7Hit"],
  v5dan: [rowList(v5), "danHit"], v5p7: [rowList(v5), "pool7Hit"],
  kill: [rowList(kill3), "hit"],
  v9p5: [rowList(v9), "pool5Hit"], v9p6: [rowList(v9), "pool6Hit"], v9p7: [rowList(v9), "pool7Hit"], v9p8: [rowList(v9), "pool8Hit"],
  v92p5: [rowList(v92), "pool5Hit"], v92p6: [rowList(v92), "pool6Hit"], v92p7: [rowList(v92), "pool7Hit"], v92p8: [rowList(v92), "pool8Hit"],
};
for (const size of [5, 6, 7]) for (const [short, field] of [["h", "hundredsHit"], ["t", "tensHit"], ["u", "unitsHit"]]) {
  stateSeries[`p${size}${short}`] = [position.pools?.[String(size)]?.history ?? [], field];
}
function stateFactor(key, cutoffDate = null) {
  const [items, field] = stateSeries[key];
  const values = items.filter((row) => row.date >= "2025-09-15" && row[field] !== undefined && (!cutoffDate || row.date < cutoffDate)).map((row) => Boolean(row[field]));
  if (values.length < 30) return 1;
  const baseline = (values.filter(Boolean).length + 10) / (values.length + 20);
  const state = values.at(-1);
  let streak = 0;
  for (let index = values.length - 1; index >= 0 && values[index] === state; index -= 1) streak += 1;
  const threshold = Math.min(streak, 8), targets = [];
  for (let index = 0; index < values.length - 1; index += 1) {
    if (values[index] !== state) continue;
    let count = 0;
    for (let cursor = index; cursor >= 0 && values[cursor] === state; cursor -= 1) count += 1;
    if (count >= threshold) targets.push(values[index + 1]);
  }
  const conditional = (targets.filter(Boolean).length + 50 * baseline) / (targets.length + 50);
  return Math.max(0.55, Math.min(1.65, Math.sqrt(conditional / Math.max(baseline, 1e-6))));
}
function stateFactors(cutoffDate = null) { return Object.fromEntries(Object.keys(stateSeries).map((key) => [key, stateFactor(key, cutoffDate)])); }

function currentPosition(size) { return position.pools?.[String(size)]?.recommendation ?? null; }
function currentSignals(heat) {
  return {
    date: heat.date, heat, v7: v7.recommendation, v2: v2.recommendation,
    v5: v5.recommendation, kill: kill3.recommendation, v9: v9.recommendation,
    v92: v92.recommendation, position5: currentPosition(5), position6: currentPosition(6), position7: currentPosition(7), stateFactors: stateFactors(),
  };
}
function historicalSignals(heatRow, heatRowIndex, modelVersion) {
  const result = { date: heatRow.date, heat: modelVersion !== "M22.1" ? source.rows[Math.max(0, heatRowIndex - 1)] : heatRow };
  for (const [name, map] of Object.entries(expertRows)) result[name] = map.get(heatRow.date);
  result.stateFactors = stateFactors(heatRow.date);
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
function scoreNumber(number, signals, history, modelVersion, coverageProfile = false) {
  const safePool = String(signals.kill?.kills ?? "").split("").reduce((pool, digit) => pool.replace(digit, ""), "0123456789");
  if (modelVersion.endsWith("state-optimized")) {
    const profile = game === "pl3"
      ? (coverageProfile
        ? { heat: 0.02, kill: 0, position: 2.50, omission: -0.12, agreement: -0.60 }
        : { heat: 0.10, kill: 0.20, position: 2.00, omission: -0.06, agreement: -0.50 })
      : (coverageProfile
        ? { heat: 0.06, kill: 0.10, position: 2.00, omission: -0.14, agreement: -0.40 }
        : { heat: 0.08, kill: 0.30, position: 1.50, omission: -0.08, agreement: -0.20 });
    const f = signals.stateFactors ?? {};
    const positionPart = [5, 6, 7].reduce((total, size) => {
      const row = signals[`position${size}`], weight = ({ 5: 0.22, 6: 0.18, 7: 0.14 })[size];
      if (!row) return total;
      const membership = ["hundredsPool", "tensPool", "unitsPool"].reduce((sum, key, index) => sum + (asSet(row[key]).has(digitsOf(number)[index]) ? (f[`p${size}${["h", "t", "u"][index]}`] ?? 1) : 0), 0) / 3;
      return total + weight * membership;
    }, 0);
    const reverse = (family, row, scale) => [5, 6, 7, 8].reduce((sum, size) => {
      const native = f[`${family}p${size}`] ?? 1, inverse = Math.max(0.55, Math.min(1.65, 2 - native));
      return sum - scale * ({ 5: 0.28, 6: 0.16, 7: 0.09, 8: 0.04 })[size] * inverse * full(number, row?.[`pool${size}`]);
    }, 0);
    const parts = {
      "当期热度": profile.heat * heatScore(number, signals.heat),
      "V7状态": 0.9 * (f.v7p7 ?? 1) * (0.58 * full(number, signals.v7?.pool7) + 0.28 * fraction(number, signals.v7?.pool7)) + 0.28 * (f.v7dan ?? 1) * dan(number, signals.v7?.dan),
      "V2状态": (f.v2p7 ?? 1) * (0.58 * full(number, signals.v2?.pool7) + 0.28 * fraction(number, signals.v2?.pool7)) + 0.28 * (f.v2dan ?? 1) * dan(number, signals.v2?.dan),
      "V5状态": 0.8 * (f.v5p7 ?? 1) * (0.58 * full(number, signals.v5?.pool7) + 0.28 * fraction(number, signals.v5?.pool7)) + 0.28 * (f.v5dan ?? 1) * dan(number, signals.v5?.dan),
      "杀码状态": profile.kill * (f.kill ?? 1) * full(number, safePool),
      "定位状态": profile.position * positionPart,
      "遗漏校准": profile.omission * omissionScore(number, history),
      "V9反向": reverse("v9", signals.v9, 1),
      "V9.2反向": reverse("v92", signals.v92, 0.85),
    };
    const agreement = [signals.v7?.pool7, signals.v2?.pool7, signals.v5?.pool7].filter(Boolean).filter((pool) => full(number, pool)).length;
    parts["重复计票校正"] = profile.agreement * Math.max(0, agreement - 1);
    return { number: String(number).padStart(3, "0"), score: Object.values(parts).reduce((sum, value) => sum + value, 0), parts };
  }
  const parts = {
    "热度": 0.72 * heatScore(number, signals.heat),
    "V7": 1.15 * full(number, signals.v7?.pool5) + 0.72 * full(number, signals.v7?.pool6) + 0.42 * full(number, signals.v7?.pool7) + 0.32 * dan(number, signals.v7?.dan),
    "V2": 1.2 * full(number, signals.v2?.pool5) + 0.76 * full(number, signals.v2?.pool6) + 0.45 * full(number, signals.v2?.pool7) + 0.34 * dan(number, signals.v2?.dan),
    "V5": 0.5 * full(number, signals.v5?.pool7) + 0.28 * dan(number, signals.v5?.dan),
    "定位": modelVersion !== "M22.1" ? 0 : 0.42 * positionFraction(number, signals.position5) + 0.38 * positionFraction(number, signals.position6) + 0.34 * positionFraction(number, signals.position7),
    "杀码": (modelVersion !== "M22.1" ? 2.22 : 0.62) * full(number, safePool),
    "遗漏": 0.26 * omissionScore(number, history),
    "V9反向": modelVersion !== "M22.1" ? 0 : -0.34 * full(number, signals.v9?.pool5) - 0.18 * full(number, signals.v9?.pool6) - 0.1 * full(number, signals.v9?.pool7),
    "V9.2反向": modelVersion !== "M22.1" ? 0 : -0.32 * full(number, signals.v92?.pool5) - 0.16 * full(number, signals.v92?.pool6) - 0.08 * full(number, signals.v92?.pool7),
  };
  const agreement = [signals.v7?.pool7, signals.v2?.pool7, signals.v5?.pool7].filter(Boolean).filter((pool) => full(number, pool)).length;
  parts["专家共识"] = agreement >= 2 ? 0.28 * (agreement - 1) : 0;
  return { number: String(number).padStart(3, "0"), score: Object.values(parts).reduce((sum, value) => sum + value, 0), parts };
}
function choose22(signals, history, modelVersion, uniqueGroups = false) {
  const ranked = Array.from({ length: 1000 }, (_, number) => scoreNumber(number, signals, history, modelVersion, uniqueGroups)).sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
  const selected = [], groupCounts = new Map(), shapeCounts = { "组六": 0, "组三": 0, "豹子": 0 };
  const quotas = { "组六": 16, "组三": 6, "豹子": 0 };
  for (const item of ranked) {
    const itemShape = shape(Number(item.number)), key = groupKey(Number(item.number));
    const straightGroupLimit = game === "pl3" ? 4 : 2;
    const groupLimit = uniqueGroups ? 1 : (itemShape === "组六" ? straightGroupLimit : Math.min(straightGroupLimit, 3));
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
const basedOnIssue = v7.recommendation?.basedOnIssue ?? latest.issue;
const basedOnDate = v7.recommendation?.basedOnDate ?? latest.date;
const targetShortIssue = String(Number(String(targetIssue).slice(-3)));
const targetHeat = preDrawSnapshots.findLast((row) => String(Number(row.issue)) === targetShortIssue) ?? null;
const optimizedModel = game === "pl3" ? "P22.5-balanced-6x16-state-optimized" : "M22.5-state-optimized";
const coverageModel = game === "pl3" ? "P22.4-group-cover" : "M22.6-group-cover";
const modelVersion = game === "pl3" || Number(targetIssue) >= 2026261 ? optimizedModel : "M22.1";
const evaluationRows = [];
const coverageRows = [];
const replayLength = modelVersion !== "M22.1" ? 259 : 120;
// The heat source can already contain the current draw while the model ledgers
// intentionally stop at the previous draw. Scan a small buffer so a row that
// is not yet eligible for historicalSignals does not shorten the published
// fixed-length replay window by one.
for (let index = Math.max(1, allHeat.length - replayLength - 32); index < allHeat.length; index += 1) {
  const heatRow = allHeat[index], signals = historicalSignals(heatRow, index, modelVersion);
  const requiredSignals = [signals.v7, signals.v2, signals.v5, signals.kill, signals.position7];
  if (hasReverseModels) requiredSignals.push(signals.v9, signals.v92);
  if (!requiredSignals.every(Boolean)) continue;
  const numbers = choose22(signals, allHeat.slice(0, index), modelVersion).map((item) => item.number);
  evaluationRows.push({ issue: heatRow.issue, date: heatRow.date, draw: heatRow.draw, numbers, hit: numbers.includes(heatRow.draw) });
  const coverageNumbers = choose22(signals, allHeat.slice(0, index), modelVersion, true).map((item) => item.number);
  const drawGroup = groupKey(Number(heatRow.draw));
  coverageRows.push({ issue: heatRow.issue, date: heatRow.date, draw: heatRow.draw, numbers: coverageNumbers, hit: coverageNumbers.some((number) => groupKey(Number(number)) === drawGroup) });
}
if (evaluationRows.length > replayLength) evaluationRows.splice(0, evaluationRows.length - replayLength);
if (coverageRows.length > replayLength) coverageRows.splice(0, coverageRows.length - replayLength);

const priorSameTarget = previousPayload?.matrix22?.targetIssue === targetIssue;
const targetHeatReady = Boolean(targetHeat);
const recommendation = priorSameTarget && previousPayload.matrix22.numbers?.length === 22 && previousPayload.matrix22.modelVersion === modelVersion && previousPayload.matrix22.heatSnapshot
  ? previousPayload.matrix22.numbers
  : targetHeatReady
    ? choose22(currentSignals(targetHeat), allHeat, modelVersion)
    : [];
const priorCoverageSameTarget = previousPayload?.matrix22Coverage?.targetIssue === targetIssue;
const coverageRecommendation = priorCoverageSameTarget && previousPayload.matrix22Coverage.numbers?.length === 22 && previousPayload.matrix22Coverage.heatSnapshot
  ? previousPayload.matrix22Coverage.numbers
  : targetHeatReady
    ? choose22(currentSignals(targetHeat), allHeat, modelVersion, true)
    : [];
const officialRows = rowList(v7);
const officialByIssue = new Map(officialRows.map((row) => [String(row.issue), row]));
const liveRowMap = new Map([...(forwardSeed[game] ?? []), ...(previousPayload?.matrix22?.liveRows ?? [])]
  .map((row) => [`${row.issue}|${row.version ?? "unknown"}`, row]));
const liveRows = [...liveRowMap.values()]
  .filter((row) => officialByIssue.has(String(row.issue)))
  .map((row) => {
    const official = officialByIssue.get(String(row.issue));
    return { ...row, date: official.date, draw: official.draw, hit: row.numbers.includes(official.draw) };
  });
const priorRecommendation = previousPayload?.matrix22;
const officialPriorResult = officialByIssue.get(String(priorRecommendation?.targetIssue));
if (priorRecommendation?.modelVersion === modelVersion && priorRecommendation?.targetIssue && priorRecommendation.numbers?.length === 22 && officialPriorResult && !liveRows.some((row) => row.issue === priorRecommendation.targetIssue)) {
  const priorNumbers = priorRecommendation.numbers.map((item) => item.number ?? item);
  liveRows.push({ issue: priorRecommendation.targetIssue, date: officialPriorResult.date, draw: officialPriorResult.draw, numbers: priorNumbers, hit: priorNumbers.includes(officialPriorResult.draw), version: priorRecommendation.modelVersion ?? "M22.1" });
}
const payload = {
  generatedAt: new Date().toISOString(), source: source.source, sourceLabel: source.sourceLabel,
  // The heat source can lag behind the official/model ledgers.  The page-level
  // update marker must describe the exact cutoff shared by the published
  // recommendations, otherwise the header and the three panels look out of sync.
  updatedThrough: `${basedOnDate} · 第${basedOnIssue}期`, totalRecords: source.count,
  notice: targetHeatReady ? `当期22组按${game === "pl3" ? "排列3" : "福彩3D"}独立状态概率、定位、杀码、遗漏校准及当期热度快照生成并锁定；概率权重使用样本收缩。` : "20:20前不展示参考号码；抓取到本期当期热度后才生成并锁定正式推荐。",
  matrix22: {
    modelVersion,
    status: targetHeatReady ? "当期热度抓取后锁定" : "尚未推荐 · 等待20:20当期热度",
    targetIssue, basedOnIssue, basedOnDate,
    heatSnapshot: targetHeat ? { issue: targetHeat.issue, date: targetHeat.date, capturedAt: targetHeat.capturedAt, capturedAtBeijing: targetHeat.capturedAtBeijing } : null,
    numbers: recommendation, structure: recommendation.length === 22 ? { group6: 16, group3: 6, triple: 0 } : { group6: 0, group3: 0, triple: 0 }, theoreticalRate: 0.022,
    replay: metrics(evaluationRows), replayRows: evaluationRows.slice().reverse(), live: metrics(liveRows.filter((row) => row.version === modelVersion)), liveAllVersions: metrics(liveRows), liveRows,
    method: targetHeatReady ? (game === "pl3" ? "排列3独立状态概率融合：分别计算排列3 V2/V5/V7、定位与杀码当前连中连断后的下一期可靠度，并用50个基准样本收缩；融合排列3遗漏与用户选号热度，不混用福彩3D参数或V9数据。直选形态与福彩一致采用16个组六、6个组三；同一组六最多保留4个高分排列，真实前瞻从本版本上线后单列。" : "优化状态概率融合：分别计算V2/V5/V7、定位与杀码当前连中连断后的下一期可靠度，并用50个基准样本收缩；降低杀码权重、提高定位权重、校正专家重复计票，V9/V9.2按分码状态反向过滤。历史验证24/200，后置审计10/60；后置审计不是严格未见答案的独立盲测，真实前瞻成绩从本版本上线后单列且不回改。") : "等待本期20:20后的当期热度；正式推荐生成前不提供参考号码。",
  },
  matrix22Coverage: {
    modelVersion: coverageModel,
    status: targetHeatReady ? "组选组合覆盖 · 已锁定" : "尚未推荐 · 等待20:20当期热度",
    targetIssue, basedOnIssue, basedOnDate,
    heatSnapshot: targetHeat ? { issue: targetHeat.issue, date: targetHeat.date, capturedAt: targetHeat.capturedAt, capturedAtBeijing: targetHeat.capturedAtBeijing } : null,
    numbers: coverageRecommendation,
    structure: coverageRecommendation.length === 22 ? { group6: 16, group3: 6, triple: 0 } : { group6: 0, group3: 0, triple: 0 },
    theoreticalRate: 0.114,
    replay: metrics(coverageRows), replayRows: coverageRows.slice().reverse(),
    method: game === "pl3" ? "排列3组选覆盖专用权重：同一组选组合只保留一个排列；提高定位状态权重并加强遗漏与重复计票校正。验证段64/200，后置审计12/60；命中按三位数字排序后的组选组合判断，不等同于直选命中。" : "组选覆盖专用权重：同一组选组合只保留一个排列，空出的名额顺延给其他高分组合；提高定位状态权重，降低杀码权重，并加强遗漏与专家重复计票校正。参数先按开发段与两个验证折选定，再打开后置60期审计。命中按三位数字排序后的组选组合判断，不等同于直选命中。",
  }, latest, history: rows.slice().reverse(),
};

await mkdir(path.join(root, "pages/assets"), { recursive: true });
await mkdir(path.join(root, "public/assets"), { recursive: true });
for (const directory of ["pages", "public"]) await writeFile(path.join(root, directory, outputName), `${JSON.stringify(payload)}\n`, "utf8");
for (const file of ["heat.html", "styles.css", path.join("assets", "heat.js"), path.join("assets", "game-switch.js")]) await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
console.log(`matrix22 ${targetIssue}: ${recommendation.map((item) => item.number).join(" ")}; replay ${payload.matrix22.replay.hits}/${payload.matrix22.replay.count}`);
