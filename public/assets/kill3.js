const $ = (selector) => document.querySelector(selector);
const root = "https://raw.githubusercontent.com/asjgnetctk-jpg/fc3d-research/main/pages";
let payload, showAll = false, query = "";
function badge(hit) { return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`; }
function metricCard(title, item, note) { return `<article class="position7-metric"><h3>${title}</h3><strong>${item.hits}/${item.count}</strong><span>命中率 ${(item.rate * 100).toFixed(1)}%</span><b>最长连错 ${item.maxMiss}期 · 当前${item.currentMiss}期</b><small>${note}</small></article>`; }
function historyRow(row) { return `<article class="kill3-row"><div class="history-date"><strong>${row.issue}</strong><span>${row.date.slice(5)}</span><em>${row.phase === "live" ? "实战" : row.phase === "independent" ? "独立" : "回测"}</em></div><div class="kill3-row-main"><span>杀码</span><strong>${[...row.kills].join(" · ")}</strong><span>开奖号 <b>${row.draw}</b></span>${badge(row.hit)}<small>连错${row.missStreak}期</small></div></article>`; }
function renderHistory() { const rows = payload.history.filter((row) => !query || [row.issue, row.date, row.draw, row.kills].join(" ").includes(query)).reverse(); $("#count").textContent = `${rows.length}期`; $("#history").innerHTML = (showAll ? rows : rows.slice(0, 30)).map(historyRow).join(""); $("#toggle").hidden = rows.length <= 30; $("#toggle").textContent = showAll ? "收起记录" : `查看全部 ${rows.length} 期`; }
function render(data) {
  payload = data; $("#version").textContent = data.formulaVersion; $("#source").textContent = `数据更新至 ${data.sourceUpdatedThrough}`; $("#notice").textContent = data.notice;
  $("#target").textContent = `第${data.recommendation.targetIssue}期`; $("#based-on").textContent = `基于${data.recommendation.basedOnIssue}期及此前数据`;
  $("#kill-digits").innerHTML = [...data.recommendation.kills].map((digit) => `<b>${digit}</b>`).join(""); $("#locked-through").textContent = `本组参数锁定至 ${data.recommendation.lockedThrough}`;
  $("#metrics").innerHTML = metricCard("近5年逐年锁定", data.metrics.rollingAll, `每年使用此前${data.trainingWindowYears}年数据`) + metricCard("最后一年独立确认", data.metrics.independent, "2025-07-30—2026-07-29") + metricCard("当前周期实战", data.metrics.live, "2026-07-30起持续记录");
  $("#rule").textContent = data.definition; $("#audit").href = `./audit/${window.LotteryGame?.id === "pl3" ? "pl3-" : ""}kill3-model.json`;
  $("#generated").textContent = `页面生成于 ${new Date(data.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
  renderHistory(); $("#loading").hidden = true; $("#content").hidden = false;
}
async function load() { try { const file = window.LotteryGame?.file("kill3-data.json") ?? "kill3-data.json"; const response = await fetch(`${root}/${file}?t=${Date.now()}`, { cache: "no-store" }); if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`); render(await response.json()); } catch (error) { $("#loading").hidden = true; $("#error").hidden = false; $("#error").textContent = error.message; } }
$("#refresh").addEventListener("click", load); $("#toggle").addEventListener("click", () => { showAll = !showAll; renderHistory(); }); $("#search").addEventListener("input", (event) => { query = event.target.value.trim(); showAll = false; renderHistory(); }); load();
