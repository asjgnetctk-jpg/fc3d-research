import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";
import { pairLifts, coordinatedPools } from "./optimize-position-joint-pairs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const modelVersion = game === "pl3" ? "PL3-POS-META-1.2" : "FC3D-POS-META-1.2";
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const contains = (value, digit) => String(value ?? "").includes(String(digit));
const source = await readJson(`scripts/data/${game}-full-history.json`);
const heat = await readJson(`scripts/data/${game}-17500-heat.json`);
const v7 = await readJson(`pages/${prefix}data.json`);
const v2 = await readJson(`pages/${prefix}v2-data.json`);
const v5 = await readJson(`pages/${prefix}v5-data.json`);
const kill3 = await readJson(`pages/${prefix}kill3-data.json`);
const legacyPosition = await readJson(`pages/${prefix}position7-data.json`);
const trustworthyPosition = await readJson(`pages/${prefix}trust-position7-data.json`);
const v9 = game === "fc3d" ? await readJson("pages/v9-data.json") : null;
const v92 = game === "fc3d" ? await readJson("pages/v9-2-data.json") : null;
const outputFile = `${prefix}meta-position-data.json`;
let previous = null;
try { previous = await readJson(`pages/${outputFile}`); } catch {}

const selected = game === "fc3d"
  ? {
      5: { configId: "grid-03", reverseMask: 1, developmentRate: 0.1255, developmentMaxMiss: 46, recentRate: 0.137, recentMaxMiss: 17 },
      6: { configId: "lag2-63", reverseMask: 1, developmentRate: 0.223, developmentMaxMiss: 28, recentRate: 0.2247, recentMaxMiss: 15 },
      7: { configId: "grid-09", reverseMask: 5, developmentRate: 0.3392, developmentMaxMiss: 17, recentRate: 0.3534, recentMaxMiss: 9 },
    }
  : {
      5: { configId: "cross-41", reverseMask: 1, pairWindow: 500, pairLambda: 0.5, developmentRate: 0.1425, developmentMaxMiss: 29, recentRate: 0.1644, recentMaxMiss: 19 },
      6: { configId: "ml-b2", reverseMask: 0, pairWindow: 250, pairLambda: 1, developmentRate: 0.2175, developmentMaxMiss: 23, recentRate: 0.2411, recentMaxMiss: 12 },
      7: { configId: "ml-b1", reverseMask: 0, pairWindow: 250, pairLambda: 1, developmentRate: 0.3381, developmentMaxMiss: 12, recentRate: 0.3753, recentMaxMiss: 8 },
    };

const exploratory = { trustworthyPosition: 0, legacyPosition: 0, v7: 0.005, v2: 0.005, v5: 0.003, dan: 0.003, killSafe: 0, omission: 0, heat: 0.02, v9Reverse: 0.003, v92Reverse: 0.002 };
const overlayBySize = game === "fc3d"
  ? {
      5: { causal: 1, ...exploratory },
      6: { causal: 1, ...exploratory, trustworthyPosition: 0.1, killSafe: 0.1, omission: 0.03 },
      7: { causal: 1, ...exploratory },
    }
  : {
      5: { causal: 1, ...exploratory },
      6: { causal: 1, ...exploratory },
      7: { causal: 1, ...exploratory },
    };
const modelHash = createHash("sha256").update(JSON.stringify({ modelVersion, selected, overlayBySize })).digest("hex");
const rows = digitRows(source.rows);
const indexData = buildIndex(rows);
const targetIndex = rows.length;
const targetIssue = String(v7.recommendation?.targetIssue ?? v2.recommendation?.targetIssue ?? "下一期");
const targetShortIssue = String(Number(targetIssue.slice(-3)));
const targetHeat = (heat.preDrawSnapshots ?? []).findLast((row) => String(Number(row.issue)) === targetShortIssue) ?? null;
const referenceHeat = targetHeat ?? heat.rows?.at(-1) ?? null;
const current = {
  v7: v7.recommendation,
  v2: v2.recommendation,
  v5: v5.recommendation,
  kill: kill3.recommendation,
  v9: v9?.recommendation,
  v92: v92?.recommendation,
};
const positionKeys = ["hundredsPool", "tensPool", "unitsPool"];
const latest = rows.at(-1);

function expertSupport(recommendation, digit) {
  if (!recommendation) return 0;
  return 0.48 * Number(contains(recommendation.pool5, digit))
    + 0.32 * Number(contains(recommendation.pool6, digit))
    + 0.2 * Number(contains(recommendation.pool7, digit));
}

function rankScores(probabilities, reverse) {
  const ranked = probabilities.map((probability, digit) => ({ digit, probability }))
    .sort((a, b) => (reverse ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit);
  return Object.fromEntries(ranked.map((item, index) => [item.digit, (9 - index) / 9]));
}

function buildRecommendation(size, heatRow, heatMode) {
  const rule = selected[size];
  const overlay = overlayBySize[size];
  const config = configs.find((item) => item.id === rule.configId);
  const weights = train(rows, indexData, config, 500, rows.length);
  const probabilities = predictProbabilities(rows, indexData, config, weights, targetIndex);
  const legacy = legacyPosition.pools?.[String(size)]?.recommendation;
  const trusted = trustworthyPosition.pools?.[String(size)]?.recommendation;
  const recommendation = {
    targetIssue,
    basedOnIssue: latest.issue,
    basedOnDate: latest.date,
    heatCapturedAt: heatRow.capturedAtBeijing ?? null,
    heatMode,
  };
  const fusedScores = [];
  for (let position = 0; position < 3; position += 1) {
    const reverse = Boolean(rule.reverseMask & (1 << position));
    const causalScores = rankScores(probabilities[position], reverse);
    const heatRanking = heatRow.rankings?.[position] ?? [];
    const lastSeen = indexData.lastBefore[targetIndex][position];
    const scored = Array.from({ length: 10 }, (_, digit) => {
      const heatRank = heatRanking.indexOf(digit);
      const omission = Math.min(lastSeen[digit] < 0 ? 40 : targetIndex - 1 - lastSeen[digit], 40) / 40;
      const trustedBoost = Number(contains(trusted?.[positionKeys[position]], digit));
      const legacyBoost = Number(contains(legacy?.[positionKeys[position]], digit));
      const safe = !contains(current.kill?.kills, digit);
      const reverseV9 = current.v9
        ? 0.55 * Number(contains(current.v9.pool5, digit)) + 0.25 * Number(contains(current.v9.pool6, digit)) + 0.14 * Number(contains(current.v9.pool7, digit)) + 0.06 * Number(contains(current.v9.pool8, digit))
        : 0;
      const reverseV92 = current.v92
        ? 0.55 * Number(contains(current.v92.pool5, digit)) + 0.25 * Number(contains(current.v92.pool6, digit)) + 0.14 * Number(contains(current.v92.pool7, digit)) + 0.06 * Number(contains(current.v92.pool8, digit))
        : 0;
      const score = overlay.causal * causalScores[digit]
        + overlay.trustworthyPosition * trustedBoost
        + overlay.legacyPosition * legacyBoost
        + overlay.v7 * expertSupport(current.v7, digit)
        + overlay.v2 * expertSupport(current.v2, digit)
        + overlay.v5 * expertSupport(current.v5, digit)
        + overlay.dan * (Number(current.v7?.dan === digit) + Number(current.v2?.dan === digit) + Number(current.v5?.dan === digit)) / 3
        + overlay.killSafe * Number(safe)
        + overlay.omission * omission
        + overlay.heat * (heatRank < 0 ? 0 : (9 - heatRank) / 9)
        - overlay.v9Reverse * reverseV9
        - overlay.v92Reverse * reverseV92;
      return { digit, score };
    }).sort((a, b) => b.score - a.score || a.digit - b.digit);
    fusedScores[position] = Array.from({ length: 10 });
    scored.forEach((item) => { fusedScores[position][item.digit] = item.score; });
    recommendation[positionKeys[position]] = scored.slice(0, size).map((item) => item.digit).sort((a, b) => a - b).join("");
  }
  if (rule.pairWindow) {
    const lifts = pairLifts(rows, targetIndex, rule.pairWindow);
    const pools = coordinatedPools(fusedScores, size, 0, lifts, rule.pairLambda);
    pools.forEach((pool, position) => { recommendation[positionKeys[position]] = [...pool].sort((a, b) => a - b).join(""); });
  }
  return recommendation;
}

function buildLockedResearchHistory(size) {
  const rule = selected[size];
  const config = configs.find((item) => item.id === rule.configId);
  const start = Math.max(501, rows.length - 365);
  const weights = train(rows, indexData, config, 500, start);
  const lifts = rule.pairWindow ? pairLifts(rows, start, rule.pairWindow) : null;
  const streaks = [0, 0, 0];
  return rows.slice(start).map((row, offset) => {
    const index = start + offset;
    const probabilities = predictProbabilities(rows, indexData, config, weights, index);
    const pools = lifts
      ? coordinatedPools(probabilities, size, rule.reverseMask, lifts, rule.pairLambda)
      : probabilities.map((values, position) => values
        .map((probability, digit) => ({ probability, digit }))
        .sort((a, b) => ((rule.reverseMask & (1 << position)) ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
        .slice(0, size).map((item) => item.digit));
    const output = { issue: row.issue, date: row.date, draw: row.draw, phase: "locked-research" };
    let allHit = true;
    positionKeys.forEach((key, position) => {
      const pool = [...pools[position]].sort((a, b) => a - b).join("");
      const hit = contains(pool, row.digits[position]);
      streaks[position] = hit ? 0 : streaks[position] + 1;
      output[key] = pool;
      output[`${key.replace("Pool", "")}Hit`] = hit;
      output[`${key.replace("Pool", "")}MissStreak`] = streaks[position];
      allHit &&= hit;
    });
    output.allHit = allHit;
    return output;
  });
}

function finalizeHistory(size, recommendation) {
  const history = [...(previous?.pools?.[String(size)]?.history ?? [])];
  if (recommendation) {
    const official = rows.find((row) => String(row.issue) === String(recommendation.targetIssue));
    if (official && !history.some((row) => String(row.issue) === String(official.issue))) {
      history.push({
        issue: official.issue,
        date: official.date,
        draw: official.draw,
        phase: "prospective-locked",
        hundredsPool: recommendation.hundredsPool,
        tensPool: recommendation.tensPool,
        unitsPool: recommendation.unitsPool,
      });
    }
  }
  const streaks = { hundreds: 0, tens: 0, units: 0 };
  return history.map((row) => {
    const output = { ...row };
    let allHit = true;
    ["hundreds", "tens", "units"].forEach((key, position) => {
      const hit = contains(row[`${key}Pool`], row.draw[position]);
      streaks[key] = hit ? 0 : streaks[key] + 1;
      output[`${key}Hit`] = hit;
      output[`${key}MissStreak`] = streaks[key];
      allHit &&= hit;
    });
    output.allHit = allHit;
    return output;
  });
}

function metric(items, field) {
  let hits = 0, miss = 0, maxMiss = 0;
  for (const item of items) {
    if (item[field]) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: items.length, hits, rate: items.length ? hits / items.length : 0, maxMiss, currentMiss: miss, targetMet: false };
}

function jointMetric(items) {
  const positionHits = {
    hundreds: items.filter((row) => row.hundredsHit).length,
    tens: items.filter((row) => row.tensHit).length,
    units: items.filter((row) => row.unitsHit).length,
  };
  const exactlyTwoHits = items.filter((row) => [row.hundredsHit, row.tensHit, row.unitsHit].filter(Boolean).length === 2).length;
  const all = metric(items, "allHit");
  const positionRates = Object.fromEntries(Object.entries(positionHits).map(([key, value]) => [key, items.length ? value / items.length : 0]));
  const product = positionRates.hundreds * positionRates.tens * positionRates.units;
  return {
    count: items.length,
    positionHits,
    positionRates,
    allThreeHits: all.hits,
    allThreeRate: all.rate,
    exactlyTwoHits,
    exactlyTwoRate: items.length ? exactlyTwoHits / items.length : 0,
    mismatchRate: items.length ? exactlyTwoHits / items.length : 0,
    syncEfficiency: product ? all.rate / product : 0,
    maxAllMiss: all.maxMiss,
    currentAllMiss: all.currentMiss,
    score: all.rate,
  };
}

const pools = {};
for (const size of [5, 6, 7]) {
  const priorRecommendation = previous?.pools?.[String(size)]?.recommendation;
  const priorWasTargetLocked = priorRecommendation?.heatMode === "target-locked" || Boolean(previous?.heatSnapshot);
  const lockedSameTarget = priorRecommendation?.targetIssue === targetIssue && priorWasTargetLocked;
  const recommendation = lockedSameTarget
    ? priorRecommendation
    : targetHeat
      ? buildRecommendation(size, targetHeat, "target-locked")
      : null;
  const history = finalizeHistory(size, priorRecommendation);
  const researchHistory = buildLockedResearchHistory(size);
  const joint = jointMetric(history);
  pools[size] = {
    poolSize: size,
    recommendation,
    status: recommendation?.heatMode === "target-locked" ? "已在开奖前锁定" : "尚未推荐 · 等待20:20当期热度",
    developmentEvidence: {
      label: "五年分段锁定研究，不计入真实前瞻",
      rate: selected[size].developmentRate,
      maxMiss: selected[size].developmentMaxMiss,
      recentYearRate: selected[size].recentRate,
      recentYearMaxMiss: selected[size].recentMaxMiss,
      theoreticalRate: size ** 3 / 1000,
      excessRate: selected[size].developmentRate - size ** 3 / 1000,
    },
    metrics: {
      joint,
      jointForward: joint,
      all: { forward: metric(history, "allHit") },
      windows: Object.fromEntries([30, 100, 300, 500].map((window) => [window, jointMetric(history.slice(-window))])),
    },
    researchHistory,
    researchMetrics: jointMetric(researchHistory),
    history,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  game,
  modelVariant: "prospective-meta-position",
  modelVersion,
  modelHash,
  sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
  dataSha256: source.canonicalSha256,
  targetIssue,
  heatSnapshot: targetHeat ? { issue: targetHeat.issue, capturedAt: targetHeat.capturedAt, capturedAtBeijing: targetHeat.capturedAtBeijing } : null,
  referenceHeat: null,
  futureGuarantee: false,
  notice: targetHeat
    ? "融合定位以因果概率模型为底层，小幅融合V2/V5/V7、V9反向、杀码、遗漏、旧定位和开奖前热度；本期已使用当期热度锁定，开奖后只核对、不回改。历史研究结果不计入真实前瞻。"
    : "20:20前不展示参考号码；抓取到本期当期热度后才生成并锁定正式推荐。历史研究结果不计入真实前瞻。",
  overlayBySize,
  selected,
  pools,
};

for (const base of ["pages", "public"]) {
  await mkdir(path.join(root, base), { recursive: true });
  await writeFile(path.join(root, base, outputFile), `${JSON.stringify(payload)}\n`, "utf8");
}
if (game === "fc3d") {
  for (const file of ["heat.html", "styles.css", path.join("assets", "heat.js"), path.join("assets", "game-switch.js")]) {
    await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
  }
}
console.log(`${game} ${modelVersion}: ${targetHeat ? "recommendations locked" : "waiting for target heat"}; forward ${pools[7].history.length}`);
