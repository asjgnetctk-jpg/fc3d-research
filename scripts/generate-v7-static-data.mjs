import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import config from "../lib/v7-robust-config.json" with { type: "json" };
import pool56Config from "../lib/pool56-config.json" with { type: "json" };
import group3Config from "../lib/group3-online-config.json" with { type: "json" };
import v5Config from "../lib/v5-config.json" with { type: "json" };
import v2Config from "../lib/v2-one-year-config.json" with { type: "json" };
import {
  actualShape,
  featureColumns,
  rankDigits,
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

function drawSha256(rows) {
  return createHash("sha256")
    .update(
      rows.map((row) => `${row.issue},${row.date},${row.draw}`).join("\n"),
      "utf8",
    )
    .digest("hex");
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

function v2OneYearReplay(draws, modelConfig) {
  const plays = ["dan", "pool5", "pool6", "pool7"];
  const missStreaks = Object.fromEntries(plays.map((play) => [play, 0]));
  const rows = [];

  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    if (row.date < modelConfig.trainingStart) continue;
    const history = draws.slice(Math.max(0, index - 365), index);
    const columns = featureColumns(history);
    const recommendations = {};
    const hits = {};
    const group3Covered = {};
    const actual = [...new Set(row.digits)];

    for (const play of plays) {
      const methods = modelConfig.plays[play].methods;
      const method = methods[Math.min(missStreaks[play], methods.length - 1)];
      const ranking = rankDigits(columns, method);
      if (play === "dan") {
        recommendations.dan = ranking[method.rank - 1].digit;
        hits.dan = actual.includes(recommendations.dan);
      } else {
        const size = Number(play.slice(-1));
        const pool = ranking
          .slice(0, size)
          .map((item) => item.digit)
          .sort((left, right) => left - right);
        recommendations[play] = pool.join("");
        hits[play] =
          actual.length === 3 && actual.every((digit) => pool.includes(digit));
        group3Covered[play] =
          actual.length === 2 && actual.every((digit) => pool.includes(digit));
      }
      missStreaks[play] = hits[play] ? 0 : missStreaks[play] + 1;
    }

    rows.push({
      issue: row.issue,
      date: row.date,
      draw: row.draw,
      shape: actualShape(row.digits),
      dan: recommendations.dan,
      pool5: recommendations.pool5,
      pool6: recommendations.pool6,
      pool7: recommendations.pool7,
      danHit: hits.dan,
      pool5Hit: hits.pool5,
      pool6Hit: hits.pool6,
      pool7Hit: hits.pool7,
      pool5Group3Covered: group3Covered.pool5,
      pool6Group3Covered: group3Covered.pool6,
      pool7Group3Covered: group3Covered.pool7,
      danMissStreak: missStreaks.dan,
      pool5MissStreak: missStreaks.pool5,
      pool6MissStreak: missStreaks.pool6,
      pool7MissStreak: missStreaks.pool7,
      phase:
        row.date <= modelConfig.trainingEnd
          ? "one-year-training"
          : "forward-locked",
    });
  }

  const columns = featureColumns(draws.slice(-365));
  const recommendation = {};
  for (const play of plays) {
    const methods = modelConfig.plays[play].methods;
    const method = methods[Math.min(missStreaks[play], methods.length - 1)];
    const ranking = rankDigits(columns, method);
    if (play === "dan") {
      recommendation.dan = ranking[method.rank - 1].digit;
    } else {
      const size = Number(play.slice(-1));
      recommendation[play] = ranking
        .slice(0, size)
        .map((item) => item.digit)
        .sort((left, right) => left - right)
        .join("");
    }
  }
  return { rows, missStreaks, recommendation };
}

async function fetchCwlOfficialCurrent() {
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

async function fetchGdfcPage(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Referer: "https://www.gdfc.org.cn/play_list_game_6.html",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`gdfc-data-${response.status}`);
  return new TextDecoder("gbk").decode(await response.arrayBuffer());
}

async function fetchGdfcOfficialCurrent() {
  const listHtml = await fetchGdfcPage(
    `https://www.gdfc.org.cn/play_list_game_6.html?_=${Date.now()}`,
  );
  const issues = [
    ...new Set(
      [...listHtml.matchAll(/draw_(\d{7})\.html/g)].map((match) => match[1]),
    ),
  ].slice(0, 20);
  if (!issues.length) throw new Error("gdfc-list-empty");

  const rows = (
    await Promise.all(
      issues.map(async (issue) => {
        const html = await fetchGdfcPage(
          `https://www.gdfc.org.cn/datas/drawinfo/3d/draw_${issue}.html?_=${Date.now()}`,
        );
        const drawMatch = html.match(
          /getD3LenoLuckyNo\("(\d)\s+(\d)\s+(\d)"\)/,
        );
        const dateMatch = html.match(
          /开奖日期：[\s\S]{0,240}?(\d{4})年(\d{2})月(\d{2})日/,
        );
        if (!drawMatch || !dateMatch) return null;
        const draw = `${drawMatch[1]}${drawMatch[2]}${drawMatch[3]}`;
        return {
          issue,
          date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
          draw,
          digits: draw.split("").map(Number),
        };
      }),
    )
  )
    .filter(Boolean)
    .sort((left, right) => left.issue.localeCompare(right.issue));
  if (!rows.length) throw new Error("gdfc-detail-empty");
  return rows;
}

async function fetchOfficialCurrent() {
  if (process.env.OFFICIAL_SOURCE === "gdfc") {
    return {
      source: "广东省福利彩票发行中心",
      rows: await fetchGdfcOfficialCurrent(),
    };
  }
  try {
    return {
      source: "中国福利彩票发行管理中心",
      rows: await fetchCwlOfficialCurrent(),
    };
  } catch (cwlError) {
    console.warn(`CWL refresh unavailable: ${cwlError.message}`);
    return {
      source: "广东省福利彩票发行中心",
      rows: await fetchGdfcOfficialCurrent(),
    };
  }
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
    source: null,
    periods: 0,
    latestIssue: null,
    latestDate: null,
  };
  try {
    const officialResult = await fetchOfficialCurrent();
    const officialRows = officialResult.rows;
    for (const row of officialRows) byIssue.set(row.issue, row);
    const latestOfficial = officialRows
      .slice()
      .sort((left, right) => left.issue.localeCompare(right.issue))
      .at(-1);
    officialRefresh = {
      succeeded: true,
      source: officialResult.source,
      periods: officialRows.length,
      latestIssue: latestOfficial.issue,
      latestDate: latestOfficial.date,
    };
  } catch (error) {
    if (process.env.REQUIRE_OFFICIAL_REFRESH === "1") throw error;
    console.warn(`Official refresh unavailable; using verified snapshot: ${error.message}`);
  }
  const draws = [...byIssue.values()].sort((left, right) =>
    left.issue.localeCompare(right.issue),
  );
  const canonicalSha256 = drawSha256(draws);
  return {
    canonicalSha256,
    snapshotChanged: canonicalSha256 !== snapshot.canonicalSha256,
    officialRefresh,
    draws,
  };
}

async function persistCanonicalHistory(
  draws,
  canonicalSha256,
  officialRefresh,
) {
  const generatedAt = new Date().toISOString();
  await writeFile(
    FULL_HISTORY_PATH,
    `${JSON.stringify(
      { generatedAt, canonicalSha256, rows: draws },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const reportPath = path.join(
    root,
    "scripts",
    "results",
    "full-history-integrity.json",
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const latest = draws.at(-1);
  report.generatedAt = generatedAt;
  report.range = {
    firstIssue: draws[0].issue,
    firstDate: draws[0].date,
    lastIssue: latest.issue,
    lastDate: latest.date,
    count: draws.length,
  };
  report.sources.liveOfficialRefresh = {
    source: officialRefresh.source,
    periods: officialRefresh.periods,
    latestIssue: officialRefresh.latestIssue,
    latestDate: officialRefresh.latestDate,
  };
  report.checks.liveOfficialRefresh = {
    passed: officialRefresh.succeeded,
    source: officialRefresh.source,
    latestIssue: officialRefresh.latestIssue,
  };
  report.canonicalIntegrity = {
    count: draws.length,
    first: draws[0],
    last: latest,
    duplicateIssues: [],
    duplicateDates: [],
    sha256: canonicalSha256,
  };
  report.canonicalSha256 = canonicalSha256;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
  const {
    draws,
    canonicalSha256,
    officialRefresh,
    snapshotChanged,
  } = await loadDraws();
  if (snapshotChanged) {
    await persistCanonicalHistory(draws, canonicalSha256, officialRefresh);
  }
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
  const v2Track = v2OneYearReplay(draws, v2Config);
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
  const v2TrainingRows = v2Track.rows.filter(
    (row) => row.date <= v2Config.trainingEnd,
  );
  const v2ForwardRows = v2Track.rows.filter(
    (row) => row.date > v2Config.trainingEnd,
  );
  const v2Metric = (play, rows = v2TrainingRows) =>
    periodMetrics(rows, `${play}Hit`, rows[0]?.date ?? v2Config.trainingStart);
  const v2Payload = {
    generatedAt,
    sourceUpdatedThrough: payload.sourceUpdatedThrough,
    formulaVersion: v2Config.version,
    trainingMode: v2Config.trainingMode,
    trainingStart: v2Config.trainingStart,
    trainingEnd: v2Config.trainingEnd,
    trainingStartIssue: v2Config.trainingStartIssue,
    trainingEndIssue: v2Config.trainingEndIssue,
    trainingPeriods: v2TrainingRows.length,
    futureGuarantee: false,
    danHardTrainingTarget: v2Config.danHardTrainingTarget,
    dataSha256: canonicalSha256,
    recommendation: {
      targetIssue: incrementIssue(latest.issue),
      basedOnIssue: latest.issue,
      basedOnDate: latest.date,
      ...v2Track.recommendation,
    },
    rows: v2Track.rows,
    metrics: {
      dan: v2Metric("dan"),
      pool5: v2Metric("pool5"),
      pool6: v2Metric("pool6"),
      pool7: v2Metric("pool7"),
    },
    forwardMetrics: {
      count: v2ForwardRows.length,
      dan: v2ForwardRows.length ? v2Metric("dan", v2ForwardRows) : null,
      pool5: v2ForwardRows.length ? v2Metric("pool5", v2ForwardRows) : null,
      pool6: v2ForwardRows.length ? v2Metric("pool6", v2ForwardRows) : null,
      pool7: v2ForwardRows.length ? v2Metric("pool7", v2ForwardRows) : null,
    },
  };

  await mkdir(path.join(root, "pages"), { recursive: true });
  await mkdir(path.join(root, "pages", "audit"), { recursive: true });
  await mkdir(path.join(root, "public", "audit"), { recursive: true });
  await mkdir(path.join(root, "public", "assets"), { recursive: true });
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
  await writeFile(
    path.join(root, "pages", "v2-data.json"),
    `${JSON.stringify(v2Payload)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "public", "v2-data.json"),
    `${JSON.stringify(v2Payload)}\n`,
    "utf8",
  );
  for (const [source, destination] of [
    ["styles.css", "styles.css"],
    ["v2.html", "v2.html"],
    ["v5.html", "v5.html"],
    [path.join("assets", "v2.js"), path.join("assets", "v2.js")],
    [path.join("assets", "v5.js"), path.join("assets", "v5.js")],
  ]) {
    await copyFile(
      path.join(root, "pages", source),
      path.join(root, "public", destination),
    );
  }
  for (const [source, output] of [
    ["full-history-integrity.json", "full-history-integrity.json"],
    ["full-history-training.json", "full-history-training.json"],
  ]) {
    await copyAudit(source, output);
  }
  await copyFile(
    path.join(root, "lib", "v2-one-year-config.json"),
    path.join(root, "pages", "audit", "v2-one-year-config.json"),
  );
  await copyFile(
    path.join(root, "lib", "v2-one-year-config.json"),
    path.join(root, "public", "audit", "v2-one-year-config.json"),
  );
  await copyFile(
    path.join(root, "scripts", "results", "v2-one-year-training.json"),
    path.join(root, "pages", "audit", "v2-one-year-training.json"),
  );
  await copyFile(
    path.join(root, "scripts", "results", "v2-one-year-training.json"),
    path.join(root, "public", "audit", "v2-one-year-training.json"),
  );
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
