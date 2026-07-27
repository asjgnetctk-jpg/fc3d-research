import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type Draw = {
  date: string;
  issue: string;
  digits: number[];
  draw: string;
};

type FeatureRow = {
  digit: number;
  danScore: number;
  poolScore: number;
  danRank?: number;
  poolRank?: number;
};

const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const LOCK_DATE = "2026-07-28";
const BACKFIT_START = "2023-07-28";
const BACKFIT_END = "2026-07-27";

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return shanghaiDate(date);
}

function zscore(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return sd > 1e-12 ? values.map((value) => (value - mean) / sd) : values.map(() => 0);
}

function presenceFrequency(history: Draw[], window: number) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => new Set(row.digits).has(digit)).length / rows.length,
  );
}

function occurrenceFrequency(history: Draw[], window: number) {
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

function gapValues(history: Draw[]) {
  return DIGITS.map((digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (new Set(history[history.length - 1 - age].digits).has(digit)) return age;
    }
    return history.length;
  });
}

function positionFrequency(history: Draw[], window: number, position: number) {
  const rows = history.slice(-window);
  return DIGITS.map(
    (digit) => rows.filter((row) => row.digits[position] === digit).length / rows.length,
  );
}

function rank(rows: FeatureRow[], score: "danScore" | "poolScore", target: "danRank" | "poolRank") {
  [...rows]
    .sort((left, right) => right[score] - left[score] || left.digit - right.digit)
    .forEach((row, index) => {
      row[target] = index + 1;
    });
}

function recommend(history: Draw[]) {
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
  const rows: FeatureRow[] = DIGITS.map((digit) => ({
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
  rank(rows, "danScore", "danRank");
  rank(rows, "poolScore", "poolRank");
  return {
    dan: rows.find((row) => row.danRank === 4)!.digit,
    pool7: rows
      .filter((row) => (row.poolRank ?? 99) <= 7)
      .map((row) => row.digit)
      .sort((left, right) => left - right),
  };
}

function shape(digits: number[]) {
  const unique = new Set(digits).size;
  return unique === 1 ? "豹子" : unique === 2 ? "组三" : "组六";
}

function incrementIssue(issue: string) {
  return String(Number(issue) + 1).padStart(issue.length, "0");
}

function metrics<T extends { danHit: boolean; pool7Hit: boolean; group3Hit: boolean }>(
  rows: T[],
  field: "danHit" | "pool7Hit" | "group3Hit",
) {
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
  const dayStart = dateDaysAgo(1700);
  const dayEnd = shanghaiDate();
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${dayStart}&dayEnd=${dayEnd}&pageNo=1&pageSize=1800&systemType=PC`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = (await response.json()) as {
    result?: Array<{ date: string; code: string; red: string }>;
  };
  return (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: item.code,
      digits: item.red.split(",").map(Number),
      draw: item.red.replaceAll(",", ""),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export async function GET() {
  try {
    const draws = await fetchDraws();
    if (draws.length < 61) throw new Error("insufficient-history");

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
        actual.size === 3 &&
        [...actual].every((digit) => prediction.pool7.includes(digit));
      const pool7Group3Covered =
        actual.size === 2 &&
        [...actual].every((digit) => prediction.pool7.includes(digit));
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
        phase: row.date >= LOCK_DATE ? ("locked" as const) : ("backfit" as const),
      });
    }

    const latest = draws.at(-1)!;
    const upcoming = recommend(draws);
    const backfit = history.filter(
      (row) => row.date >= BACKFIT_START && row.date <= BACKFIT_END,
    );
    const locked = history.filter((row) => row.date >= LOCK_DATE);

    return NextResponse.json(
      {
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
        },
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    console.error("recommendation-api", error);
    return NextResponse.json(
      { error: "暂时无法读取官方开奖数据，请稍后刷新。" },
      { status: 503 },
    );
  }
}
