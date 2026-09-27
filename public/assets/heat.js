const PASSWORD_HASH = "41368ab21298d9364e60169933ba2e9b67060b4f620b6551d9668b4396990444";
const labels = ["百位热度", "十位热度", "个位热度", "不定位热度"];

async function sha256(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ranking(label, values) {
  return `<article><span>${label}</span><div>${values.map((digit, index) => `<b><i>${index + 1}</i>${digit}</b>`).join("")}</div></article>`;
}

function historyRow(row) {
  return `<article><div><strong>${row.issue}期</strong><span>${row.date}</span><em>开奖号 ${row.draw}</em></div><div>${row.rankings.map((values, index) => `<p><span>${labels[index]}</span><b>${values.join(" ")}</b></p>`).join("")}</div></article>`;
}

function matrixNumber(item) {
  return `<article class="matrix22-number"><strong>${item.number}</strong><span>${item.shape}</span><small>${item.contributors.join(" · ")}</small></article>`;
}

function matrixHistoryRow(row) {
  return `<article><div><strong>${row.issue}期</strong><span>${row.date}</span><em>开奖 ${row.draw}</em>${row.version ? `<em>${row.version}</em>` : ""}</div><div><span class="${row.hit ? "matrix-hit" : "matrix-miss"}">${row.hit ? "命中" : "未中"}</span><p>${row.numbers.join(" · ")}</p></div></article>`;
}

function renderMatrix(matrix) {
  const rate = (matrix.replay.rate * 100).toFixed(2);
  document.querySelector("#matrix22-target").textContent = `第${matrix.targetIssue}期 · 22组直选`;
  document.querySelector("#matrix22-based").textContent = `${matrix.modelVersion} · 基于${matrix.basedOnIssue}期及以前数据`;
  document.querySelector("#matrix22-numbers").innerHTML = matrix.numbers.map(matrixNumber).join("");
  document.querySelector("#matrix22-structure").innerHTML = `<span>组六 <b>${matrix.structure.group6}</b>组</span><span>组三 <b>${matrix.structure.group3}</b>组</span><span>豹子 <b>${matrix.structure.triple}</b>组</span><span>${matrix.status}</span>`;
  document.querySelector("#matrix22-metrics").innerHTML = `<article><span>历史回放</span><strong>${matrix.replay.hits}/${matrix.replay.count}</strong></article><article><span>回放命中率</span><strong>${rate}%</strong></article><article><span>最长连断</span><strong>${matrix.replay.maxMiss}期</strong></article><article><span>当前连断</span><strong>${matrix.replay.currentMiss}期</strong></article>`;
  document.querySelector("#matrix22-method").textContent = matrix.method;
  document.querySelector("#matrix22-live-count").textContent = matrix.live.count ? `${matrix.modelVersion}：${matrix.live.hits}/${matrix.live.count} · 最长断${matrix.live.maxMiss}期` : `${matrix.modelVersion}等待首期官方开奖`;
  document.querySelector("#matrix22-live-history").innerHTML = matrix.liveRows.length ? matrix.liveRows.slice().reverse().map(matrixHistoryRow).join("") : '<p class="matrix22-empty">从第2026260期开始，开奖前锁定且不回改。</p>';
  document.querySelector("#matrix22-history").innerHTML = matrix.replayRows.map(matrixHistoryRow).join("");
}

async function loadHeat() {
  const loading = document.querySelector("#heat-loading");
  const error = document.querySelector("#heat-error");
  try {
    const response = await fetch(`./heat-data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    document.querySelector("#heat-through").textContent = data.updatedThrough;
    document.querySelector("#heat-count").textContent = `${data.totalRecords}期热度记录`;
    document.querySelector("#heat-notice").textContent = data.notice;
    renderMatrix(data.matrix22);
    document.querySelector("#heat-issue").textContent = `第${data.latest.issue}期`;
    document.querySelector("#heat-date").textContent = data.latest.date;
    document.querySelector("#heat-rankings").innerHTML = data.latest.rankings.map((values, index) => ranking(labels[index], values)).join("");
    const search = document.querySelector("#heat-search");
    const render = () => {
      const keyword = search.value.trim();
      const rows = data.history.filter((row) => !keyword || `${row.issue} ${row.date} ${row.draw}`.includes(keyword));
      document.querySelector("#heat-history-count").textContent = `${rows.length}期`;
      document.querySelector("#heat-history").innerHTML = rows.map(historyRow).join("");
    };
    search.addEventListener("input", render);
    render();
    loading.hidden = true;
    document.querySelector("#heat-content").hidden = false;
  } catch (cause) {
    loading.hidden = true;
    error.hidden = false;
    error.textContent = `热度数据读取失败：${cause.message}`;
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
if (sessionStorage.getItem("heat-module-unlocked") === "1") reveal();
