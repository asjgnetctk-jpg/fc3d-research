import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import config from "../lib/v6-blind-config.json" with { type: "json" };
import { actualShape, recommendV5 } from "../lib/v5-model.js";

const FETCH_START = "2014-01-01";
const TEST_START = "2021-07-28";
const TEST_END = "2026-07-27";

function metrics(hits, rows) {
  let hitCount = 0;
  let currentMiss = 0;
  let currentStart = 0;
  let longest = { length: 0, startIndex: 0, endIndex: -1 };
  hits.forEach((hit, index) => {
    if (hit) {
      hitCount += 1;
      currentMiss = 0;
    } else {
      if (currentMiss === 0) currentStart = index;
      currentMiss += 1;
      if (currentMiss > longest.length) {
        longest = { length: currentMiss, startIndex: currentStart, endIndex: index };
      }
    }
  });
  return {
    count: hits.length,
    hits: hitCount,
    rate: hits.length ? hitCount / hits.length : 0,
    maxMiss: longest.length,
    longestMiss:
      longest.endIndex >= 0
        ? {
            length: longest.length,
            startIssue: rows[longest.startIndex].issue,
            startDate: rows[longest.startIndex].date,
            endIssue: rows[longest.endIndex].issue,
            endDate: rows[longest.endIndex].date,
          }
        : null,
  };
}

async function fetchThroughTestEnd() {
  const requestUrl =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${TEST_END}` +
    "&pageNo=1&pageSize=5000&systemType=PC";
  const response = await fetch(requestUrl, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/6.0-blind-audit)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = await response.json();
  const draws = (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      draw: item.red.replaceAll(",", ""),
      digits: item.red.split(",").map(Number),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return { requestUrl, draws };
}

function validate(draws) {
  const issues = new Set();
  const dates = new Set();
  const duplicateIssues = [];
  const duplicateDates = [];
  let invalidRows = 0;
  for (const row of draws) {
    if (issues.has(row.issue)) duplicateIssues.push(row.issue);
    if (dates.has(row.date)) duplicateDates.push(row.date);
    issues.add(row.issue);
    dates.add(row.date);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !/^\d{7}$/.test(row.issue) ||
      row.digits.length !== 3 ||
      row.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)
    ) invalidRows += 1;
  }
  return {
    fetched: draws.length,
    duplicateIssues,
    duplicateDates,
    invalidRows,
    passed: !duplicateIssues.length && !duplicateDates.length && !invalidRows,
  };
}

async function main() {
  if (
    config.trainingDataCutoff >= TEST_START ||
    config.independentTestStart !== TEST_START ||
    config.independentTestEnd !== TEST_END
  ) {
    throw new Error("locked-config-boundary-invalid");
  }
  const configText = await readFile("lib/v6-blind-config.json", "utf8");
  const configSha256 = createHash("sha256").update(configText, "utf8").digest("hex");
  const trainingReport = JSON.parse(
    await readFile("scripts/results/v6-pretest-training.json", "utf8"),
  );
  if (configSha256 !== trainingReport.lockedConfigSha256) {
    throw new Error("locked-config-hash-mismatch");
  }

  const { requestUrl, draws } = await fetchThroughTestEnd();
  const integrity = validate(draws);
  if (!integrity.passed) throw new Error(`integrity:${JSON.stringify(integrity)}`);
  const testIndices = draws
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.date >= TEST_START && row.date <= TEST_END);
  if (testIndices.length < 1000) throw new Error(`test-samples:${testIndices.length}`);

  let danMissStreak = 0;
  let pool7MissStreak = 0;
  let shapeMissStreak = 0;
  const rows = [];
  for (const { row, index } of testIndices) {
    const prediction = recommendV5(
      draws.slice(0, index),
      danMissStreak,
      pool7MissStreak,
      config,
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
    shapeMissStreak = shapeHit ? 0 : shapeMissStreak + 1;
    rows.push({
      date: row.date,
      issue: row.issue,
      dan: prediction.dan,
      pool7: prediction.pool7.join(""),
      shapeRecommendation: prediction.shapePlay,
      draw: row.draw,
      actualShape: shape,
      danHit,
      pool7Hit,
      pool7Group3Covered,
      shapeHit,
      danMissStreak,
      pool7MissStreak,
      shapeMissStreak,
    });
  }

  const danMetrics = metrics(rows.map((row) => row.danHit), rows);
  const pool7Metrics = metrics(rows.map((row) => row.pool7Hit), rows);
  const shapeMetrics = metrics(rows.map((row) => row.shapeHit), rows);
  const alwaysGroup6Metrics = metrics(
    rows.map((row) => row.actualShape === "组六"),
    rows,
  );
  const canonicalTestData = rows
    .map((row) => `${row.date},${row.issue},${row.draw}`)
    .join("\n");
  const report = {
    version: "V6-independent-five-year-audit-1",
    createdAt: new Date().toISOString(),
    protocol: {
      trainingDataCutoff: config.trainingDataCutoff,
      formulaConfigSha256: configSha256,
      formulaLockedBeforeTestEvaluation: true,
      testStart: TEST_START,
      testEnd: TEST_END,
      selectionOrTuningUsingTestRows: false,
      rule:
        "公式由截止2021-07-27的数据选定并锁定；本脚本只加载锁定配置，逐期特征仅取当期之前数据，不含搜索、比较或调参逻辑。",
    },
    source: {
      provider: "中国福利彩票官网",
      requestUrl,
      integrity,
      canonicalTestDataSha256: createHash("sha256")
        .update(canonicalTestData, "utf8")
        .digest("hex"),
    },
    range: { start: TEST_START, end: TEST_END, count: rows.length },
    metrics: {
      dan: danMetrics,
      pool7: pool7Metrics,
      shapeChoice: shapeMetrics,
      alwaysGroup6Baseline: alwaysGroup6Metrics,
    },
    rows,
  };

  const csvRows = [
    [
      "日期", "期号", "独胆推荐", "7码推荐", "形态推荐", "开奖号", "实际形态",
      "独胆命中", "独胆连续未中", "7码命中", "7码连续未中", "7码组三覆盖",
      "形态命中", "形态连续未中",
    ],
    ...rows.map((row) => [
      row.date,
      row.issue,
      row.dan,
      row.pool7,
      row.shapeRecommendation,
      row.draw,
      row.actualShape,
      row.danHit ? "中" : "未中",
      row.danMissStreak,
      row.pool7Hit ? "中" : "未中",
      row.pool7MissStreak,
      row.pool7Group3Covered ? "组三覆盖" : "",
      row.shapeHit ? "中" : "未中",
      row.shapeMissStreak,
    ]),
  ];

  await mkdir("scripts/results", { recursive: true });
  await mkdir("pages/audit", { recursive: true });
  await writeFile(
    "scripts/results/v6-independent-five-year.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "pages/audit/v6-independent-five-year-20210728-20260727.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "pages/audit/v6-independent-five-year-20210728-20260727.csv",
    `\uFEFF${csvRows.map((row) => row.join(",")).join("\n")}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        configSha256,
        range: report.range,
        metrics: report.metrics,
      },
      null,
      2,
    ),
  );
}

await main();
