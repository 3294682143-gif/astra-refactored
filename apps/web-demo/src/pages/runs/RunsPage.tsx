import { useState, useEffect } from "react";
import { Link } from "react-router";
import { ArrowRight, Clock, Hash, RefreshCw } from "lucide-react";
import { StatusBadge, normalizeStatusKind } from "@/components/StatusBadge";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import { fetchRuns, resolveTraceLevel, type ApiResult, type RunsResponse } from "@/api/client.ts";
import { describeStopReason } from "@/domain/stopReasonView.ts";

const UNKNOWN = "未知";

function truncate(value: string | null | undefined, max = 140): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function formatCreatedAt(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toLocaleString()
    : UNKNOWN;
}

export function RunsPage() {
  const [result, setResult] = useState<ApiResult<RunsResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setResult(null);
    fetchRuns().then((res) => {
      if (alive) setResult(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          求解运行历史
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          直接读取 <code>GET /api/runs</code>（本地运行索引）。字段缺失处显示「未知」，不做默认值填充，
          请求失败时显示真实错误态且不回落演示数据。
        </p>
      </div>

      {result === null ? (
        <div style={{ padding: "30px", textAlign: "center", color: "var(--color-ink-soft)" }}>
          正在加载运行历史列表...
        </div>
      ) : !result.ok ? (
        <PanelEmptyState
          variant="missing"
          title="运行历史加载失败（真实错误态）"
          description={`${result.error.message}（接口：${result.error.url}）`}
          hint="未改用演示数据顶替。请确认 Python BFF 已启动后重试。"
          action={
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "8px",
                border: "1px solid var(--color-brand)",
                backgroundColor: "var(--color-brand-tint)",
                color: "var(--color-brand-deep)",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              <span>重新加载</span>
            </button>
          }
        />
      ) : result.data.items.length === 0 ? (
        <PanelEmptyState
          variant="empty"
          title="接口返回 0 条运行记录"
          description="此结果来自真实接口响应（HTTP 200 且 items 为空），不是加载失败，也不代表系统已通过验收。"
          hint="先到「求解工作台」发起一次求解，或核对 ASTRA_DATA_ROOT 指向的数据目录。"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {result.data.items.map((run) => {
            const statusKind = normalizeStatusKind(run.status);
            const level = resolveTraceLevel(run);
            const stopInfo = describeStopReason(
              typeof run.summary?.["stopReason"] === "string"
                ? (run.summary["stopReason"] as string)
                : null,
            );
            const durationText =
              typeof run.duration_s === "number" && Number.isFinite(run.duration_s)
                ? `${run.duration_s}s`
                : UNKNOWN;
            const modelText = run.model && run.model.trim() ? run.model : UNKNOWN;

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
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxWidth: "68%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)", fontFamily: "var(--font-mono)" }}>
                      {run.run_id}
                    </span>
                    <StatusBadge status={statusKind} size="sm" />
                    <DataSourceBadge level={level} size="sm" />
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--color-ink)", fontWeight: 500 }}>
                    {truncate(run.scenario) || "（场景未记录）"}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "12px", color: "var(--color-ink-mute)", flexWrap: "wrap" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <Clock size={12} />
                      创建时间: {formatCreatedAt(run.created_at)}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <Hash size={12} />
                      止因: <code>{stopInfo.code}</code>（{stopInfo.title}）
                    </span>
                    <span>来源: <code>{run.source || UNKNOWN}</code></span>
                  </div>
                  {run.status !== statusKind ? (
                    <div style={{ fontSize: "11px", color: "#b45309" }}>
                      ⚠ 接口原始状态 <code>{String(run.status)}</code> 未在受控状态表中注册，已按「状态未知」呈现（不回落为候选）。
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                  <div style={{ textAlign: "right", fontSize: "12px", color: "var(--color-ink-soft)" }}>
                    <div>耗时: <strong>{durationText}</strong></div>
                    <div style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>模型: {modelText}</div>
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