import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const candidateDirectory = path.join(
  root,
  process.env.V2_CANDIDATE_DIRECTORY ?? "work/v2-candidates",
);
const currentConfigPath = path.join(
  root,
  process.env.V2_CURRENT_CONFIG ?? "lib/v2-one-year-config.json",
);
const currentReportPath = path.join(
  root,
  process.env.V2_CURRENT_REPORT ??
    "scripts/results/v2-one-year-training.json",
);
const outputConfigPath = path.join(
  root,
  process.env.V2_SELECTED_CONFIG ?? "lib/v2-one-year-config.json",
);
const outputReportPath = path.join(
  root,
  process.env.V2_SELECTED_REPORT ??
    "scripts/results/v2-one-year-training.json",
);
const plays = ["dan", "pool5", "pool6", "pool7"];

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function compare(left, right) {
  return (
    left.final.maxMiss - right.final.maxMiss ||
    right.final.hits - left.final.hits ||
    right.final.rate - left.final.rate
  );
}

const candidates = [
  {
    label: "current",
    config: await readJson(currentConfigPath),
    report: await readJson(currentReportPath),
  },
];

for (const file of await readdir(candidateDirectory)) {
  const match = /^config-(\d+)\.json$/.exec(file);
  if (!match) continue;
  const seed = match[1];
  candidates.push({
    label: seed,
    config: await readJson(path.join(candidateDirectory, file)),
    report: await readJson(
      path.join(candidateDirectory, `report-${seed}.json`),
    ),
  });
}

const selected = {};
for (const play of plays) {
  selected[play] = [...candidates].sort((left, right) =>
    compare(left.report.metrics[play], right.report.metrics[play]),
  )[0];
}

const base = selected.dan;
const trainedAt = new Date().toISOString();
const config = {
  ...base.config,
  trainedAt,
  search: {
    ...base.config.search,
    candidateSeeds: candidates
      .filter((candidate) => candidate.label !== "current")
      .map((candidate) => Number(candidate.label)),
    selectedSeedByPlay: Object.fromEntries(
      plays.map((play) => [play, selected[play].label]),
    ),
    selectionPriority: "lowest maxMiss, then highest hits",
  },
  plays: Object.fromEntries(
    plays.map((play) => [play, selected[play].config.plays[play]]),
  ),
};
const report = {
  ...base.report,
  generatedAt: trainedAt,
  methodology:
    `${base.report.methodology} Multiple deterministic seeds were compared per play; selection priority was lowest maximum miss streak, then highest hits.`,
  rows: Object.fromEntries(
    plays.map((play) => [play, selected[play].report.rows[play]]),
  ),
  metrics: Object.fromEntries(
    plays.map((play) => [play, selected[play].report.metrics[play]]),
  ),
  selectedSeedByPlay: config.search.selectedSeedByPlay,
};

await writeFile(
  outputConfigPath,
  `${JSON.stringify(config, null, 2)}\n`,
  "utf8",
);
await writeFile(
  outputReportPath,
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

for (const play of plays) {
  const final = report.metrics[play].final;
  console.log(
    `${play}: seed ${selected[play].label}, ${final.hits}/${final.count}, maxMiss ${final.maxMiss}`,
  );
}
