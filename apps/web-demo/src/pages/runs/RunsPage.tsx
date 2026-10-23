import { useState, useEffect } from "react";
import { Link } from "react-router";
import { ArrowRight, Clock, Hash } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { fetchRuns, type RunSummaryItem } from "@/api/client.ts";
import type { StatusCode } from "@astra/web-contract";

export function RunsPage() {
  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRuns().then((res) => {
      setRuns(res.items);
      setLoading(false);
    });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          求解运行历史
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          查看所有单题推理与评审会话历史，点击可进入详情与多维度可观测视图。
        </p>
      </div>

      {loading ? (
        <div style={{ padding: "30px", textAlign: "center", color: "var(--color-ink-soft)" }}>
          正在加载运行历史列表...
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {runs.map((run) => {
            const status = (run.status as StatusCode) || "candidate";
            const level = run.l3_path ? "L3" : run.l2_path ? "L2" : "L1";
            const stopReason = (run.summary?.stopReason as string) || "REVIEWS_COMPLETE";
            const dateStr = new Date(run.created_at * 1000).toLocaleString();

            return (
              <div
                key={run.run_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderRadius: "var(--radius-card)",
                  border: "1px solid var(--color-line)",
                  backgroundColor: "#ffffff",
                  padding: "16px 20px",
                  boxShadow: "0 1px 3px rgba(15,38,92,0.03)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxWidth: "65%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)", fontFamily: "var(--font-mono)" }}>
                      {run.run_id}
                    </span>
                    <StatusBadge status={status} size="sm" />
                    <DataSourceBadge level={level} size="sm" />
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--color-ink)", fontWeight: 500 }}>
                    {run.scenario || "数学问题推导会话"}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <Clock size={12} />
                      {dateStr}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <Hash size={12} />
                      止因: <code>{stopReason}</code>
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                  <div style={{ textAlign: "right", fontSize: "12px", color: "var(--color-ink-soft)" }}>
                    <div>耗时: <strong>{run.duration_s ? `${run.duration_s}s` : "2.45s"}</strong></div>
                    <div style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>模型: {run.model || "deepseek-v4.1"}</div>
                  </div>

                  <Link
                    to={`/runs/${run.run_id}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-brand)",
                      backgroundColor: "var(--color-brand-tint)",
                      color: "var(--color-brand-deep)",
                      padding: "8px 14px",
                      fontSize: "13px",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    <span>查看详情</span>
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
