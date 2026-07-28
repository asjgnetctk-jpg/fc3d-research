const $ = (selector) => document.querySelector(selector);
let payload;
let showAll = false;
let searchQuery = "";

function metricCard(label, metric) {
  return `
    <div class="metric-card">
      <span>${label}</span>
      <strong>${metric.hits}/${metric.count}</strong>
      <small>命中率 ${(metric.rate * 100).toFixed(1)}% · 最长未中 ${metric.maxMiss}期</small>
    </div>
  `;
}

function hitBadge(hit) {
  return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`;
}

function historyRow(row) {
  const poolBadge = row.pool7Group3Covered
    ? '<span class="hit-badge group3 is-covered">组三覆盖</span>'
    : hitBadge(row.pool7Hit);
  return `
    <article class="history-row">
      <div class="history-date">
        <strong>${row.issue}</strong>
        <span>${row.date.slice(5)}</span>
        <em>V6</em>
      </div>
      <div class="history-data">
        <div><span>推荐</span><strong>胆${row.dan} · ${row.pool7} · ${row.shapeRecommendation}</strong></div>
        <div><span>开奖</span><strong>${row.draw}</strong><small>${row.actualShape}</small></div>
      </div>
      <div class="history-result">
        <div><span>胆</span>${hitBadge(row.danHit)}<small>断${row.danMissStreak}</small></div>
        <div><span>7码</span>${poolBadge}<small>断${row.pool7MissStreak}</small></div>
        <div><span>形态</span>${hitBadge(row.shapeHit)}<small>断${row.shapeMissStreak}</small></div>
      </div>
    </article>
  `;
}

function matches(row, tokens) {
  if (!tokens.length) return true;
  const searchable = [
    row.date,
    row.issue,
    `胆${row.dan}`,
    `胆码${row.dan}`,
    row.pool7,
    `7码${row.pool7}`,
    row.shapeRecommendation,
    row.draw,
    row.actualShape,
    row.danHit ? "胆码中" : "胆码未中",
    row.pool7Hit ? "7码中" : "7码未中",
    row.pool7Group3Covered ? "组三覆盖" : "",
    row.shapeHit ? "形态中" : "形态未中",
  ].join(" ").toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

function renderHistory() {
  const tokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = payload.rows.filter((row) => matches(row, tokens)).reverse();
  $("#v6-search-count").textContent = `${rows.length}期`;
  if (!rows.length) {
    $("#v6-history").innerHTML = '<div class="notice">没有找到符合条件的V6记录。</div>';
    $("#v6-toggle-history").hidden = true;
    return;
  }
  $("#v6-toggle-history").hidden = rows.length <= 18;
  const visible = showAll ? rows : rows.slice(0, 18);
  $("#v6-history").innerHTML = visible.map(historyRow).join("");
  $("#v6-toggle-history").textContent = showAll ? "收起记录" : `查看全部 ${rows.length} 期`;
}

async function load() {
  try {
    const response = await fetch(
      `./audit/v6-independent-five-year-20210728-20260727.json?t=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
    payload = await response.json();
    $("#v6-metrics").innerHTML =
      metricCard("独胆", payload.metrics.dan) +
      metricCard("7码", payload.metrics.pool7) +
      metricCard("形态二选一", payload.metrics.shapeChoice);
    renderHistory();
    $("#loading").hidden = true;
    $("#content").hidden = false;
  } catch (error) {
    $("#loading").hidden = true;
    $("#error").textContent = `${error.message}。请稍后刷新。`;
    $("#error").hidden = false;
  }
}

$("#v6-search").addEventListener("input", (event) => {
  searchQuery = event.target.value;
  showAll = false;
  renderHistory();
});

$("#v6-toggle-history").addEventListener("click", () => {
  showAll = !showAll;
  renderHistory();
});

load();
