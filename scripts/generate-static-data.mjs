import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const LOCK_DATE = "2026-07-28";
const BACKFIT_START = "2023-07-28";
const BACKFIT_END = "2026-07-27";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return shanghaiDate(date);
}

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

function ewmaPresence(history, halfLife) {
  const decay = Math.exp(Math.log(0.5) / halfLife);
  const rows = history.slice(-60).reverse();
  const totals = Array(10).fill(0);
  let totalWeight = 0;
  rows.forEach((row, age) => {
    const weight = decay ** age;
    totalWeight += weight;
    const present = new Set(row.digits);
    for (const digit of DIGITS) {
      if (present.has(digit)) totals[digit] += weight;
    }
  });
  return totals.map((value) => value / totalWeight);
}

function gapValues(history) {
  return DIGITS.map((digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (new Set(history[history.length - 1 - age].digits).has(digit)) return age;
    }
    return history.length;
  });
}

function positionFrequency(history, window, position) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => row.digits[position] === digit).length / rows.length,
  );
}

function recommend(history) {
  const zPresence5 = zscore(presenceFrequency(history, 5));
  const zPresence7 = zscore(presenceFrequency(history, 7));
  const zPresence45 = zscore(presenceFrequency(history, 45));
  const zPresence3 = zscore(presenceFrequency(history, 3));
  const zOccurrence14 = zscore(occurrenceFrequency(history, 14));
  const zOccurrence60 = zscore(occurrenceFrequency(history, 60));
  const zOccurrence90 = zscore(occurrenceFrequency(history, 90));
  const zOccurrence120 = zscore(occurrenceFrequency(history, 120));
  const zPosition1_10 = zscore(positionFrequency(history, 10, 0));
  const zPosition3_30 = zscore(positionFrequency(history, 30, 2));
  const zPosition3_60 = zscore(positionFrequency(history, 60, 2));
  const zLast2 = zscore(presenceFrequency(history, 2));
  const rows = DIGITS.map((digit) => ({
    digit,
    danScore:
      -2 * zPresence3[digit] -
      2 * zOccurrence14[digit] +
      zOccurrence60[digit] +
      3 * zOccurrence90[digit] -
      3 * zOccurrence120[digit] -
      2 * zPosition1_10[digit] +
      3 * zPosition3_30[digit] -
      zPosition3_60[digit] -
      zLast2[digit],
    poolScore:
      -zPresence5[digit] + zPresence7[digit] + zPresence45[digit],
  }));
  const danRank = [...rows].sort(
    (left, right) => right.danScore - left.danScore || left.digit - right.digit,
  );
  const poolRank = [...rows].sort(
    (left, right) => right.poolScore - left.poolScore || left.digit - right.digit,
  );
  return {
    dan: danRank[3].digit,
    pool7: poolRank
      .slice(0, 7)
      .map((row) => row.digit)
      .sort((left, right) => left - right),
  };
}

function shape(digits) {
  const unique = new Set(digits).size;
  return unique === 1 ? "豹子" : unique === 2 ? "组三" : "组六";
}

function incrementIssue(issue) {
  return String(Number(issue) + 1).padStart(issue.length, "0");
}

function metrics(rows, field) {
  let maxMiss = 0;
  let current = 0;
  let hits = 0;
  rows.forEach((row) => {
    if (row[field]) {
      hits += 1;
      current = 0;
    } else {
      current += 1;
      maxMiss = Math.max(maxMiss, current);
    }
  });
  return {
    count: rows.length,
    hits,
    rate: rows.length ? hits / rows.length : 0,
    maxMiss,
  };
}

async function fetchDraws() {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${dateDaysAgo(1700)}&dayEnd=${shanghaiDate()}` +
    "&pageNo=1&pageSize=1800&systemType=PC";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/1.0)",
    },
  });
  if (!response.ok) throw new Error(`官方数据请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  const draws = (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: item.code,
      digits: item.red.split(",").map(Number),
      draw: item.red.replaceAll(",", ""),
    }))
    .filter(
      (item) =>
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        /^\d+$/.test(item.issue) &&
        item.digits.length === 3 &&
        item.digits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  if (draws.length < 61) throw new Error(`有效历史数据不足：${draws.length}期`);
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
    console.warn(
      `官方数据暂时不可用，保留已核验快照：${existing.sourceUpdatedThrough}；${error.message}`,
    );
    return;
  }
  const history = [];
  let danMissStreak = 0;
  let pool7MissStreak = 0;
  let group3MissStreak = 0;

  for (let index = 60; index < draws.length; index += 1) {
    const row = draws[index];
    if (row.date < BACKFIT_START) continue;
    const prediction = recommend(draws.slice(0, index));
    const actual = new Set(row.digits);
    const danHit = actual.has(prediction.dan);
    const pool7Hit =
      actual.size === 3 && [...actual].every((digit) => prediction.pool7.includes(digit));
    const pool7Group3Covered =
      actual.size === 2 && [...actual].every((digit) => prediction.pool7.includes(digit));
    const group3Hit = actual.size === 2;
    danMissStreak = danHit ? 0 : danMissStreak + 1;
    pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
    group3MissStreak = group3Hit ? 0 : group3MissStreak + 1;
    history.push({
      date: row.date,
      issue: row.issue,
      dan: prediction.dan,
      pool7: prediction.pool7.join(""),
      draw: row.draw,
      shape: shape(row.digits),
      danHit,
      pool7Hit,
      pool7Group3Covered,
      group3Hit,
      danMissStreak,
      pool7MissStreak,
      group3MissStreak,
      phase: row.date >= LOCK_DATE ? "locked" : "backfit",
    });
  }

  const latest = draws.at(-1);
  const upcoming = recommend(draws);
  const backfit = history.filter(
    (row) => row.date >= BACKFIT_START && row.date <= BACKFIT_END,
  );
  const locked = history.filter((row) => row.date >= LOCK_DATE);
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
    formulaVersion: "V4.0",
    lockDate: LOCK_DATE,
    recommendation: {
      targetIssue: incrementIssue(latest.issue),
      basedOnIssue: latest.issue,
      basedOnDate: latest.date,
      dan: upcoming.dan,
      pool7: upcoming.pool7.join(""),
      group3: "组三",
    },
    history,
    metrics: {
      backfitDan: metrics(backfit, "danHit"),
      backfitPool7: metrics(backfit, "pool7Hit"),
      lockedDan: metrics(locked, "danHit"),
      lockedPool7: metrics(locked, "pool7Hit"),
      backfitGroup3: metrics(backfit, "group3Hit"),
      lockedGroup3: metrics(locked, "group3Hit"),
      backfitPool7Group3: {
        count: backfit.filter((row) => row.shape === "组三").length,
        hits: backfit.filter((row) => row.pool7Group3Covered).length,
      },
      lockedPool7Group3: {
        count: locked.filter((row) => row.shape === "组三").length,
        hits: locked.filter((row) => row.pool7Group3Covered).length,
      },
    },
  };

  await mkdir(path.join(root, "pages"), { recursive: true });
  await writeFile(
    path.join(root, "pages", "data.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `已生成：${latest.issue}期后推荐 胆${upcoming.dan} / 7码${upcoming.pool7.join("")}`,
  );
}

await main();
