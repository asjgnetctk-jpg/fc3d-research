import { NextResponse } from "next/server";
import config from "@/lib/v7-robust-config.json";
import pool56Config from "@/lib/pool56-config.json";
import group3Config from "@/lib/group3-online-config.json";
import { recommendPool, recommendV5 } from "@/lib/v5-model.js";
import {
  buildGroup3Examples,
  forecastNextGroup3Knn,
  runGroup3Knn,
} from "@/lib/group3-online.js";

export const runtime = "edge";
export const dynamic = "force-dynamic";
const ROLLING_VERSION = "V7.2-rolling";

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
  pool5: string;
  pool6: string;
  pool7: string;
  draw: string;
  shape: string;
  danHit: boolean;
  pool5Hit: boolean;
  pool6Hit: boolean;
  pool7Hit: boolean;
  pool5Group3Covered: boolean;
  pool6Group3Covered: boolean;
  pool7Group3Covered: boolean;
  danMissStreak: number;
  pool5MissStreak: number;
  pool6MissStreak: number;
  pool7MissStreak: number;
  shapePlay?: string;
  group3Probability?: number;
  group3Level?: "high" | "middle" | "low";
  shapeEvaluated?: boolean;
  shapeHit?: boolean;
  shapeMissStreak?: number;
};

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function incrementIssue(issue: string) {
  return String(Number(issue) + 1).padStart(issue.length, "0");
}

function metrics(rows: HistoryRow[], field: keyof HistoryRow) {
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

function rollingReplay(draws: Draw[], startDate: string) {
  const rows: HistoryRow[] = [];
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
      config,
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
      shape: actualGroup3 ? "开组三" : "未开组三",
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

async function fetchDraws(): Promise<Draw[]> {
  const url =
    "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
    `?name=3d&dayStart=2009-01-01&dayEnd=${shanghaiDate()}` +
    "&pageNo=1&pageSize=5000&systemType=PC";
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
      "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/7.2)",
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
    if (draws.length < 365) throw new Error("insufficient-history");
    const rolling = rollingReplay(draws, config.simulationStart);
    const group3Track = runGroup3Knn(
      buildGroup3Examples(draws),
      group3Config,
      config.simulationStart,
    );
    const group3ByIssue = new Map(
      group3Track.rows.map((row) => [row.issue, row]),
    );
    let shapeMissStreak = 0;
    const history = rolling.rows.map((row) => {
      const group3 = group3ByIssue.get(row.issue);
      if (!group3) throw new Error(`group3-row-missing:${row.issue}`);
      const shapeEvaluated = group3.level === "high";
      const shapeHit = shapeEvaluated && group3.group3;
      if (shapeEvaluated) {
        shapeMissStreak = shapeHit ? 0 : shapeMissStreak + 1;
      }
      return {
        ...row,
        shapePlay: shapeEvaluated ? "推荐组三" : "不推荐组三",
        group3Probability: group3.probability,
        group3Level: group3.level,
        shapeEvaluated,
        shapeHit,
        shapeMissStreak,
      };
    });

    const latest = draws.at(-1)!;
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
    const upcomingGroup3 = forecastNextGroup3Knn(draws, group3Config);

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        sourceUpdatedThrough: `${latest.date} · 第${latest.issue}期`,
        formulaVersion: ROLLING_VERSION,
        trainingMode: "expanding-window",
        trainingUpdatedThrough: latest.date,
        recommendation: {
          targetIssue: incrementIssue(latest.issue),
          basedOnIssue: latest.issue,
          basedOnDate: latest.date,
          dan: upcoming.dan,
          pool7: upcoming.pool7.join(""),
          pool6: upcomingPool6.join(""),
          pool5: upcomingPool5.join(""),
          shapePlay:
            upcomingGroup3.level === "high" ? "推荐组三" : "不推荐组三",
          group3Probability: upcomingGroup3.probability,
          group3Level: upcomingGroup3.level,
        },
        history,
        metrics: {
          dan: metrics(history, "danHit"),
          pool5: metrics(history, "pool5Hit"),
          pool6: metrics(history, "pool6Hit"),
          pool7: metrics(history, "pool7Hit"),
          group3: metrics(
            history.filter((row) => row.shapeEvaluated),
            "shapeHit",
          ),
          totalPeriods: history.length,
        },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("recommendation-api", error);
    return NextResponse.json(
      { error: "暂时无法读取官方开奖数据，请稍后刷新。" },
      { status: 503 },
    );
  }
}
