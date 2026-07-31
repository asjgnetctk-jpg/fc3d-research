const $ = (selector) => document.querySelector(selector);
const labels = {
  dan: "独胆",
  pool5: "5码",
  pool6: "6码",
  pool7: "7码",
};
let payload;
let activePlay = "dan";
let showAll = false;
let searchQuery = "";

function metricCard(play, metric) {
  const target = play === "dan" ? 5 : null;
  const passed = target === null || metric.maxMiss <= target;
  return `
    <div class="metric-card${passed ? "" : " failed"}">
      <span>${labels[play]}</span>
      <strong>${metric.hits}/${metric.count}</strong>
      <small>命中率${(metric.rate * 100).toFixed(1)}% · 最长连断${metric.maxMiss}期</small>
      ${target === null ? "" : `<em class="${passed ? "target-pass" : "target-fail"}">训练硬门槛≤${target}期：${passed ? "达标" : "未达标"}</em>`}
    </div>`;
}

function hitBadge(hit, covered = false) {
  if (covered) {
    return '<span class="hit-badge group3 is-covered">组三覆盖</span>';
  }
  return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`;
}

function playValue(row, play) {
  return play === "dan" ? `胆${row.dan}` : row[play];
}

function playHit(row, play) {
  return row[`${play}Hit`];
}

function playStreak(row, play) {
  return row[`${play}MissStreak`];
}

function group3Covered(row, play) {
  return play === "dan" ? false : row[`${play}Group3Covered`];
}

function matches(row) {
  const tokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const searchable = [
    row.issue,
    row.date,
    row.draw,
    `胆${row.dan}`,
    row.pool5,
    row.pool6,
    row.pool7,
    row.shape,
    row.phase,
  ].join(" ").toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

function historyRow(row) {
  const covered = group3Covered(row, activePlay);
  return `
    <article class="history-row">
      <div class="history-date">
        <strong>${row.issue}</strong>
        <span>${row.date.slice(5)}</span>
        <em>${row.phase === "one-year-training" ? "训练" : "前瞻"}</em>
      </div>
      <div class="history-data">
        <div><span>推荐</span><strong>${playValue(row, activePlay)}</strong></div>
        <div><span>开奖</span><strong>${row.draw}</strong><small>${row.shape}</small></div>
      </div>
      <div class="history-result single-result">
        <div>
          <span>${labels[activePlay]}</span>
          ${hitBadge(playHit(row, activePlay), covered)}
          <small>断${playStreak(row, activePlay)}</small>
        </div>
      </div>
    </article>`;
}

function renderHistory() {
  const rows = payload.rows.filter(matches).reverse();
  $("#v2-search-count").textContent = `${rows.length}期`;
  $("#v2-history-eyebrow").textContent = `${labels[activePlay]}逐期训练证据`;
  $("#v2-toggle-history").hidden = rows.length <= 18;
  $("#v2-toggle-history").textContent =
    showAll ? "收起记录" : `查看全部 ${rows.length} 期`;
  $("#v2-history").innerHTML = (showAll ? rows : rows.slice(0, 18))
    .map(historyRow)
    .join("");
}

function renderCurrent() {
  const recommendation = payload.recommendation;
  if (activePlay === "dan") {
    $("#v2-current-play").innerHTML = `
      <div class="single-dan">
        <p>V2独胆推荐</p>
        <strong>${recommendation.dan}</strong>
        <small>历史训练内最长连断5期；未来不作同等保证</small>
      </div>`;
  } else {
    const pool = recommendation[activePlay];
    $("#v2-current-play").innerHTML = `
      <div class="single-pool">
        <p>V2 ${labels[activePlay]}推荐</p>
        <div class="number-pills pool-${pool.length}">
          ${pool.split("").map((digit) => `<span>${digit}</span>`).join("")}
        </div>
        <small>组六全覆盖计命中；组三覆盖单独标记</small>
      </div>`;
  }
  renderHistory();
}

function render(data) {
  payload = data;
  $("#v2-version").textContent = data.formulaVersion;
  $("#v2-training-range").textContent =
    `${data.trainingStart}—${data.trainingEnd}`;
  $("#v2-target-issue").textContent = `第${data.recommendation.targetIssue}期`;
  $("#v2-based-on").textContent =
    `基于${data.recommendation.basedOnIssue}期及此前数据`;
  $("#v2-source-line").textContent =
    `官方数据更新至${data.sourceUpdatedThrough}`;
  $("#v2-periods").textContent = `${data.trainingPeriods}期`;
  $("#v2-all-metrics").innerHTML = ["dan", "pool5", "pool6", "pool7"]
    .map((play) => metricCard(play, data.metrics[play]))
    .join("");
  $("#v2-generated-at").textContent =
    `页面生成于${new Date(data.generatedAt).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    })}`;
  renderCurrent();
  $("#v2-loading").hidden = true;
  $("#v2-error").hidden = true;
  $("#v2-content").hidden = false;
}

async function load() {
  $("#v2-refresh").disabled = true;
  try {
    const dataFile = window.LotteryGame?.file("v2-data.json") ?? "v2-data.json";
    const response = await fetch(`./${dataFile}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("#v2-loading").hidden = true;
    $("#v2-error").textContent = `${error.message}。请稍后刷新。`;
    $("#v2-error").hidden = false;
  } finally {
    $("#v2-refresh").disabled = false;
  }
}

document.querySelectorAll(".play-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    activePlay = button.dataset.play;
    showAll = false;
    document.querySelectorAll(".play-tabs button").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    renderCurrent();
  });
});
$("#v2-refresh").addEventListener("click", load);
$("#v2-toggle-history").addEventListener("click", () => {
  showAll = !showAll;
  renderHistory();
});
$("#v2-search").addEventListener("input", (event) => {
  searchQuery = event.target.value;
  showAll = false;
  renderHistory();
});
load();
