import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = "https://www.17500.cn/chart/3d-xntztablen.html?limit=4000";
const target = path.join(root, "scripts", "data", "fc3d-17500-heat.json");

function clean(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

async function existingPayload() {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return null;
  }
}

const response = await fetch(source, {
  headers: {
    "user-agent": "Mozilla/5.0 (compatible; fc3d-research-data-bot/1.0)",
    accept: "text/html,application/xhtml+xml",
  },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`17500 returned HTTP ${response.status}`);
const html = await response.text();
const rows = [];
for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
  const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => clean(cell[1]));
  if (cells.length !== 43 || !/^\d{3}$/.test(cells[0]) || !/^\d{4}-\d{2}-\d{2}$/.test(cells[1])) continue;
  const draw = (cells[2].match(/\d/g) ?? []).join("");
  const rankings = Array.from({ length: 4 }, (_, block) =>
    cells.slice(3 + block * 10, 13 + block * 10).map(Number),
  );
  const validRankings = rankings.every(
    (ranking) => ranking.length === 10 && [...ranking].sort((a, b) => a - b).join("") === "0123456789",
  );
  if (draw.length === 3 && validRankings) {
    rows.push({ issue: cells[0], date: cells[1], draw, rankings });
  }
}
rows.sort((left, right) => left.date.localeCompare(right.date));
if (rows.length < 3_000) throw new Error(`17500 validation failed: only ${rows.length} rows`);

const previous = await existingPayload();
const previousLast = previous?.rows?.at(-1);
const latest = rows.at(-1);
if (previousLast && latest.date < previousLast.date) {
  throw new Error(`17500 went backwards: ${latest.date} < ${previousLast.date}`);
}

const unchanged = previous?.rows?.length === rows.length
  && previousLast?.date === latest.date
  && previousLast?.issue === latest.issue
  && JSON.stringify(previousLast?.rankings) === JSON.stringify(latest.rankings);
if (!unchanged) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({
    source,
    sourceLabel: "17500模拟大数据用户选号热度排名，非官方销量",
    updatedThrough: `${latest.date} · 第${latest.issue}期`,
    count: rows.length,
    rows,
  })}\n`, "utf8");
}
console.log(`17500 heat ${unchanged ? "unchanged" : "updated"}: ${rows.length} rows through ${latest.date}`);
