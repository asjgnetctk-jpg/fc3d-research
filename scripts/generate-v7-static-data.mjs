import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import config from "../lib/v7-robust-config.json" with { type: "json" };
import pool56Config from "../lib/pool56-config.json" with { type: "json" };
import group3Config from "../lib/group3-online-config.json" with { type: "json" };
import v5Config from "../lib/v5-config.json" with { type: "json" };
import {
  actualShape,
  recommendPool,
  recommendV5,
} from "../lib/v5-model.js";
import {
  buildGroup3Examples,
  forecastNextGroup3Knn,
  runGroup3Knn,
} from "../lib/group3-online.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLING_VERSION = "V7.2-rolling";

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function incrementIssue(issue) {
  return String(Number(issue) + 1).padStart(issue.length, "0");
}

function metrics(rows, field) {
  let hits = 0;
  let current = 0;
  let maxMiss = 0;
  for (const row of rows) {
    if (row[field]) {
      hits += 1;
      current = 0;
    } else {
      current += 1;
      maxMiss = Math.max(maxMiss, current);
    }
  }
  return {
    count: rows.length,
    hits,
    rate: rows.length ? hits / rows.length : 0,
    maxMiss,
  };
}

function legacyReplay(draws, startDate, endDate, phase, modelConfig) {
  const rows = [];
  let danMissStreak = 0;
  let pool7MissStreak = 0;
  let shapeMissStreak = 0;

  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    if (row.date < startDate || (endDate && row.date > endDate)) continue;
    const prediction = recommendV5(
      draws.slice(0, index),
      danMissStreak,
      pool7MissStreak,
      modelConfig,
    );
    const actual = new Set(row.digits);
    const shape = actualShape(row.digits);
    const danHit = actual.has(prediction.dan);
    const pool7Hit =
      actual.size === 3 && [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool7Group3Covered =
      actual.size === 2 && [...actual].every((digit) => prediction.pool7.includes(digit));
    const shapeHit = shape === prediction.shapePlay;
    danMissStreak = danHit ? 0 : danMissStreak + 1;
    pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
    shapeMissStreak = shapeHit ? 0 : shapeMissStreak + 1;
    rows.push({
      date: row.date,
      issue: row.issue,
      dan: prediction.dan,
      pool7: prediction.pool7.join(""),
      shapePlay: prediction.shapePlay,
      draw: row.draw,
      shape,
      danHit,
      pool7Hit,
      pool7Group3Covered,
      shapeHit,
      danMissStreak,
      pool7MissStreak,
      shapeMissStreak,
      phase,
    });
  }

  return { rows, danMissStreak, pool7MissStreak };
}

function rollingReplay(draws, startDate, endDate, modelConfig) {
  const rows = [];
  let danMissStreak = 0;
  let pool7MissStreak = 0;
  let pool6MissStreak = 0;
  let pool5MissStreak = 0;

  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    const priorDraws = draws.slice(0, index);
    const prediction = recommendV5(
      priorDraws,
      danMissStreak,
      pool7MissStreak,
      modelConfig,
    );
    const pool6 = recommendPool(
      priorDraws,
      pool6MissStreak,
      pool56Config.pool6.methods,
      6,
    );
    const pool5 = recommendPool(
      priorDraws,
      pool5MissStreak,
      pool56Config.pool5.methods,
      5,
    );
    const actual = new Set(row.digits);
    const actualGroup3 = actual.size === 2;
    const danHit = actual.has(prediction.dan);
    const pool7Hit =
      actual.size === 3 && [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool7Group3Covered =
      actualGroup3 && [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool6Hit =
      actual.size === 3 && [...actual].every((digit) => pool6.includes(digit));
    const pool5Hit =
      actual.size === 3 && [...actual].every((digit) => pool5.includes(digit));
    const pool6Group3Covered =
      actualGroup3 && [...actual].every((digit) => pool6.includes(digit));
    const pool5Group3Covered =
      actualGroup3 && [...actual].every((digit) => pool5.includes(digit));

    danMissStreak = danHit ? 0 : danMissStreak + 1;
    pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
    pool6MissStreak = pool6Hit ? 0 : pool6MissStreak + 1;
    pool5MissStreak = pool5Hit ? 0 : pool5MissStreak + 1;

    if (row.date < startDate || (endDate && row.date > endDate)) continue;
    rows.push({
      date: row.date,
      issue: row.issue,
      dan: prediction.dan,
      pool7: prediction.pool7.join(""),
      pool6: pool6.join(""),
      pool5: pool5.join(""),
      draw: row.draw,
      shape: actualGroup3 ? "开组三" : "未开组三",
      danHit,
      pool7Hit,
      pool6Hit,
      pool5Hit,
      pool7Group3Covered,
      pool6Group3Covered,
      pool5Group3Covered,
      danMissStreak,
      pool7MissStreak,
      pool6MissStreak,
      pool5MissStreak,
      phase: "rolling",
    });
  }

  return {
    rows,
    danMissStreak,
    pool7MissStreak,
    pool6MissStreak,
    pool5MissStreak,
  };
}

async function fetchDraws() {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=2009-01-01&dayEnd=${shanghaiDate()}` +
    "&pageNo=1&pageSize=5000&systemType=PC";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/6.0)",
    },
  });
  if (!response.ok) throw new Error(`官方数据请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  const draws = (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      digits: item.red.split(",").map(Number),
      draw: item.red.replaceAll(",", ""),
    }))
    .filter(
      (item) =>
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        /^\d{7}$/.test(item.issue) &&
        item.digits.length === 3 &&
        item.digits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  if (draws.length < 120) throw new Error(`有效历史数据不足：${draws.length}期`);
  return draws;
}

async function main() {
  let draws;
  try {
    draws = await fetchDraws();
  } catch (error) {
    const fallbackPath = path.join(root, "pages", "data.json");
    const existing = JSON.parse(await readFile(fallbackPath, "utf8"));
    if (!existing?.recommendation || !Array.isArray(existing?.history)) throw error;
    console.warn(`官方数据暂不可用，保留已核验快照：${error.message}`);
    return;
  }

  const rolling = rollingReplay(draws, config.simulationStart, null, config);
  const group3Track = runGroup3Knn(
    buildGroup3Examples(draws),
    group3Config,
    config.simulationStart,
  );
  const group3ByIssue = new Map(
    group3Track.rows.map((row) => [row.issue, row]),
  );
  let group3MissStreak = 0;
  const history = rolling.rows.map((row) => {
    const group3 = group3ByIssue.get(row.issue);
    if (!group3) throw new Error(`group3-row-missing:${row.issue}`);
    const shapeEvaluated = group3.level === "high";
    const shapeHit = shapeEvaluated && group3.group3;
    if (shapeEvaluated) {
      group3MissStreak = shapeHit ? 0 : group3MissStreak + 1;
    }
    return {
      ...row,
      shapePlay: shapeEvaluated ? "推荐组三" : "不推荐组三",
      group3Probability: group3.probability,
      group3Level: group3.level,
      shapeEvaluated,
      shapeHit,
      shapeMissStreak: group3MissStreak,
    };
  });

  const latest = draws.at(-1);
  const upcoming = recommendV5(
    draws,
    rolling.danMissStreak,
    rolling.pool7MissStreak,
    config,
  );
  const upcomingPool6 = recommendPool(
    draws,
    rolling.pool6MissStreak,
    pool56Config.pool6.methods,
    6,
  );
  const upcomingPool5 = recommendPool(
    draws,
    rolling.pool5MissStreak,
    pool56Config.pool5.methods,
    5,
  );
  const upcomingGroup3 = forecastNextGroup3Knn(draws, group3Config);
  const v5Track = legacyReplay(
    draws,
    v5Config.backfitStart,
    null,
    "locked",
    v5Config,
  );
  const upcomingV5 = recommendV5(
    draws,
    v5Track.danMissStreak,
    v5Track.pool7MissStreak,
    v5Config,
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
    formulaVersion: ROLLING_VERSION,
    trainingMode: "expanding-window",
    trainingUpdatedThrough: latest.date,
    recommendation: {
      targetIssue: incrementIssue(latest.issue),
      basedOnIssue: latest.issue,
      basedOnDate: latest.date,
      dan: upcoming.dan,
      pool7: upcoming.pool7.join(""),
      pool6: upcomingPool6.join(""),
      pool5: upcomingPool5.join(""),
      shapePlay:
        upcomingGroup3.level === "high" ? "推荐组三" : "不推荐组三",
      group3Probability: upcomingGroup3.probability,
      group3Level: upcomingGroup3.level,
    },
    history,
    metrics: {
      dan: metrics(history, "danHit"),
      pool7: metrics(history, "pool7Hit"),
      pool6: metrics(history, "pool6Hit"),
      pool5: metrics(history, "pool5Hit"),
      group3: metrics(
        history.filter((row) => row.shapeEvaluated),
        "shapeHit",
      ),
      totalPeriods: history.length,
    },
  };
  const v5Payload = {
    generatedAt: payload.generatedAt,
    sourceUpdatedThrough: payload.sourceUpdatedThrough,
    formulaVersion: v5Config.version,
    recommendation: {
      targetIssue: incrementIssue(latest.issue),
      basedOnIssue: latest.issue,
      basedOnDate: latest.date,
      dan: upcomingV5.dan,
      pool7: upcomingV5.pool7.join(""),
      shapePlay: upcomingV5.shapePlay,
    },
    rows: v5Track.rows,
    metrics: {
      dan: metrics(v5Track.rows, "danHit"),
      pool7: metrics(v5Track.rows, "pool7Hit"),
      shape: metrics(v5Track.rows, "shapeHit"),
    },
  };

  await mkdir(path.join(root, "pages"), { recursive: true });
  await mkdir(path.join(root, "pages", "audit"), { recursive: true });
  await mkdir(path.join(root, "public", "audit"), { recursive: true });
  await writeFile(
    path.join(root, "pages", "data.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "pages", "v5-data.json"),
    `${JSON.stringify(v5Payload, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "public", "v5-data.json"),
    `${JSON.stringify(v5Payload, null, 2)}\n`,
    "utf8",
  );
  await copyFile(
    path.join(root, "scripts", "results", "v7-robust-training.json"),
    path.join(root, "pages", "audit", "v7-robust-training.json"),
  );
  await copyFile(
    path.join(root, "lib", "v7-robust-config.json"),
    path.join(root, "pages", "audit", "v7-locked-config.json"),
  );
  await copyFile(
    path.join(root, "scripts", "results", "group3-knn-search.json"),
    path.join(root, "pages", "audit", "group3-knn-search.json"),
  );
  await copyFile(
    path.join(root, "scripts", "results", "pool56-robust-search.json"),
    path.join(root, "pages", "audit", "pool56-robust-search.json"),
  );
  await copyFile(
    path.join(root, "scripts", "results", "pool56-untouched-test.json"),
    path.join(root, "pages", "audit", "pool56-untouched-test.json"),
  );
  await copyFile(
    path.join(root, "lib", "group3-online-config.json"),
    path.join(root, "pages", "audit", "group3-online-config.json"),
  );
  await copyFile(
    path.join(root, "lib", "pool56-config.json"),
    path.join(root, "pages", "audit", "pool56-config.json"),
  );
  for (const file of [
    "v7-robust-training.json",
    "v7-locked-config.json",
    "group3-knn-search.json",
    "pool56-robust-search.json",
    "pool56-untouched-test.json",
    "group3-online-config.json",
    "pool56-config.json",
  ]) {
    await copyFile(
      path.join(root, "pages", "audit", file),
      path.join(root, "public", "audit", file),
    );
  }
  console.log(
    `已生成V7：${latest.issue}期后 胆${upcoming.dan} / 5码${upcomingPool5.join("")} / 6码${upcomingPool6.join("")} / 7码${upcoming.pool7.join("")} / ${upcomingGroup3.level === "high" ? "推荐组三" : "不推荐组三"} ${(upcomingGroup3.probability * 100).toFixed(1)}%`,
  );
}

await main();
