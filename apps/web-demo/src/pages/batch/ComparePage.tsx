import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Columns2, RefreshCw } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchRuns,
  type ApiResult,
  type RunSummaryItem,
  type RunsResponse,
} from "@/api/client.ts";

/**
 * Atria-Dawn vs Intern-S2 同域 A/B 对照视图。
 * provider 来自服务端 SolverAdapter 对 run summary 的 setdefault("provider", ...) 打标，
 * 浏览器只做只读聚合；无打标的历史运行归入「未标注」列，绝不推测归属。
 */

interface ProviderBucket {
  readonly label: string;
  readonly runs: RunSummaryItem[];
}

function bucketOf(run: RunSummaryItem): string {
  const provider = run.summary?.["provider"];
  if (provider === "atria") return "atria";
  if (provider === "s2") return "s2";
  if (provider === "inkstone-desktop") return "inkstone-desktop";
  return "unlabeled";
}

const BUCKET_LABELS: Record<string, string> = {
  atria: "Atria-Dawn",
  s2: "Intern-S2",
  "inkstone-desktop": "InkStone 桥接",
  unlabeled: "未标注（历史运行）",
};

function summarize(runs: readonly RunSummaryItem[]) {
  const total = runs.length;
  const finished = runs.filter((r) => r.status === "candidate" || r.status === "unsolved" || r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed" || r.status === "error").length;
  const durations = runs
    .map((r) => r.duration_s)
    .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  return { total, finished, failed, avgDuration };
}

export function ComparePage() {
  const [runs, setRuns] = useState<ApiResult<RunsResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchRuns(200, 0).then((res) => {
      if (alive) setRuns(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const buckets: ProviderBucket[] = useMemo(() => {
    if (!runs || !runs.ok) return [];
    const groups = new Map<string, RunSummaryItem[]>();
    for (const run of runs.data.items) {
      const key = bucketOf(run);
      const list = groups.get(key) ?? [];
      list.push(run);
      groups.set(key, list);
    }
    return ["atria", "s2", "inkstone-desktop", "unlabeled"]
      .filter((key) => groups.has(key))
      .map((key) => ({ label: BUCKET_LABELS[key] ?? key, runs: groups.get(key) ?? [] }));
  }, [runs]);

  const comparable = buckets.filter((b) => b.label !== BUCKET_LABELS.unlabeled);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <section
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "18px 22px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            <Columns2 size={16} style={{ verticalAlign: "-3px", marginRight: "6px" }} />
            同域 A/B 对照
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--color-ink-mute)" }}>
            provider 由服务端 SolverAdapter 打标（ASTRA_PROVIDER 环境变量），浏览器只读聚合；盲跑口径：同题集、同预算。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            borderRadius: "8px",
            border: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface-muted)",
            padding: "7px 14px",
            fontSize: "13px",
            cursor: "pointer",
            color: "var(--color-ink-soft)",
          }}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </section>

      {runs === null && <div style={{ fontSize: "13px", color: "var(--color-ink-mute)" }}>加载运行列表…</div>}
      {runs && !runs.ok && (
        <PanelEmptyState variant="missing" title="运行列表不可达" description={runs.error.message} />
      )}
      {runs && runs.ok && comparable.length === 0 && (
        <PanelEmptyState
          title="暂无可对照的运行"
          description="分别以 ASTRA_PROVIDER=atria 与 ASTRA_PROVIDER=s2 跑同一题集后，本页自动产出对照表。"
        />
      )}

      {comparable.length > 0 && (
        <section style={{ display: "grid", gridTemplateColumns: `repeat(${comparable.length}, minmax(240px, 1fr))`, gap: "16px" }}>
          {comparable.map(({ label, runs: bucketRuns }) => {
            const s = summarize(bucketRuns);
            return (
              <article
                key={label}
                style={{
                  borderRadius: "12px",
                  border: "1px solid var(--color-line)",
                  backgroundColor: "var(--color-surface)",
                  padding: "18px",
                }}
              >
                <h2 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                  {label}
                </h2>
                <dl style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 2 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <dt>运行总数</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{s.total}</dd>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <dt>终态收口</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{s.finished}</dd>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <dt>失败</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>{s.failed}</dd>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <dt>平均耗时</dt>
                    <dd style={{ margin: 0, fontWeight: 600 }}>
                      {s.avgDuration === null ? "未知（无 duration_s 字段）" : `${s.avgDuration.toFixed(1)}s`}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </section>
      )}

      {comparable.length > 0 && (
        <section
          style={{
            borderRadius: "12px",
            border: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface)",
            padding: "18px",
            overflowX: "auto",
          }}
        >
          <h2 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            运行明细（按创建时间倒序）
          </h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-ink-mute)", borderBottom: "1px solid var(--color-line)" }}>
                <th style={{ padding: "6px 8px" }}>run_id</th>
                <th style={{ padding: "6px 8px" }}>provider</th>
                <th style={{ padding: "6px 8px" }}>status</th>
                <th style={{ padding: "6px 8px" }}>stopReason</th>
                <th style={{ padding: "6px 8px" }}>duration_s</th>
                <th style={{ padding: "6px 8px" }}>created_at</th>
              </tr>
            </thead>
            <tbody>
              {buckets
                .flatMap((b) => b.runs)
                .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
                .map((run) => {
                  const provider = bucketOf(run);
                  const stopReason = run.summary?.["stopReason"];
                  return (
                    <tr key={run.run_id} style={{ borderBottom: "1px dashed var(--color-line)" }}>
                      <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                        <Link to={`/runs/${encodeURIComponent(run.run_id)}`} style={{ color: "var(--color-brand)" }}>
                          {run.run_id.slice(0, 18)}…
                        </Link>
                      </td>
                      <td style={{ padding: "6px 8px" }}>{BUCKET_LABELS[provider] ?? provider}</td>
                      <td style={{ padding: "6px 8px" }}>{run.status}</td>
                      <td style={{ padding: "6px 8px" }}>{typeof stopReason === "string" ? stopReason : "—"}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {typeof run.duration_s === "number" ? run.duration_s.toFixed(1) : "—"}
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        {run.created_at ? new Date(run.created_at * 1000).toLocaleString() : "—"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
