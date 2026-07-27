import { NextResponse } from "next/server";
import config from "@/lib/v5-config.json";
import { actualShape, recommendV5 } from "@/lib/v5-model.js";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type Draw = {
  date: string;
  issue: string;
  digits: number[];
  draw: string;
};

type HistoryRow = {
  date: string;
  issue: string;
  dan: number;
  pool7: string;
  shapePlay: string;
  draw: string;
  shape: string;
  danHit: boolean;
  pool7Hit: boolean;
  pool7Group3Covered: boolean;
  shapeHit: boolean;
  danMissStreak: number;
  pool7MissStreak: number;
  shapeMissStreak: number;
  phase: "backfit" | "locked";
};

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

function incrementIssue(issue: string) {
  return String(Number(issue) + 1).padStart(issue.length, "0");
}

function metrics(rows: HistoryRow[], field: "danHit" | "pool7Hit" | "shapeHit") {
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

async function fetchDraws(): Promise<Draw[]> {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=${dateDaysAgo(1700)}&dayEnd=${shanghaiDate()}` +
    "&pageNo=1&pageSize=1800&systemType=PC";
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/5.0)",
    },
  });
  if (!response.ok) throw new Error(`official-data-${response.status}`);
  const payload = (await response.json()) as {
    result?: Array<{ date: string; code: string; red: string }>;
  };
  return (payload.result ?? [])
    .map((item) => ({
      date: item.date.slice(0, 10),
      issue: String(item.code),
      digits: item.red.split(",").map(Number),
      draw: item.red.replaceAll(",", ""),
    }))
    .filter(
      (item) =>
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        /^\d{7}$/.test(item.issue) &&
        item.digits.length === 3 &&
        item.digits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
}

export async function GET() {
  try {
    const draws = await fetchDraws();
    if (draws.length < 120) throw new Error("insufficient-history");

    const history: HistoryRow[] = [];
    let danMissStreak = 0;
    let pool7MissStreak = 0;
    let shapeMissStreak = 0;

    for (let index = 120; index < draws.length; index += 1) {
      const row = draws[index];
      if (row.date < config.backfitStart) continue;
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
      history.push({
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
        shapeMissStreak,
        phase: row.date >= config.lockDate ? "locked" : "backfit",
      });
    }

    const latest = draws.at(-1)!;
    const upcoming = recommendV5(draws, danMissStreak, pool7MissStreak, config);
    const backfit = history.filter(
      (row) => row.date >= config.backfitStart && row.date <= config.backfitEnd,
    );
    const locked = history.filter((row) => row.date >= config.lockDate);

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
        formulaVersion: config.version,
        lockDate: config.lockDate,
        recommendation: {
          targetIssue: incrementIssue(latest.issue),
          basedOnIssue: latest.issue,
          basedOnDate: latest.date,
          dan: upcoming.dan,
          pool7: upcoming.pool7.join(""),
          shapePlay: upcoming.shapePlay,
        },
        history,
        metrics: {
          backfitDan: metrics(backfit, "danHit"),
          backfitPool7: metrics(backfit, "pool7Hit"),
          backfitShape: metrics(backfit, "shapeHit"),
          lockedDan: metrics(locked, "danHit"),
          lockedPool7: metrics(locked, "pool7Hit"),
          lockedShape: metrics(locked, "shapeHit"),
          shapeAlwaysGroup6Baseline: {
            count: 1054,
            hits: 779,
            rate: 0.7390891840607211,
            maxMiss: 5,
          },
        },
      },
      {
        headers: { "Cache-Control": "no-store, max-age=0" },
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
