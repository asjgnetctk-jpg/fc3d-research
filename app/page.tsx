"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Recommendation = {
  targetIssue: string;
  basedOnIssue: string;
  basedOnDate: string;
  dan: number;
  pool7: string;
  shapePlay: string;
  group3Probability: number;
};

type HistoryRow = {
  date: string;
  issue: string;
  dan: number;
  pool7: string;
  shapePlay: string;
  group3Probability: number;
  draw: string;
  shape: string;
  danHit: boolean;
  pool7Hit: boolean;
  pool7Group3Covered: boolean;
  shapeHit: boolean;
  danMissStreak: number;
  pool7MissStreak: number;
  shapeMissStreak: number;
  phase: "rolling";
};

type ApiPayload = {
  generatedAt: string;
  sourceUpdatedThrough: string;
  recommendation: Recommendation;
  history: HistoryRow[];
  metrics: {
    dan: { count: number; hits: number; rate: number; maxMiss: number };
    pool7: { count: number; hits: number; rate: number; maxMiss: number };
    group3: { count: number; hits: number; rate: number; maxMiss: number };
  };
  formulaVersion: string;
  trainingMode: "expanding-window";
  trainingUpdatedThrough: string;
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
    `${(row.group3Probability * 100).toFixed(1)}%`,
    row.draw,
    row.shape,
    "滚动",
    row.danHit ? "胆码中" : "胆码未中",
    row.pool7Hit ? "7码中" : "7码未中",
    row.pool7Group3Covered ? "组三覆盖" : "",
    row.shapeHit ? "组三判断中" : "组三判断未中",
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

      <nav className="version-switch" aria-label="切换算法版本">
        <Link className="is-active" href="/" aria-current="page">
          <strong>V7</strong><span>当前算法</span>
        </Link>
        <Link href="/v5.html">
          <strong>V5</strong><span>历史算法</span>
        </Link>
      </nav>
      <p className="version-note">两套算法、推荐记录和连续未中状态独立计算，互不混用。</p>

      <section className="status-strip">
        <span className="status-dot" />
        <span>{data.formulaVersion} 逐期滚动</span>
        <span className="status-separator">·</span>
        <span>数据更新至 {data.trainingUpdatedThrough}</span>
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
            <small>每期只读取当期开奖前已经公开的数据</small>
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
              <p>组三判断</p>
              <strong>{data.recommendation.shapePlay}</strong>
            </div>
            <small>
              模型参考概率{" "}
              {(data.recommendation.group3Probability * 100).toFixed(1)}%
              {" · "}数学基准约27%
            </small>
          </article>
        </div>

        <div className="source-line">
          官方数据更新至 {data.sourceUpdatedThrough}
        </div>
      </section>

      <section className="section-block history-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">V7逐期滚动记录</p>
            <h2>每天推荐码、开奖号与命中结果</h2>
          </div>
        </div>
        <p className="section-note">
          每一期只使用该期开奖前的数据计算。开奖号公布后才并入总数据库，供下一期更新；不会读取未来答案。
        </p>

        <div className="history-search">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setShowAll(false);
            }}
            placeholder="搜期号、日期、开奖号、胆码、7码、组三概率或命中结果"
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
                <em>滚动</em>
              </div>
              <div className="history-data">
                <div>
                  <span>推荐</span>
                  <strong>
                    胆{row.dan} · {row.pool7} · {row.shapePlay}{" "}
                    {(row.group3Probability * 100).toFixed(1)}%
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
                  <span>组三</span>
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
              每期按时间顺序计算：预测某一期时，只读取它之前已经开奖的数据。上一期开奖后，开奖号才进入总数据库，用于更新近期频率、定位频率、转移频率和遗漏状态。
            </p>
            <h3>7码</h3>
            <p>
              同样按连续未中状态切换四套固定评分，综合近期出现、定位频率、转移频率、奇偶和中心距离，得分从高到低取前7名。
            </p>
            <p>得分从高到低取前7名。开奖号须为组六且三个不同数字全部入池才算中奖；组三的两个不同数字全部入池时只标记“组三覆盖”，不计作组六7码中奖。</p>
            <h3>是否开组三</h3>
            <p>
              先用截至前一期的数据计算组三模型分，再用此前最多1200期的“当时模型分—实际是否组三”记录进行滚动校准，取最接近的160期并加入27%的数学先验，得到今日组三参考概率。达到27%显示“看组三”，否则显示“不看组三”。这里不推荐组六；“不看组三”仅表示模型估计没有超过数学基准。
            </p>
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
