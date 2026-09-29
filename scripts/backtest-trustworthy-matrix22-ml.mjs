import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOLDOUT_DAYS = 365;
const VALIDATION_DAYS = 365;
const WARMUP = 500;
const digitRows = (rows) => rows.map((row) => ({ ...row, draw: String(row.draw).padStart(3, "0"), digits: String(row.draw).padStart(3, "0").split("").map(Number) }));
const shapeOf = (number) => new Set(String(number).padStart(3, "0")).size === 3 ? "group6" : new Set(String(number).padStart(3, "0")).size === 2 ? "group3" : "triple";
const configs = [
  { id: "ml-a1", freqWindows: [10, 30, 120, 500], transitionWindows: [60, 250], learningRate: 0.08, regularization: 0.001, epochs: 4 },
  { id: "ml-a2", freqWindows: [10, 30, 120, 500], transitionWindows: [60, 250], learningRate: 0.04, regularization: 0.01, epochs: 7 },
  { id: "ml-b1", freqWindows: [5, 20, 60, 250], transitionWindows: [60, 250, 500], learningRate: 0.06, regularization: 0.003, epochs: 5 },
  { id: "ml-b2", freqWindows: [5, 20, 60, 250], transitionWindows: [60, 250, 500], learningRate: 0.03, regularization: 0.02, epochs: 8 },
  { id: "ml-c1", freqWindows: [20, 60, 120, 250, 500], transitionWindows: [120, 500], learningRate: 0.05, regularization: 0.005, epochs: 6 },
  { id: "ml-c2", freqWindows: [20, 60, 120, 250, 500], transitionWindows: [120, 500], learningRate: 0.025, regularization: 0.03, epochs: 10 },
];
const quotaOptions = [
  { id: "free", group6: 22, group3: 22, triple: 22 },
  { id: "16-6", group6: 16, group3: 6, triple: 0 },
  { id: "14-8", group6: 14, group3: 8, triple: 0 },
  { id: "18-4", group6: 18, group3: 4, triple: 0 },
];

const dot = (weights, features) => weights.reduce((sum, value, index) => sum + value * features[index], 0);
const softmax = (scores) => {
  const max = Math.max(...scores);
  const values = scores.map((score) => Math.exp(score - max));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
};

function buildIndex(rows) {
  const countPrefix = Array.from({ length: 3 }, () => Array.from({ length: 10 }, () => new Int32Array(rows.length + 1)));
  const transitionPrefix = Array.from({ length: 3 }, () => Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => new Int32Array(rows.length + 1))));
  const lastBefore = Array.from({ length: rows.length }, () => Array.from({ length: 3 }, () => Array(10).fill(-1)));
  const lastSeen = Array.from({ length: 3 }, () => Array(10).fill(-1));
  for (let index = 0; index < rows.length; index += 1) {
    for (let position = 0; position < 3; position += 1) {
      lastBefore[index][position] = [...lastSeen[position]];
      for (let digit = 0; digit < 10; digit += 1) countPrefix[position][digit][index + 1] = countPrefix[position][digit][index];
      countPrefix[position][rows[index].digits[position]][index + 1] += 1;
      for (let previous = 0; previous < 10; previous += 1) for (let digit = 0; digit < 10; digit += 1) {
        transitionPrefix[position][previous][digit][index + 1] = transitionPrefix[position][previous][digit][index];
      }
      if (index > 0) transitionPrefix[position][rows[index - 1].digits[position]][rows[index].digits[position]][index + 1] += 1;
      lastSeen[position][rows[index].digits[position]] = index;
    }
  }
  lastBefore[rows.length] = lastSeen.map((items) => [...items]);
  return { countPrefix, transitionPrefix, lastBefore };
}

function featureVector(rows, indexData, config, index, position, candidate) {
  const features = [1];
  for (let digit = 0; digit < 10; digit += 1) features.push(candidate === digit ? 1 : 0);
  for (const window of config.freqWindows) {
    const start = Math.max(0, index - window);
    const count = indexData.countPrefix[position][candidate][index] - indexData.countPrefix[position][candidate][start];
    features.push(count / Math.max(index - start, 1));
  }
  const previous = rows[index - 1].digits[position];
  for (const window of config.transitionWindows) {
    const start = Math.max(1, index - window);
    let total = 0;
    for (let digit = 0; digit < 10; digit += 1) total += indexData.transitionPrefix[position][previous][digit][index] - indexData.transitionPrefix[position][previous][digit][start];
    const count = indexData.transitionPrefix[position][previous][candidate][index] - indexData.transitionPrefix[position][previous][candidate][start];
    features.push(count / Math.max(total, 1));
  }
  const last = indexData.lastBefore[index][position][candidate];
  features.push(Math.min(last < 0 ? 40 : index - 1 - last, 40) / 40);
  features.push(candidate === previous ? 1 : 0);
  features.push(rows[index - 1].digits.filter((digit) => digit === candidate).length / 3);
  features.push(Math.abs(candidate - previous) / 9);
  return features;
}

function train(rows, indexData, config, start, end) {
  const featureCount = featureVector(rows, indexData, config, Math.max(start, 1), 0, 0).length;
  const weights = Array.from({ length: 3 }, () => Array(featureCount).fill(0));
  for (let epoch = 0; epoch < config.epochs; epoch += 1) {
    const rate = config.learningRate / Math.sqrt(epoch + 1);
    for (let index = start; index < end; index += 1) for (let position = 0; position < 3; position += 1) {
      const vectors = Array.from({ length: 10 }, (_, candidate) => featureVector(rows, indexData, config, index, position, candidate));
      const probabilities = softmax(vectors.map((vector) => dot(weights[position], vector)));
      for (let candidate = 0; candidate < 10; candidate += 1) {
        const error = probabilities[candidate] - (candidate === rows[index].digits[position] ? 1 : 0);
        for (let feature = 0; feature < featureCount; feature += 1) {
          weights[position][feature] -= rate * (error * vectors[candidate][feature] + config.regularization * weights[position][feature] / 10);
        }
      }
    }
  }
  return weights;
}

function predictProbabilities(rows, indexData, config, weights, index) {
  return Array.from({ length: 3 }, (_, position) => softmax(Array.from({ length: 10 }, (_, candidate) => dot(weights[position], featureVector(rows, indexData, config, index, position, candidate)))));
}

function recommend(rows, indexData, config, weights, index, quota) {
  const probabilities = predictProbabilities(rows, indexData, config, weights, index);
  const candidates = [];
  for (let hundreds = 0; hundreds < 10; hundreds += 1) for (let tens = 0; tens < 10; tens += 1) for (let units = 0; units < 10; units += 1) {
    const number = `${hundreds}${tens}${units}`;
    candidates.push({ number, score: probabilities[0][hundreds] * probabilities[1][tens] * probabilities[2][units], shape: shapeOf(number) });
  }
  candidates.sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
  const selected = [], counts = { group6: 0, group3: 0, triple: 0 };
  for (const item of candidates) {
    if (counts[item.shape] >= quota[item.shape]) continue;
    selected.push(item.number);
    counts[item.shape] += 1;
    if (selected.length === 22) break;
  }
  return selected;
}

function positionMetrics(rows) {
  const keys = ["hundredsHit", "tensHit", "unitsHit"];
  const positions = Object.fromEntries(keys.map((key) => [key, metrics(rows.map((row) => ({ hit: row[key] })))]));
  const joint = metrics(rows.map((row) => ({ hit: row.allHit })));
  const exactlyTwo = rows.filter((row) => keys.filter((key) => row[key]).length === 2).length;
  const product = keys.reduce((value, key) => value * positions[key].rate, 1);
  return {
    positions,
    joint,
    exactlyTwo,
    exactlyTwoRate: rows.length ? exactlyTwo / rows.length : 0,
    syncEfficiency: product > 0 ? joint.rate / product : 0,
  };
}

function evaluatePosition(rows, indexData, config, weights, size, start, end, includeRows = false) {
  const results = [];
  for (let index = start; index < end; index += 1) {
    const probabilities = predictProbabilities(rows, indexData, config, weights, index);
    const pools = probabilities.map((values) => values
      .map((probability, digit) => ({ digit, probability }))
      .sort((a, b) => b.probability - a.probability || a.digit - b.digit)
      .slice(0, size)
      .map((item) => item.digit));
    const hits = pools.map((pool, position) => pool.includes(rows[index].digits[position]));
    results.push({
      issue: rows[index].issue,
      date: rows[index].date,
      draw: rows[index].draw,
      hundredsHit: hits[0],
      tensHit: hits[1],
      unitsHit: hits[2],
      allHit: hits.every(Boolean),
      ...(includeRows ? { hundredsPool: pools[0].join(""), tensPool: pools[1].join(""), unitsPool: pools[2].join("") } : {}),
    });
  }
  return { metrics: positionMetrics(results), rows: results };
}

function evaluateMixedPosition(rows, indexData, selections, size, start, end, includeRows = false) {
  const results = [];
  for (let index = start; index < end; index += 1) {
    const pools = selections.map(({ config, weights, reverse = false }, position) => {
      const values = softmax(Array.from({ length: 10 }, (_, candidate) => dot(weights[position], featureVector(rows, indexData, config, index, position, candidate))));
      return values.map((probability, digit) => ({ digit, probability }))
        .sort((a, b) => (reverse ? a.probability - b.probability : b.probability - a.probability) || a.digit - b.digit)
        .slice(0, size)
        .map((item) => item.digit);
    });
    const hits = pools.map((pool, position) => pool.includes(rows[index].digits[position]));
    results.push({
      issue: rows[index].issue,
      date: rows[index].date,
      draw: rows[index].draw,
      hundredsHit: hits[0],
      tensHit: hits[1],
      unitsHit: hits[2],
      allHit: hits.every(Boolean),
      ...(includeRows ? { hundredsPool: pools[0].join(""), tensPool: pools[1].join(""), unitsPool: pools[2].join("") } : {}),
    });
  }
  return { metrics: positionMetrics(results), rows: results };
}

function metrics(rows) {
  let hits = 0, miss = 0, maxMiss = 0;
  for (const row of rows) {
    if (row.hit) { hits += 1; miss = 0; } else { miss += 1; maxMiss = Math.max(maxMiss, miss); }
  }
  return { count: rows.length, hits, rate: rows.length ? hits / rows.length : 0, maxMiss, currentMiss: miss };
}

function evaluate(rows, indexData, config, weights, quota, start, end, includeRows = false) {
  const results = [];
  for (let index = start; index < end; index += 1) {
    const numbers = recommend(rows, indexData, config, weights, index, quota);
    results.push({ issue: rows[index].issue, date: rows[index].date, draw: rows[index].draw, hit: numbers.includes(rows[index].draw), ...(includeRows ? { numbers } : {}) });
  }
  return { metrics: metrics(results), rows: results };
}

async function run(game) {
  const payload = JSON.parse(await readFile(path.join(root, "scripts", "data", `${game}-full-history.json`), "utf8"));
  const rows = digitRows(payload.rows);
  const indexData = buildIndex(rows);
  const holdoutStart = rows.length - HOLDOUT_DAYS;
  const validationStart = holdoutStart - VALIDATION_DAYS;
  const candidates = [];
  const trainedConfigs = [];
  const sharedPositionCandidates = { 5: [], 6: [], 7: [] };
  for (const config of configs) {
    const weights = train(rows, indexData, config, WARMUP, validationStart);
    trainedConfigs.push({ config, weights });
    for (const quota of quotaOptions) {
      const validation = evaluate(rows, indexData, config, weights, quota, validationStart, holdoutStart);
      candidates.push({ config, quota, validation: validation.metrics });
    }
    for (const size of [5, 6, 7]) {
      const validation = evaluatePosition(rows, indexData, config, weights, size, validationStart, holdoutStart);
      sharedPositionCandidates[size].push({ config, validation: validation.metrics });
    }
  }
  candidates.sort((a, b) => b.validation.rate - a.validation.rate || a.validation.maxMiss - b.validation.maxMiss || a.config.id.localeCompare(b.config.id) || a.quota.id.localeCompare(b.quota.id));
  const winner = candidates[0];
  const finalWeights = train(rows, indexData, winner.config, WARMUP, holdoutStart);
  const holdout = evaluate(rows, indexData, winner.config, finalWeights, winner.quota, holdoutStart, rows.length, true);
  const positionPools = {};
  for (const size of [5, 6, 7]) {
    const combinations = [];
    for (const hundreds of trainedConfigs) for (const tens of trainedConfigs) for (const units of trainedConfigs) {
      const selections = [hundreds, tens, units];
      const validation = evaluateMixedPosition(rows, indexData, selections, size, validationStart, holdoutStart);
      combinations.push({ configIds: selections.map((item) => item.config.id), validation: validation.metrics });
    }
    combinations.sort((a, b) => b.validation.joint.rate - a.validation.joint.rate
      || b.validation.syncEfficiency - a.validation.syncEfficiency
      || a.validation.joint.maxMiss - b.validation.joint.maxMiss
      || a.configIds.join("/").localeCompare(b.configIds.join("/")));
    const selected = combinations[0];
    const finalSelections = selected.configIds.map((id) => {
      const config = configs.find((item) => item.id === id);
      return { config, weights: train(rows, indexData, config, WARMUP, holdoutStart) };
    });
    const positionHoldout = evaluateMixedPosition(rows, indexData, finalSelections, size, holdoutStart, rows.length, true);
    sharedPositionCandidates[size].sort((a, b) => b.validation.joint.rate - a.validation.joint.rate
      || b.validation.syncEfficiency - a.validation.syncEfficiency
      || a.validation.joint.maxMiss - b.validation.joint.maxMiss
      || a.config.id.localeCompare(b.config.id));
    const sharedSelected = sharedPositionCandidates[size][0];
    const sharedWeights = train(rows, indexData, sharedSelected.config, WARMUP, holdoutStart);
    const sharedHoldout = evaluatePosition(rows, indexData, sharedSelected.config, sharedWeights, size, holdoutStart, rows.length, true);
    const orientedCandidates = [];
    for (const trained of trainedConfigs) for (let mask = 0; mask < 8; mask += 1) {
      const selections = [0, 1, 2].map((position) => ({ ...trained, reverse: Boolean(mask & (1 << position)) }));
      const validation = evaluateMixedPosition(rows, indexData, selections, size, validationStart, holdoutStart);
      orientedCandidates.push({ config: trained.config, reverseMask: mask, validation: validation.metrics });
    }
    orientedCandidates.sort((a, b) => b.validation.joint.rate - a.validation.joint.rate
      || b.validation.syncEfficiency - a.validation.syncEfficiency
      || a.validation.joint.maxMiss - b.validation.joint.maxMiss
      || a.config.id.localeCompare(b.config.id)
      || a.reverseMask - b.reverseMask);
    const orientedSelected = orientedCandidates[0];
    const orientedWeights = train(rows, indexData, orientedSelected.config, WARMUP, holdoutStart);
    const orientedSelections = [0, 1, 2].map((position) => ({ config: orientedSelected.config, weights: orientedWeights, reverse: Boolean(orientedSelected.reverseMask & (1 << position)) }));
    const orientedHoldout = evaluateMixedPosition(rows, indexData, orientedSelections, size, holdoutStart, rows.length, true);
    positionPools[size] = {
      selectedConfigIds: selected.configIds,
      validation: selected.validation,
      holdout: positionHoldout,
      alternatives: combinations.slice(0, 20),
      shared: {
        selectedConfig: sharedSelected.config,
        validation: sharedSelected.validation,
        holdout: sharedHoldout,
        alternatives: sharedPositionCandidates[size],
      },
      oriented: {
        selectedConfig: orientedSelected.config,
        reverseMask: orientedSelected.reverseMask,
        validation: orientedSelected.validation,
        holdout: orientedHoldout,
        alternatives: orientedCandidates,
      },
    };
  }
  return {
    game,
    sourceHash: payload.canonicalSha256,
    selection: { developmentStart: rows[WARMUP].date, developmentEnd: rows[validationStart - 1].date, validationStart: rows[validationStart].date, validationEnd: rows[holdoutStart - 1].date },
    selected: winner,
    holdout: { start: rows[holdoutStart].date, end: rows.at(-1).date, ...holdout },
    positionPools,
    alternatives: candidates,
  };
}

async function main() {
  const output = {
    generatedAt: new Date().toISOString(),
    model: "TM22.2-causal-position-probability",
    researchAttempt: 2,
    theoreticalRate: 0.022,
    caveat: "This is the second registered research family tested against the same final year. It is useful evidence, but only predictions locked after 2026-09-28 qualify as untouched prospective evidence.",
    results: [],
  };
  for (const game of ["fc3d", "pl3"]) {
    const result = await run(game);
    output.results.push(result);
    console.log(`${game}: selected ${result.selected.config.id}/${result.selected.quota.id}; validation ${result.selected.validation.hits}/${result.selected.validation.count} (${(result.selected.validation.rate * 100).toFixed(2)}%); holdout ${result.holdout.metrics.hits}/${result.holdout.metrics.count} (${(result.holdout.metrics.rate * 100).toFixed(2)}%), max miss ${result.holdout.metrics.maxMiss}`);
    for (const size of [5, 6, 7]) {
      const pool = result.positionPools[size];
      console.log(`  ${size}码 ${pool.selectedConfigIds.join("/")}: validation ${(pool.validation.joint.rate * 100).toFixed(2)}%; holdout ${pool.holdout.metrics.joint.hits}/${pool.holdout.metrics.joint.count} (${(pool.holdout.metrics.joint.rate * 100).toFixed(2)}%), max miss ${pool.holdout.metrics.joint.maxMiss}, sync ${pool.holdout.metrics.syncEfficiency.toFixed(3)}`);
      console.log(`    shared ${pool.shared.selectedConfig.id}: validation ${(pool.shared.validation.joint.rate * 100).toFixed(2)}%; holdout ${pool.shared.holdout.metrics.joint.hits}/${pool.shared.holdout.metrics.joint.count} (${(pool.shared.holdout.metrics.joint.rate * 100).toFixed(2)}%), max miss ${pool.shared.holdout.metrics.joint.maxMiss}, sync ${pool.shared.holdout.metrics.syncEfficiency.toFixed(3)}`);
      console.log(`    oriented ${pool.oriented.selectedConfig.id}/mask${pool.oriented.reverseMask}: validation ${(pool.oriented.validation.joint.rate * 100).toFixed(2)}%; holdout ${pool.oriented.holdout.metrics.joint.hits}/${pool.oriented.holdout.metrics.joint.count} (${(pool.oriented.holdout.metrics.joint.rate * 100).toFixed(2)}%), max miss ${pool.oriented.holdout.metrics.joint.maxMiss}, sync ${pool.oriented.holdout.metrics.syncEfficiency.toFixed(3)}`);
    }
  }
  await mkdir(path.join(root, "work"), { recursive: true });
  await writeFile(path.join(root, "work", "trustworthy-matrix22-ml-backtest.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

export { configs, digitRows, buildIndex, train, featureVector, predictProbabilities, softmax, dot };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
