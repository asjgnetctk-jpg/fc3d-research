import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issue = String(process.argv[2] ?? "");
if (!/^\d{7}$/.test(issue)) throw new Error("Usage: node scripts/replay-meta-position-issue.mjs <7-digit issue>");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const contains = (value, digit) => String(value ?? "").includes(String(digit));
const rowList = (data) => data.history ?? data.rows ?? [];
const predictionRow = (data, fields) => {
  const row = rowList(data).find((item) => String(item.issue) === issue);
  if (!row) return null;
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
};

const [source, heat, v7, v2, v5, kill3, legacyPosition, trustworthyPosition, v9, v92] = await Promise.all([
  readJson("scripts/data/fc3d-full-history.json"),
  readJson("scripts/data/fc3d-17500-heat.json"),
  readJson("pages/data.json"),
  readJson("pages/v2-data.json"),
  readJson("pages/v5-data.json"),
  readJson("pages/kill3-data.json"),
  readJson("pages/position7-data.json"),
  readJson("pages/trust-position7-data.json"),
  readJson("pages/v9-data.json"),
  readJson("pages/v9-2-data.json"),
]);

const issueYear = issue.slice(0, 4);
const issueShort = String(Number(issue.slice(-3)));
const heatArchive = heat.rows.find((row) => row.date.startsWith(`${issueYear}-`) && String(Number(row.issue)) === issueShort);
if (!heatArchive?.rankings?.length) throw new Error(`No archived heat rankings for ${issue}`);
const targetDate = heatArchive.date;
const causalSource = { ...source, rows: source.rows.filter((row) => row.date < targetDate) };
const rows = digitRows(causalSource.rows);
const indexData = buildIndex(rows);
const targetIndex = rows.length;
const latest = rows.at(-1);
if (!latest || latest.date >= targetDate) throw new Error("Causal cutoff failed");

// Only ranking arrays enter the recommendation phase.  The archived page's
// draw field is deliberately excluded until every pool has been frozen.
const heatInput = { rankings: heatArchive.rankings.map((ranking) => [...ranking]) };
const pickPosition = (data, size) => {
  const row = data.pools?.[String(size)]?.history?.find((item) => String(item.issue) === issue);
  return row ? { hundredsPool: row.hundredsPool, tensPool: row.tensPool, unitsPool: row.unitsPool } : null;
};
const current = {
  v7: predictionRow(v7, ["dan", "pool5", "pool6", "pool7"]),
  v2: predictionRow(v2, ["dan", "pool5", "pool6", "pool7"]),
  v5: predictionRow(v5, ["dan", "pool5", "pool6", "pool7"]),
  kill: predictionRow(kill3, ["kills"]),
  v9: predictionRow(v9, ["pool5", "pool6", "pool7", "pool8"]),
  v92: predictionRow(v92, ["pool5", "pool6", "pool7", "pool8"]),
};
const selected = {
  5: { configId: "grid-03", reverseMask: 1 },
  6: { configId: "lag2-63", reverseMask: 1 },
  7: { configId: "grid-09", reverseMask: 5 },
};
const exploratory = { trustworthyPosition: 0, legacyPosition: 0, v7: 0.005, v2: 0.005, v5: 0.003, dan: 0.003, killSafe: 0, omission: 0, heat: 0.02, v9Reverse: 0.003, v92Reverse: 0.002 };
const overlayBySize = {
  5: { causal: 1, ...exploratory },
  6: { causal: 1, ...exploratory, trustworthyPosition: 0.1, killSafe: 0.1, omission: 0.03 },
  7: { causal: 1, ...exploratory },
};
const positionKeys = ["hundredsPool", "tensPool", "unitsPool"];
const expertSupport = (recommendation, digit) => recommendation
  ? 0.48 * Number(contains(recommendation.pool5, digit)) + 0.32 * Number(contains(recommendation.pool6, digit)) + 0.2 * Number(contains(recommendation.pool7, digit))
  : 0;
const rankScores = (probabilities, reverse) => {
  const ranked = probabilities.map((probability, digit) => ({ digit, probability }))
    .sort((a, b) => (reverse ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit);
  return Object.fromEntries(ranked.map((item, index) => [item.digit, (9 - index) / 9]));
};

function buildRecommendation(size) {
  const rule = selected[size];
  const overlay = overlayBySize[size];
  const config = configs.find((item) => item.id === rule.configId);
  const weights = train(rows, indexData, config, 500, rows.length);
  const probabilities = predictProbabilities(rows, indexData, config, weights, targetIndex);
  const legacy = pickPosition(legacyPosition, size);
  const trusted = pickPosition(trustworthyPosition, size);
  const recommendation = { targetIssue: issue, basedOnIssue: latest.issue, basedOnDate: latest.date, heatMode: "historical-reconstruction" };
  for (let position = 0; position < 3; position += 1) {
    const reverse = Boolean(rule.reverseMask & (1 << position));
    const causalScores = rankScores(probabilities[position], reverse);
    const heatRanking = heatInput.rankings[position] ?? [];
    const lastSeen = indexData.lastBefore[targetIndex][position];
    const scored = Array.from({ length: 10 }, (_, digit) => {
      const heatRank = heatRanking.indexOf(digit);
      const omission = Math.min(lastSeen[digit] < 0 ? 40 : targetIndex - 1 - lastSeen[digit], 40) / 40;
      const safe = !contains(current.kill?.kills, digit);
      const reverseV9 = current.v9 ? 0.55 * Number(contains(current.v9.pool5, digit)) + 0.25 * Number(contains(current.v9.pool6, digit)) + 0.14 * Number(contains(current.v9.pool7, digit)) + 0.06 * Number(contains(current.v9.pool8, digit)) : 0;
      const reverseV92 = current.v92 ? 0.55 * Number(contains(current.v92.pool5, digit)) + 0.25 * Number(contains(current.v92.pool6, digit)) + 0.14 * Number(contains(current.v92.pool7, digit)) + 0.06 * Number(contains(current.v92.pool8, digit)) : 0;
      const score = overlay.causal * causalScores[digit]
        + overlay.trustworthyPosition * Number(contains(trusted?.[positionKeys[position]], digit))
        + overlay.legacyPosition * Number(contains(legacy?.[positionKeys[position]], digit))
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

const recommendations = Object.fromEntries([5, 6, 7].map((size) => [size, buildRecommendation(size)]));

// Open the answer only after all recommendations are frozen above.
const official = source.rows.find((row) => String(row.issue) === issue);
if (!official) throw new Error(`No official result for ${issue}`);
const evaluations = Object.fromEntries(Object.entries(recommendations).map(([size, recommendation]) => {
  const hits = positionKeys.map((key, position) => contains(recommendation[key], official.draw[position]));
  return [size, { ...recommendation, draw: official.draw, positionHits: hits, allHit: hits.every(Boolean) }];
}));
const report = {
  generatedAt: new Date().toISOString(),
  issue,
  date: targetDate,
  protocol: "recommendations frozen from archived heat rankings and data through the prior issue; official draw opened afterward",
  evidenceClass: "historical reconstruction, not a contemporaneously timestamped pre-draw snapshot",
  heatSource: heat.source,
  heatIssue: heatArchive.issue,
  heatRankings: heatInput.rankings,
  cutoffIssue: latest.issue,
  cutoffDate: latest.date,
  evaluations,
};
await mkdir(path.join(root, "reports"), { recursive: true });
const output = path.join(root, "reports", `meta-position-replay-${issue}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, issue, cutoffIssue: latest.issue, evaluations }, null, 2));
