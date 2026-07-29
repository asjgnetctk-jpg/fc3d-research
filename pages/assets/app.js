const $ = (selector) => document.querySelector(selector);
const labels = { dan: "独胆", pool5: "5码", pool6: "6码", pool7: "7码", group3: "组三" };
let payload;
let activePlay = "dan";
let showAll = false;
let searchQuery = "";

function updateBeijingTime() {
  $("#beijing-time").textContent = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}
updateBeijingTime();
setInterval(updateBeijingTime, 1000);

function badge(hit) {
  return `<span class="hit-badge${hit ? " is-hit" : ""}">${hit ? "中" : "未中"}</span>`;
}

function poolValue(row, play) {
  return play === "pool5" ? row.pool5 : play === "pool6" ? row.pool6 : row.pool7;
}

function rowHit(row, play) {
  return play === "dan"
    ? row.danHit
    : play === "pool5"
      ? row.pool5Hit
      : play === "pool6"
        ? row.pool6Hit
        : play === "pool7"
          ? row.pool7Hit
          : row.shapeHit;
}

function rowStreak(row, play) {
  return play === "dan"
    ? row.danMissStreak
    : play === "pool5"
      ? row.pool5MissStreak
      : play === "pool6"
        ? row.pool6MissStreak
        : play === "pool7"
          ? row.pool7MissStreak
          : row.shapeMissStreak;
}

function poolCovered(row, play) {
  return play === "pool5"
    ? row.pool5Group3Covered
    : play === "pool6"
      ? row.pool6Group3Covered
      : row.pool7Group3Covered;
}

function poolBadge(row, play) {
  return poolCovered(row, play)
    ? '<span class="hit-badge group3 is-covered">组三覆盖</span>'
    : badge(rowHit(row, play));
}

function matches(row) {
  const tokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const searchable = [
    row.date,
    row.issue,
    row.draw,
    `胆${row.dan}`,
    `5码${row.pool5}`,
    `6码${row.pool6}`,
    `7码${row.pool7}`,
    row.pool5,
    row.pool6,
    row.pool7,
    row.shapePlay,
    row.shape,
    `${(row.group3Probability * 100).toFixed(1)}%`,
  ].join(" ").toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

function historyRow(row) {
  const isGroup3 = activePlay === "group3";
  const isPool = activePlay.startsWith("pool");
  const evaluated = !isGroup3 || row.shapeEvaluated;
  const recommendation =
    activePlay === "dan"
      ? `胆${row.dan}`
      : isGroup3
        ? `${row.shapePlay} ${(row.group3Probability * 100).toFixed(1)}%`
        : poolValue(row, activePlay);
  const result =
    isGroup3 && !evaluated
      ? '<span class="hit-badge is-skip">未推荐</span>'
      : isPool
        ? poolBadge(row, activePlay)
        : badge(rowHit(row, activePlay));
  const streak =
    isGroup3 && !evaluated
      ? row.group3Level === "low" ? "低位" : "中位"
      : `断${rowStreak(row, activePlay)}`;
  return `
    <article class="history-row">
      <div class="history-date">
        <strong>${row.issue}</strong><span>${row.date.slice(5)}</span><em>滚动</em>
      </div>
      <div class="history-data">
        <div><span>推荐</span><strong>${recommendation}</strong></div>
        <div><span>开奖</span><strong>${row.draw}</strong><small>${row.shape}</small></div>
      </div>
      <div class="history-result single-result">
        <div><span>${labels[activePlay]}</span>${result}<small>${streak}</small></div>
      </div>
    </article>`;
}

function renderHistory() {
  const rows = payload.history.filter(matches).reverse();
  $("#search-count").textContent = `${rows.length}期`;
  $("#history-eyebrow").textContent = `${labels[activePlay]}逐期证据`;
  $("#toggle-history").hidden = rows.length <= 18;
  $("#toggle-history").textContent = showAll ? "收起记录" : `查看全部 ${rows.length} 期`;
  $("#history").innerHTML = (showAll ? rows : rows.slice(0, 18)).map(historyRow).join("");
}

function formulaText(play) {
  if (play === "dan") {
    return "先把每期开奖前可见的近期频率、定位频率、转移频率、遗漏、奇偶和中心距离转成特征，再按当前连续未中状态切换四套评分公式，对0—9排序后取一个独胆。当前公式由完整历史结果参与筛选，因此页面战绩属于训练回放，不是独立盲测。";
  }
  if (play === "group3") {
    return "采用扩展窗口在线逻辑模型：只用当期之前的数据更新参数，以历史组三频率、遗漏、最近三期形态及上一期结构为特征。概率进入最近365期预测值前20%时明确推荐组三；其他期只显示概率，不计推荐成败。超参数由完整历史结果筛选，回放成绩不代表未来。";
  }
  return `${labels[play]}使用独立的低断档公式。完整搜索记录比较了6,016套排名公式，并为每种玩法测试12,000套连续未中状态组合；每期开奖后更新近期频率、定位、遗漏和转移特征。开奖号必须为组六且三个不同数字全部入池才算命中，组三只单独标记覆盖。`;
}

function renderCurrent() {
  const recommendation = payload.recommendation;
  let html;
  if (activePlay === "dan") {
    html = `<div class="single-dan"><p>独胆推荐</p><strong>${recommendation.dan}</strong></div>`;
  } else if (activePlay.startsWith("pool")) {
    const pool = recommendation[activePlay];
    html = `<div class="single-pool"><p>${labels[activePlay]}推荐</p><div class="number-pills pool-${pool.length}">${pool
      .split("")
      .map((digit) => `<span>${digit}</span>`)
      .join("")}</div><small>组六全覆盖计命中；组三覆盖单独标记</small></div>`;
  } else {
    const level =
      recommendation.group3Level === "high"
        ? "高概率区"
        : recommendation.group3Level === "low"
          ? "低概率区"
          : "中间区";
    html = `<div class="single-group3"><span>模型判断</span><strong>${recommendation.shapePlay}</strong><b>${(
      recommendation.group3Probability * 100
    ).toFixed(1)}%</b><small>当前处于${level}；只有高概率区才进入组三推荐战绩</small></div>`;
  }
  $("#current-play").innerHTML = html;

  const metric = payload.metrics[activePlay];
  $("#metric-title").textContent = `${labels[activePlay]}滚动战绩`;
  $("#metric-count-label").textContent =
    activePlay === "group3" ? `明确推荐${metric.count}次` : `全部${metric.count}期`;
  $("#metric-score").textContent = `${metric.hits}/${metric.count}`;
  $("#metric-detail").textContent =
    `命中率 ${(metric.rate * 100).toFixed(1)}% · 最长连续未中 ${metric.maxMiss}期`;
  $("#group3-metric-note").hidden = activePlay !== "group3";
  $("#formula-label").textContent = `${labels[activePlay]}计算规则`;
  $("#formula-text").textContent = formulaText(activePlay);
  $("#formula-audits").innerHTML =
    activePlay === "group3"
      ? '<a href="./audit/full-history-training.json">查看组三全历史训练报告</a>'
      : activePlay === "pool5" || activePlay === "pool6"
        ? '<a href="./audit/full-history-training.json">查看5/6码全历史训练报告</a>'
        : '<a href="./audit/full-history-training.json">查看全历史训练报告</a>';
  renderHistory();
}

function render(data) {
  payload = data;
  $("#formula-version").textContent = `${data.formulaVersion} 逐期滚动`;
  $("#training-date").textContent = `数据更新至 ${data.trainingUpdatedThrough}`;
  $("#evaluation-notice").textContent = data.evaluationNotice;
  $("#integrity-summary").textContent =
    `数据范围 ${data.trainingDataStart}—${data.trainingUpdatedThrough} · ` +
    `前瞻从第${data.forwardStartIssue}期开始 · SHA-256 ` +
    `${data.dataIntegrity.canonicalSha256.slice(0, 16)}…`;
  $("#target-issue").textContent = `第${data.recommendation.targetIssue}期`;
  $("#based-on").textContent = `基于${data.recommendation.basedOnIssue}期及此前数据`;
  $("#source-line").textContent = `官方数据更新至 ${data.sourceUpdatedThrough}`;
  $("#total-periods").textContent = `${data.metrics.totalPeriods}期数据`;
  $("#generated-at").textContent = `页面生成于 ${new Date(data.generatedAt).toLocaleString(
    "zh-CN",
    { timeZone: "Asia/Shanghai", hour12: false },
  )}`;
  renderCurrent();
  $("#loading").hidden = true;
  $("#error").hidden = true;
  $("#content").hidden = false;
}

async function load() {
  $("#refresh").disabled = true;
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
$("#refresh").addEventListener("click", load);
$("#toggle-history").addEventListener("click", () => {
  showAll = !showAll;
  renderHistory();
});
$("#history-search").addEventListener("input", (event) => {
  searchQuery = event.target.value;
  showAll = false;
  renderHistory();
});
$("#toggle-formula").addEventListener("click", () => {
  const formula = $("#formula");
  formula.hidden = !formula.hidden;
  $("#toggle-formula").setAttribute("aria-expanded", String(!formula.hidden));
  $("#toggle-formula b").textContent = formula.hidden ? "+" : "−";
});
load();
