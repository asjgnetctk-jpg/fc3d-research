import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CWL_URL =
  "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=3d&dayStart=2004-01-01&dayEnd=2099-12-31" +
  "&pageNo=1&pageSize=10000&systemType=PC";
const SECONDARY_BASE =
  "https://datachart.500star.com/sd/history/inc/history.php";
const JS_ARCHIVE_BASE = "https://www.jslottery.com";
const JS_FIRST_OLD_PAGE = 239;
const JS_LAST_PAGE = 386;
const CACHE_PATH = "scripts/data/jslottery-2004-2012.json";
const SUPPLEMENT_CACHE_PATH = "scripts/data/jslottery-cwl-supplement.json";

const DATE_OVERRIDES = {
  "2005001": {
    date: "2005-01-01",
    source: "500 mirror and chronological sequence",
    reason: "Jiangsu detail page contains a wrong year in one date field",
  },
  "2005113": {
    date: "2005-04-30",
    source: "Jiangsu official archive",
    reason: "500 mirror contains a one-month typo",
  },
  "2005126": {
    date: "2005-05-13",
    source: "Jiangsu official archive",
    reason: "500 mirror date is shifted by one day",
  },
  "2005127": {
    date: "2005-05-14",
    source: "Jiangsu official archive",
    reason: "500 mirror date is shifted by one day",
  },
  "2005244": {
    date: "2005-09-08",
    source: "500 mirror and chronological sequence",
    reason: "Jiangsu parser picked a later notice date instead of draw date",
  },
  "2006193": {
    date: "2006-07-20",
    source: "Jiangsu official archive and chronological sequence",
    reason: "500 mirror duplicates the following issue date",
  },
};

function sha256(rows) {
  return createHash("sha256")
    .update(
      rows.map((row) => `${row.issue},${row.date},${row.draw}`).join("\n"),
      "utf8",
    )
    .digest("hex");
}

function normalize(rows) {
  return rows
    .filter(
      (row) =>
        /^\d{7}$/.test(row.issue) &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        /^\d{3}$/.test(row.draw),
    )
    .map((row) => ({
      issue: row.issue,
      date: row.date,
      draw: row.draw,
      digits: row.draw.split("").map(Number),
    }))
    .sort((left, right) => left.issue.localeCompare(right.issue));
}

function integrity(rows) {
  const issueCount = new Map();
  const dateCount = new Map();
  for (const row of rows) {
    issueCount.set(row.issue, (issueCount.get(row.issue) ?? 0) + 1);
    dateCount.set(row.date, (dateCount.get(row.date) ?? 0) + 1);
  }
  return {
    count: rows.length,
    first: rows[0],
    last: rows.at(-1),
    duplicateIssues: [...issueCount]
      .filter(([, count]) => count > 1)
      .map(([issue]) => issue),
    duplicateDates: [...dateCount]
      .filter(([, count]) => count > 1)
      .map(([date]) => date),
    sha256: sha256(rows),
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Referer: url.includes("jslottery")
        ? "https://www.jslottery.com/winning_history_a?locale=zh-CN&lottery_type_id=9"
        : "https://datachart.500star.com/sd/history/history.shtml",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/data-verification)",
    },
  });
  if (!response.ok) throw new Error(`request-failed:${response.status}:${url}`);
  return response.text();
}

async function fetchCwl() {
  const response = await fetch(CWL_URL, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/data-verification)",
    },
  });
  if (!response.ok) throw new Error(`cwl-request-failed:${response.status}`);
  const payload = await response.json();
  return normalize(
    (payload.result ?? []).map((item) => ({
      issue: String(item.code),
      date: item.date.slice(0, 10),
      draw: item.red.replaceAll(",", ""),
    })),
  );
}

async function fetchSecondary(latestIssue) {
  const url =
    `${SECONDARY_BASE}?start=2004001&end=${encodeURIComponent(latestIssue)}`;
  const html = await fetchText(url);
  const matches = [
    ...html.matchAll(
      /<tr class="t_tr1">[\s\S]*?<td>(\d{7})<\/td><td class="cfont2">\s*([0-9])\s+([0-9])\s+([0-9])\s*<\/td>[\s\S]*?<td class="t_tr1">(\d{4}-\d{2}-\d{2})<\/td><\/tr>/g,
    ),
  ];
  return {
    url,
    rows: normalize(
      matches.map((match) => ({
        issue: match[1],
        draw: `${match[2]}${match[3]}${match[4]}`,
        date: match[5],
      })),
    ),
  };
}

function decodeNumericEntities(html) {
  return html
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&nbsp;", " ");
}

function parseJiangsuDetail(html, expectedIssue) {
  const decoded = decodeNumericEntities(html);
  const issue =
    decoded.match(/<th[^>]*>\s*(\d{7})\s*<\/th>/)?.[1] ??
    decoded.match(/第\s*(\d{7})\s*期/)?.[1];
  if (issue !== expectedIssue) {
    throw new Error(`jiangsu-issue-mismatch:${expectedIssue}:${issue}`);
  }

  const marker = decoded.indexOf("\u4e2d\u5956\u53f7\u7801");
  if (marker < 0) throw new Error(`jiangsu-draw-marker-missing:${issue}`);
  let drawDigits = [
    ...decoded
      .slice(marker, marker + 2500)
      .matchAll(/<td[^>]*>\s*([0-9])\s*<\/td>/g),
  ]
    .slice(0, 3)
    .map((match) => match[1]);
  if (drawDigits.length !== 3) {
    drawDigits = [
      ...decoded
        .slice(marker, marker + 3500)
        .replace(/<[^>]+>/g, " ")
        .matchAll(/(?:^|\s)([0-9])(?=\s|$)/g),
    ]
      .slice(0, 3)
      .map((match) => match[1]);
  }
  if (drawDigits.length !== 3) {
    throw new Error(`jiangsu-draw-missing:${issue}`);
  }

  const plainText = decoded.replace(/<[^>]+>/g, " ");
  const dates = [
    ...plainText.matchAll(
      /(\d{4})\s*\u5e74\s*(\d{1,2})\s*\u6708\s*(\d{1,2})\s*\u65e5/g,
    ),
  ];
  const dateParts = dates.at(-1);
  const candidateDate = dateParts
    ? `${dateParts[1]}-${dateParts[2].padStart(2, "0")}-${dateParts[3].padStart(2, "0")}`
    : null;
  const date =
    candidateDate &&
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(candidateDate)
      ? candidateDate
      : null;
  return { issue, date, draw: drawDigits.join("") };
}

async function fetchJiangsuIndex() {
  const links = new Map();
  for (let page = JS_FIRST_OLD_PAGE; page <= JS_LAST_PAGE; page += 1) {
    const url =
      `${JS_ARCHIVE_BASE}/winning_history_a?locale=zh-CN` +
      `&lottery_type_id=9&page=${page}&periods=`;
    const html = await fetchText(url);
    for (const match of html.matchAll(
      /winning_detail\?id=(\d+)&amp;locale=zh-CN">[^<]*?(\d{7})/g,
    )) {
      if (match[2] <= "2013001") links.set(match[2], Number(match[1]));
    }
  }
  return [...links]
    .map(([issue, id]) => ({ issue, id }))
    .sort((left, right) => left.issue.localeCompare(right.issue));
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
      if ((index + 1) % 250 === 0) {
        console.log(`Jiangsu official archive: ${index + 1}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function fetchJiangsuArchive(secondaryRows) {
  try {
    const cached = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    const rows = normalize(cached.rows ?? []);
    if (
      rows[0]?.issue === "2004001" &&
      rows.at(-1)?.issue === "2013001" &&
      rows.length > 2900
    ) {
      return {
        rows,
        cached: true,
        indexCount: cached.indexCount,
        datesFromSecondary: cached.datesFromSecondary ?? 0,
        excludedIndexEntries: cached.excludedIndexEntries ?? [],
      };
    }
  } catch {
    // No verified cache yet.
  }

  const rawIndex = await fetchJiangsuIndex();
  const secondaryIssues = new Set(secondaryRows.map((row) => row.issue));
  const excludedIndexEntries = rawIndex.filter(
    (row) => !secondaryIssues.has(row.issue),
  );
  const index = rawIndex.filter((row) => secondaryIssues.has(row.issue));
  if (index[0]?.issue !== "2004001" || index.at(-1)?.issue !== "2013001") {
    throw new Error(
      `jiangsu-index-boundary:${index[0]?.issue}:${index.at(-1)?.issue}`,
    );
  }
  const secondaryByIssue = new Map(
    secondaryRows.map((row) => [row.issue, row]),
  );
  const detailRows = await mapConcurrent(index, 12, async ({ issue, id }) => {
    const url = `${JS_ARCHIVE_BASE}/winning_detail?id=${id}&locale=zh-CN`;
    return parseJiangsuDetail(await fetchText(url), issue);
  });
  const datesFromSecondary = detailRows.filter((row) => !row.date).length;
  const rows = normalize(
    detailRows.map((row) => ({
      ...row,
      date: row.date ?? secondaryByIssue.get(row.issue)?.date ?? "",
    })),
  );
  await mkdir("scripts/data", { recursive: true });
  await writeFile(
    CACHE_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: `${JS_ARCHIVE_BASE}/winning_history_a?locale=zh-CN&lottery_type_id=9`,
        indexPages: [JS_FIRST_OLD_PAGE, JS_LAST_PAGE],
        indexCount: rawIndex.length,
        excludedIndexEntries,
        datesFromSecondary,
        rows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    rows,
    cached: false,
    indexCount: rawIndex.length,
    excludedIndexEntries,
    datesFromSecondary,
  };
}

async function fetchJiangsuIssues(issues, secondaryRows) {
  if (!issues.length) return { rows: [], cached: true };
  try {
    const cached = JSON.parse(await readFile(SUPPLEMENT_CACHE_PATH, "utf8"));
    const rows = normalize(cached.rows ?? []);
    const cachedIssues = new Set(rows.map((row) => row.issue));
    if (issues.every((issue) => cachedIssues.has(issue))) {
      return { rows, cached: true };
    }
  } catch {
    // No complete verified supplement cache yet.
  }

  const secondaryByIssue = new Map(
    secondaryRows.map((row) => [row.issue, row]),
  );
  const rows = await mapConcurrent(issues, 8, async (issue) => {
    const searchUrl =
      `${JS_ARCHIVE_BASE}/winning_history_a?locale=zh-CN` +
      `&lottery_type_id=9&periods=${issue}`;
    const html = await fetchText(searchUrl);
    const links = [
      ...html.matchAll(
        /winning_detail\?id=(\d+)&amp;locale=zh-CN">[^<]*?(\d{7})/g,
      ),
    ];
    const match = links.find((entry) => entry[2] === issue);
    if (!match) throw new Error(`jiangsu-search-missing:${issue}`);
    const detailUrl =
      `${JS_ARCHIVE_BASE}/winning_detail?id=${match[1]}&locale=zh-CN`;
    const detail = parseJiangsuDetail(await fetchText(detailUrl), issue);
    return {
      ...detail,
      date: detail.date ?? secondaryByIssue.get(issue)?.date ?? "",
    };
  });

  const normalized = normalize(rows);
  await mkdir("scripts/data", { recursive: true });
  await writeFile(
    SUPPLEMENT_CACHE_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: `${JS_ARCHIVE_BASE}/winning_history_a?locale=zh-CN&lottery_type_id=9`,
        requestedIssues: issues,
        rows: normalized,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { rows: normalized, cached: false };
}

function compare(
  leftRows,
  rightRows,
  startIssue = null,
  endIssue = null,
  fields = ["date", "draw"],
) {
  const right = new Map(rightRows.map((row) => [row.issue, row]));
  const scoped = leftRows.filter(
    (row) =>
      (!startIssue || row.issue >= startIssue) &&
      (!endIssue || row.issue <= endIssue),
  );
  const missing = [];
  const conflicts = [];
  for (const left of scoped) {
    const candidate = right.get(left.issue);
    if (!candidate) {
      missing.push(left.issue);
      continue;
    }
    if (fields.some((field) => left[field] !== candidate[field])) {
      conflicts.push({
        issue: left.issue,
        fields,
        left: Object.fromEntries(fields.map((field) => [field, left[field]])),
        right: Object.fromEntries(
          fields.map((field) => [field, candidate[field]]),
        ),
      });
    }
  }
  return {
    checked: scoped.length,
    missing,
    conflicts,
    passed: missing.length === 0 && conflicts.length === 0,
  };
}

function expectedIssueGaps(rows) {
  const byYear = new Map();
  for (const row of rows) {
    const year = row.issue.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(Number(row.issue.slice(4)));
  }
  const gaps = [];
  for (const [year, sequences] of byYear) {
    const present = new Set(sequences);
    const first = Math.min(...sequences);
    const last = Math.max(...sequences);
    for (let sequence = first; sequence <= last; sequence += 1) {
      if (!present.has(sequence)) {
        gaps.push(`${year}${String(sequence).padStart(3, "0")}`);
      }
    }
  }
  return gaps;
}

async function main() {
  console.log("Reading China Welfare Lottery national API");
  const cwl = await fetchCwl();
  if (cwl[0]?.issue !== "2013002") {
    throw new Error(`unexpected-cwl-first:${cwl[0]?.issue}`);
  }
  console.log(
    `National API: ${cwl.length} rows, ${cwl[0].issue}-${cwl.at(-1).issue}`,
  );

  console.log("Reading 500 full-history mirror");
  const secondary = await fetchSecondary(cwl.at(-1).issue);
  if (
    secondary.rows[0]?.issue !== "2004001" ||
    secondary.rows.at(-1)?.issue !== cwl.at(-1).issue
  ) {
    throw new Error(
      `secondary-boundary:${secondary.rows[0]?.issue}:${secondary.rows.at(-1)?.issue}`,
    );
  }

  console.log("Reading Jiangsu official old archive");
  const jiangsu = await fetchJiangsuArchive(secondary.rows);
  const nationalDrawCheck = compare(
    cwl,
    secondary.rows,
    null,
    null,
    ["draw"],
  );
  const oldDrawCheck = compare(
    jiangsu.rows,
    secondary.rows,
    "2004001",
    "2013001",
    ["draw"],
  );
  const oldDateAudit = compare(
    jiangsu.rows,
    secondary.rows,
    "2004001",
    "2013001",
    ["date"],
  );

  const cwlIssues = new Set(cwl.map((row) => row.issue));
  const missingFromCwl = secondary.rows
    .filter((row) => row.issue >= "2013002" && !cwlIssues.has(row.issue))
    .map((row) => row.issue);
  console.log(
    `Verifying ${missingFromCwl.length} mirror rows omitted by national API`,
  );
  const supplement = await fetchJiangsuIssues(missingFromCwl, secondary.rows);
  const supplementDrawCheck = compare(
    supplement.rows,
    secondary.rows,
    null,
    null,
    ["draw"],
  );

  const firstIssueCheck =
    jiangsu.rows[0]?.issue === "2004001" &&
    jiangsu.rows[0]?.date === "2004-10-18" &&
    jiangsu.rows[0]?.draw === "070";
  const cwlByIssue = new Map(cwl.map((row) => [row.issue, row]));
  const jiangsuByIssue = new Map(
    [...jiangsu.rows, ...supplement.rows].map((row) => [row.issue, row]),
  );
  const allRows = normalize(
    secondary.rows.map((mirror) => {
      const official =
        cwlByIssue.get(mirror.issue) ?? jiangsuByIssue.get(mirror.issue);
      const override = DATE_OVERRIDES[mirror.issue];
      return {
        issue: mirror.issue,
        draw: official?.draw ?? mirror.draw,
        date: override?.date ?? official?.date ?? mirror.date,
      };
    }),
  );
  const allIntegrity = integrity(allRows);
  const issueGaps = expectedIssueGaps(allRows);
  const officialCoverageMissing = allRows
    .filter((row) => !cwlByIssue.has(row.issue) && !jiangsuByIssue.has(row.issue))
    .map((row) => row.issue);

  const report = {
    generatedAt: new Date().toISOString(),
    passed:
      nationalDrawCheck.passed &&
      oldDrawCheck.passed &&
      supplementDrawCheck.passed &&
      firstIssueCheck &&
      officialCoverageMissing.length === 0 &&
      issueGaps.length === 0 &&
      allIntegrity.duplicateIssues.length === 0 &&
      allIntegrity.duplicateDates.length === 0,
    range: {
      firstIssue: allRows[0]?.issue,
      firstDate: allRows[0]?.date,
      lastIssue: allRows.at(-1)?.issue,
      lastDate: allRows.at(-1)?.date,
      count: allRows.length,
    },
    sources: {
      cwl: { url: CWL_URL, integrity: integrity(cwl) },
      jiangsuOfficialArchive: {
        url: `${JS_ARCHIVE_BASE}/winning_history_a?locale=zh-CN&lottery_type_id=9`,
        cached: jiangsu.cached,
        indexCount: jiangsu.indexCount,
        excludedIndexEntries: jiangsu.excludedIndexEntries,
        datesFromSecondary: jiangsu.datesFromSecondary,
        integrity: integrity(jiangsu.rows),
      },
      jiangsuOfficialSupplement: {
        cached: supplement.cached,
        requestedIssues: missingFromCwl.length,
        integrity: integrity(supplement.rows),
      },
      secondaryMirror: {
        url: secondary.url,
        integrity: integrity(secondary.rows),
      },
    },
    checks: {
      cwlVsSecondaryDraws: nationalDrawCheck,
      jiangsuVsSecondaryDraws: oldDrawCheck,
      jiangsuVsSecondaryDateAudit: oldDateAudit,
      jiangsuSupplementVsSecondaryDraws: supplementDrawCheck,
      officialCoverage: {
        checked: allRows.length,
        missing: officialCoverageMissing,
        passed: officialCoverageMissing.length === 0,
      },
      issueSequence: {
        gaps: issueGaps,
        passed: issueGaps.length === 0,
      },
      officialFirstIssue2004001: {
        passed: firstIssueCheck,
        expected: {
          issue: "2004001",
          date: "2004-10-18",
          draw: "070",
        },
        actual: jiangsu.rows[0],
      },
    },
    dateOverrides: DATE_OVERRIDES,
    canonicalIntegrity: allIntegrity,
    canonicalSha256: sha256(allRows),
  };

  await mkdir("scripts/results", { recursive: true });
  await writeFile(
    "scripts/results/full-history-integrity.json",
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    "scripts/data/fc3d-full-history.json",
    `${JSON.stringify(
      {
        generatedAt: report.generatedAt,
        canonicalSha256: report.canonicalSha256,
        rows: allRows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error("full-history-integrity-failed");
}

await main();
