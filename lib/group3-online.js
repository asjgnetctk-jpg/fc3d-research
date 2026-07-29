const GROUP3_BASE_RATE = 0.27;

function isGroup3(draw) {
  return new Set(draw.digits).size === 2;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function quantile(values, ratio) {
  if (!values.length) return GROUP3_BASE_RATE;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function rate(history, index, window) {
  const start = Math.max(0, index - window);
  let hits = 0;
  for (let cursor = start; cursor < index; cursor += 1) {
    if (isGroup3(history[cursor])) hits += 1;
  }
  return hits / Math.max(1, index - start);
}

function group3Gap(history, index) {
  for (let age = 1; age <= Math.min(index, 60); age += 1) {
    if (isGroup3(history[index - age])) return age - 1;
  }
  return 60;
}

function drawStructure(draw) {
  const digits = draw.digits;
  return [
    digits.reduce((sum, digit) => sum + digit, 0) / 27,
    (Math.max(...digits) - Math.min(...digits)) / 9,
    digits.filter((digit) => digit % 2 === 1).length / 3,
    digits.filter((digit) => digit >= 5).length / 3,
    new Set(digits).size / 3,
  ];
}

function featureVector(history, index, featureSet) {
  const windows =
    featureSet === "compact"
      ? [10, 30, 90, 365]
      : [3, 5, 10, 14, 20, 30, 45, 60, 90, 120, 180, 365];
  const features = windows.map((window) => rate(history, index, window) - GROUP3_BASE_RATE);
  features.push(Math.min(group3Gap(history, index), 30) / 30);

  if (featureSet !== "rates") {
    features.push(
      Number(isGroup3(history[index - 1])),
      Number(isGroup3(history[index - 2])),
      Number(isGroup3(history[index - 3])),
    );
  }

  if (featureSet === "full") {
    features.push(...drawStructure(history[index - 1]));
    const previous = new Set(history[index - 1].digits);
    const before = new Set(history[index - 2].digits);
    let overlap = 0;
    for (const digit of previous) if (before.has(digit)) overlap += 1;
    features.push(overlap / 3);
  }

  return features;
}

export function buildGroup3Examples(draws, minHistory = 365) {
  const examples = [];
  for (let index = minHistory; index < draws.length; index += 1) {
    examples.push({
      date: draws[index].date,
      issue: draws[index].issue,
      features: featureVector(draws, index, "full"),
      featureSets: {
        compact: featureVector(draws, index, "compact"),
        rates: featureVector(draws, index, "rates"),
        full: featureVector(draws, index, "full"),
      },
      group3: isGroup3(draws[index]),
    });
  }
  return examples;
}

function initialModel(size) {
  return {
    bias: Math.log(GROUP3_BASE_RATE / (1 - GROUP3_BASE_RATE)),
    weights: Array(size).fill(0),
  };
}

function predict(model, features) {
  let score = model.bias;
  for (let index = 0; index < features.length; index += 1) {
    score += model.weights[index] * features[index];
  }
  return sigmoid(score);
}

function update(model, features, target, learningRate, l2) {
  const probability = predict(model, features);
  const error = Number(target) - probability;
  model.bias += learningRate * error;
  for (let index = 0; index < features.length; index += 1) {
    model.weights[index] +=
      learningRate * (error * features[index] - l2 * model.weights[index]);
  }
}

export function runGroup3Online(examples, config, outputStart, outputEnd = null) {
  const featureKey = config.featureSet;
  const first = examples.find((row) => row.date < config.onlineStart);
  if (!first) throw new Error("group3-initial-training-data-missing");
  const model = initialModel(first.featureSets[featureKey].length);
  const initialRows = examples.filter((row) => row.date < config.onlineStart);

  for (let epoch = 0; epoch < config.epochs; epoch += 1) {
    for (const row of initialRows) {
      update(
        model,
        row.featureSets[featureKey],
        row.group3,
        config.learningRate,
        config.l2,
      );
    }
  }

  const probabilityHistory = [];
  const rows = [];
  for (const row of examples) {
    if (row.date < config.onlineStart) continue;
    const features = row.featureSets[featureKey];
    const probability = predict(model, features);
    const recentProbabilities = probabilityHistory.slice(-365);
    const highThreshold = quantile(
      recentProbabilities,
      config.highQuantile ?? 0.8,
    );
    const lowThreshold = quantile(recentProbabilities, 0.2);
    const level =
      probability >= highThreshold
        ? "high"
        : probability <= lowThreshold
          ? "low"
          : "middle";

    if (
      row.date >= outputStart &&
      (!outputEnd || row.date <= outputEnd)
    ) {
      rows.push({
        date: row.date,
        issue: row.issue,
        probability,
        level,
        highThreshold,
        lowThreshold,
        group3: row.group3,
      });
    }

    probabilityHistory.push(probability);
    update(
      model,
      features,
      row.group3,
      config.learningRate,
      config.l2,
    );
  }

  return { rows, model, probabilityHistory };
}

export function forecastNextGroup3(draws, config) {
  const examples = buildGroup3Examples(draws);
  const trained = runGroup3Online(
    examples,
    config,
    draws.at(-1).date,
    draws.at(-1).date,
  );
  const model = trained.model;
  const nextFeatures = featureVector(draws, draws.length, config.featureSet);
  const probability = predict(model, nextFeatures);
  const recentProbabilities = trained.probabilityHistory.slice(-365);
  const highThreshold = quantile(
    recentProbabilities,
    config.highQuantile ?? 0.8,
  );
  const lowThreshold = quantile(recentProbabilities, 0.2);
  return {
    probability,
    highThreshold,
    lowThreshold,
    level:
      probability >= highThreshold
        ? "high"
        : probability <= lowThreshold
          ? "low"
          : "middle",
  };
}

function knnProbability(pool, features, config) {
  const nearest = pool
    .map((row) => {
      const vector = row.featureSets[config.featureSet];
      let distance = 0;
      for (let index = 0; index < vector.length; index += 1) {
        distance += (vector[index] - features[index]) ** 2;
      }
      return { group3: row.group3, distance: Math.sqrt(distance) };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, config.neighbors);
  let hits = config.priorStrength * GROUP3_BASE_RATE;
  let total = config.priorStrength;
  for (const row of nearest) {
    const weight = 1 / (0.05 + row.distance);
    hits += Number(row.group3) * weight;
    total += weight;
  }
  return hits / total;
}

export function runGroup3Knn(examples, config, outputStart, outputEnd = null) {
  const pool = examples.filter((row) => row.date < config.onlineStart);
  const probabilityHistory = [];
  const rows = [];
  for (const row of examples) {
    if (row.date < config.onlineStart) continue;
    const probability = knnProbability(
      pool,
      row.featureSets[config.featureSet],
      config,
    );
    const recentProbabilities = probabilityHistory.slice(-365);
    const highThreshold = quantile(
      recentProbabilities,
      config.highQuantile ?? 0.8,
    );
    const lowThreshold = quantile(recentProbabilities, 0.2);
    const level =
      probability >= highThreshold
        ? "high"
        : probability <= lowThreshold
          ? "low"
          : "middle";
    if (row.date >= outputStart && (!outputEnd || row.date <= outputEnd)) {
      rows.push({
        date: row.date,
        issue: row.issue,
        probability,
        level,
        highThreshold,
        lowThreshold,
        group3: row.group3,
      });
    }
    probabilityHistory.push(probability);
    pool.push(row);
  }
  return { rows, pool, probabilityHistory };
}

export function forecastNextGroup3Knn(draws, config) {
  const examples = buildGroup3Examples(draws);
  const trained = runGroup3Knn(
    examples,
    config,
    draws.at(-1).date,
    draws.at(-1).date,
  );
  const probability = knnProbability(
    trained.pool,
    featureVector(draws, draws.length, config.featureSet),
    config,
  );
  const recentProbabilities = trained.probabilityHistory.slice(-365);
  const highThreshold = quantile(
    recentProbabilities,
    config.highQuantile ?? 0.8,
  );
  const lowThreshold = quantile(recentProbabilities, 0.2);
  return {
    probability,
    highThreshold,
    lowThreshold,
    level:
      probability >= highThreshold
        ? "high"
        : probability <= lowThreshold
          ? "low"
          : "middle",
  };
}

export const group3BaseRate = GROUP3_BASE_RATE;
