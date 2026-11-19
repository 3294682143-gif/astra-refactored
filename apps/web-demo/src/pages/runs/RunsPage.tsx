import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  Clock,
  Cpu,
  History,
  Play,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import {
  fetchRuns,
  readTerminalFacts,
  resolveTraceLevel,
  type RunSummaryItem,
} from "@/api/client.ts";
import { DataSourceBadge } from "@/components/DataSourceBadge.tsx";
import { InlineMathText } from "@/components/MathMarkdown.tsx";
import { PanelEmptyState } from "@/components/PanelEmptyState.tsx";
import {
  normalizeStatusKind,
  StatusBadge,
  type StatusKind,
} from "@/components/StatusBadge.tsx";
import { describeStopReason } from "@/domain/stopReasonView.ts";

const UNKNOWN = "未知";

function truncate(text: string | null | undefined, maxLen = 180): string {
  if (!text || !text.trim()) return UNKNOWN;
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

function formatCreatedAt(ts: number | null | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return UNKNOWN;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  try {
    return new Date(ms).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return UNKNOWN;
  }
}

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return UNKNOWN;
  }
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

type StatusFilter = "all" | "candidate" | "running" | "error";

function matchesFilter(kind: StatusKind, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "candidate") return kind === "candidate" || kind === "solved" || kind === "finished";
  if (filter === "running") return kind === "running" || kind === "idle";
  return (
    kind === "failed" ||
    kind === "error" ||
    kind === "timeout" ||
    kind === "aborted" ||
    kind === "cancelled"
  );
}

export function RunsPage() {
  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    const res = await fetchRuns(100, 0);
    if (!res.ok) {
      setErrorMessage(res.error.message);
      setRuns([]);
      setLoading(false);
      return;
    }
    setRuns(res.data.items ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((run) => {
      const kind = normalizeStatusKind(run.status);
      if (!matchesFilter(kind, statusFilter)) return false;
      if (!q) return true;
      return (
        run.run_id.toLowerCase().includes(q) ||
        (run.scenario ?? "").toLowerCase().includes(q) ||
        (run.model ?? "").toLowerCase().includes(q) ||
        (run.source ?? "").toLowerCase().includes(q)
      );
    });
  }, [runs, query, statusFilter]);

  return (
    <div className="zygos-page-container" style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      {/* Keynote Page Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-brand-mid)",
              marginBottom: "6px",
            }}
          >
            <History size={13} />
            <span>RUN ARCHIVES · 真实运行轨迹</span>
          </div>
          <h1
            className="zygos-keynote-title"
            style={{
              margin: 0,
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.025em",
            }}
          >
            历史研究运行记录
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "13.5px", color: "var(--color-ink-soft)" }}>
            直接读取真实后端落盘档案（GET /api/runs），保留原始终止原因与 L1/L2/L3 可观测级别，绝不美化失败记录。
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Link
            to="/solve"
            className="zygos-btn-primary"
            style={{ padding: "8px 16px", fontSize: "13px", textDecoration: "none" }}
          >
            <Sparkles size={14} />
            <span>发起新研究</span>
          </Link>
          <button
            type="button"
            onClick={() => void loadRuns()}
            disabled={loading}
            className="zygos-btn-ghost"
            style={{ padding: "8px 14px", fontSize: "13px" }}
          >
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            <span>刷新档案</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div
        className="zygos-glass"
        style={{
          borderRadius: "14px",
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "14px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: "1 1 260px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Search
            size={15}
            color="var(--color-ink-mute)"
            style={{ position: "absolute", left: "12px", pointerEvents: "none" }}
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="检索 Run ID、数学题目关键字或模型名称..."
            style={{
              width: "100%",
              padding: "8px 12px 8px 34px",
              borderRadius: "10px",
              border: "1px solid var(--color-line-strong)",
              backgroundColor: "var(--color-surface-sunken)",
              fontSize: "13px",
              outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {(
            [
              { id: "all", label: `全部 (${runs.length})` },
              { id: "candidate", label: "候选/收口" },
              { id: "running", label: "运行/待定" },
              { id: "error", label: "异常/取消" },
            ] as const
          ).map((tab) => {
            const active = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className="zygos-tabular"
                style={{
                  padding: "6px 12px",
                  borderRadius: "999px",
                  border: active
                    ? "1px solid var(--color-brand-ring)"
                    : "1px solid var(--color-line)",
                  backgroundColor: active
                    ? "var(--color-brand-tint)"
                    : "var(--color-surface-sunken)",
                  color: active ? "var(--color-brand-deep)" : "var(--color-ink-soft)",
                  fontSize: "12px",
                  fontWeight: active ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content Area */}
      {loading ? (
        <div
          className="zygos-glass"
          style={{
            borderRadius: "16px",
            padding: "48px 24px",
            textAlign: "center",
            fontSize: "13.5px",
            color: "var(--color-ink-soft)",
          }}
        >
          正在加载真实运行档案...
        </div>
      ) : errorMessage ? (
        <PanelEmptyState
          variant="missing"
          title="无法读取运行记录（接口错误）"
          description={errorMessage}
          hint="按可信原则，系统不会用演示样例顶替真实运行历史。"
          action={
            <button
              type="button"
              onClick={() => void loadRuns()}
              className="zygos-btn-primary"
              style={{ padding: "8px 16px", fontSize: "13px" }}
            >
              重新请求
            </button>
          }
        />
      ) : filteredRuns.length === 0 ? (
        <PanelEmptyState
          variant="empty"
          title={runs.length === 0 ? "暂无历史运行记录" : "没有匹配当前筛选条件的运行"}
          description={
            runs.length === 0
              ? "尚未检测到任何落盘运行档案，请先前往求解工作台发起研究任务。"
              : "请尝试清空搜索关键字或切换状态筛选器。"
          }
          action={
            runs.length === 0 ? (
              <Link
                to="/solve"
                className="zygos-btn-primary"
                style={{ padding: "8px 16px", fontSize: "13px", textDecoration: "none" }}
              >
                前往研究工作台
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {filteredRuns.map((run) => {
            const statusKind = normalizeStatusKind(run.status);
            const traceLevel = resolveTraceLevel(run);
            const facts = readTerminalFacts(run);
            const stopInfo = describeStopReason(facts.stopReason);
            const statusMismatch = run.status !== statusKind;

            return (
              <article
                key={run.run_id}
                className="zygos-bento"
                style={{
                  padding: "18px 20px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "18px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0, flex: "1 1 520px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  {/* Top Badges Row */}
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <code
                      style={{
                        padding: "3px 9px",
                        borderRadius: "7px",
                        backgroundColor: "var(--color-code-inline-bg)",
                        color: "var(--color-code-inline-ink)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "11.5px",
                        fontWeight: 600,
                      }}
                    >
                      {run.run_id}
                    </code>

                    <StatusBadge status={statusKind} size="sm" />
                    <DataSourceBadge level={traceLevel} size="sm" />

                    {statusMismatch && (
                      <span
                        title={`后端原始 status="${run.status}" 与归一化枚举 "${statusKind}" 不一致`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "2px 8px",
                          borderRadius: "999px",
                          backgroundColor: "var(--color-state-candidate-bg)",
                          border: "1px solid var(--color-state-candidate-border)",
                          color: "var(--color-state-candidate)",
                          fontSize: "11px",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        <AlertTriangle size={11} />
                        原始状态: {run.status || UNKNOWN}
                      </span>
                    )}

                    <span
                      title={stopInfo.description}
                      style={{
                        padding: "2px 9px",
                        borderRadius: "999px",
                        backgroundColor: "var(--color-surface-sunken)",
                        border: "1px solid var(--color-line)",
                        fontSize: "11px",
                        color: "var(--color-ink-soft)",
                      }}
                    >
                      终止：{stopInfo.title}
                    </span>
                  </div>

                  {/* Problem Statement with Inline KaTeX */}
                  <div
                    style={{
                      fontSize: "14px",
                      lineHeight: 1.6,
                      color: "var(--color-ink)",
                      fontWeight: 500,
                    }}
                  >
                    <InlineMathText text={truncate(run.scenario)} />
                  </div>

                  {/* Metadata Strip */}
                  <div
                    className="zygos-tabular"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "16px",
                      flexWrap: "wrap",
                      fontSize: "12px",
                      color: "var(--color-ink-mute)",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                      <Cpu size={13} />
                      模型：{run.model || UNKNOWN}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                      <Clock size={13} />
                      耗时：{formatDuration(run.duration_s)}
                    </span>
                    <span>种子：{run.seed ?? UNKNOWN}</span>
                    <span>记录时间：{formatCreatedAt(run.created_at)}</span>
                    <span>来源：{run.source || UNKNOWN}</span>
                  </div>
                </div>

                {/* Action Controls */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0, flexWrap: "wrap" }}>
                  <Link
                    to={`/runs/${encodeURIComponent(run.run_id)}/replay`}
                    className="zygos-btn-ghost"
                    style={{ padding: "7px 12px", fontSize: "12.5px", textDecoration: "none" }}
                  >
                    <Play size={13} />
                    <span>全过程回放</span>
                  </Link>
                  <Link
                    to={`/runs/${encodeURIComponent(run.run_id)}/answer`}
                    className="zygos-btn-primary"
                    style={{ padding: "7px 14px", fontSize: "12.5px", textDecoration: "none" }}
                  >
                    <span>查看最终答案</span>
                    <ArrowUpRight size={14} />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
