import { readFile, writeFile } from "node:fs/promises";

const reportPath =
  process.env.PL3_V5_REPORT ?? "scripts/results/pl3-v5-three-way.json";
const outputPath = process.env.PL3_V5_CONFIG ?? "lib/pl3-v5-config.json";

function weightsObject(weights) {
  return Object.fromEntries(
    weights.map(({ feature, weight }) => [feature, weight]),
  );
}

function digitMethod(method) {
  return {
    id: `pl3-v5-${method.id}`,
    rank: method.rank,
    weights: weightsObject(method.weights),
  };
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
const config = {
  version: "PL3-V5-three-year-streak-min",
  lockDate: report.range.end,
  backfitStart: report.range.start,
  backfitEnd: report.range.end,
  canonicalDataSha256: report.source.canonicalTestDataSha256,
  selectionPriority: "lowest maxMiss, then highest hit rate",
  dan: {
    methods: report.dan.stateMethods.map(digitMethod),
  },
  pool7: {
    methods: report.pool7.stateMethods.map(digitMethod),
  },
  shapeChoice: {
    threshold: report.shapeChoice.threshold,
    weights: weightsObject(report.shapeChoice.model.weights),
  },
};

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      dan: report.dan.metrics,
      pool7: report.pool7.metrics,
      shapeChoice: report.shapeChoice.metrics,
    },
    null,
    2,
  ),
);
