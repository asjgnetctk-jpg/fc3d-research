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
