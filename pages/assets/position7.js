const $ = (selector) => document.querySelector(selector);
const root = "https://raw.githubusercontent.com/asjgnetctk-jpg/fc3d-research/main/pages";
const names = { hundreds: "百位", tens: "十位", units: "个位" };
let data;
let showAll = false;
let query = "";

function pills(value) {
  return `<div class="position7-pills">${[...value].map((digit) => `<b>${digit}</b>`).join("")}</div>`;
}
function badge(hit) { return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`; }
function metricCard(key) {
  const item = data.metrics[key];
  const forward = item.forward;
  const forwardLine = forward.count
    ? `<strong>${forward.hits}/${forward.count}</strong><span>锁定后命中率 ${(forward.rate * 100).toFixed(1)}%</span><b class="${forward.targetMet ? "target-pass" : "target-fail"}">最长连断 ${forward.maxMiss}期 · ${forward.targetMet ? "达标" : "未达标"}</b>`
    : `<strong>等待开奖</strong><span>下一期起计独立前瞻</span><b>尚无锁定后样本</b>`;
  return `<article class="position7-metric"><h3>${names[key]}</h3>${forwardLine}<small>近一年训练：${item.training.hits}/${item.training.count}，命中率${(item.training.rate * 100).toFixed(1)}%，最长连断${item.training.maxMiss}期</small></article>`;
}
function historyRow(row) {
  return `<article class="position7-row"><div class="history-date"><strong>${row.issue}</strong><span>${row.date.slice(5)}</span><em>${row.phase === "locked-forward" ? "盲测" : "训练"}</em></div><div class="position7-row-main"><div class="position7-draw">开奖 <strong>${row.draw}</strong></div>${Object.keys(names).map((key, index) => `<div class="position7-line"><span>${names[key]}</span><strong>${row[`${key}Pool`]}</strong>${badge(row[`${key}Hit`])}<small>开奖号${row.draw[index]} · 断${row[`${key}MissStreak`]}</small></div>`).join("")}</div></article>`;
}
function matches(row) {
  const text = [row.issue, row.date, row.draw, row.hundredsPool, row.tensPool, row.unitsPool].join(" ");
  return !query || text.includes(query);
}
function renderHistory() {
  const rows = data.history.filter(matches).reverse();
  $("#count").textContent = `${rows.length}期`;
  $("#history").innerHTML = (showAll ? rows : rows.slice(0, 20)).map(historyRow).join("");
  $("#toggle").hidden = rows.length <= 20;
  $("#toggle").textContent = showAll ? "收起记录" : `查看全部 ${rows.length} 期`;
}
function render(payload) {
  data = payload;
  $("#version").textContent = payload.formulaVersion;
  $("#source").textContent = `数据更新至 ${payload.sourceUpdatedThrough}`;
  $("#notice").textContent = payload.notice;
  $("#target").textContent = `第${payload.recommendation.targetIssue}期`;
  $("#based-on").textContent = `基于${payload.recommendation.basedOnIssue}期及此前数据`;
  $("#recommendation").innerHTML = Object.keys(names).map((key) => `<article><span>${names[key]}7码</span>${pills(payload.recommendation[`${key}Pool`])}</article>`).join("");
  $("#metrics").innerHTML = Object.keys(names).map(metricCard).join("");
  $("#audit").href = `./audit/${window.LotteryGame?.id === "pl3" ? "pl3-" : ""}position7-model.json`;
  $("#generated").textContent = `页面生成于 ${new Date(payload.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
  renderHistory();
  $("#loading").hidden = true; $("#content").hidden = false;
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
load();
