import { ChevronLeft, ChevronRight, CheckCircle2, Eye, Play, Search, Trash2, ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import {
  readTerminalFacts,
  resolveTraceLevel,
  type AblationRunItem,
  type AblationRunsResponse,
  type AblationRunsQuery,
  type ProblemSetDetail,
  type ProblemSetSummary,
  type RunSummaryItem,
} from "@/api/client.ts";
import { DataSourceBadge } from "@/components/DataSourceBadge.tsx";
import { InlineMathText } from "@/components/MathMarkdown.tsx";
import { PanelEmptyState } from "@/components/PanelEmptyState.tsx";
import { normalizeStatusKind, StatusBadge } from "@/components/StatusBadge.tsx";
import { describeStopReason } from "@/domain/stopReasonView.ts";

const UNKNOWN = "未知";

const CONFIG_META: readonly { value: string; name: string }[] = [
  { value: "full", name: "full (完整天轭)" },
  { value: "no_goal_dag", name: "no_goal_dag (去契约DAG)" },
  { value: "no_ballot", name: "no_ballot (去多路投票)" },
  { value: "no_assets_routing", name: "no_assets_routing (去资产路由)" },
  { value: "no_review_repair", name: "no_review_repair (去审修)" },
  { value: "no_resume", name: "no_resume (去断点续推)" },
];

export type RunTableSource = "eval200" | "problem_sets" | "local";

function truncate(text: string | null | undefined, maxLen = 78): string {
  if (!text || !text.trim()) return UNKNOWN;
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

export interface MeasuredRunsSectionProps {
  sourceMode: RunTableSource;
  onChangeSourceMode: (mode: RunTableSource) => void;
  localRuns: RunSummaryItem[];
  localLoading: boolean;
  localError: string | null;
  onRetryLocal: () => void;
  evalData: AblationRunsResponse | null;
  evalLoading: boolean;
  evalError: string | null;
  evalQuery: AblationRunsQuery;
  onUpdateEvalQuery: (patch: Partial<AblationRunsQuery>) => void;
  onRetryEval: () => void;
  problemSets: readonly ProblemSetSummary[];
  problemSetsLoading: boolean;
  selectedSetId: string | null;
  selectedSetDetail: ProblemSetDetail | null;
  onSelectProblemSet: (setId: string) => void;
  onDeleteProblemSet: (setId: string) => void;
  onOpenImport: () => void;
}

export function MeasuredRunsSection({
  sourceMode,
  onChangeSourceMode,
  localRuns,
  localLoading,
  localError,
  onRetryLocal,
  evalData,
  evalLoading,
  evalError,
  evalQuery,
  onUpdateEvalQuery,
  onRetryEval,
  problemSets,
  problemSetsLoading,
  selectedSetId,
  selectedSetDetail,
  onSelectProblemSet,
  onDeleteProblemSet,
  onOpenImport,
}: MeasuredRunsSectionProps) {
  const isEval = sourceMode === "eval200";
  const isProblemSets = sourceMode === "problem_sets";
  const evalItems: AblationRunItem[] = evalData?.items ?? [];
  const evalCount = evalData?.count ?? 0;
  const evalLimit = evalQuery.limit ?? 50;
  const evalOffset = evalQuery.offset ?? 0;
  const totalPages = Math.max(1, Math.ceil(evalCount / evalLimit));
  const currentPage = Math.min(totalPages, Math.floor(evalOffset / evalLimit) + 1);
  const selectedSetItems = selectedSetDetail?.items ?? [];

  return (
    <div
      className="zygos-glass"
      style={{
        borderRadius: "16px",
        overflow: "hidden",
      }}
    >
      {/* Table Header + Source Switcher */}
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid var(--color-line)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "14px",
              fontWeight: 700,
              color: "var(--color-brand-deep)",
            }}
          >
            <CheckCircle2 size={15} color="var(--color-brand-mid)" />
            样本明细总表（按真实返回条目渲染）
          </span>

          <div
            role="tablist"
            aria-label="运行日志数据源"
            style={{
              display: "inline-flex",
              padding: "3px",
              borderRadius: "10px",
              backgroundColor: "var(--color-surface-sunken)",
              border: "1px solid var(--color-line)",
              gap: "4px",
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isEval}
              onClick={() => onChangeSourceMode("eval200")}
              style={{
                padding: "4px 10px",
                borderRadius: "7px",
                border: "none",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
                backgroundColor: isEval ? "var(--color-brand-mid)" : "transparent",
                color: isEval ? "#ffffff" : "var(--color-ink-soft)",
              }}
            >
              实测有结果日志 ({evalData?.available ? evalData.total_all : "1000"})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isProblemSets}
              onClick={() => onChangeSourceMode("problem_sets")}
              style={{
                padding: "4px 10px",
                borderRadius: "7px",
                border: "none",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
                backgroundColor: isProblemSets ? "var(--color-brand-mid)" : "transparent",
                color: isProblemSets ? "#ffffff" : "var(--color-ink-soft)",
              }}
            >
              已导入 JSONL 题集 ({problemSets.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isEval && !isProblemSets}
              onClick={() => onChangeSourceMode("local")}
              style={{
                padding: "4px 10px",
                borderRadius: "7px",
                border: "none",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 600,
                backgroundColor: !isEval && !isProblemSets ? "var(--color-brand-mid)" : "transparent",
                color: !isEval && !isProblemSets ? "#ffffff" : "var(--color-ink-soft)",
              }}
            >
              本地研究日志 ({localRuns.length})
            </button>
          </div>
        </div>

        <span className="zygos-tabular" style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
          {isEval
            ? `共 ${evalCount} 行${evalData && evalCount !== evalData.total_all ? `（总库 ${evalData.total_all} 行）` : ""} · 第 ${currentPage} / ${totalPages} 页`
            : isProblemSets
              ? `共 ${problemSets.length} 个题集${selectedSetDetail ? ` · 当前题集 ${selectedSetDetail.count} 题` : ""}`
              : `共 ${localRuns.length} 行`}
        </span>
      </div>

      {/* Filters Toolbar for 1200 Measured Logs */}
      {isProblemSets ? (
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface-sunken)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink-soft)" }}>选择题集：</span>
            <select
              aria-label="选择已导入 JSONL 题集"
              value={selectedSetId ?? ""}
              onChange={(e) => onSelectProblemSet(e.target.value)}
              disabled={problemSets.length === 0}
              style={{ fontSize: "12px", padding: "5px 9px", borderRadius: "8px", border: "1px solid var(--color-line)" }}
            >
              {problemSets.length === 0 ? (
                <option value="">暂无已导入题集</option>
              ) : (
                problemSets.map((ps) => (
                  <option key={ps.set_id} value={ps.set_id}>
                    {ps.name} ({ps.count} 题 · {ps.mode})
                  </option>
                ))
              )}
            </select>
            {selectedSetId ? (
              <button
                type="button"
                onClick={() => onDeleteProblemSet(selectedSetId)}
                className="zygos-btn-ghost"
                style={{ padding: "4px 9px", fontSize: "12px", color: "var(--color-state-unsolved)" }}
              >
                <Trash2 size={13} />
                <span>删除该题集</span>
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onOpenImport}
            className="zygos-btn-primary"
            style={{ padding: "5px 11px", fontSize: "12px" }}
          >
            继续导入 JSONL 题集
          </button>
        </div>
      ) : null}

      {isEval ? (
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface-sunken)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <select
              aria-label="按消融配置筛选"
              value={evalQuery.config ?? ""}
              onChange={(e) => onUpdateEvalQuery({ config: e.target.value, offset: 0 })}
              style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "8px", border: "1px solid var(--color-line)" }}
            >
              <option value="">全部配置 ({evalData?.available ? evalData.total_all : 1000})</option>
              {CONFIG_META.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.name} · {evalData?.stats_all?.config_counts?.[opt.value] ?? "—"}
                </option>
              ))}
            </select>

            <select
              aria-label="按题组筛选"
              value={evalQuery.group ?? ""}
              onChange={(e) => onUpdateEvalQuery({ group: e.target.value, offset: 0 })}
              style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "8px", border: "1px solid var(--color-line)" }}
            >
              <option value="">全部题组</option>
              <option value="A">A 组 · 课内</option>
              <option value="B">B 组 · 竞赛</option>
            </select>

            <select
              aria-label="按人工复核判分筛选"
              value={evalQuery.verdict ?? ""}
              onChange={(e) => onUpdateEvalQuery({ verdict: e.target.value, offset: 0 })}
              style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "8px", border: "1px solid var(--color-line)" }}
            >
              <option value="">全部复核判分</option>
              <option value="correct">✓ 复核全对</option>
              <option value="wrong">✗ 候选未过复核</option>
            </select>

            <select
              aria-label="排序方式"
              value={evalQuery.sort ?? "config_problem"}
              onChange={(e) => onUpdateEvalQuery({ sort: e.target.value, offset: 0 })}
              style={{ fontSize: "12px", padding: "5px 8px", borderRadius: "8px", border: "1px solid var(--color-line)" }}
            >
              <option value="config_problem">排序：配置组 → 题号</option>
              <option value="problem_config">排序：单题号 → 六配置对比</option>
              <option value="duration_desc">排序：耗时从高到低</option>
              <option value="duration_asc">排序：耗时从低到高</option>
            </select>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "4px 9px",
                borderRadius: "8px",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface)",
              }}
            >
              <Search size={13} color="var(--color-ink-mute)" />
              <input
                type="search"
                aria-label="搜索题号、题干或答案"
                placeholder="搜题号如 B-001 / 题干 / 备注"
                value={evalQuery.q ?? ""}
                onChange={(e) => onUpdateEvalQuery({ q: e.target.value, offset: 0 })}
                style={{
                  border: "none",
                  outline: "none",
                  fontSize: "12px",
                  width: "185px",
                  backgroundColor: "transparent",
                  color: "var(--color-ink)",
                }}
              />
            </label>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <button
              type="button"
              disabled={evalOffset === 0 || evalLoading}
              onClick={() => onUpdateEvalQuery({ offset: Math.max(0, evalOffset - evalLimit) })}
              className="zygos-btn-ghost"
              style={{ padding: "4px 9px", fontSize: "12px" }}
            >
              <ChevronLeft size={13} />
              <span>上一页</span>
            </button>
            <span className="zygos-tabular" style={{ minWidth: "66px", textAlign: "center", fontWeight: 600 }}>
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages || evalLoading}
              onClick={() => onUpdateEvalQuery({ offset: evalOffset + evalLimit })}
              className="zygos-btn-ghost"
              style={{ padding: "4px 9px", fontSize: "12px" }}
            >
              <span>下一页</span>
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      ) : null}

      {/* Body */}
      {isEval ? (
        evalError ? (
          <div style={{ padding: "18px" }}>
            <PanelEmptyState
              variant="missing"
              title="1200 条实测单题日志拉取失败"
              description={evalError}
              action={
                <button
                  type="button"
                  onClick={onRetryEval}
                  className="zygos-btn-primary"
                  style={{ padding: "8px 16px", fontSize: "13px" }}
                >
                  重试加载
                </button>
              }
            />
          </div>
        ) : evalData && !evalData.available ? (
          <div style={{ padding: "18px" }}>
            <PanelEmptyState
              variant="missing"
              title="未检测到本地 full200_fixv3 实测日志目录"
              description={evalData.reason ?? "请检查消融/internal/results/full200_fixv3 目录或 ASTRA_EVAL200_RUNS_ROOT 环境变量；您仍可切换至本地研究日志查看历史记录。"}
              action={
                <button
                  type="button"
                  onClick={() => onChangeSourceMode("local")}
                  className="zygos-btn-primary"
                  style={{ padding: "8px 16px", fontSize: "13px" }}
                >
                  切换到本地研究日志 ({localRuns.length})
                </button>
              }
            />
          </div>
        ) : !evalLoading && evalItems.length === 0 ? (
          <div style={{ padding: "18px" }}>
            <PanelEmptyState
              variant="empty"
              title="当前筛选条件下无匹配的单题运行日志"
              description="请尝试清空关键词或重置配置 / 状态 / 复核筛选条件。"
            />
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr
                    style={{
                      backgroundColor: "var(--color-surface-sunken)",
                      borderBottom: "1px solid var(--color-line)",
                      textAlign: "left",
                      fontSize: "11.5px",
                      color: "var(--color-ink-mute)",
                    }}
                  >
                    <th style={{ padding: "11px 14px" }}>Run ID（单题运行）</th>
                    <th style={{ padding: "11px 12px" }}>配置 · 题号</th>
                    <th style={{ padding: "11px 12px" }}>状态归类 · 复核</th>
                    <th style={{ padding: "11px 14px" }}>数学题目与答案摘要</th>
                    <th style={{ padding: "11px 12px" }}>终止原因</th>
                    <th style={{ padding: "11px 12px" }}>观测级别</th>
                    <th style={{ padding: "11px 12px" }}>耗时 / 调用</th>
                    <th style={{ padding: "11px 14px", textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {evalItems.map((run) => {
                    const statusKind = normalizeStatusKind(run.status);
                    const traceLevel = resolveTraceLevel(run);
                    const facts = readTerminalFacts(run);
                    const stopInfo = describeStopReason(facts.stopReason);
                    const isCorrect = run.delivered_correct === true;
                    const hasL2 = traceLevel === "L2" || traceLevel === "L3";

                    return (
                      <tr key={run.run_id} style={{ borderBottom: "1px solid var(--color-line)" }}>
                        <td
                          style={{
                            padding: "10px 14px",
                            fontFamily: "var(--font-mono)",
                            fontSize: "12px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <Link
                            to={`/runs/${encodeURIComponent(run.run_id)}`}
                            style={{ color: "var(--color-brand-mid)", textDecoration: "none", fontWeight: 600 }}
                          >
                            {run.run_id}
                          </Link>
                        </td>
                        <td style={{ padding: "10px 12px", whiteSpace: "nowrap", fontSize: "12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span
                              style={{
                                padding: "2px 7px",
                                borderRadius: "6px",
                                backgroundColor: "var(--color-surface-sunken)",
                                border: "1px solid var(--color-line)",
                                fontFamily: "var(--font-mono)",
                                fontSize: "11px",
                                fontWeight: 700,
                                color: "var(--color-brand-deep)",
                              }}
                            >
                              {run.config_id}
                            </span>
                            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{run.problem_id}</span>
                          </div>
                          {run.answer_type || run.source_dataset ? (
                            <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", marginTop: "2px" }}>
                              {run.stratum}组 · {run.answer_type ?? "—"} · {run.source_dataset ?? "—"}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}>
                            <StatusBadge status={statusKind} size="sm" />
                            <span
                              title={run.judge_note ?? undefined}
                              style={{
                                fontSize: "11px",
                                fontWeight: 700,
                                color: isCorrect
                                  ? "var(--color-state-solved, #22c55e)"
                                  : "var(--color-state-unsolved, #f87171)",
                              }}
                            >
                              {isCorrect
                                ? "✓ 复核全对"
                                : `✗ ${run.judge_failure ?? "未对"}${typeof run.subq === "number" && run.subq > 0 && run.subq < 1 ? ` (${run.subq.toFixed(2)})` : ""}`}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "10px 14px", maxWidth: "360px", color: "var(--color-ink)" }}>
                          <InlineMathText text={truncate(run.scenario)} />
                          {run.final_answer ? (
                            <div
                              style={{
                                marginTop: "3px",
                                fontSize: "11px",
                                color: "var(--color-ink-soft)",
                                fontFamily: "var(--font-mono)",
                              }}
                              title={run.final_answer}
                            >
                              解：{truncate(run.final_answer, 56)}
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{ padding: "10px 12px", fontSize: "12px", color: "var(--color-ink-soft)" }}
                          title={stopInfo.description}
                        >
                          <div>{stopInfo.title}</div>
                          {facts.stopReason ? (
                            <div style={{ fontFamily: "var(--font-mono)", fontSize: "10.5px", color: "var(--color-ink-mute)" }}>
                              {facts.stopReason}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "3px", alignItems: "flex-start" }}>
                            <DataSourceBadge level={traceLevel} size="sm" />
                            <span className="zygos-tabular" style={{ fontSize: "10.5px", color: "var(--color-ink-mute)" }}>
                              {hasL2
                                ? `${run.trace_frames_count ?? "?"} 帧 trace`
                                : "0 帧 (空 trace)"}
                            </span>
                          </div>
                        </td>
                        <td
                          className="zygos-tabular"
                          style={{
                            padding: "10px 12px",
                            fontFamily: "var(--font-mono)",
                            fontSize: "12px",
                            color: "var(--color-ink-soft)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <div>
                            {typeof run.duration_s === "number" && Number.isFinite(run.duration_s)
                              ? `${run.duration_s.toFixed(2)}s`
                              : UNKNOWN}
                          </div>
                          {typeof run.logical_model_calls === "number" ? (
                            <div style={{ fontSize: "10.5px", color: "var(--color-ink-mute)" }}>
                              {run.logical_model_calls} 次调用
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                          <div style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                            {hasL2 ? (
                              <Link
                                to={`/runs/${encodeURIComponent(run.run_id)}/replay`}
                                className="zygos-btn-ghost"
                                style={{ padding: "4px 10px", fontSize: "11.5px", textDecoration: "none" }}
                              >
                                <Play size={12} />
                                <span>回放</span>
                              </Link>
                            ) : (
                              <Link
                                to={`/runs/${encodeURIComponent(run.run_id)}`}
                                className="zygos-btn-ghost"
                                style={{ padding: "4px 10px", fontSize: "11.5px", textDecoration: "none" }}
                              >
                                <Eye size={12} />
                                <span>详情</span>
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div
              style={{
                padding: "11px 18px",
                borderTop: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface-sunken)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "10px",
                fontSize: "12px",
              }}
            >
              <span className="zygos-tabular" style={{ color: "var(--color-ink-soft)" }}>
                当前显示第 {evalCount === 0 ? 0 : evalOffset + 1}–{Math.min(evalOffset + evalItems.length, evalCount)} 条，共 {evalCount} 条实测日志
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  type="button"
                  disabled={evalOffset === 0 || evalLoading}
                  onClick={() => onUpdateEvalQuery({ offset: Math.max(0, evalOffset - evalLimit) })}
                  className="zygos-btn-ghost"
                  style={{ padding: "4px 10px", fontSize: "12px" }}
                >
                  <ChevronLeft size={13} />
                  <span>上一页</span>
                </button>
                <span className="zygos-tabular" style={{ minWidth: "66px", textAlign: "center", fontWeight: 600 }}>
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={currentPage >= totalPages || evalLoading}
                  onClick={() => onUpdateEvalQuery({ offset: evalOffset + evalLimit })}
                  className="zygos-btn-ghost"
                  style={{ padding: "4px 10px", fontSize: "12px" }}
                >
                  <span>下一页</span>
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          </>
        )
      ) : isProblemSets ? (
        !problemSetsLoading && problemSets.length === 0 ? (
          <div style={{ padding: "18px" }}>
            <PanelEmptyState
              variant="empty"
              title="尚未导入 JSONL 题目集"
              description="点击右上角「导入 JSONL 题目集」上传 .jsonl 或粘贴题目 JSONL，即可在此逐题浏览或单题入队求解。"
              action={
                <button
                  type="button"
                  onClick={onOpenImport}
                  className="zygos-btn-primary"
                  style={{ padding: "8px 16px", fontSize: "13px" }}
                >
                  导入 JSONL 题目集
                </button>
              }
            />
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr
                  style={{
                    backgroundColor: "var(--color-surface-sunken)",
                    borderBottom: "1px solid var(--color-line)",
                    textAlign: "left",
                    fontSize: "11.5px",
                    color: "var(--color-ink-mute)",
                  }}
                >
                  <th style={{ padding: "11px 14px" }}>序号 / 题号</th>
                  <th style={{ padding: "11px 12px" }}>题型与分组</th>
                  <th style={{ padding: "11px 14px" }}>题目正文摘要</th>
                  <th style={{ padding: "11px 12px" }}>队列状态</th>
                  <th style={{ padding: "11px 14px", textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {selectedSetItems.map((item, idx) => {
                  const runId = selectedSetDetail?.enqueued_run_ids?.[idx];
                  return (
                    <tr key={`${item.id}-${idx}`} style={{ borderBottom: "1px solid var(--color-line)" }}>
                      <td style={{ padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap" }}>
                        #{item.index} · {item.id}
                      </td>
                      <td style={{ padding: "10px 12px", fontSize: "12px", color: "var(--color-ink-soft)", whiteSpace: "nowrap" }}>
                        {[item.stratum ? `${item.stratum}组` : null, item.answer_type, item.source_dataset]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td style={{ padding: "10px 14px", maxWidth: "520px", color: "var(--color-ink)" }}>
                        <InlineMathText text={truncate(item.problem, 120)} />
                      </td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "11.5px", whiteSpace: "nowrap" }}>
                        {runId ? (
                          <Link
                            to={`/runs/${encodeURIComponent(runId)}`}
                            style={{ color: "var(--color-brand-mid)", textDecoration: "none", fontWeight: 600 }}
                          >
                            {runId}
                          </Link>
                        ) : (
                          <span style={{ color: "var(--color-ink-mute)" }}>未入队</span>
                        )}
                      </td>
                      <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                        <Link
                          to={`/solve?problem=${encodeURIComponent(item.problem)}`}
                          className="zygos-btn-ghost"
                          style={{ padding: "4px 10px", fontSize: "11.5px", textDecoration: "none" }}
                        >
                          <ArrowUpRight size={12} />
                          <span>去求解</span>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : localError ? (
        <div style={{ padding: "18px" }}>
          <PanelEmptyState
            variant="missing"
            title="批量记录拉取失败"
            description={localError}
            action={
              <button
                type="button"
                onClick={onRetryLocal}
                className="zygos-btn-primary"
                style={{ padding: "8px 16px", fontSize: "13px" }}
              >
                重试加载
              </button>
            }
          />
        </div>
      ) : !localLoading && localRuns.length === 0 ? (
        <div style={{ padding: "18px" }}>
          <PanelEmptyState
            variant="empty"
            title="当前暂无可统计的运行样本"
            description="发起单题研究或执行任务后，样本汇总将自动显示于此。"
          />
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr
                style={{
                  backgroundColor: "var(--color-surface-sunken)",
                  borderBottom: "1px solid var(--color-line)",
                  textAlign: "left",
                  fontSize: "11.5px",
                  color: "var(--color-ink-mute)",
                }}
              >
                <th style={{ padding: "11px 14px" }}>Run ID</th>
                <th style={{ padding: "11px 14px" }}>状态归类</th>
                <th style={{ padding: "11px 14px" }}>数学题目摘要</th>
                <th style={{ padding: "11px 14px" }}>终止原因</th>
                <th style={{ padding: "11px 14px" }}>观测级别</th>
                <th style={{ padding: "11px 14px" }}>耗时 (s)</th>
                <th style={{ padding: "11px 14px", textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {localRuns.map((run) => {
                const statusKind = normalizeStatusKind(run.status);
                const traceLevel = resolveTraceLevel(run);
                const facts = readTerminalFacts(run);
                const stopInfo = describeStopReason(facts.stopReason);

                return (
                  <tr key={run.run_id} style={{ borderBottom: "1px solid var(--color-line)" }}>
                    <td
                      style={{
                        padding: "11px 14px",
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Link
                        to={`/runs/${encodeURIComponent(run.run_id)}`}
                        style={{ color: "var(--color-brand-mid)", textDecoration: "none", fontWeight: 600 }}
                      >
                        {run.run_id}
                      </Link>
                    </td>
                    <td style={{ padding: "11px 14px", whiteSpace: "nowrap" }}>
                      <StatusBadge status={statusKind} size="sm" />
                    </td>
                    <td style={{ padding: "11px 14px", maxWidth: "360px", color: "var(--color-ink)" }}>
                      <InlineMathText text={truncate(run.scenario)} />
                    </td>
                    <td
                      style={{ padding: "11px 14px", fontSize: "12px", color: "var(--color-ink-soft)" }}
                      title={stopInfo.description}
                    >
                      {stopInfo.title}
                    </td>
                    <td style={{ padding: "11px 14px", whiteSpace: "nowrap" }}>
                      <DataSourceBadge level={traceLevel} size="sm" />
                    </td>
                    <td
                      className="zygos-tabular"
                      style={{
                        padding: "11px 14px",
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        color: "var(--color-ink-soft)",
                      }}
                    >
                      {typeof run.duration_s === "number" && Number.isFinite(run.duration_s)
                        ? `${run.duration_s.toFixed(2)}s`
                        : UNKNOWN}
                    </td>
                    <td style={{ padding: "11px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <Link
                        to={`/runs/${encodeURIComponent(run.run_id)}/replay`}
                        className="zygos-btn-ghost"
                        style={{ padding: "4px 10px", fontSize: "11.5px", textDecoration: "none" }}
                      >
                        <Play size={12} />
                        <span>回放</span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
