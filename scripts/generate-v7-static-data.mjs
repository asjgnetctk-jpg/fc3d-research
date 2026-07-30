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

function periodMetrics(rows, field, startDate) {
  const scoped = rows.filter((row) => row.date >= startDate);
  const base = metrics(scoped, field);
  let current = [];
  const longestRuns = [];
  for (const row of scoped) {
    if (row[field]) {
      if (current.length) longestRuns.push(current);
      current = [];
    } else {
      current.push(row);
    }
  }
  if (current.length) longestRuns.push(current);
  const maxMiss = longestRuns.reduce(
    (maximum, run) => Math.max(maximum, run.length),
    0,
  );
  return {
    ...base,
    startDate,
    longestRuns: longestRuns
      .filter((run) => run.length === maxMiss)
      .map((run) => ({
        length: run.length,
        startIssue: run[0].issue,
        startDate: run[0].date,
        endIssue: run.at(-1).issue,
        endDate: run.at(-1).date,
      })),
  };
}

function metricBundle(rows, field, recentOneYearStart, recentThreeYearStart) {
  return {
    ...metrics(rows, field),
    recentOneYear: periodMetrics(rows, field, recentOneYearStart),
    recentThreeYears: periodMetrics(rows, field, recentThreeYearStart),
  };
}

function dateYearsAgo(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function dateDaysAgo(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function omissionMetric(draws, digit, position = null) {
  const runs = [];
  let currentRun = [];
  let lastSeen = null;

  for (const row of draws) {
    const appeared =
      position === null
        ? row.digits.includes(digit)
        : row.digits[position] === digit;
    if (appeared) {
      if (currentRun.length) runs.push(currentRun);
      currentRun = [];
      lastSeen = row;
    } else {
      currentRun.push(row);
    }
  }
  if (currentRun.length) runs.push(currentRun);

  const max = runs.reduce(
    (maximum, run) => Math.max(maximum, run.length),
    0,
  );
  return {
    current: currentRun.length,
    max,
    lastSeenIssue: lastSeen?.issue ?? null,
    lastSeenDate: lastSeen?.date ?? null,
    maxRuns: runs
      .filter((run) => run.length === max)
      .map((run) => ({
        length: run.length,
        startIssue: run[0].issue,
        startDate: run[0].date,
        endIssue: run.at(-1).issue,
        endDate: run.at(-1).date,
      })),
  };
}

function digitOmissionReport(draws) {
  const latest = draws.at(-1);
  return {
    throughIssue: latest.issue,
    throughDate: latest.date,
    totalPeriods: draws.length,
    definition:
      "当前遗漏为截至最新一期连续未出现期数；最大遗漏为完整历史数据中的最长连续未出现期数。整体遗漏按百十个位任一位置出现即归零，定位遗漏只按对应位置出现归零。",
    digits: Array.from({ length: 10 }, (_, digit) => ({
      digit,
      overall: omissionMetric(draws, digit),
      hundreds: omissionMetric(draws, digit, 0),
      tens: omissionMetric(draws, digit, 1),
      units: omissionMetric(draws, digit, 2),
    })),
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
  const today = shanghaiDate();
  const recentStart = dateDaysAgo(today, 45);
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const query = new URLSearchParams({
        name: "3d",
        dayStart: recentStart,
        dayEnd: today,
        pageNo: "1",
        pageSize: "100",
        systemType: "PC",
        _: String(Date.now()),
      });
      const url =
        "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
        `?${query}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`official-data-${response.status}`);
      const payload = await response.json();
      const rows = (payload.result ?? [])
        .map((item) => ({
          date: String(item.date).slice(0, 10),
          issue: String(item.code),
          digits: String(item.red).split(",").map(Number),
          draw: String(item.red).replaceAll(",", ""),
        }))
        .filter(
          (row) =>
            /^\d{7}$/.test(row.issue) &&
            /^\d{3}$/.test(row.draw) &&
            row.digits.length === 3 &&
            row.digits.every((digit) => Number.isInteger(digit)),
        );
      if (!rows.length) throw new Error("official-data-empty");
      return rows;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
  }
  throw lastError ?? new Error("official-data-unavailable");
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
  let officialRefresh = {
    succeeded: false,
    periods: 0,
    latestIssue: null,
    latestDate: null,
  };
  try {
    const officialRows = await fetchOfficialCurrent();
    for (const row of officialRows) byIssue.set(row.issue, row);
    const latestOfficial = officialRows
      .slice()
      .sort((left, right) => left.issue.localeCompare(right.issue))
      .at(-1);
    officialRefresh = {
      succeeded: true,
      periods: officialRows.length,
      latestIssue: latestOfficial.issue,
      latestDate: latestOfficial.date,
    };
  } catch (error) {
    if (process.env.REQUIRE_OFFICIAL_REFRESH === "1") throw error;
    console.warn(`Official refresh unavailable; using verified snapshot: ${error.message}`);
  }
  return {
    canonicalSha256: snapshot.canonicalSha256,
    officialRefresh,
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
  const { draws, canonicalSha256, officialRefresh } = await loadDraws();
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
  const recentOneYearStart = dateYearsAgo(latest.date, 1);
  const recentThreeYearStart = dateYearsAgo(latest.date, 3);
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
      officialRefresh,
    },
    digitOmissions: digitOmissionReport(draws),
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
      dan: metricBundle(
        history,
        "danHit",
        recentOneYearStart,
        recentThreeYearStart,
      ),
      pool7: metricBundle(
        history,
        "pool7Hit",
        recentOneYearStart,
        recentThreeYearStart,
      ),
      pool6: metricBundle(
        history,
        "pool6Hit",
        recentOneYearStart,
        recentThreeYearStart,
      ),
      pool5: metricBundle(
        history,
        "pool5Hit",
        recentOneYearStart,
        recentThreeYearStart,
      ),
      group3: metricBundle(
        history.filter((row) => row.shapeEvaluated),
        "shapeHit",
        recentOneYearStart,
        recentThreeYearStart,
      ),
      totalPeriods: history.length,
      recentOneYearStart,
      recentThreeYearStart,
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
