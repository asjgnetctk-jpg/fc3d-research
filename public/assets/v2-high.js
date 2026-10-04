const root = "https://raw.githubusercontent.com/asjgnetctk-jpg/fc3d-research/main/pages";

function metricCard(label, metric, baseline, selected = false) {
  const delta = (metric.rate - baseline) * 100;
  return `<div class="metric-card${selected ? " selected" : ""}">
    <span>${label}${selected ? " · 最终选择" : ""}</span>
    <strong>${(metric.rate * 100).toFixed(2)}%</strong>
    <small>${metric.hits}/${metric.count} · 最长连断${metric.maxMiss}期</small>
    <small>理论${(baseline * 100).toFixed(0)}% · ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}个百分点</small>
  </div>`;
}

function rowCard(row) {
  return `<article class="history-row">
    <div class="history-date"><strong>${row.issue}</strong><span>${row.date}</span><em>独立</em></div>
    <div class="history-data"><div><span>推荐6码</span><strong>${row.recommendation}</strong></div><div><span>开奖</span><strong>${row.draw}</strong></div></div>
    <div class="history-result single-result"><div><span>结果</span><span class="hit-badge${row.hit ? " is-hit" : ""}">${row.hit ? "中" : "未中"}</span></div></div>
  </article>`;
}

async function load() {
  try {
    const [fc, pl] = await Promise.all([
      fetch(`${root}/audit/fc3d-v2-online-stack.json?t=${Date.now()}`, { cache: "no-store" }).then((response) => response.json()),
      fetch(`${root}/audit/pl3-v2-online-stack.json?t=${Date.now()}`, { cache: "no-store" }).then((response) => response.json()),
    ]);
    const fc5 = fc.plays.pool5.selected.test;
    const fc6 = fc.plays.pool6.selected.test;
    const pl5 = pl.plays.pool5.selected.test;
    const pl6 = pl.plays.pool6.selected.test;
    document.querySelector("#latest-source").textContent = `审计生成 ${new Date(fc.generatedAt).toLocaleDateString("zh-CN")}`;
    document.querySelector("#blind-metrics").innerHTML = [
      metricCard("福彩5码", fc5, 0.06),
      metricCard("福彩6码", fc6, 0.12, true),
      metricCard("体彩5码", pl5, 0.06),
      metricCard("体彩6码", pl6, 0.12),
    ].join("");
    document.querySelector("#blind-history").innerHTML = fc.plays.pool6.testRows.slice(-18).reverse().map(rowCard).join("");
  } catch (error) {
    document.querySelector("#latest-source").textContent = `读取失败：${error.message}`;
  }
}
load();
