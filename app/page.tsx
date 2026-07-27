"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Recommendation = {
  targetIssue: string;
  basedOnIssue: string;
  basedOnDate: string;
  dan: number;
  pool7: string;
};

type HistoryRow = {
  date: string;
  issue: string;
  dan: number;
  pool7: string;
  draw: string;
  shape: string;
  danHit: boolean;
  pool7Hit: boolean;
  danMissStreak: number;
  pool7MissStreak: number;
  phase: "backfit" | "locked";
};

type Metric = {
  count: number;
  hits: number;
  rate: number;
  maxMiss: number;
};

type ApiPayload = {
  generatedAt: string;
  sourceUpdatedThrough: string;
  recommendation: Recommendation;
  history: HistoryRow[];
  metrics: {
    backfitDan: Metric;
    backfitPool7: Metric;
    lockedDan: Metric;
    lockedPool7: Metric;
  };
  formulaVersion: string;
  lockDate: string;
};

function HitBadge({ hit }: { hit: boolean }) {
  return (
    <span className={hit ? "hit-badge is-hit" : "hit-badge"}>
      {hit ? "中" : "未中"}
    </span>
  );
}

function MetricCard({
  label,
  metric,
  pending,
}: {
  label: string;
  metric: Metric;
  pending?: boolean;
}) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      {pending ? (
        <strong>等待开奖</strong>
      ) : (
        <>
          <strong>
            {metric.hits}/{metric.count}
          </strong>
          <small>
            命中率 {(metric.rate * 100).toFixed(1)}% · 最长断{" "}
            {metric.maxMiss}期
          </small>
        </>
      )}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showFormula, setShowFormula] = useState(false);
  const [showAll, setShowAll] = useState(false);

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
    void load();
  }, [load]);

  const history = useMemo(() => {
    if (!data) return [];
    const reversed = [...data.history].reverse();
    return showAll ? reversed : reversed.slice(0, 18);
  }, [data, showAll]);

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
  const lockedPending = data.metrics.lockedDan.count === 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">福彩3D · 私人研究台</p>
          <h1>今日双核参考</h1>
        </div>
        <button
          className="refresh-button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新最新数据"
        >
          {loading ? "刷新中" : "刷新"}
        </button>
      </header>

      <section className="status-strip">
        <span className="status-dot" />
        <span>公式 {data.formulaVersion} 已锁定</span>
        <span className="status-separator">·</span>
        <span>{data.lockDate}起真实验证</span>
      </section>

      <section className="hero-card">
        <div className="hero-meta">
          <span>第 {data.recommendation.targetIssue} 期</span>
          <span>基于 {data.recommendation.basedOnIssue} 期及此前数据</span>
        </div>

        <div className="recommendation-grid">
          <article className="dan-panel">
            <p>独胆</p>
            <strong>{data.recommendation.dan}</strong>
            <small>14期低频第2名</small>
          </article>
          <article className="pool-panel">
            <p>7码池</p>
            <div className="number-pills">
              {data.recommendation.pool7.split("").map((digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </div>
            <small>仅按组六判中</small>
          </article>
        </div>

        <div className="source-line">
          官方数据更新至 {data.sourceUpdatedThrough}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">真实封盘区</p>
            <h2>7月28日起，不再改公式</h2>
          </div>
          <span className="lock-chip">LOCKED</span>
        </div>
        <div className="metrics-grid">
          <MetricCard
            label="独胆实测"
            metric={data.metrics.lockedDan}
            pending={lockedPending}
          />
          <MetricCard
            label="7码实测"
            metric={data.metrics.lockedPool7}
            pending={lockedPending}
          />
        </div>
        <p className="section-note">
          新开奖自动进入这里。任何一项连续未中超过7期，就直接标记策略失效。
        </p>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">历史回溯区</p>
            <h2>5月1日—7月27日核查</h2>
          </div>
          <span className="backfit-chip">回溯拟合</span>
        </div>
        <div className="metrics-grid">
          <MetricCard label="独胆回溯" metric={data.metrics.backfitDan} />
          <MetricCard label="7码回溯" metric={data.metrics.backfitPool7} />
        </div>
        <p className="section-note warning-note">
          这段数据参与过规则筛选，只能证明历史样本达到门槛，不能当成未来保证。
        </p>
      </section>

      <section className="section-block history-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">逐期证据</p>
            <h2>推荐码与实际开奖号</h2>
          </div>
        </div>

        <div className="history-list">
          {history.map((row) => (
            <article className="history-row" key={row.issue}>
              <div className="history-date">
                <strong>{row.issue}</strong>
                <span>{row.date.slice(5)}</span>
                <em>{row.phase === "locked" ? "真实" : "回溯"}</em>
              </div>
              <div className="history-data">
                <div>
                  <span>推荐</span>
                  <strong>
                    胆{row.dan} · {row.pool7}
                  </strong>
                </div>
                <div>
                  <span>开奖</span>
                  <strong>{row.draw}</strong>
                  <small>{row.shape}</small>
                </div>
              </div>
              <div className="history-result">
                <div>
                  <span>胆</span>
                  <HitBadge hit={row.danHit} />
                  <small>断{row.danMissStreak}</small>
                </div>
                <div>
                  <span>7码</span>
                  <HitBadge hit={row.pool7Hit} />
                  <small>断{row.pool7MissStreak}</small>
                </div>
              </div>
            </article>
          ))}
        </div>

        <button className="secondary-button" onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起记录" : `查看全部 ${data.history.length} 期`}
        </button>
      </section>

      <section className="section-block formula-block">
        <button
          className="formula-toggle"
          onClick={() => setShowFormula(!showFormula)}
          aria-expanded={showFormula}
        >
          <span>
            <small>计算规则</small>
            <strong>每天到底怎么选？</strong>
          </span>
          <b>{showFormula ? "−" : "+"}</b>
        </button>
        {showFormula && (
          <div className="formula-content">
            <h3>独胆</h3>
            <p>
              统计0—9在最近14期中至少出现一次的期数，从低到高排列，取第2名。
              同分时数字小者排前。
            </p>
            <h3>7码</h3>
            <p>
              每个数字计算30期频率、60期频率、EWMA5近期热度、遗漏期数和30期定位峰值。
              全部标准化后：
            </p>
            <code>
              Z30 − Z60 − ZEWMA5 − Z遗漏 + Z定位峰
            </code>
            <p>得分从高到低取前7名。开奖号须为组六且三位全部入池才算中。</p>
          </div>
        )}
      </section>

      <footer>
        <strong>只做研究记录，不承诺中奖</strong>
        <p>
          随机开奖无法保证7期内必然命中。不要追损、翻倍、借钱或超预算投注。
        </p>
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
