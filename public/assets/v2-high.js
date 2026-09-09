const labels = { dan: "独胆", pool5: "5码", pool6: "6码", pool7: "7码" };
const root = "https://raw.githubusercontent.com/asjgnetctk-jpg/fc3d-research/main/pages";
function card(play, metric) { return `<div class="metric-card"><span>${labels[play]}</span><strong>实际命中率 ${(metric.rate * 100).toFixed(1)}%</strong><small>${metric.hits}/${metric.count} · 最长连断${metric.maxMiss}期</small></div>`; }
async function load() { try { const response = await fetch(`${root}/v2-data.json?t=${Date.now()}`, { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json(); document.querySelector("#latest-source").textContent = `数据截至第${data.recommendation.basedOnIssue}期`; document.querySelector("#baseline-metrics").innerHTML = ["dan", "pool5", "pool6", "pool7"].map((play) => card(play, data.actualMetrics[play])).join(""); } catch (error) { document.querySelector("#latest-source").textContent = `数据读取失败：${error.message}`; } }
load();
