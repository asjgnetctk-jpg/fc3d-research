"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type PlayKey = "dan" | "pool5" | "pool6" | "pool7" | "group3";
type LongestRun = {
  length: number;
  startIssue: string;
  startDate: string;
  endIssue: string;
  endDate: string;
};
type PeriodMetric = {
  count: number;
  hits: number;
  rate: number;
  maxMiss: number;
  startDate: string;
  longestRuns: LongestRun[];
};
type Metric = {
  count: number;
  hits: number;
  rate: number;
  maxMiss: number;
  recentOneYear: PeriodMetric;
  recentThreeYears: PeriodMetric;
};

type OmissionMetric = {
  current: number;
  max: number;
  lastSeenIssue: string | null;
  lastSeenDate: string | null;
  maxRuns: LongestRun[];
};

type DigitOmission = {
  digit: number;
  overall: OmissionMetric;
  hundreds: OmissionMetric;
  tens: OmissionMetric;
  units: OmissionMetric;
};

type Recommendation = {
  targetIssue: string;
  basedOnIssue: string;
  basedOnDate: string;
  dan: number;
  pool5: string;
  pool6: string;
  pool7: string;
  shapePlay: string;
  group3Probability: number;
  group3Level: "high" | "middle" | "low";
};

type HistoryRow = {
  date: string;
  issue: string;
  dan: number;
  pool5: string;
  pool6: string;
  pool7: string;
  shapePlay: string;
  group3Probability: number;
  group3Level: "high" | "middle" | "low";
  shapeEvaluated: boolean;
  draw: string;
  shape: string;
  danHit: boolean;
  pool5Hit: boolean;
  pool6Hit: boolean;
  pool7Hit: boolean;
  pool5Group3Covered: boolean;
  pool6Group3Covered: boolean;
  pool7Group3Covered: boolean;
  shapeHit: boolean;
  danMissStreak: number;
  pool5MissStreak: number;
  pool6MissStreak: number;
  pool7MissStreak: number;
  shapeMissStreak: number;
};

type ApiPayload = {
  generatedAt: string;
  sourceUpdatedThrough: string;
  recommendation: Recommendation;
  history: HistoryRow[];
  metrics: {
    dan: Metric;
    pool5: Metric;
    pool6: Metric;
    pool7: Metric;
    group3: Metric;
    totalPeriods: number;
  };
  formulaVersion: string;
  trainingUpdatedThrough: string;
  trainingDataStart: string;
  forwardStartIssue: string;
  evaluationNotice: string;
  dataIntegrity: {
    periods: number;
    canonicalSha256: string;
    report: string;
  };
  digitOmissions: {
    throughIssue: string;
    throughDate: string;
    totalPeriods: number;
    definition: string;
    digits: DigitOmission[];
  };
};

const PLAYS: Array<{ key: PlayKey; label: string }> = [
  { key: "dan", label: "独胆" },
  { key: "pool5", label: "5码" },
  { key: "pool6", label: "6码" },
  { key: "pool7", label: "7码" },
  { key: "group3", label: "组三" },
];

function BeijingClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="beijing-clock">
      <span>北京时间</span>
      <strong>
        {now
          ? now.toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour12: false,
            })
          : "正在校时"}
      </strong>
    </div>
  );
}

function HitBadge({ hit }: { hit: boolean }) {
  return (
    <span className={hit ? "hit-badge is-hit" : "hit-badge"}>
      {hit ? "中" : "未中"}
    </span>
  );
}

function PoolBadge({
  hit,
  covered,
}: {
  hit: boolean;
  covered: boolean;
}) {
  if (covered) {
    return <span className="hit-badge group3 is-covered">组三覆盖</span>;
  }
  return <HitBadge hit={hit} />;
}

function metricFor(data: ApiPayload, play: PlayKey) {
  return data.metrics[play];
}

function playLabel(play: PlayKey) {
  return PLAYS.find((item) => item.key === play)?.label ?? play;
}

function poolValue(row: HistoryRow, play: PlayKey) {
  if (play === "pool5") return row.pool5;
  if (play === "pool6") return row.pool6;
  return row.pool7;
}

function rowHit(row: HistoryRow, play: PlayKey) {
  if (play === "dan") return row.danHit;
  if (play === "pool5") return row.pool5Hit;
  if (play === "pool6") return row.pool6Hit;
  if (play === "pool7") return row.pool7Hit;
  return row.shapeHit;
}

function rowStreak(row: HistoryRow, play: PlayKey) {
  if (play === "dan") return row.danMissStreak;
  if (play === "pool5") return row.pool5MissStreak;
  if (play === "pool6") return row.pool6MissStreak;
  if (play === "pool7") return row.pool7MissStreak;
  return row.shapeMissStreak;
}

function poolCovered(row: HistoryRow, play: PlayKey) {
  if (play === "pool5") return row.pool5Group3Covered;
  if (play === "pool6") return row.pool6Group3Covered;
  return row.pool7Group3Covered;
}

function matchesHistorySearch(row: HistoryRow, query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
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
    row.shapeEvaluated ? "推荐组三" : "未推荐组三",
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

function formulaText(play: PlayKey) {
  if (play === "dan") {
    return "先把每期开奖前可见的近期频率、定位频率、转移频率、遗漏、奇偶和中心距离转成特征，再按当前连续未中状态切换四套评分公式，对0—9排序后取一个独胆。当前公式由完整历史结果参与筛选，因此页面战绩属于训练回放，不是独立盲测。";
  }
  if (play === "group3") {
    return "采用扩展窗口在线逻辑模型：只用当期之前的数据更新参数，以历史组三频率、遗漏、最近三期形态及上一期结构为特征。概率进入最近365期预测值前20%时明确推荐组三；其他期只显示概率，不计推荐成败。超参数由完整历史结果筛选，回放成绩不代表未来。";
  }
  return `${playLabel(play)}使用独立公式。扩大搜索比较了24,016套排名公式和8,000套十段连断状态组合，并对高连断状态追加每段12,000套修复公式；只有全历史最长连断确实下降才替换旧模型。开奖号必须为组六且三个不同数字全部入池才算命中，组三只单独标记覆盖。`;
}

export default function Home() {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activePlay, setActivePlay] = useState<PlayKey>("dan");
  const [showFormula, setShowFormula] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/recommend", { cache: "no-store" });
      if (!response.ok) throw new Error("暂时无法读取最新开奖");
      setData((await response.json()) as ApiPayload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刷新失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void load());
    return () => cancelAnimationFrame(frame);
  }, [load]);

  const filteredRows = useMemo(
    () =>
      data?.history
        .filter((row) => matchesHistorySearch(row, searchQuery))
        .reverse() ?? [],
    [data, searchQuery],
  );
  const history = showAll ? filteredRows : filteredRows.slice(0, 18);

  if (loading && !data) {
    return (
      <main className="app-shell loading-shell">
        <div className="loading-mark">3D</div>
        <p>正在读取最新开奖并计算今日号码…</p>
      </main>
    );
  }
  if (error && !data) {
    return (
      <main className="app-shell error-shell">
        <div className="loading-mark">!</div>
        <h1>数据暂时没有接通</h1>
        <p>{error}</p>
        <button className="primary-button" onClick={() => void load()}>
          重新刷新
        </button>
      </main>
    );
  }
  if (!data) return null;

  const metric = metricFor(data, activePlay);
  const recommendation = data.recommendation;
  const pool =
    activePlay === "pool5"
      ? recommendation.pool5
      : activePlay === "pool6"
        ? recommendation.pool6
        : recommendation.pool7;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">福彩3D · 私人研究台</p>
          <h1>五项滚动研究</h1>
        </div>
        <button
          className="refresh-button"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "刷新中" : "刷新"}
        </button>
      </header>

      <BeijingClock />

      <nav className="version-switch three-versions" aria-label="切换算法版本">
        <Link className="is-active" href="/" aria-current="page">
          <strong>V7</strong><span>当前算法</span>
        </Link>
        <Link href="/v2.html">
          <strong>V2</strong>
        </Link>
        <Link href="/v5.html">
          <strong>V5</strong><span>历史算法</span>
        </Link>
      </nav>

      <section className="status-strip">
        <span className="status-dot" />
        <span>{data.formulaVersion} 逐期滚动</span>
        <span className="status-separator">·</span>
        <span>数据更新至 {data.trainingUpdatedThrough}</span>
      </section>

      <section className="section-block integrity-block">
        <p className="section-note">{data.evaluationNotice}</p>
        <div className="audit-links">
          <a href="/audit/full-history-integrity.json">查看7706期数据真实性报告</a>
          <a href="/audit/full-history-training.json">查看全历史训练与回放报告</a>
        </div>
        <small>
          数据范围 {data.trainingDataStart}—{data.trainingUpdatedThrough} ·
          前瞻记录从第{data.forwardStartIssue}期开始 · SHA-256{" "}
          {data.dataIntegrity.canonicalSha256.slice(0, 16)}…
        </small>
      </section>

      <section className="section-block omission-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">0—9完整历史统计</p>
            <h2>数字与定位遗漏</h2>
          </div>
          <span className="backfit-chip">
            截止{data.digitOmissions.throughIssue}期
          </span>
        </div>
        <p className="section-note">{data.digitOmissions.definition}</p>
        <div className="omission-legend" aria-label="遗漏表图例">
          <span><i className="current-dot" />当前遗漏</span>
          <span><i className="max-dot" />历史最大</span>
        </div>
        <div className="omission-table-wrap">
          <table className="omission-table">
            <thead>
              <tr>
                <th>数字</th>
                <th>整体</th>
                <th>百位</th>
                <th>十位</th>
                <th>个位</th>
              </tr>
            </thead>
            <tbody>
              {data.digitOmissions.digits.map((row) => (
                <tr key={row.digit}>
                  <th scope="row"><b>{row.digit}</b></th>
                  {(["overall", "hundreds", "tens", "units"] as const).map(
                    (key) => (
                      <td key={key}>
                        <span className="omission-current">
                          今 <b>{row[key].current}</b>
                        </span>
                        <span className="omission-max">
                          最大 <b>{row[key].max}</b>
                        </span>
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <small className="omission-through">
          共统计{data.digitOmissions.totalPeriods}期，最新开奖日期
          {data.digitOmissions.throughDate}。点击或横向滑动表格可完整查看定位数据。
        </small>
      </section>

      <nav className="play-tabs" aria-label="切换研究项目">
        {PLAYS.map((play) => (
          <button
            key={play.key}
            className={activePlay === play.key ? "is-active" : ""}
            onClick={() => {
              setActivePlay(play.key);
              setShowAll(false);
            }}
          >
            {play.label}
          </button>
        ))}
      </nav>

      <section className="hero-card play-hero">
        <div className="hero-meta">
          <span>第 {recommendation.targetIssue} 期</span>
          <span>基于 {recommendation.basedOnIssue} 期及此前数据</span>
        </div>
        {activePlay === "dan" && (
          <div className="single-dan">
            <p>独胆推荐</p>
            <strong>{recommendation.dan}</strong>
          </div>
        )}
        {activePlay.startsWith("pool") && (
          <div className="single-pool">
            <p>{playLabel(activePlay)}推荐</p>
            <div className={`number-pills pool-${pool.length}`}>
              {pool.split("").map((digit) => <span key={digit}>{digit}</span>)}
            </div>
            <small>组六全覆盖计命中；组三覆盖单独标记</small>
          </div>
        )}
        {activePlay === "group3" && (
          <div className="single-group3">
            <span>模型判断</span>
            <strong>{recommendation.shapePlay}</strong>
            <b>{(recommendation.group3Probability * 100).toFixed(1)}%</b>
            <small>
              当前处于
              {recommendation.group3Level === "high"
                ? "高概率区"
                : recommendation.group3Level === "low"
                  ? "低概率区"
                  : "中间区"}
              ；只有高概率区才进入组三推荐战绩
            </small>
          </div>
        )}
        <div className="source-line">官方数据更新至 {data.sourceUpdatedThrough}</div>
      </section>

      <section className="section-block total-result">
        <div className="section-heading">
          <div>
            <p className="eyebrow">全部期数总结果</p>
            <h2>{playLabel(activePlay)}滚动战绩</h2>
          </div>
          <span className="backfit-chip">{data.metrics.totalPeriods}期数据</span>
        </div>
        <div className="metric-card">
          <span>
            {activePlay === "group3"
              ? `明确推荐${metric.count}次`
              : `全部${metric.count}期`}
          </span>
          <strong>{metric.hits}/{metric.count}</strong>
          <small>
            命中率 {(metric.rate * 100).toFixed(1)}% · 最长连续未中{" "}
            {metric.maxMiss}期
          </small>
        </div>
        <div className="recent-metric one-year">
          <span>近1年（{metric.recentOneYear.startDate}起）</span>
          <strong>
            {metric.recentOneYear.hits}/{metric.recentOneYear.count} ·
            命中率{(metric.recentOneYear.rate * 100).toFixed(1)}%
          </strong>
          <b>最长连断 {metric.recentOneYear.maxMiss}期</b>
          <small>
            {metric.recentOneYear.longestRuns.length
              ? metric.recentOneYear.longestRuns
                  .map(
                    (run) =>
                      `${run.startIssue}期（${run.startDate}）—${run.endIssue}期（${run.endDate}）`,
                  )
                  .join("；")
              : "没有未命中区间"}
          </small>
        </div>
        <div className="recent-metric three-year">
          <span>近3年（{metric.recentThreeYears.startDate}起）</span>
          <strong>
            {metric.recentThreeYears.hits}/{metric.recentThreeYears.count} ·
            命中率{(metric.recentThreeYears.rate * 100).toFixed(1)}%
          </strong>
          <b>最长连断 {metric.recentThreeYears.maxMiss}期</b>
          <small>
            {metric.recentThreeYears.longestRuns.length
              ? metric.recentThreeYears.longestRuns
                  .map(
                    (run) =>
                      `${run.startIssue}期（${run.startDate}）—${run.endIssue}期（${run.endDate}）`,
                  )
                  .join("；")
              : "没有未命中区间"}
          </small>
        </div>
        {activePlay === "group3" && (
          <p className="section-note">
            未明确推荐组三的期数不算中奖，也不算失败；避免用“非组三概率高”抬高成绩。
          </p>
        )}
      </section>

      <section className="section-block history-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{playLabel(activePlay)}逐期证据</p>
            <h2>当期推荐、开奖号与真实结果</h2>
          </div>
        </div>
        <p className="section-note">
          每一期只使用该期开奖前的数据；开奖后才进入下一期训练与计算。
        </p>
        <div className="history-search">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setShowAll(false);
            }}
            placeholder="搜期号、日期、开奖号或推荐号码"
          />
          <span>{filteredRows.length}期</span>
        </div>
        <div className="history-list">
          {history.map((row) => {
            const isGroup3 = activePlay === "group3";
            const isPool = activePlay.startsWith("pool");
            const evaluated = !isGroup3 || row.shapeEvaluated;
            const recommendationText =
              activePlay === "dan"
                ? `胆${row.dan}`
                : isGroup3
                  ? `${row.shapePlay} ${(row.group3Probability * 100).toFixed(1)}%`
                  : poolValue(row, activePlay);
            return (
              <article className="history-row" key={row.issue}>
                <div className="history-date">
                  <strong>{row.issue}</strong>
                  <span>{row.date.slice(5)}</span>
                  <em>滚动</em>
                </div>
                <div className="history-data">
                  <div><span>推荐</span><strong>{recommendationText}</strong></div>
                  <div><span>开奖</span><strong>{row.draw}</strong><small>{row.shape}</small></div>
                </div>
                <div className="history-result single-result">
                  <div>
                    <span>{playLabel(activePlay)}</span>
                    {isGroup3 && !evaluated ? (
                      <span className="hit-badge is-skip">未推荐</span>
                    ) : isPool ? (
                      <PoolBadge
                        hit={rowHit(row, activePlay)}
                        covered={poolCovered(row, activePlay)}
                      />
                    ) : (
                      <HitBadge hit={rowHit(row, activePlay)} />
                    )}
                    <small>
                      {isGroup3 && !evaluated
                        ? row.group3Level === "low" ? "低位" : "中位"
                        : `断${rowStreak(row, activePlay)}`}
                    </small>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {filteredRows.length > 18 && (
          <button className="secondary-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? "收起记录" : `查看全部 ${filteredRows.length} 期`}
          </button>
        )}
      </section>

      <section className="section-block formula-block">
        <button
          className="formula-toggle"
          onClick={() => setShowFormula(!showFormula)}
          aria-expanded={showFormula}
        >
          <span>
            <small>{playLabel(activePlay)}计算规则</small>
            <strong>这项每天怎么选？</strong>
          </span>
          <b>{showFormula ? "−" : "+"}</b>
        </button>
        {showFormula && (
          <div className="formula-content">
            <p>{formulaText(activePlay)}</p>
            <div className="audit-links">
              {activePlay === "group3" ? (
                <a href="/audit/full-history-training.json">查看组三全历史训练报告</a>
              ) : activePlay === "pool5" || activePlay === "pool6" ? (
                <a href="/audit/full-history-training.json">查看5/6码全历史训练报告</a>
              ) : (
                <a href="/audit/full-history-training.json">查看全历史训练报告</a>
              )}
            </div>
          </div>
        )}
      </section>

      <footer>
        <strong>只做研究记录，不承诺中奖</strong>
        <p>历史最短断档不代表未来必然复制。不要追损、翻倍、借钱或超预算投注。</p>
        <span>
          页面生成于{" "}
          {new Date(data.generatedAt).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          })}
        </span>
      </footer>
    </main>
  );
}
