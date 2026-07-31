const $ = (selector) => document.querySelector(selector);

let payload;
let activeSize = 3;
let showAll = false;
let searchQuery = "";
let sortMode = "current";

function updateBeijingTime() {
  $("#beijing-time").textContent = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function activePool() {
  return payload.pools[`pool${activeSize}`];
}

function sortedRows() {
  const query = searchQuery.trim();
  const rows = activePool().rows.filter((row) =>
    query ? row.combination.includes(query) : true,
  );
  return rows.sort((left, right) => {
    if (sortMode === "max") {
      return (
        right.maxMiss - left.maxMiss ||
        right.currentMiss - left.currentMiss ||
        left.combination.localeCompare(right.combination)
      );
    }
    if (sortMode === "hits") {
      return (
        right.hits - left.hits ||
        left.combination.localeCompare(right.combination)
      );
    }
    if (sortMode === "combination") {
      return left.combination.localeCompare(right.combination);
    }
    return (
      right.currentMiss - left.currentMiss ||
      right.maxMiss - left.maxMiss ||
      left.combination.localeCompare(right.combination)
    );
  });
}

function summaryCard(label, value, note) {
  return `
    <div class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${note}</small>
    </div>`;
}

function combinationRow(row) {
  const recent = row.lastHitIssue
    ? `${row.lastHitIssue}期 · ${row.lastHitDate}`
    : "全历史尚未命中";
  const previousMiss =
    row.previousMiss === null || row.previousMissDays === null
      ? "—"
      : `${row.previousMissDays}天`;
  const previousMissUnit =
    row.previousMiss === null || row.previousMissDays === null
      ? "无上次记录"
      : `${row.previousMiss}期`;
  return `
    <article class="combination-row">
      <div class="combination-number">
        <span>${activeSize}码组合</span>
        <strong>${row.combination}</strong>
      </div>
      <div class="combination-metrics">
        <div class="is-current"><span>当前遗漏</span><strong>${row.currentMiss}</strong><small>期</small></div>
        <div class="is-previous"><span>上期遗漏</span><strong>${previousMiss}</strong><small>${previousMissUnit}</small></div>
        <div><span>历史最大</span><strong>${row.maxMiss}</strong><small>期</small></div>
        <div><span>理论命中</span><strong>${row.theoreticalHits.toFixed(1)}</strong><small>次</small></div>
        <div><span>实际命中</span><strong>${row.hits}</strong><small>次</small></div>
      </div>
      <div class="combination-recent">
        <span>最近命中</span>
        <strong>${recent}</strong>
      </div>
    </article>`;
}

function renderSummary() {
  const pool = activePool();
  const maximumCurrent = Math.max(...pool.rows.map((row) => row.currentMiss));
  const maximumHistorical = Math.max(...pool.rows.map((row) => row.maxMiss));
  $("#combination-eyebrow").textContent = `${activeSize}码组合遗漏`;
  $("#combination-count-chip").textContent = `${pool.count}种组合`;
  $("#combination-list-title").textContent = `${activeSize}码全部组合明细`;
  $("#combination-summary-cards").innerHTML = [
    summaryCard("组合数量", pool.count, `C(10,${activeSize})`),
    summaryCard("当前最大遗漏", `${maximumCurrent}期`, "该位数所有组合中的最高值"),
    summaryCard("历史最大遗漏", `${maximumHistorical}期`, "全部统计期内的最高值"),
    summaryCard(
      "理论命中",
      `${pool.theoreticalHits.toFixed(1)}次`,
      `单组合理论率 ${(pool.theoreticalHitRate * 100).toFixed(1)}%`,
    ),
  ].join("");
}

function renderList() {
  const rows = sortedRows();
  const visible = showAll ? rows : rows.slice(0, 30);
  $("#combination-result-count").textContent = `找到 ${rows.length} 种组合`;
  $("#combination-list").innerHTML = visible.map(combinationRow).join("");
  $("#combination-toggle").hidden = rows.length <= 30;
  $("#combination-toggle").textContent = showAll
    ? "收起组合"
    : `查看全部 ${rows.length} 种组合`;
}

function selectSize(size) {
  activeSize = Number(size);
  showAll = false;
  searchQuery = "";
  $("#combination-search").value = "";
  document.querySelectorAll(".combination-tabs button").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.size) === activeSize);
  });
  renderSummary();
  renderList();
}

function render(data) {
  payload = data;
  $("#omission-range").textContent =
    `${data.dataStart}—${data.dataEnd} · ${data.periods}期`;
  $("#omission-source").textContent = `更新至${data.sourceUpdatedThrough}`;
  $("#omission-generated-at").textContent =
    `页面生成于${new Date(data.generatedAt).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    })}`;
  selectSize(activeSize);
  $("#omission-loading").hidden = true;
  $("#omission-error").hidden = true;
  $("#omission-content").hidden = false;
}

async function load() {
  $("#omission-refresh").disabled = true;
  try {
    const dataFile =
      window.LotteryGame?.file("omissions-data.json") ?? "omissions-data.json";
    const response = await fetch(`./${dataFile}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`数据请求失败：HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("#omission-loading").hidden = true;
    $("#omission-error").textContent = `${error.message}。请稍后刷新。`;
    $("#omission-error").hidden = false;
  } finally {
    $("#omission-refresh").disabled = false;
  }
}

document.querySelectorAll(".combination-tabs button").forEach((button) => {
  button.addEventListener("click", () => selectSize(button.dataset.size));
});
$("#combination-search").addEventListener("input", (event) => {
  searchQuery = event.target.value.replace(/\D/g, "");
  showAll = false;
  renderList();
});
$("#combination-sort").addEventListener("change", (event) => {
  sortMode = event.target.value;
  showAll = false;
  renderList();
});
$("#combination-toggle").addEventListener("click", () => {
  showAll = !showAll;
  renderList();
});
$("#omission-refresh").addEventListener("click", load);

updateBeijingTime();
setInterval(updateBeijingTime, 1000);
load();
