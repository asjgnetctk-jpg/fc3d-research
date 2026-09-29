import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configs, digitRows, buildIndex, train, predictProbabilities } from "./backtest-trustworthy-matrix22-ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const contains = (pool, digit) => String(pool ?? "").includes(String(digit));
const asMap = (rows, predicate = () => true) => new Map((rows ?? []).filter(predicate).map((row) => [String(row.issue), row]));
const positionKeys = ["hundredsPool", "tensPool", "unitsPool"];
const jobs = [
  ["fc3d", 5, "grid-03", 1], ["fc3d", 6, "lag2-63", 1], ["fc3d", 7, "grid-09", 5],
  ["pl3", 5, "cross-41", 1], ["pl3", 6, "ml-b2", 0], ["pl3", 7, "ml-b1", 0],
];

function rankScores(values, reverse) {
  const ranked = values.map((value, digit) => ({ value, digit })).sort((a, b) => (reverse ? a.value - b.value : b.value - a.value) || a.digit - b.digit);
  const result = Array(10);
  ranked.forEach((item, index) => { result[item.digit] = (9 - index) / 9; });
  return result;
}

function summarize(items) {
  let hits = 0, miss = 0, maxMiss = 0, exactlyTwo = 0;
  const positionHits = [0, 0, 0], drag = [0, 0, 0];
  for (const row of items) {
    const n = row.filter(Boolean).length;
    row.forEach((hit, position) => { if (hit) positionHits[position] += 1; });
    if (n === 2) { exactlyTwo += 1; drag[row.findIndex((hit) => !hit)] += 1; }
    if (n === 3) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  const count = items.length, rate = hits / count, positionRates = positionHits.map((value) => value / count), exactlyTwoRate = exactlyTwo / count, dragRates = drag.map((value) => value / count);
  const score = 0.55 * rate + 0.15 * exactlyTwoRate + 0.1 * positionRates.reduce((sum, value) => sum + value, 0) - 0.2 * Math.max(...dragRates);
  return { count, hits, rate, maxMiss, currentMiss: miss, positionRates, exactlyTwoRate, dragRates, score };
}

async function run(game, size, configId, mask) {
  const prefix = game === "pl3" ? "pl3-" : "";
  const [source, v7, v2, v5, kill, legacy, trusted] = await Promise.all([
    readJson(`scripts/data/${game}-full-history.json`), readJson(`pages/${prefix}data.json`), readJson(`pages/${prefix}v2-data.json`), readJson(`pages/${prefix}v5-data.json`),
    readJson(`pages/${prefix}kill3-data.json`), readJson(`pages/${prefix}position7-data.json`), readJson(`pages/${prefix}trust-position7-data.json`),
  ]);
  const rows = digitRows(source.rows), indexData = buildIndex(rows), config = configs.find((item) => item.id === configId);
  const start = rows.length - 365, weights = train(rows, indexData, config, 500, start);
  const maps = {
    v7: asMap(v7.history, (row) => row.phase === "forward-locked"),
    v2: asMap(v2.rows, (row) => row.phase === "forward-locked"),
    v5: asMap(v5.rows, (row) => v5.forwardStart && row.date >= v5.forwardStart),
    kill: asMap(kill.history, (row) => row.phase === "independent" || row.phase === "live"),
    legacy: asMap(legacy.pools[String(size)].history, (row) => row.phase === "locked-forward"),
    trusted: asMap(trusted.pools[String(size)].history, (row) => row.phase === "locked-forward"),
    v9: asMap([]), v92: asMap([]),
  };
  const base = [];
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index], issue = String(row.issue), probabilities = predictProbabilities(rows, indexData, config, weights, index);
    const causal = probabilities.map((values, position) => rankScores(values, Boolean(mask & (1 << position))));
    const lastSeen = indexData.lastBefore[index];
    base.push({ row, causal, experts: Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, map.get(issue)])), lastSeen, index });
  }
  const choices = [];
  for (const positionBoost of [0, 0.1, 0.2, 0.35, 0.5]) for (const expertBoost of [0]) for (const reverseBoost of [0]) for (const killBoost of [0, 0.05, 0.1, 0.2]) for (const omissionBoost of [0, 0.03, 0.08, 0.15]) choices.push({ positionBoost, expertBoost, reverseBoost, killBoost, omissionBoost });

  function evaluate(choice, items) {
    return summarize(items.map(({ row, causal, experts, lastSeen, index }) => {
      return causal.map((scores, position) => {
        const ranked = Array.from({ length: 10 }, (_, digit) => {
          const globalPool = (expert) => expert?.[`pool${size}`] ?? (size === 7 ? expert?.pool7 : null);
          const expertScore = [experts.v7, experts.v2, experts.v5].reduce((sum, expert, expertIndex) => sum + (expertIndex === 2 ? 0.5 : 1) * (Number(contains(globalPool(expert), digit)) + 0.25 * Number(expert?.dan === digit)), 0);
          const positionScore = Number(contains(experts.trusted?.[positionKeys[position]], digit)) + 0.5 * Number(contains(experts.legacy?.[positionKeys[position]], digit));
          const reverseScore = Number(contains(experts.v9?.[`pool${size}`], digit)) + 0.5 * Number(contains(experts.v92?.[`pool${size}`], digit));
          const safe = experts.kill ? Number(!contains(experts.kill.kills, digit)) : 0;
          const omission = Math.min(lastSeen[position][digit] < 0 ? 40 : index - 1 - lastSeen[position][digit], 40) / 40;
          return { digit, score: scores[digit] + choice.positionBoost * positionScore + choice.expertBoost * expertScore - choice.reverseBoost * reverseScore + choice.killBoost * safe + choice.omissionBoost * omission };
        }).sort((a, b) => b.score - a.score || a.digit - b.digit);
        const pool = ranked.slice(0, size).map((item) => item.digit);
        return pool.includes(row.digits[position]);
      });
    }));
  }

  const selectionRows = base.slice(0, 240), holdoutRows = base.slice(240);
  const candidates = choices.map((choice) => {
    const folds = [0, 1, 2].map((fold) => evaluate(choice, selectionRows.slice(fold * 80, (fold + 1) * 80)));
    return { choice, selection: evaluate(choice, selectionRows), folds, worstFoldScore: Math.min(...folds.map((item) => item.score)), worstFoldRate: Math.min(...folds.map((item) => item.rate)) };
  });
  candidates.sort((a, b) => b.worstFoldScore - a.worstFoldScore || b.selection.score - a.selection.score || b.worstFoldRate - a.worstFoldRate || b.selection.rate - a.selection.rate || a.selection.maxMiss - b.selection.maxMiss);
  const winner = candidates[0];
  return { game, size, configId, mask, winner: { ...winner, holdout: evaluate(winner.choice, holdoutRows) }, causalOnly: { selection: evaluate(choices[0], selectionRows), holdout: evaluate(choices[0], holdoutRows) }, top: candidates.slice(0, 5) };
}

for (const job of jobs) console.log(JSON.stringify(await run(...job)));
