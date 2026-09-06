const $ = (selector) => document.querySelector(selector);
const VERIFIED_DATA_ROOT =
  "https://raw.githubusercontent.com/asjgnetctk-jpg/fc3d-research/main/pages";
const DATA_FILE = document.body.dataset.v9Data || "v9-data.json";
const labels = { pool5: "5码", pool6: "6码", pool7: "7码", pool8: "8码" };
let payload;
let activePlay = "pool5";
let showAll = false;
let searchQuery = "";
const isOneYearVariant = DATA_FILE === "v9-2-data.json";

function updateBeijingTime() {
  $("#v9-beijing-time").textContent = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}
updateBeijingTime();
setInterval(updateBeijingTime, 1000);

function badge(hit) {
  return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`;
}

function methodText(method) {
  if (method.family === "fixed") return `训练段固定组合 ${method.pool.join("")}`;
  return `读取此前${method.window}期，按出现频率、覆盖频率、定位集中度、遗漏、上期重号与历史转移特征加权排序，取综合分最低的号码。所有权重在验证期开始前锁定。`;
}

function renderCurrent() {
  const pool = payload.recommendation[activePlay];
  $("#v9-current").innerHTML = `<div class="single-pool"><p>${labels[activePlay]}组合</p><div class="number-pills pool-${pool.length}">${pool.split("").map((digit) => `<span>${digit}</span>`).join("")}</div><small>仅组六三个不同数字全部入池才计为命中</small></div>`;
  const metric = payload.metrics[activePlay];
  $("#v9-metric-title").textContent = `${labels[activePlay]}滚动战绩`;
  $("#v9-periods").textContent = `${metric.all.count}期`;
  $("#v9-score").textContent = `${metric.all.hits}/${metric.all.count}`;
  $("#v9-detail").textContent = `命中率 ${(metric.all.rate * 100).toFixed(2)}% · 未命中 ${metric.all.misses}期 · 最长连续未中 ${metric.all.maxMiss}期`;
  const validationLabel = isOneYearVariant ? "近1年独立检验" : `${payload.validation.startDate.slice(0, 4)}年至今独立验证`;
  $("#v9-validation").innerHTML = `<span>${validationLabel}</span><strong>${metric.validation.hits}/${metric.validation.count} · ${(metric.validation.rate * 100).toFixed(2)}%</strong><b>最长未中 ${metric.validation.maxMiss}期</b>`;
  $("#v9-one-year").innerHTML = `<span>近1年实际结果</span><strong>${metric.recentOneYear.hits}/${metric.recentOneYear.count} · ${(metric.recentOneYear.rate * 100).toFixed(2)}%</strong><b>最长未中 ${metric.recentOneYear.maxMiss}期</b>`;
  $("#v9-one-year").hidden = isOneYearVariant;
  $("#v9-formula-text").textContent = `${methodText(payload.methods[activePlay])} 同码数随机组合的理论命中率约为${(payload.randomBaselines[activePlay] * 100).toFixed(1)}%；历史差异不能证明未来概率已改变。`;
  renderComparison();
  renderHistory();
}

function renderComparison() {
  const section = $("#v9-comparison-section");
  const grid = $("#v9-comparison-grid");
  if (!section || !grid || !payload.comparisons) return;
  const entries = [
    ["V9.2", payload.metrics[activePlay].all],
    ["V2", payload.comparisons.V2?.[activePlay]],
    ["V5", payload.comparisons.V5?.[activePlay]],
  ];
  grid.innerHTML = entries.map(([name, item]) => {
    if (!item) return `<div class="benchmark-card is-empty"><span>${name}</span><strong>无此玩法</strong></div>`;
    return `<div class="benchmark-card"><span>${name}</span><strong>${(item.rate * 100).toFixed(2)}%</strong><small>${item.hits}/${item.count}期</small></div>`;
  }).join("");
  section.hidden = false;
}

function matches(row) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  return [row.issue, row.date, row.draw, row[activePlay]].join(" ").toLowerCase().includes(query);
}

function historyRow(row) {
  const group3Mark = row[`${activePlay}Group3Covered`] ? `<span class="hit-badge group3 is-covered">组三覆盖</span>` : "";
  return `<article class="history-row"><div class="history-date"><strong>${row.issue}</strong><span>${row.date.slice(5)}</span><em>滚动</em></div><div class="history-data"><div><span>组合</span><strong>${row[activePlay]}</strong></div><div><span>开奖</span><strong>${row.draw}</strong></div></div><div class="history-result single-result"><div><span>${labels[activePlay]}</span>${badge(row[`${activePlay}Hit`])}${group3Mark}<small>断${row[`${activePlay}MissStreak`]}</small></div></div></article>`;
}

function renderHistory() {
  const rows = payload.history.filter(matches).reverse();
  $("#v9-search-count").textContent = `${rows.length}期`;
  $("#v9-toggle-history").hidden = rows.length <= 18;
  $("#v9-toggle-history").textContent = showAll ? "收起记录" : `查看全部 ${rows.length} 期`;
  $("#v9-history").innerHTML = (showAll ? rows : rows.slice(0, 18)).map(historyRow).join("");
}

function render(data) {
  payload = data;
  $("#v9-version").textContent = data.formulaVersion;
  $("#v9-range").textContent = `${data.historyStartDate || data.training.startDate}—${data.sourceUpdatedThrough}`;
  $("#v9-target").textContent = `第${data.targetIssue}期`;
  $("#v9-based-on").textContent = `基于${data.basedOnIssue}期及此前数据`;
  $("#v9-source").textContent = `官方数据更新至 ${data.sourceUpdatedThrough}`;
  $("#v9-generated").textContent = `页面生成于 ${new Date(data.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
  renderCurrent();
  $("#v9-loading").hidden = true;
  $("#v9-content").hidden = false;
}

async function load() {
  $("#v9-refresh").disabled = true;
  try {
    const response = await fetch(`${VERIFIED_DATA_ROOT}/${DATA_FILE}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("#v9-loading").hidden = true;
    $("#v9-error").textContent = `${error.message}。请稍后刷新。`;
    $("#v9-error").hidden = false;
  } finally {
    $("#v9-refresh").disabled = false;
  }
}

document.querySelectorAll(".play-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    activePlay = button.dataset.play;
    showAll = false;
    document.querySelectorAll(".play-tabs button").forEach((item) => item.classList.toggle("is-active", item === button));
    renderCurrent();
  });
});
$("#v9-refresh").addEventListener("click", load);
$("#v9-search").addEventListener("input", (event) => { searchQuery = event.target.value; showAll = false; renderHistory(); });
$("#v9-toggle-history").addEventListener("click", () => { showAll = !showAll; renderHistory(); });
$("#v9-toggle-formula").addEventListener("click", () => {
  const formula = $("#v9-formula");
  formula.hidden = !formula.hidden;
  $("#v9-toggle-formula").setAttribute("aria-expanded", String(!formula.hidden));
  $("#v9-toggle-formula b").textContent = formula.hidden ? "+" : "−";
});
load();
