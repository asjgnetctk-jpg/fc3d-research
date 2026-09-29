import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = process.env.LOTTERY_GAME === "pl3" ? "pl3" : "fc3d";
const prefix = game === "pl3" ? "pl3-" : "";
const modelVersion = game === "pl3" ? "PL3-POS-META-1.0" : "FC3D-POS-META-1.0";
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const rowList = (payload) => payload.history ?? payload.rows ?? [];
const digits = (value) => String(value ?? "").split("").map(Number);
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
      5: { configId: "ml-a2", reverseMask: 4, developmentRate: 0.1452, developmentMaxMiss: 35 },
      6: { configId: "ml-b2", reverseMask: 0, developmentRate: 0.2548, developmentMaxMiss: 15, trustworthyAnchor: true },
      7: { configId: "ml-a2", reverseMask: 0, developmentRate: 0.3479, developmentMaxMiss: 16 },
    }
  : {
      5: { configId: "ml-a1", reverseMask: 0, developmentRate: 0.1397, developmentMaxMiss: 27 },
      6: { configId: "ml-b2", reverseMask: 0, developmentRate: 0.2356, developmentMaxMiss: 12 },
      7: { configId: "ml-b1", reverseMask: 0, developmentRate: 0.3726, developmentMaxMiss: 8 },
    };

const overlay = {
  causal: 1,
  trustworthyPosition: 0.18,
  legacyPosition: 0.1,
  v7: 0.065,
  v2: 0.075,
  v5: 0.045,
  dan: 0.035,
  killSafe: 0.045,
  omission: 0.03,
  heat: 0.09,
  v9Reverse: 0.035,
  v92Reverse: 0.025,
};
const modelHash = createHash("sha256").update(JSON.stringify({ modelVersion, selected, overlay })).digest("hex");
const rows = digitRows(source.rows);
const indexData = buildIndex(rows);
const targetIndex = rows.length;
const targetIssue = String(v7.recommendation?.targetIssue ?? v2.recommendation?.targetIssue ?? "下一期");
const targetShortIssue = String(Number(targetIssue.slice(-3)));
const targetHeat = (heat.preDrawSnapshots ?? []).findLast((row) => String(Number(row.issue)) === targetShortIssue) ?? null;
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

function buildRecommendation(size) {
  const rule = selected[size];
  const config = configs.find((item) => item.id === rule.configId);
  const weights = train(rows, indexData, config, 500, rows.length);
  const probabilities = predictProbabilities(rows, indexData, config, weights, targetIndex);
  const legacy = legacyPosition.pools?.[String(size)]?.recommendation;
  const trusted = trustworthyPosition.pools?.[String(size)]?.recommendation;
  const recommendation = {
    targetIssue,
    basedOnIssue: latest.issue,
    basedOnDate: latest.date,
    heatCapturedAt: targetHeat.capturedAtBeijing,
  };
  for (let position = 0; position < 3; position += 1) {
    const reverse = Boolean(rule.reverseMask & (1 << position));
    const causalScores = rankScores(probabilities[position], reverse);
    const heatRanking = targetHeat.rankings?.[position] ?? [];
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
    recommendation[positionKeys[position]] = scored.slice(0, size).map((item) => item.digit).sort((a, b) => a - b).join("");
  }
  return recommendation;
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
  const lockedSameTarget = priorRecommendation?.targetIssue === targetIssue;
  const recommendation = lockedSameTarget ? priorRecommendation : targetHeat ? buildRecommendation(size) : null;
  const history = finalizeHistory(size, priorRecommendation);
  const joint = jointMetric(history);
  pools[size] = {
    poolSize: size,
    recommendation,
    status: recommendation ? "已在开奖前锁定" : "等待20:20后当期热度快照",
    developmentEvidence: {
      label: "多方案研究结果，不计入真实前瞻",
      rate: selected[size].developmentRate,
      maxMiss: selected[size].developmentMaxMiss,
    },
    metrics: {
      joint,
      jointForward: joint,
      all: { forward: metric(history, "allHit") },
      windows: Object.fromEntries([30, 100, 300, 500].map((window) => [window, jointMetric(history.slice(-window))])),
    },
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
  futureGuarantee: false,
  notice: "融合定位以因果概率模型为底层，小幅融合V2/V5/V7、V9反向、杀码、遗漏、旧定位和开奖前热度。历史研究结果不计入真实前瞻；从本版本上线后逐期锁定，开奖后只核对、不回改。",
  overlay,
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
