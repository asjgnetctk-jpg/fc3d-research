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
const BACKFIT_START = "2026-05-01";
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

function ewmaPresence(history: Draw[], halfLife: number) {
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

function gapValues(history: Draw[]) {
  return DIGITS.map((digit) => {
    for (let age = 0; age < history.length; age += 1) {
      if (new Set(history[history.length - 1 - age].digits).has(digit)) return age;
    }
    return history.length;
  });
}

function positionPeak(history: Draw[]) {
  const rows = history.slice(-30);
  return DIGITS.map((digit) => {
    const counts = [0, 1, 2].map(
      (position) => rows.filter((row) => row.digits[position] === digit).length,
    );
    return Math.max(...counts) / rows.length;
  });
}

function rank(rows: FeatureRow[], score: "danScore" | "poolScore", target: "danRank" | "poolRank") {
  [...rows]
    .sort((left, right) => right[score] - left[score] || left.digit - right.digit)
    .forEach((row, index) => {
      row[target] = index + 1;
    });
}

function recommend(history: Draw[]) {
  const freq14 = presenceFrequency(history, 14);
  const z14 = zscore(freq14);
  const z30 = zscore(presenceFrequency(history, 30));
  const z60 = zscore(presenceFrequency(history, 60));
  const zEwma = zscore(ewmaPresence(history, 5));
  const zGap = zscore(gapValues(history));
  const zPeak = zscore(positionPeak(history));
  const rows: FeatureRow[] = DIGITS.map((digit) => ({
    digit,
    danScore: -z14[digit],
    poolScore:
      z30[digit] -
      z60[digit] -
      zEwma[digit] -
      zGap[digit] +
      zPeak[digit],
  }));
  rank(rows, "danScore", "danRank");
  rank(rows, "poolScore", "poolRank");
  return {
    dan: rows.find((row) => row.danRank === 2)!.digit,
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

function metrics<T extends { danHit: boolean; pool7Hit: boolean }>(
  rows: T[],
  field: "danHit" | "pool7Hit",
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
  const dayStart = dateDaysAgo(260);
  const dayEnd = shanghaiDate();
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${dayStart}&dayEnd=${dayEnd}&pageNo=1&pageSize=300&systemType=PC`;
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

    for (let index = 60; index < draws.length; index += 1) {
      const row = draws[index];
      if (row.date < BACKFIT_START) continue;
      const prediction = recommend(draws.slice(0, index));
      const actual = new Set(row.digits);
      const danHit = actual.has(prediction.dan);
      const pool7Hit =
        actual.size === 3 &&
        [...actual].every((digit) => prediction.pool7.includes(digit));
      danMissStreak = danHit ? 0 : danMissStreak + 1;
      pool7MissStreak = pool7Hit ? 0 : pool7MissStreak + 1;
      history.push({
        date: row.date,
        issue: row.issue,
        dan: prediction.dan,
        pool7: prediction.pool7.join(""),
        draw: row.draw,
        shape: shape(row.digits),
        danHit,
        pool7Hit,
        danMissStreak,
        pool7MissStreak,
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
        formulaVersion: "V1.0",
        lockDate: LOCK_DATE,
        recommendation: {
          targetIssue: incrementIssue(latest.issue),
          basedOnIssue: latest.issue,
          basedOnDate: latest.date,
          dan: upcoming.dan,
          pool7: upcoming.pool7.join(""),
        },
        history,
        metrics: {
          backfitDan: metrics(backfit, "danHit"),
          backfitPool7: metrics(backfit, "pool7Hit"),
          lockedDan: metrics(locked, "danHit"),
          lockedPool7: metrics(locked, "pool7Hit"),
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
