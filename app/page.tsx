"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Recommendation = {
  targetIssue: string;
  basedOnIssue: string;
  basedOnDate: string;
  dan: number;
  pool7: string;
  shapePlay: string;
};

type HistoryRow = {
  date: string;
  issue: string;
  dan: number;
  pool7: string;
  shapePlay: string;
  draw: string;
  shape: string;
  danHit: boolean;
  pool7Hit: boolean;
  pool7Group3Covered: boolean;
  shapeHit: boolean;
  danMissStreak: number;
  pool7MissStreak: number;
  shapeMissStreak: number;
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
    backfitShape: Metric;
    lockedShape: Metric;
    shapeAlwaysGroup6Baseline: Metric;
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

function PoolBadge({ row }: { row: HistoryRow }) {
  if (row.pool7Group3Covered) {
    return (
      <span className="hit-badge group3 is-covered">组三覆盖</span>
    );
  }
  return <HitBadge hit={row.pool7Hit} />;
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
    const frame = requestAnimationFrame(() => {
      void load();
    });
    return () => cancelAnimationFrame(frame);
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
          <h1>今日三项参考</h1>
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
            <small>V5按当前断期状态切换公式</small>
          </article>
          <article className="pool-panel">
            <p>7码池</p>
            <div className="number-pills">
              {data.recommendation.pool7.split("").map((digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </div>
            <small>组六判中奖，组三覆盖另标</small>
          </article>
          <article className="group3-panel">
            <div>
              <p>形态二选一</p>
              <strong>{data.recommendation.shapePlay}</strong>
            </div>
            <small>推荐与实际形态一致才中；豹子算失败</small>
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
        <div className="metrics-grid three-metrics">
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
          <MetricCard
            label="形态实测"
            metric={data.metrics.lockedShape}
            pending={lockedPending}
          />
        </div>
        <p className="section-note">
          新开奖自动进入这里。三项都按命中率和最长连续未中统计；7码的组三覆盖只作单独标记。
        </p>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">历史回溯区</p>
            <h2>2023年7月28日—2026年7月27日核查</h2>
          </div>
          <span className="backfit-chip">回溯拟合</span>
        </div>
        <div className="metrics-grid three-metrics">
          <MetricCard label="独胆回溯" metric={data.metrics.backfitDan} />
          <MetricCard label="7码回溯" metric={data.metrics.backfitPool7} />
          <MetricCard label="形态二选一" metric={data.metrics.backfitShape} />
        </div>
        <p className="section-note warning-note">
          V5逐期计算没有使用当期开奖，但四状态公式和形态阈值是比较三年成绩后选出的后验模型，不能当成独立前瞻成绩。
        </p>
        <p className="section-note warning-note">
          三年独胆369/1054（35.01%），最长断9期，仍未达到7期目标；7码274/1054（26.00%），最长断11期；动态形态734/1054（69.64%），最长断4期。
        </p>
        <p className="section-note">
          仅作对照：若三年每天固定选组六，历史为779/1054（73.91%）、最长断5期，但它没有做每日形态判断，所以不作为正式动态模型成绩。
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
                    胆{row.dan} · {row.pool7} · {row.shapePlay}
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
                  <PoolBadge row={row} />
                  <small>断{row.pool7MissStreak}</small>
                </div>
                <div>
                  <span>形态</span>
                  <HitBadge hit={row.shapeHit} />
                  <small>断{row.shapeMissStreak}</small>
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
              V5把连续未中分成0—2、3—4、5—6、7期以上四个状态；每个状态使用不同的历史频率、定位频率和转移评分公式，再按该状态的固定名次取一个独胆。
            </p>
            <h3>7码</h3>
            <p>
              同样按连续未中状态切换四套固定评分，综合近期出现、定位频率、转移频率、奇偶和中心距离，得分从高到低取前7名。
            </p>
            <p>得分从高到低取前7名。开奖号须为组六且三个不同数字全部入池才算中奖；组三的两个不同数字全部入池时只标记“组三覆盖”，不计作组六7码中奖。</p>
            <h3>组三/组六二选一</h3>
            <p>根据最近3—120期的组三、组六比例，组六遗漏、最近一期与最近两期形态、近期重号率计算形态分。达到固定阈值推荐组三，否则推荐组六；实际形态一致才算命中，豹子统一算失败。</p>
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
