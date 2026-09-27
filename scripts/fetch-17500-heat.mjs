import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = "https://www.17500.cn/chart/3d-xntztablen.html?limit=4000";
const target = path.join(root, "scripts", "data", "fc3d-17500-heat.json");
const now = new Date();
const capturedAt = now.toISOString();
const beijingParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
const beijingDate = `${beijingParts.year}-${beijingParts.month}-${beijingParts.day}`;
const beijingMinute = Number(beijingParts.hour) * 60 + Number(beijingParts.minute);
const insidePreDrawCaptureWindow = beijingMinute >= 20 * 60 + 20 && beijingMinute <= 21 * 60 + 10;

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
  if ((draw.length === 0 || draw.length === 3) && validRankings) {
    rows.push({ issue: cells[0], date: cells[1], draw: draw || null, rankings });
  }
}
rows.sort((left, right) => left.date.localeCompare(right.date));
const officialRows = rows.filter((row) => row.draw);
if (officialRows.length < 3_000) throw new Error(`17500 validation failed: only ${officialRows.length} official rows`);

const previous = await existingPayload();
const previousLast = previous?.rows?.at(-1);
const latest = officialRows.at(-1);
if (previousLast && latest.date < previousLast.date) {
  throw new Error(`17500 went backwards: ${latest.date} < ${previousLast.date}`);
}

const preDrawSnapshots = [...(previous?.preDrawSnapshots ?? [])];
const liveHeat = rows.at(-1);
let snapshotAdded = false;
if (
  liveHeat
  && !liveHeat.draw
  && liveHeat.date === beijingDate
  && insidePreDrawCaptureWindow
  && !preDrawSnapshots.some((row) => row.issue === liveHeat.issue && row.date === liveHeat.date)
) {
  preDrawSnapshots.push({
    issue: liveHeat.issue,
    date: liveHeat.date,
    rankings: liveHeat.rankings,
    capturedAt,
    capturedAtBeijing: `${beijingDate} ${beijingParts.hour}:${beijingParts.minute}`,
    captureWindow: "20:20—21:10",
  });
  snapshotAdded = true;
}

const unchanged = previous?.rows?.length === officialRows.length
  && previousLast?.date === latest.date
  && previousLast?.issue === latest.issue
  && JSON.stringify(previousLast?.rankings) === JSON.stringify(latest.rankings)
  && !snapshotAdded;
if (!unchanged) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({
    source,
    sourceLabel: "17500模拟大数据用户选号热度排名，非官方销量",
    updatedThrough: `${latest.date} · 第${latest.issue}期`,
    count: officialRows.length,
    rows: officialRows,
    preDrawSnapshots,
  })}\n`, "utf8");
}
console.log(`17500 heat ${unchanged ? "unchanged" : "updated"}: ${officialRows.length} rows through ${latest.date}; pre-draw snapshots ${preDrawSnapshots.length}${snapshotAdded ? " (+1)" : ""}`);
