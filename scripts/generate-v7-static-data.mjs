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
  forecastNextGroup3,
  runGroup3Online,
} from "../lib/group3-online.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_HISTORY_PATH = path.join(
  root,
  "scripts",
  "data",
  "fc3d-full-history.json",
);

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

function rollingReplay(draws, startDate, modelConfig) {
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
      actual.size === 3 &&
      [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool6Hit =
      actual.size === 3 && [...actual].every((digit) => pool6.includes(digit));
    const pool5Hit =
      actual.size === 3 && [...actual].every((digit) => pool5.includes(digit));
    const pool7Group3Covered =
      actualGroup3 &&
      [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool6Group3Covered =
      actualGroup3 && [...actual].every((digit) => pool6.includes(digit));
    const pool5Group3Covered =
      actualGroup3 && [...actual].every((digit) => pool5.includes(digit));

    danMissStreak = danHit ? 0 : danMissStreak + 1;
    pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
    pool6MissStreak = pool6Hit ? 0 : pool6MissStreak + 1;
    pool5MissStreak = pool5Hit ? 0 : pool5MissStreak + 1;
    if (row.date < startDate) continue;
    rows.push({
      date: row.date,
      issue: row.issue,
      dan: prediction.dan,
      pool7: prediction.pool7.join(""),
      pool6: pool6.join(""),
      pool5: pool5.join(""),
      draw: row.draw,
      shape: actualShape(row.digits),
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
      phase: "full-history-training-replay",
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

function legacyReplay(draws, modelConfig) {
  const rows = [];
  let danMissStreak = 0;
  let pool7MissStreak = 0;
  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    if (row.date < modelConfig.backfitStart) continue;
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
      actual.size === 3 &&
      [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool7Group3Covered =
      actual.size === 2 &&
      [...actual].every((digit) => prediction.pool7.includes(digit));
    const shapeHit = shape === prediction.shapePlay;
    danMissStreak = danHit ? 0 : danMissStreak + 1;
    pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
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
      phase: "locked",
    });
  }
  return { rows, danMissStreak, pool7MissStreak };
}

async function fetchOfficialCurrent() {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=2013-01-01&dayEnd=${shanghaiDate()}` +
    "&pageNo=1&pageSize=10000&systemType=PC";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/full-history)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  return (payload.result ?? []).map((item) => ({
    date: item.date.slice(0, 10),
    issue: String(item.code),
    digits: item.red.split(",").map(Number),
    draw: item.red.replaceAll(",", ""),
  }));
}

async function loadDraws() {
  const snapshot = JSON.parse(await readFile(FULL_HISTORY_PATH, "utf8"));
  const byIssue = new Map(
    snapshot.rows.map((row) => [
      row.issue,
      {
        date: row.date,
        issue: row.issue,
        digits: row.digits,
        draw: row.draw,
      },
    ]),
  );
  try {
    for (const row of await fetchOfficialCurrent()) byIssue.set(row.issue, row);
  } catch (error) {
    console.warn(`Official refresh unavailable; using verified snapshot: ${error.message}`);
  }
  return {
    canonicalSha256: snapshot.canonicalSha256,
    draws: [...byIssue.values()].sort((left, right) =>
      left.issue.localeCompare(right.issue),
    ),
  };
}

async function copyAudit(file, outputName = file) {
  await copyFile(
    path.join(root, "scripts", "results", file),
    path.join(root, "pages", "audit", outputName),
  );
  await copyFile(
    path.join(root, "pages", "audit", outputName),
    path.join(root, "public", "audit", outputName),
  );
}

async function main() {
  const { draws, canonicalSha256 } = await loadDraws();
  const rolling = rollingReplay(draws, config.simulationStart, config);
  const group3Track = runGroup3Online(
    buildGroup3Examples(draws),
    group3Config,
    group3Config.onlineStart,
  );
  const group3ByIssue = new Map(
    group3Track.rows.map((row) => [row.issue, row]),
  );
  let group3MissStreak = 0;
  const history = rolling.rows.map((row) => {
    const group3 = group3ByIssue.get(row.issue);
    const shapeEvaluated = group3?.level === "high";
    const shapeHit = Boolean(shapeEvaluated && group3?.group3);
    if (shapeEvaluated) {
      group3MissStreak = shapeHit ? 0 : group3MissStreak + 1;
    }
    return {
      ...row,
      shapePlay: shapeEvaluated ? "推荐组三" : "暂不推荐组三",
      group3Probability: group3?.probability ?? 0.27,
      group3Level: group3?.level ?? "middle",
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
  const upcomingGroup3 = forecastNextGroup3(draws, group3Config);
  const v5Track = legacyReplay(draws, v5Config);
  const upcomingV5 = recommendV5(
    draws,
    v5Track.danMissStreak,
    v5Track.pool7MissStreak,
    v5Config,
  );
  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
    formulaVersion: config.version,
    trainingMode: "full-history-expanding-replay",
    trainingUpdatedThrough: latest.date,
    trainingDataStart: draws[0].date,
    forwardStartIssue: config.forwardStartIssue,
    evaluationNotice:
      "全量结果参与了模型选择；以下为训练回放，不是独立盲测。真实前瞻从下一期开奖开始另计。",
    dataIntegrity: {
      periods: draws.length,
      canonicalSha256,
      report: "./audit/full-history-integrity.json",
    },
    recommendation: {
      targetIssue: incrementIssue(latest.issue),
      basedOnIssue: latest.issue,
      basedOnDate: latest.date,
      dan: upcoming.dan,
      pool7: upcoming.pool7.join(""),
      pool6: upcomingPool6.join(""),
      pool5: upcomingPool5.join(""),
      shapePlay:
        upcomingGroup3.level === "high" ? "推荐组三" : "暂不推荐组三",
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
    generatedAt,
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
    `${JSON.stringify(payload)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "pages", "v5-data.json"),
    `${JSON.stringify(v5Payload)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "public", "v5-data.json"),
    `${JSON.stringify(v5Payload)}\n`,
    "utf8",
  );
  for (const [source, output] of [
    ["full-history-integrity.json", "full-history-integrity.json"],
    ["full-history-training.json", "full-history-training.json"],
  ]) {
    await copyAudit(source, output);
  }
  for (const [source, output] of [
    ["v7-robust-config.json", "v7-locked-config.json"],
    ["pool56-config.json", "pool56-config.json"],
    ["group3-online-config.json", "group3-online-config.json"],
  ]) {
    await copyFile(
      path.join(root, "lib", source),
      path.join(root, "pages", "audit", output),
    );
    await copyFile(
      path.join(root, "pages", "audit", output),
      path.join(root, "public", "audit", output),
    );
  }
  console.log(
    `Generated ${config.version}: ${latest.issue} -> dan ${upcoming.dan}, pool5 ${upcomingPool5.join("")}, pool6 ${upcomingPool6.join("")}, pool7 ${upcoming.pool7.join("")}, group3 ${(upcomingGroup3.probability * 100).toFixed(1)}%`,
  );
}

await main();
