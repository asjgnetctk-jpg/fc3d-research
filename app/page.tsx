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
  phase: "replay" | "locked";
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
    replayDan: Metric;
    replayPool7: Metric;
    replayShape: Metric;
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

function matchesHistorySearch(row: HistoryRow, query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const searchable = [
    row.date,
    row.issue,
    `胆${row.dan}`,
    `胆码${row.dan}`,
    row.pool7,
    `7码${row.pool7}`,
    row.shapePlay,
    row.draw,
    row.shape,
    row.phase === "locked" ? "前瞻" : "历史回放",
    row.danHit ? "胆码中" : "胆码未中",
    row.pool7Hit ? "7码中" : "7码未中",
    row.pool7Group3Covered ? "组三覆盖" : "",
    row.shapeHit ? "形态中" : "形态未中",
  ].join(" ").toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

export default function Home() {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
    const frame = requestAnimationFrame(() => {
      void load();
    });
    return () => cancelAnimationFrame(frame);
  }, [load]);

  const history = useMemo(() => {
    if (!data) return [];
    const reversed = data.history
      .filter((row) => matchesHistorySearch(row, searchQuery))
      .reverse();
    return showAll ? reversed : reversed.slice(0, 18);
  }, [data, searchQuery, showAll]);

  const filteredCount = useMemo(
    () => data?.history.filter((row) => matchesHistorySearch(row, searchQuery)).length ?? 0,
    [data, searchQuery],
  );

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
            <small>V7公式仅用2021-07-27前数据搜索并锁定</small>
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
            <h2>2026年7月28日起继续前瞻记录</h2>
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
            <p className="eyebrow">前置多折验证</p>
            <h2>三段历史区间分别检验稳定性</h2>
          </div>
          <span className="backfit-chip">仅用截止日前数据</span>
        </div>
        <div className="metrics-grid three-metrics">
          <MetricCard label="独胆多折验证" metric={data.metrics.backfitDan} />
          <MetricCard label="7码多折验证" metric={data.metrics.backfitPool7} />
          <MetricCard label="形态验证" metric={data.metrics.backfitShape} />
        </div>
        <p className="section-note warning-note">
          V7只读取截至2021年7月27日的数据，并在2016—2017、2018—2019、2020—2021年7月27日三段区间分别检验。独胆三段最长未中为11、9、9期，合计591/1937（30.51%）。
        </p>
        <p className="section-note warning-note">
          7码三段最长未中为13、14、13期，合计474/1937（24.47%）；它不是硬性达标项。形态前置验证247/351（70.37%），最长未中4期。
        </p>
        <p className="section-note">
          “约10期”只是历史验证目标，不代表今后必定10期内命中。V7从2026年7月28日起只记真实前瞻战绩，不用后续开奖结果反向改公式。
        </p>
        <div className="audit-links">
          <a href="/audit/v7-robust-training.json">查看V7训练与分段结果</a>
          <a href="/audit/v7-locked-config.json">查看V7锁定公式配置</a>
          <a href="/v6.html">查看V6历史推荐页</a>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">V7历史逐期回放</p>
            <h2>2021年7月28日—2026年7月27日</h2>
          </div>
          <span className="backfit-chip">非独立盲测</span>
        </div>
        <div className="metrics-grid three-metrics">
          <MetricCard label="独胆历史回放" metric={data.metrics.replayDan} />
          <MetricCard label="7码历史回放" metric={data.metrics.replayPool7} />
          <MetricCard label="形态历史回放" metric={data.metrics.replayShape} />
        </div>
        <p className="section-note warning-note">
          下面逐期表已恢复这五年每天的V7推荐、开奖号、命中结果和连续未中期数。由于V7是在这段历史已经公开后建立的，所以这里只能称为“固定公式历史回放”，不能冒充独立盲测。
        </p>
        <p className="section-note">
          历史回放的连续未中状态与2026年7月28日起的真实前瞻状态分开计算，不把历史回放状态带入新战绩。
        </p>
      </section>

      <section className="section-block history-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">V7逐期证据</p>
            <h2>每天推荐码、开奖号与命中结果</h2>
          </div>
        </div>

        <div className="history-search">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setShowAll(false);
            }}
            placeholder="搜期号、日期、开奖号、胆码、7码、组三/组六或命中结果"
            aria-label="搜索V7逐期数据"
          />
          <span>{filteredCount}期</span>
        </div>

        <div className="history-list">
          {history.length === 0 && (
            <div className="notice">
              {searchQuery.trim() ? "没有找到符合条件的V7记录。" : "暂无V7逐期记录。"}
            </div>
          )}
          {history.map((row) => (
            <article className="history-row" key={row.issue}>
              <div className="history-date">
                <strong>{row.issue}</strong>
                <span>{row.date.slice(5)}</span>
                <em>{row.phase === "locked" ? "前瞻" : "历史回放"}</em>
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

        {filteredCount > 18 && (
          <button className="secondary-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? "收起记录" : `查看全部 ${filteredCount} 期`}
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
            <small>计算规则</small>
            <strong>每天到底怎么选？</strong>
          </span>
          <b>{showFormula ? "−" : "+"}</b>
        </button>
        {showFormula && (
          <div className="formula-content">
            <h3>独胆</h3>
            <p>
              V7只在2021年7月27日前的数据中搜索候选公式，并用三段互不重叠区间比较稳定性。最终按连续未中0—2、3—4、5—6、7期以上四种状态，锁定对应的历史频率、定位频率和转移评分公式。
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
