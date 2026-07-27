import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const FETCH_START = "2025-04-01";
const TEST_START = "2025-07-28";
const TEST_END = "2026-07-27";
const FORMULA_VERSION = "V2.0";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "pages", "audit");

function zscore(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return sd > 1e-12 ? values.map((value) => (value - mean) / sd) : values.map(() => 0);
}

function presenceFrequency(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => new Set(row.digits).has(digit)).length / rows.length,
  );
}

function occurrenceFrequency(history, window) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) =>
      rows.reduce(
        (sum, row) => sum + row.digits.filter((value) => value === digit).length,
        0,
      ) /
      (rows.length * 3),
  );
}

function gapValues(history) {
  return DIGITS.map((digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (history[history.length - 1 - age].digits.includes(digit)) return age;
    }
    return history.length;
  });
}

function recommend(history) {
  const zPresence5 = zscore(presenceFrequency(history, 5));
  const zPresence7 = zscore(presenceFrequency(history, 7));
  const zPresence45 = zscore(presenceFrequency(history, 45));
  const zOccurrence10 = zscore(occurrenceFrequency(history, 10));
  const zGap = zscore(gapValues(history));
  const rows = DIGITS.map((digit) => ({
    digit,
    danScore: -2 * zPresence7[digit] + zOccurrence10[digit] - zGap[digit],
    poolScore:
      -zPresence5[digit] + zPresence7[digit] + zPresence45[digit],
  }));
  const danRanking = [...rows].sort(
    (left, right) => right.danScore - left.danScore || left.digit - right.digit,
  );
  const poolRanking = [...rows].sort(
    (left, right) => right.poolScore - left.poolScore || left.digit - right.digit,
  );
  return {
    dan: danRanking[3].digit,
    pool7: poolRanking
      .slice(0, 7)
      .map((row) => row.digit)
      .sort((left, right) => left - right),
  };
}

function shape(digits) {
  const unique = new Set(digits).size;
  return unique === 1 ? "豹子" : unique === 2 ? "组三" : "组六";
}

function metric(rows, field) {
  let hits = 0;
  let currentMiss = 0;
  let currentStart = null;
  let longest = { length: 0, startIssue: null, startDate: null, endIssue: null, endDate: null };
  for (const row of rows) {
    if (row[field]) {
      hits += 1;
      currentMiss = 0;
      currentStart = null;
      continue;
    }
    if (currentMiss === 0) currentStart = row;
    currentMiss += 1;
    if (currentMiss > longest.length) {
      longest = {
        length: currentMiss,
        startIssue: currentStart.issue,
        startDate: currentStart.date,
        endIssue: row.issue,
        endDate: row.date,
      };
    }
  }
  return {
    count: rows.length,
    hits,
    rate: hits / rows.length,
    longestMiss: longest,
  };
}

function validateDraws(draws) {
  const duplicateIssues = [];
  const duplicateDates = [];
  const invalidRows = [];
  const issueGaps = [];
  const seenIssues = new Set();
  const seenDates = new Set();
  draws.forEach((row, index) => {
    if (seenIssues.has(row.issue)) duplicateIssues.push(row.issue);
    if (seenDates.has(row.date)) duplicateDates.push(row.date);
    seenIssues.add(row.issue);
    seenDates.add(row.date);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !/^\d{7}$/.test(row.issue) ||
      row.digits.length !== 3 ||
      row.digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)
    ) {
      invalidRows.push(row);
    }
    if (index === 0) return;
    const previous = draws[index - 1];
    const currentYear = row.issue.slice(0, 4);
    const previousYear = previous.issue.slice(0, 4);
    if (currentYear === previousYear) {
      const expected = Number(previous.issue.slice(4)) + 1;
      const actual = Number(row.issue.slice(4));
      if (actual !== expected) {
        issueGaps.push({
          afterIssue: previous.issue,
          beforeIssue: row.issue,
          expectedSerial: expected,
          actualSerial: actual,
        });
      }
    }
  });
  return {
    duplicateIssues,
    duplicateDates,
    invalidRowCount: invalidRows.length,
    issueGaps,
    passed:
      duplicateIssues.length === 0 &&
      duplicateDates.length === 0 &&
      invalidRows.length === 0 &&
      issueGaps.length === 0,
  };
}

async function fetchOfficialDraws() {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${FETCH_START}&dayEnd=${TEST_END}` +
    "&pageNo=1&pageSize=700&systemType=PC";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearchAudit/2.0)",
    },
  });
  if (!response.ok) throw new Error(`中国福利彩票官网返回HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.result ?? [];
  const draws = result
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      digits: String(item.red).split(",").map(Number),
      draw: String(item.red).replaceAll(",", ""),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return { url, draws };
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const retrievedAt = new Date().toISOString();
  const { url, draws } = await fetchOfficialDraws();
  const integrity = validateDraws(draws);
  if (!integrity.passed) {
    throw new Error(`官方数据完整性检查失败：${JSON.stringify(integrity)}`);
  }

  const rows = [];
  for (let index = 0; index < draws.length; index += 1) {
    const actualRow = draws[index];
    if (actualRow.date < TEST_START || actualRow.date > TEST_END) continue;
    const prior = draws.slice(0, index);
    if (prior.length < 60) {
      throw new Error(`第${actualRow.issue}期之前只有${prior.length}期预热数据`);
    }
    const prediction = recommend(prior);
    const actual = new Set(actualRow.digits);
    const danHit = actual.has(prediction.dan);
    const pool7Hit =
      actual.size === 3 && [...actual].every((digit) => prediction.pool7.includes(digit));
    rows.push({
      date: actualRow.date,
      issue: actualRow.issue,
      basedOnIssue: prior.at(-1).issue,
      dan: prediction.dan,
      pool7: prediction.pool7.join(""),
      draw: actualRow.draw,
      shape: shape(actualRow.digits),
      danHit,
      pool7Hit,
    });
  }

  const canonicalRaw = rows
    .map((row) => `${row.date},${row.issue},${row.draw}`)
    .join("\n");
  const sourceSha256 = createHash("sha256").update(canonicalRaw, "utf8").digest("hex");
  const audit = {
    auditVersion: "1.0",
    formulaVersion: FORMULA_VERSION,
    testRange: { start: TEST_START, end: TEST_END },
    methodology: {
      rolling: true,
      futureDataUsedForEachPrediction: false,
      formulaSelectionWarning:
        "V2公式曾使用2026-03-01至2026-07-27数据进行筛选，因此本报告是真实逐期回算，但整个一年区间不是完全独立的前瞻实验。",
      danRule:
        "score=-2*Z(7期出现率)+Z(10期总出现频率)-Z(遗漏)，按分数降序取第4名",
      pool7Rule:
        "score=-Z(5期出现率)+Z(7期出现率)+Z(45期出现率)，按分数降序取前7名",
      pool7HitRule: "开奖号为组六，且三个不同数字全部进入7码池",
    },
    source: {
      provider: "中国福利彩票官网",
      requestUrl: url,
      retrievedAt,
      fetchedRange: { start: FETCH_START, end: TEST_END },
      fetchedCount: draws.length,
      testCount: rows.length,
      firstTestDraw: rows.at(0),
      lastTestDraw: rows.at(-1),
      canonicalTestDataSha256: sourceSha256,
    },
    integrity,
    metrics: {
      dan: metric(rows, "danHit"),
      pool7: metric(rows, "pool7Hit"),
    },
    rows,
  };

  const csvHeaders = [
    "日期",
    "期号",
    "仅依据截至期号",
    "独胆推荐",
    "7码推荐",
    "开奖号",
    "形态",
    "独胆命中",
    "7码命中",
  ];
  const csvRows = rows.map((row) => [
    row.date,
    row.issue,
    row.basedOnIssue,
    row.dan,
    row.pool7,
    row.draw,
    row.shape,
    row.danHit ? "中" : "未中",
    row.pool7Hit ? "中" : "未中",
  ]);
  const csv = [csvHeaders, ...csvRows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  const summary = `# 福彩3D V2一年真实滚动回测

- 数据来源：中国福利彩票官网
- 测试区间：${TEST_START}—${TEST_END}
- 有效开奖：${rows.length}期
- 数据完整性：${integrity.passed ? "通过" : "未通过"}
- 原始测试数据SHA-256：\`${sourceSha256}\`

## 结果

| 项目 | 命中 | 命中率 | 最长连续未中 |
|---|---:|---:|---:|
| 独胆 | ${audit.metrics.dan.hits}/${audit.metrics.dan.count} | ${(audit.metrics.dan.rate * 100).toFixed(2)}% | ${audit.metrics.dan.longestMiss.length}期 |
| 7码 | ${audit.metrics.pool7.hits}/${audit.metrics.pool7.count} | ${(audit.metrics.pool7.rate * 100).toFixed(2)}% | ${audit.metrics.pool7.longestMiss.length}期 |

## 口径限制

每一期只使用该期开奖之前的数据计算。V2公式曾使用2026-03-01至2026-07-27数据筛选，因此结果是真实回算，但不能包装成完整一年的独立前瞻实验。真正独立封盘从2026-07-28开始。
`;

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "v2-one-year-20250728-20260727.json"),
    `${JSON.stringify(audit, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "v2-one-year-20250728-20260727.csv"),
    `\uFEFF${csv}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "v2-one-year-20250728-20260727.md"),
    summary,
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        testCount: rows.length,
        integrity,
        sha256: sourceSha256,
        metrics: audit.metrics,
      },
      null,
      2,
    ),
  );
}

await main();
