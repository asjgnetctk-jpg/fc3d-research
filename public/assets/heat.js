const PASSWORD_HASH = "41368ab21298d9364e60169933ba2e9b67060b4f620b6551d9668b4396990444";
const positionNames = { hundreds: "百位", tens: "十位", units: "个位" };
let privatePositionPayload = null;
let privatePositionSize = 7;
let privatePositionShowAll = false;
let privatePositionQuery = "";

async function sha256(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function matrixNumber(item) {
  return `<article class="matrix22-number"><strong>${item.number}</strong><span>${item.shape}</span><small>${item.contributors.join(" · ")}</small></article>`;
}

function matrixHistoryRow(row) {
  const recordLabel = row.recordType === "live" ? `真实前瞻 · ${row.version}` : "历史回放";
  return `<article><div><strong>${row.issue}期</strong><span>${row.date}</span><em>开奖 ${row.draw}</em><em>${recordLabel}</em></div><div><span class="${row.hit ? "matrix-hit" : "matrix-miss"}">${row.hit ? "命中" : "未中"}</span><p>${row.numbers.join(" · ")}</p></div></article>`;
}

function coverageHistoryRow(row) {
  return `<article><div><strong>${row.issue}期</strong><span>${row.date}</span><em>开奖 ${row.draw}</em></div><div><span class="${row.hit ? "matrix-hit" : "matrix-miss"}">${row.hit ? "已覆盖" : "未覆盖"}</span><p>${row.numbers.join(" · ")}</p></div></article>`;
}

function positionPills(value) {
  return `<div class="position7-pills" data-pool-size="${value.length}" style="--pool-size:${value.length}">${[...value].map((digit) => `<b>${digit}</b>`).join("")}</div>`;
}

function percentage(value) {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

function privatePositionHistoryRow(row) {
  const lines = Object.entries(positionNames).map(([key, name], index) => {
    const hit = row[`${key}Hit`];
    return `<div class="position7-line"><span>${name}</span><strong>${row[`${key}Pool`]}</strong><span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span><small>开奖号${row.draw[index]} · 断${row[`${key}MissStreak`]}</small></div>`;
  }).join("");
  const phase = row.phase === "prospective-locked" ? "前瞻" : row.phase === "locked-forward" ? "实战" : row.phase === "locked-research" ? "锁定研究" : "训练";
  return `<article class="position7-row"><div class="history-date"><strong>${row.issue}</strong><span>${row.date.slice(5)}</span><em>${phase}</em></div><div class="position7-row-main"><div class="position7-draw">开奖 <strong>${row.draw}</strong><span class="hit-badge${row.allHit ? " is-hit" : ""}">${row.allHit ? "三位全中" : "未全中"}</span></div>${lines}</div></article>`;
}

function renderPrivatePositionHistory() {
  const result = privatePositionPayload?.pools?.[privatePositionSize];
  if (!result) return;
  const rows = result.history.filter((row) => !privatePositionQuery || [row.issue, row.date, row.draw, row.hundredsPool, row.tensPool, row.unitsPool].join(" ").includes(privatePositionQuery)).reverse();
  document.querySelector("#private-position-history-count").textContent = `${rows.length}期`;
  document.querySelector("#private-position-history").innerHTML = rows.length
    ? (privatePositionShowAll ? rows : rows.slice(0, 20)).map(privatePositionHistoryRow).join("")
    : '<p class="matrix22-empty">新版融合定位尚未产生首期真实前瞻记录；北京时间20:20后锁定推荐，开奖后才会在这里新增记录。历史研究命中率不冒充真实前瞻。</p>';
  const toggle = document.querySelector("#private-position-toggle");
  toggle.hidden = rows.length <= 20;
  toggle.textContent = privatePositionShowAll ? "收起记录" : `查看全部 ${rows.length} 期`;
  const forwardIssues = new Set(result.history.map((row) => String(row.issue)));
  const forwardDates = new Set(result.history.map((row) => row.date));
  const researchRows = (result.researchHistory ?? []).filter((row) =>
    !forwardIssues.has(String(row.issue)) && !forwardDates.has(row.date),
  );
  const researchSummary = document.querySelector("#private-position-research-summary");
  const researchHistory = document.querySelector("#private-position-research-history");
  if (researchSummary) researchSummary.textContent = `查看最近一年 ${researchRows.length} 期锁定研究明细（已排除真实前瞻同期）`;
  if (researchHistory) researchHistory.innerHTML = researchRows.slice().reverse().map(privatePositionHistoryRow).join("");
}

function renderPrivatePosition(size) {
  const result = privatePositionPayload?.pools?.[size];
  if (!result) return;
  privatePositionSize = size;
  privatePositionShowAll = false;
  document.querySelectorAll("[data-private-pool-size]").forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.privatePoolSize) === size);
  });
  const recommendation = result.recommendation;
  document.querySelector("#private-position-target").textContent = `第${recommendation?.targetIssue ?? privatePositionPayload.targetIssue}期 · 融合定位${size}码`;
  document.querySelector("#private-position-based").textContent = recommendation ? `基于${recommendation.basedOnIssue}期及以前数据` : result.status;
  document.querySelector("#private-position-recommendation").innerHTML = recommendation
    ? Object.entries(positionNames).map(([key, name]) => `<article><span>${name}${size}码</span>${positionPills(recommendation[`${key}Pool`])}</article>`).join("")
    : '<p class="matrix22-empty">等待北京时间20:20后抓取当期热度，成功后才生成并锁定本期定位码。</p>';
  const joint = result.metrics.jointForward ?? result.metrics.joint;
  const forward = result.metrics.all.forward;
  const positionRate = `${percentage(joint.positionRates.hundreds)} / ${percentage(joint.positionRates.tens)} / ${percentage(joint.positionRates.units)}`;
  document.querySelector("#private-position-metrics").innerHTML = [
    ["真实前瞻全中率", joint.count ? `${joint.allThreeHits}/${joint.count} · ${percentage(joint.allThreeRate)}` : "等待首期开奖"],
    ["五年分段研究", `${percentage(result.developmentEvidence.rate)} · 最长断${result.developmentEvidence.maxMiss}期`],
    ["最近一年锁定段", `${percentage(result.developmentEvidence.recentYearRate)} · 最长断${result.developmentEvidence.recentYearMaxMiss}期`],
    ["理论基线 / 五年差值", `${percentage(result.developmentEvidence.theoreticalRate)} / ${result.developmentEvidence.excessRate >= 0 ? "+" : ""}${percentage(result.developmentEvidence.excessRate)}`],
    ["错位率", percentage(joint.mismatchRate)],
    ["同步效率", joint.syncEfficiency.toFixed(3)],
    ["最大未全中遗漏", `${joint.maxAllMiss}期`],
    ["百/十/个位", positionRate],
    ["联合评分", joint.score.toFixed(4)],
    ["盲测最长/当前断", `${forward.maxMiss}期 / ${forward.currentMiss}期`],
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
  const rows = [30, 100, 300, 500].map((window) => {
    const item = result.metrics.windows[window];
    return `<tr><th>近${window}期</th><td>${item.count}</td><td>${percentage(item.allThreeRate)}</td><td>${percentage(item.mismatchRate)}</td><td>${item.syncEfficiency.toFixed(3)}</td><td>${item.maxAllMiss}期</td></tr>`;
  }).join("");
  document.querySelector("#private-position-windows").innerHTML = `<table><thead><tr><th>窗口</th><th>样本</th><th>全中率</th><th>错位率</th><th>同步效率</th><th>最大遗漏</th></tr></thead><tbody>${rows}</tbody></table>`;
  document.querySelector("#private-position-notice").textContent = `“历史研究参考”只用于选模，不计入真实前瞻；真实前瞻从本版本开奖前锁定后逐期累计。${privatePositionPayload.notice}`;
  renderPrivatePositionHistory();
}

function selectMatrixPanel(panel) {
  if (!["straight", "coverage", "position"].includes(panel)) panel = "straight";
  document.querySelectorAll("[data-matrix-panel-section]").forEach((section) => {
    section.hidden = section.dataset.matrixPanelSection !== panel;
  });
  document.querySelectorAll("[data-matrix-panel]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.matrixPanel === panel);
  });
  sessionStorage.setItem("private-matrix-panel", panel);
}

function renderMatrix(matrix) {
  const rate = (matrix.replay.rate * 100).toFixed(2);
  document.querySelector("#matrix22-target").textContent = `第${matrix.targetIssue}期 · 22组直选`;
  const snapshotText = matrix.heatSnapshot?.capturedAtBeijing
    ? ` · 热度锁定 ${matrix.heatSnapshot.capturedAtBeijing}`
    : " · 等待当期热度";
  document.querySelector("#matrix22-based").textContent = `${matrix.modelVersion} · 基于${matrix.basedOnIssue}期及以前数据${snapshotText}`;
  document.querySelector("#matrix22-numbers").innerHTML = matrix.numbers.length
    ? matrix.numbers.map(matrixNumber).join("")
    : '<p class="matrix22-empty">等待北京时间20:20后抓取当期热度。抓取成功后才会生成并锁定22组。</p>';
  document.querySelector("#matrix22-structure").innerHTML = `<span>组六 <b>${matrix.structure.group6}</b>组</span><span>组三 <b>${matrix.structure.group3}</b>组</span><span>豹子 <b>${matrix.structure.triple}</b>组</span><span>${matrix.status}</span>`;
  document.querySelector("#matrix22-metrics").innerHTML = `<article><span>历史回放</span><strong>${matrix.replay.hits}/${matrix.replay.count}</strong></article><article><span>回放命中率</span><strong>${rate}%</strong></article><article><span>最长连断</span><strong>${matrix.replay.maxMiss}期</strong></article><article><span>当前连断</span><strong>${matrix.replay.currentMiss}期</strong></article>`;
  document.querySelector("#matrix22-method").textContent = matrix.method;
  const replayRows = matrix.replayRows ?? [];
  const currentLiveRows = (matrix.liveRows ?? []).filter((row) => row.version === matrix.modelVersion);
  const liveDates = new Set(currentLiveRows.map((row) => row.date));
  const visibleReplayRows = replayRows.filter((row) => !liveDates.has(row.date));
  const combinedRows = [
    ...currentLiveRows.map((row) => ({ ...row, recordType: "live" })),
    ...visibleReplayRows.map((row) => ({ ...row, recordType: "replay" })),
  ].sort((left, right) => right.date.localeCompare(left.date) || Number(right.recordType === "live") - Number(left.recordType === "live"));
  document.querySelector("#matrix22-live-count").textContent = currentLiveRows.length
    ? `${matrix.modelVersion}前瞻 ${matrix.live.hits}/${matrix.live.count} · 回放${replayRows.length}期`
    : `${matrix.modelVersion}等待首期官方开奖 · 回放${replayRows.length}期`;
  document.querySelector("#matrix22-live-history").innerHTML = combinedRows.length
    ? combinedRows.map(matrixHistoryRow).join("")
    : '<p class="matrix22-empty">暂无可显示的前瞻或历史回放记录。</p>';
}

function renderCoverage(matrix) {
  const rate = (matrix.replay.rate * 100).toFixed(2);
  document.querySelector("#matrix22-coverage-target").textContent = `第${matrix.targetIssue}期 · 22组组选覆盖`;
  const snapshotText = matrix.heatSnapshot?.capturedAtBeijing ? ` · 热度锁定 ${matrix.heatSnapshot.capturedAtBeijing}` : " · 等待当期热度";
  document.querySelector("#matrix22-coverage-based").textContent = `${matrix.modelVersion} · 基于${matrix.basedOnIssue}期及以前数据${snapshotText}`;
  document.querySelector("#matrix22-coverage-numbers").innerHTML = matrix.numbers.length
    ? matrix.numbers.map(matrixNumber).join("")
    : '<p class="matrix22-empty">等待北京时间20:20后抓取当期热度，与直选版同时生成并分别锁定。</p>';
  document.querySelector("#matrix22-coverage-structure").innerHTML = `<span>组六 <b>${matrix.structure.group6}</b>组</span><span>组三 <b>${matrix.structure.group3}</b>组</span><span>豹子 <b>${matrix.structure.triple}</b>组</span><span>${matrix.status}</span>`;
  document.querySelector("#matrix22-coverage-metrics").innerHTML = `<article><span>组选回放</span><strong>${matrix.replay.hits}/${matrix.replay.count}</strong></article><article><span>组选覆盖率</span><strong>${rate}%</strong></article><article><span>最长未覆盖</span><strong>${matrix.replay.maxMiss}期</strong></article><article><span>当前未覆盖</span><strong>${matrix.replay.currentMiss}期</strong></article>`;
  document.querySelector("#matrix22-coverage-method").textContent = matrix.method;
  document.querySelector("#matrix22-coverage-history").innerHTML = matrix.replayRows.map(coverageHistoryRow).join("");
}

async function loadHeat() {
  const loading = document.querySelector("#heat-loading");
  const error = document.querySelector("#heat-error");
  try {
    const dataFile = window.LotteryGame?.file("heat-data.json") ?? "heat-data.json";
    const positionFile = window.LotteryGame?.file("meta-position-data.json") ?? "meta-position-data.json";
    const [response, positionResponse] = await Promise.all([
      fetch(`./${dataFile}?t=${Date.now()}`, { cache: "no-store" }),
      fetch(`./${positionFile}?t=${Date.now()}`, { cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (positionResponse.ok) {
      privatePositionPayload = await positionResponse.json();
      const targets = [
        data.matrix22?.targetIssue,
        data.matrix22Coverage?.targetIssue,
        ...Object.values(privatePositionPayload.pools ?? {}).map((pool) => pool.recommendation?.targetIssue ?? privatePositionPayload.targetIssue),
      ].filter(Boolean).map(String);
      const cutoffs = [
        data.matrix22?.basedOnIssue,
        data.matrix22Coverage?.basedOnIssue,
        ...Object.values(privatePositionPayload.pools ?? {}).map((pool) => pool.recommendation?.basedOnIssue),
      ].filter(Boolean).map(String);
      if (new Set(targets).size !== 1 || new Set(cutoffs).size !== 1) {
        throw new Error(`推荐数据不同步：目标期 ${[...new Set(targets)].join("/")}，数据截止期 ${[...new Set(cutoffs)].join("/")}`);
      }
      renderPrivatePosition(7);
    } else {
      document.querySelector("#private-position-notice").textContent = `定位推荐读取失败：HTTP ${positionResponse.status}`;
    }
    document.querySelector("#heat-through").textContent = `数据更新至 ${data.updatedThrough} · 本页推荐第${data.matrix22.targetIssue}期`;
    document.querySelector("#heat-count").textContent = `${data.totalRecords}期数据记录`;
    document.querySelector("#heat-notice").textContent = data.notice;
    renderMatrix(data.matrix22);
    renderCoverage(data.matrix22Coverage);
    loading.hidden = true;
    document.querySelector("#heat-content").hidden = false;
  } catch (cause) {
    loading.hidden = true;
    error.hidden = false;
    error.textContent = `矩阵数据读取失败：${cause.message}`;
  }
}

async function unlock(password) {
  if (await sha256(password) !== PASSWORD_HASH) return false;
  sessionStorage.setItem("heat-module-unlocked", "1");
  await reveal();
  return true;
}

async function reveal() {
  document.querySelector("#heat-lock").hidden = true;
  document.querySelector("#heat-app").hidden = false;
  await loadHeat();
}

document.querySelector("#heat-login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#heat-password");
  const accepted = await unlock(input.value);
  document.querySelector("#heat-login-error").hidden = accepted;
  if (!accepted) { input.value = ""; input.focus(); }
});
document.querySelector("#heat-lock-button").addEventListener("click", () => {
  sessionStorage.removeItem("heat-module-unlocked");
  location.reload();
});
document.querySelector("#private-position-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-private-pool-size]");
  if (button) renderPrivatePosition(Number(button.dataset.privatePoolSize));
});
document.querySelector("#private-position-search").addEventListener("input", (event) => {
  privatePositionQuery = event.target.value.trim();
  privatePositionShowAll = false;
  renderPrivatePositionHistory();
});
document.querySelector("#private-position-toggle").addEventListener("click", () => {
  privatePositionShowAll = !privatePositionShowAll;
  renderPrivatePositionHistory();
});
document.querySelector("#matrix-panel-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-matrix-panel]");
  if (button) selectMatrixPanel(button.dataset.matrixPanel);
});
selectMatrixPanel(sessionStorage.getItem("private-matrix-panel") ?? "straight");
if (sessionStorage.getItem("heat-module-unlocked") === "1") reveal();
