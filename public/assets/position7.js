const $ = (selector) => document.querySelector(selector);
const root = "https://raw.githubusercontent.com/asjgnetctk-jpg/fc3d-research/main/pages";
const names = { hundreds: "百位", tens: "十位", units: "个位" };
let payload, data;
let showAll = false;
let query = "";
const showCombinedMetric = false;

function pills(value) { return `<div class="position7-pills" style="--pool-size:${value.length}">${[...value].map((digit) => `<b>${digit}</b>`).join("")}</div>`; }
function badge(hit) { return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`; }
function metricCard(key) {
  const item = data.metrics[key];
  const isWeightTraining = payload.trainingMode?.startsWith("one-year-in-sample-weight-selection");
  const result = item.fit ?? (isWeightTraining ? item.training : item.forward);
  const currentMiss = item.forward?.count ? item.forward.currentMiss : result.currentMiss;
  const label = item.fit ? "近3年回看命中率" : (isWeightTraining ? "一年权重训练命中率" : "独立命中率");
  const detail = isWeightTraining
    ? (item.forward?.count ? `锁定后实战：${item.forward.hits}/${item.forward.count}，命中率${(item.forward.rate * 100).toFixed(1)}%，最长连断${item.forward.maxMiss}期` : "答案参与选权重；锁定后实战尚无样本")
    : `历史训练：${item.training.hits}/${item.training.count}，命中率${(item.training.rate * 100).toFixed(1)}%，最长连断${item.training.maxMiss}期`;
  return `<article class="position7-metric"><h3>${names[key]}</h3><strong>${result.hits}/${result.count}</strong><span>${label} ${(result.rate * 100).toFixed(1)}%</span><b>最长连断 ${result.maxMiss}期 · 当前${currentMiss}期</b><small>${detail}</small></article>`;
}
function combinedMetricCard() {
  const result = data.metrics.all?.overall;
  if (!result) return "";
  return `<article class="position7-metric is-combined"><h3>百十个三位同时命中</h3><strong>${result.hits}/${result.count}</strong><span>三位同中率 ${(result.rate * 100).toFixed(1)}%</span><b>历史最大遗漏 ${result.maxMiss}期 · 目前遗漏 ${result.currentMiss}期</b><small>同一期百位、十位、个位全部命中才算中；任一位置未中均继续累计遗漏。</small></article>`;
}
function historyRow(row) {
  return `<article class="position7-row"><div class="history-date"><strong>${row.issue}</strong><span>${row.date.slice(5)}</span><em>${row.phase === "locked-forward" ? "实战" : "训练"}</em></div><div class="position7-row-main"><div class="position7-draw">开奖 <strong>${row.draw}</strong></div>${Object.keys(names).map((key, index) => `<div class="position7-line"><span>${names[key]}</span><strong>${row[`${key}Pool`]}</strong>${badge(row[`${key}Hit`])}<small>开奖号${row.draw[index]} · 断${row[`${key}MissStreak`]}</small></div>`).join("")}</div></article>`;
}
function matches(row) { return !query || [row.issue, row.date, row.draw, row.hundredsPool, row.tensPool, row.unitsPool].join(" ").includes(query); }
function renderHistory() {
  const rows = data.history.filter(matches).reverse();
  $("#count").textContent = `${rows.length}期`;
  $("#history").innerHTML = (showAll ? rows : rows.slice(0, 20)).map(historyRow).join("");
  $("#toggle").hidden = rows.length <= 20;
  $("#toggle").textContent = showAll ? "收起记录" : `查看全部 ${rows.length} 期`;
}
function selectPool(size) {
  data = payload.pools?.[size] ?? payload;
  document.querySelectorAll("[data-pool-size]").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.poolSize) === size));
  $("#pool-label").textContent = `定位${size}码`;
  $("#target").textContent = `第${data.recommendation.targetIssue}期`;
  $("#based-on").textContent = `基于${data.recommendation.basedOnIssue}期及此前数据`;
  $("#recommendation").innerHTML = Object.keys(names).map((key) => `<article><span>${names[key]}${size}码</span>${pills(data.recommendation[`${key}Pool`])}</article>`).join("");
  $("#metrics").innerHTML = Object.keys(names).map(metricCard).join("") + (showCombinedMetric ? combinedMetricCard() : "");
  $("#rule").textContent = `命中规则：百位、十位、个位分别核对；对应位置开奖号落入该位置${size}码池才算命中。单位置理论覆盖率为${size * 10}%；当前训练成绩使用一年答案选择权重。`;
  showAll = false;
  renderHistory();
}
function render(value) {
  payload = value;
  const prefix = window.LotteryGame?.id === "pl3" ? "pl3-" : "";
  const audit = $("#audit");
  if (audit) audit.href = `./audit/${prefix}position7-model.json`;
  $("#version").textContent = value.formulaVersion;
  $("#source").textContent = `数据更新至 ${value.sourceUpdatedThrough}`;
  $("#notice").textContent = value.notice;
  $("#generated").textContent = `页面生成于 ${new Date(value.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
  $("#pool-tabs").hidden = !value.pools;
  selectPool(7);
  $("#loading").hidden = true;
  $("#content").hidden = false;
}
async function load() {
  try {
    const file = window.LotteryGame?.file("position7-data.json") ?? "position7-data.json";
    const response = await fetch(`${root}/${file}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
    render(await response.json());
  } catch (error) { $("#loading").hidden = true; $("#error").hidden = false; $("#error").textContent = error.message; }
}
$("#refresh").addEventListener("click", load);
$("#toggle").addEventListener("click", () => { showAll = !showAll; renderHistory(); });
$("#search").addEventListener("input", (event) => { query = event.target.value.trim(); showAll = false; renderHistory(); });
$("#pool-tabs").addEventListener("click", (event) => { const button = event.target.closest("[data-pool-size]"); if (button) selectPool(Number(button.dataset.poolSize)); });
load();
