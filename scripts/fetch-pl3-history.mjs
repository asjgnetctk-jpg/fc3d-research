import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "scripts", "data", "pl3-full-history.json");
const reportPath = path.join(
  root,
  "scripts",
  "results",
  "pl3-full-history-integrity.json",
);
const sourceUrl =
  "https://api.js-lottery.com/Lottery/_ListData?itemType=p3";
const pageSize = 100;

function decodeHtml(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#160;", " ")
    .replaceAll("&amp;", "&");
}

function parseRows(html) {
  const rows = [];
  const rowPattern = /<tr>([\s\S]*?)<\/tr>/g;
  for (const match of html.matchAll(rowPattern)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (cell) =>
        decodeHtml(cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    );
    if (cells.length < 3) continue;
    const date = cells[0].match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const issue = cells[1].match(/\d{5}/)?.[0];
    const digits = cells[2].match(/\d/g)?.slice(0, 3).map(Number);
    if (!date || !issue || digits?.length !== 3) continue;
    rows.push({
      date,
      issue,
      digits,
      draw: digits.join(""),
    });
  }
  return rows;
}

async function fetchPage(pageIndex, attempt = 1) {
  const url =
    `${sourceUrl}&pageindex=${pageIndex}&pageSize=${pageSize}` +
    `&_=${Date.now()}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://api.js-lottery.com/wfzq/p3p5/p3data",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`pl3-official-${response.status}`);
    const html = await response.text();
    const rows = parseRows(html);
    if (!rows.length) throw new Error(`pl3-page-${pageIndex}-empty`);
    const total = Number(html.match(/data-sum="(\d+)"/)?.[1] ?? 0);
    return { rows, total };
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    return fetchPage(pageIndex, attempt + 1);
  }
}

async function fetchEarlySupplement(issue, attempt = 1) {
  const url =
    `https://open.500.com/iframe/kaijiang/pls.php?expect=${issue}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`pl3-supplement-${response.status}`);
    const html = new TextDecoder("gb18030").decode(await response.arrayBuffer());
    const dateMatch = html.match(
      /开奖日期[：:]\s*(\d{4})年(\d{2})月(\d{2})日/,
    );
    const drawBlock = html.match(/开奖号码[：:][\s\S]{0,800}?<\/ul>/)?.[0] ?? "";
    const digits = [...drawBlock.matchAll(/ball_orange">\s*(\d)\s*</g)].map(
      (match) => Number(match[1]),
    );
    if (!dateMatch || digits.length !== 3) {
      throw new Error(`pl3-supplement-${issue}-invalid`);
    }
    return {
      date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
      issue,
      digits,
      draw: digits.join(""),
    };
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    return fetchEarlySupplement(issue, attempt + 1);
  }
}

function sha256(rows) {
  return createHash("sha256")
    .update(rows.map((row) => `${row.issue},${row.date},${row.draw}`).join("\n"))
    .digest("hex");
}

const firstPage = await fetchPage(1);
const total = firstPage.total || firstPage.rows.length;
const pageCount = Math.ceil(total / pageSize);
const rows = [...firstPage.rows];

for (let start = 2; start <= pageCount; start += 8) {
  const indexes = Array.from(
    { length: Math.min(8, pageCount - start + 1) },
    (_, offset) => start + offset,
  );
  const pages = await Promise.all(indexes.map((index) => fetchPage(index)));
  for (const page of pages) rows.push(...page.rows);
  console.log(`Fetched PL3 ${Math.min(start + 7, pageCount)}/${pageCount} pages`);
}

const supplementIssues = Array.from(
  { length: 8 },
  (_, index) => `04${String(index + 1).padStart(3, "0")}`,
);
const supplementRows = [];
for (const issue of supplementIssues) {
  supplementRows.push(await fetchEarlySupplement(issue));
}
rows.push(...supplementRows);

const unique = new Map(rows.map((row) => [row.issue, row]));
const canonicalRows = [...unique.values()].sort((left, right) =>
  left.issue.localeCompare(right.issue),
);
const duplicateIssueCount = rows.length - unique.size;
const duplicateDates = canonicalRows
  .map((row) => row.date)
  .filter((date, index, all) => all.indexOf(date) !== index);

if (canonicalRows.length !== total + supplementRows.length) {
  throw new Error(
    `pl3-count-mismatch: expected ${total + supplementRows.length}, received ${canonicalRows.length}`,
  );
}
if (duplicateIssueCount) {
  throw new Error(
    `pl3-duplicate-data: issues=${duplicateIssueCount}, dates=${duplicateDates.length}`,
  );
}
if (
  canonicalRows.some(
    (row) =>
      !/^\d{5}$/.test(row.issue) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !/^\d{3}$/.test(row.draw),
  )
) {
  throw new Error("pl3-invalid-row-format");
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: "江苏省体育彩票管理中心排列3历史数据",
  sourceUrl: "https://api.js-lottery.com/wfzq/p3p5/p3data",
  supplement: {
    range: "04001-04008",
    source: "500彩票网历史开奖页；04001与04004另由同期公开报道交叉核对",
    sourceUrl: "https://open.500.com/iframe/kaijiang/pls.php",
  },
  canonicalSha256: sha256(canonicalRows),
  sameDateDraws: [...new Set(duplicateDates)],
  rows: canonicalRows,
};

await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      version: "pl3-integrity-1",
      generatedAt: payload.generatedAt,
      passed: true,
      range: {
        firstIssue: canonicalRows[0].issue,
        firstDate: canonicalRows[0].date,
        lastIssue: canonicalRows.at(-1).issue,
        lastDate: canonicalRows.at(-1).date,
        count: canonicalRows.length,
      },
      canonicalSha256: payload.canonicalSha256,
      sources: {
        primary: {
          name: payload.source,
          url: payload.sourceUrl,
          periods: total,
        },
        supplement: {
          ...payload.supplement,
          periods: supplementRows.length,
        },
      },
      checks: {
        expectedCount: total + supplementRows.length,
        actualCount: canonicalRows.length,
        duplicateIssues: [],
        sameDateDraws: payload.sameDateDraws,
        invalidRows: 0,
        passed: true,
      },
      warning:
        "04001-04008 are absent from the primary provincial archive and are supplied from a historical result archive. 04001 and 04004 were separately cross-checked against contemporaneous public reports.",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(
  `Saved ${canonicalRows.length} PL3 draws: ${canonicalRows[0].issue} ${canonicalRows[0].date} -> ${canonicalRows.at(-1).issue} ${canonicalRows.at(-1).date}`,
);
