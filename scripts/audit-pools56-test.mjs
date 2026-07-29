import { writeFile } from "node:fs/promises";
import config from "../lib/pool56-config.json" with { type: "json" };
import { recommendPool } from "../lib/v5-model.js";

const requestUrl =
  "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=3d&dayStart=2009-01-01&dayEnd=2026-07-28" +
  "&pageNo=1&pageSize=5000&systemType=PC";
const response = await fetch(requestUrl, {
  headers: {
    Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/3d/",
    "User-Agent": "Mozilla/5.0 (compatible; FC3DResearch/pools56-test)",
  },
});
if (!response.ok) throw new Error(`official-data-${response.status}`);
const payload = await response.json();
const draws = (payload.result ?? [])
  .map((item) => ({
    date: item.date.slice(0, 10),
    issue: String(item.code),
    digits: item.red.split(",").map(Number),
  }))
  .sort((left, right) => left.date.localeCompare(right.date));

function simulate(poolSize, methods) {
  let missStreak = 0;
  let reportMissStreak = 0;
  let maxMiss = 0;
  let hits = 0;
  let count = 0;
  for (let index = 120; index < draws.length; index += 1) {
    const row = draws[index];
    const pool = recommendPool(draws.slice(0, index), missStreak, methods, poolSize);
    const actual = new Set(row.digits);
    const hit =
      actual.size === 3 && [...actual].every((digit) => pool.includes(digit));
    missStreak = hit ? 0 : missStreak + 1;
    if (row.date < config.simulationStart) continue;
    count += 1;
    if (hit) {
      hits += 1;
      reportMissStreak = 0;
    } else {
      reportMissStreak += 1;
      maxMiss = Math.max(maxMiss, reportMissStreak);
    }
  }
  return { count, hits, rate: hits / count, maxMiss };
}

const result = {
  createdAt: new Date().toISOString(),
  range: [config.simulationStart, draws.at(-1).date],
  pool5: simulate(5, config.pool5.methods),
  pool6: simulate(6, config.pool6.methods),
};
await writeFile(
  "scripts/results/pool56-untouched-test.json",
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result, null, 2));
