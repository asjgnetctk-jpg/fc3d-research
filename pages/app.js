const $ = (selector) => document.querySelector(selector);
let payload;
let showAll = false;

function metricCard(label, metric, enforceSeven = false) {
  const pending = metric.count === 0;
  const failed = enforceSeven && metric.maxMiss > 7;
  return `
    <div class="metric-card${failed ? " failed" : ""}">
      <span>${label}</span>
      <strong>${pending ? "等待开奖" : `${metric.hits}/${metric.count}`}</strong>
      <small>${
        pending
          ? "暂无真实封盘样本"
          : `命中率 ${(metric.rate * 100).toFixed(1)}% · 最长未中 ${metric.maxMiss}期`
      }</small>
    </div>
  `;
}

function historyRow(row) {
  const badge = (hit) =>
    `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`;
  const poolBadge =
    row.shape === "组三"
      ? `<span class="hit-badge group3${row.pool7Group3Covered ? " is-covered" : ""}">${
          row.pool7Group3Covered ? "组三覆盖" : "组三未覆"
        }</span>`
      : badge(row.pool7Hit);
  return `
    <article class="history-row">
      <div class="history-date">
        <strong>${row.issue}</strong>
        <span>${row.date.slice(5)}</span>
        <em>${row.phase === "locked" ? "真实" : "回溯"}</em>
      </div>
      <div class="history-data">
        <div><span>推荐</span><strong>胆${row.dan} · ${row.pool7}</strong></div>
        <div><span>开奖</span><strong>${row.draw}</strong><small>${row.shape}</small></div>
      </div>
      <div class="history-result">
        <div><span>胆</span>${badge(row.danHit)}<small>断${row.danMissStreak}</small></div>
        <div><span>7码</span>${poolBadge}<small>${
          row.shape === "组三" ? "不计组六奖" : `断${row.pool7MissStreak}`
        }</small></div>
      </div>
    </article>
  `;
}

function renderHistory() {
  const rows = [...payload.history].reverse();
  const visible = showAll ? rows : rows.slice(0, 18);
  $("#history").innerHTML = visible.map(historyRow).join("");
  $("#toggle-history").textContent = showAll
    ? "收起记录"
    : `查看全部 ${payload.history.length} 期`;
}

function render(data) {
  payload = data;
  $("#formula-version").textContent = `公式 ${data.formulaVersion} 已锁定`;
  $("#lock-date").textContent = `${data.lockDate}起真实验证`;
  $("#target-issue").textContent = `第${data.recommendation.targetIssue}期`;
  $("#based-on").textContent = `基于${data.recommendation.basedOnIssue}期及此前数据`;
  $("#dan").textContent = data.recommendation.dan;
  $("#pool7").innerHTML = data.recommendation.pool7
    .split("")
    .map((digit) => `<span>${digit}</span>`)
    .join("");
  $("#source-line").textContent = `官方数据更新至 ${data.sourceUpdatedThrough}`;
  $("#locked-metrics").innerHTML =
    metricCard("独胆实测", data.metrics.lockedDan, true) +
    metricCard("7码实测", data.metrics.lockedPool7);
  $("#backfit-metrics").innerHTML =
    metricCard("独胆回溯", data.metrics.backfitDan, true) +
    metricCard("7码回溯", data.metrics.backfitPool7);
  $("#generated-at").textContent = `页面数据生成于 ${new Date(
    data.generatedAt,
  ).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`;
  renderHistory();
  $("#loading").hidden = true;
  $("#error").hidden = true;
  $("#content").hidden = false;
}

async function load() {
  $("#refresh").disabled = true;
  $("#error").hidden = true;
  try {
    const response = await fetch(`./data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("#loading").hidden = true;
    $("#error").textContent = `${error.message}。请稍后再刷新。`;
    $("#error").hidden = false;
  } finally {
    $("#refresh").disabled = false;
  }
}

$("#refresh").addEventListener("click", load);
$("#toggle-history").addEventListener("click", () => {
  showAll = !showAll;
  renderHistory();
});
$("#toggle-formula").addEventListener("click", () => {
  const formula = $("#formula");
  formula.hidden = !formula.hidden;
  $("#toggle-formula").setAttribute("aria-expanded", String(!formula.hidden));
  $("#toggle-formula b").textContent = formula.hidden ? "+" : "−";
});

load();
