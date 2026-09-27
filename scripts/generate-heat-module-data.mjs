import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(await readFile(path.join(root, "scripts/data/fc3d-17500-heat.json"), "utf8"));
const rows = source.rows.slice(-120);
const latest = rows.at(-1);
if (!latest || latest.rankings?.length !== 4) throw new Error("17500 heat data is unavailable");

const payload = {
  generatedAt: new Date().toISOString(),
  source: source.source,
  sourceLabel: source.sourceLabel,
  updatedThrough: source.updatedThrough,
  totalRecords: source.count,
  notice: "热度排名来自17500公开页面，反映其模拟大数据用户选号排序，不是官方销量，也不保证提高中奖率。",
  latest,
  history: rows.slice().reverse(),
};

await mkdir(path.join(root, "pages/assets"), { recursive: true });
await mkdir(path.join(root, "public/assets"), { recursive: true });
for (const directory of ["pages", "public"]) {
  await writeFile(path.join(root, directory, "heat-data.json"), `${JSON.stringify(payload)}\n`, "utf8");
}
for (const file of ["heat.html", "styles.css", path.join("assets", "heat.js"), path.join("assets", "game-switch.js")]) {
  await copyFile(path.join(root, "pages", file), path.join(root, "public", file));
}
console.log(`heat module ${latest.issue}: ${source.count} records through ${latest.date}`);
