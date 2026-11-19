import { useState, useEffect, Fragment } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import {
  Sparkles,
  Play,
  RotateCcw,
  CheckCircle2,
  Clock,
  FileText,
  ChevronRight,
  X,
  Award,
  GitBranch,
} from "lucide-react";
import { MACRO_STAGES, type ResearchViewModel } from "../../../domain/research/types";
import { toPlainAnswerText } from "../../../domain/research/plainAnswer";
import { MathMarkdown } from "../../../components/MathMarkdown";

interface WorkspaceHeaderProps {
  viewModel: ResearchViewModel;
  isReplay: boolean;
  isFastUnfold?: boolean;
  onToggleReplay?: () => void;
  onResume?: () => void;
  completedView?: "answer" | "process";
  onChangeCompletedView?: (view: "answer" | "process") => void;
}

export function WorkspaceHeader({
  viewModel,
  isReplay,
  isFastUnfold = false,
  onToggleReplay,
  onResume,
  completedView,
  onChangeCompletedView,
}: WorkspaceHeaderProps) {
  const [showFullProblem, setShowFullProblem] = useState(false);

  useEffect(() => {
    if (!showFullProblem) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setShowFullProblem(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [showFullProblem]);

  useEffect(() => {
    setShowFullProblem(false);
  }, [viewModel.runId]);

  const getStatusBadge = () => {
    if (isReplay) {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 11px",
            borderRadius: "9999px",
            backgroundColor: "rgba(139, 92, 246, 0.16)",
            border: "1px solid rgba(167, 139, 250, 0.35)",
            color: "var(--color-aurora-indigo)",
            fontSize: "12px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          <RotateCcw size={13} />
          <span>真实回放</span>
        </span>
      );
    }
    if (viewModel.mode === "running") {
      return (
        <span
          title={
            isFastUnfold
              ? "源自 var/astra/runs 真实实采事件轨迹按快速节奏展开 · candidateVerified 恒为 false"
              : undefined
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            padding: "4px 12px",
            borderRadius: "9999px",
            backgroundColor: "var(--color-brand-tint)",
            border: "1px solid var(--color-brand-ring)",
            color: "var(--color-brand-deep)",
            fontSize: "12px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              backgroundColor: "#3b82f6",
              animation: "pulse 1.5s infinite",
            }}
          />
          <span>{isFastUnfold ? "推演进行中" : "实时推演中"}</span>
        </span>
      );
    }
    if (viewModel.status === "candidate") {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 11px",
            borderRadius: "9999px",
            backgroundColor: "var(--color-state-candidate-bg)",
            border: "1px solid var(--color-state-candidate-border)",
            color: "var(--color-state-candidate)",
            fontSize: "12px",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          <CheckCircle2 size={13} />
          <span>候选已收敛（待形式化验证）</span>
        </span>
      );
    }
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "4px 11px",
          borderRadius: "9999px",
          backgroundColor: "var(--color-surface-sunken)",
          border: "1px solid var(--color-line)",
          color: "var(--color-ink-soft)",
          fontSize: "12px",
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        <Clock size={13} />
        <span>{viewModel.status || "未开始"}</span>
      </span>
    );
  };

  const activeStageIndex = MACRO_STAGES.findIndex((s) => s.id === viewModel.currentStage);

  return (
    <header
      className="zygos-glass"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 25,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: "60px",
        padding: "8px 24px",
        borderTop: "none",
        borderLeft: "none",
        borderRight: "none",
        borderRadius: 0,
        gap: "16px",
        flexWrap: "wrap",
      }}
    >
      {/* 左侧：状态徽章、题目摘要与查看原题 */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: "1 1 260px" }}>
        {getStatusBadge()}

        <div
          style={{
            fontSize: "13.5px",
            fontWeight: 600,
            color: "var(--color-ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "360px",
          }}
          title={viewModel.problem}
        >
          {(viewModel.problem && toPlainAnswerText(viewModel.problem, { singleLine: true })) ||
            "新建研究题目"}
        </div>

        {viewModel.problem && (
          <button
            type="button"
            onClick={() => setShowFullProblem(true)}
            className="zygos-btn-ghost"
            style={{
              padding: "4px 10px",
              fontSize: "12px",
              borderRadius: "7px",
              flexShrink: 0,
            }}
          >
            <FileText size={13} />
            <span>查看原题</span>
          </button>
        )}
      </div>

      {/* 中间：四大宏观阶段胶囊步进器 */}
      {viewModel.mode !== "unstarted" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "4px",
            borderRadius: "12px",
            backgroundColor: "var(--color-surface-sunken)",
            border: "1px solid var(--color-line)",
          }}
        >
          {MACRO_STAGES.map((st, idx) => {
            const isActive = viewModel.currentStage === st.id;
            const isPast = activeStageIndex > idx;

            return (
              <Fragment key={st.id}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "4px 10px",
                    borderRadius: "8px",
                    fontSize: "12px",
                    fontWeight: isActive ? 700 : 500,
                    backgroundColor: isActive
                      ? "var(--color-brand-tint)"
                      : isPast
                      ? "var(--color-state-success-bg)"
                      : "transparent",
                    color: isActive
                      ? "var(--color-brand-deep)"
                      : isPast
                      ? "var(--color-state-success)"
                      : "var(--color-ink-mute)",
                    border: isActive
                      ? "1px solid var(--color-brand-ring)"
                      : "1px solid transparent",
                    transition: "all 0.25s var(--ease-spring)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    className="zygos-tabular"
                    style={{
                      width: "17px",
                      height: "17px",
                      borderRadius: "50%",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "10px",
                      fontWeight: 700,
                      backgroundColor: isActive
                        ? "var(--color-brand)"
                        : isPast
                        ? "#10b981"
                        : "var(--color-line-strong)",
                      color: "#ffffff",
                    }}
                  >
                    {isPast ? "✓" : st.order}
                  </span>
                  <span>{st.name}</span>
                </div>
                {idx < MACRO_STAGES.length - 1 && (
                  <ChevronRight size={13} color="var(--color-ink-mute)" style={{ opacity: 0.5 }} />
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {/* 右侧：操作按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0, flexWrap: "wrap" }}>
        {viewModel.mode === "completed" && onChangeCompletedView && (
          <div
            role="tablist"
            aria-label="完成态视图切换"
            style={{
              display: "inline-flex",
              padding: "3px",
              borderRadius: "10px",
              backgroundColor: "var(--color-surface-sunken)",
              border: "1px solid var(--color-line-strong)",
              gap: "2px",
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={completedView === "answer"}
              onClick={() => onChangeCompletedView("answer")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 11px",
                borderRadius: "7px",
                border: "none",
                fontSize: "12px",
                fontWeight: 700,
                cursor: "pointer",
                backgroundColor:
                  completedView === "answer"
                    ? "var(--color-brand)"
                    : "transparent",
                color:
                  completedView === "answer" ? "#ffffff" : "var(--color-ink-soft)",
              }}
            >
              <Award size={13} />
              <span>最终答案页</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={completedView === "process"}
              onClick={() => onChangeCompletedView("process")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 11px",
                borderRadius: "7px",
                border: "none",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor:
                  completedView === "process"
                    ? "var(--color-brand-tint)"
                    : "transparent",
                color:
                  completedView === "process"
                    ? "var(--color-brand-deep)"
                    : "var(--color-ink-soft)",
              }}
            >
              <GitBranch size={13} />
              <span>四阶段过程</span>
            </button>
          </div>
        )}

        {viewModel.recovery.eligible && onResume && (
          <button
            type="button"
            onClick={onResume}
            className="zygos-btn-primary"
            style={{
              padding: "6px 13px",
              fontSize: "12px",
              borderRadius: "8px",
            }}
          >
            <RotateCcw size={13} />
            <span>恢复同题研究</span>
          </button>
        )}

        {viewModel.runId && onToggleReplay && (
          <button
            type="button"
            onClick={onToggleReplay}
            className="zygos-btn-ghost"
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              borderRadius: "8px",
              backgroundColor: isReplay ? "var(--color-brand-tint)" : undefined,
              borderColor: isReplay ? "var(--color-brand-ring)" : undefined,
              color: isReplay ? "var(--color-brand-deep)" : undefined,
            }}
          >
            <Play size={13} />
            <span>{isReplay ? "退出回放" : "全过程回放"}</span>
          </button>
        )}

        <Link
          to="/solve"
          className="zygos-btn-ghost"
          style={{
            padding: "6px 12px",
            fontSize: "12px",
            borderRadius: "8px",
            textDecoration: "none",
          }}
        >
          <Sparkles size={13} />
          <span>新建</span>
        </Link>
      </div>

      {/* 查看原题模态框 —— 通过 Portal 挂载到 body，避免被 sticky/backdrop-filter 顶栏裁剪卡住 */}
      {showFullProblem &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="研究题目完整定义"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              backgroundColor: "rgba(4, 8, 20, 0.72)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "24px",
              overflowY: "auto",
            }}
            onClick={() => setShowFullProblem(false)}
          >
            <div
              className="zygos-glass zygos-modal-card"
              style={{
                borderRadius: "18px",
                padding: "26px",
                maxWidth: "720px",
                width: "100%",
                maxHeight: "86vh",
                display: "flex",
                flexDirection: "column",
                backgroundColor: "var(--color-surface-popover)",
                boxShadow: "var(--shadow-ambient)",
                margin: "auto",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", gap: "12px" }}>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                  研究题目完整定义
                </h3>
                <button
                  type="button"
                  onClick={() => setShowFullProblem(false)}
                  className="zygos-btn-ghost"
                  style={{ padding: "6px 10px", borderRadius: "8px", fontSize: "12px" }}
                  aria-label="关闭原题弹窗"
                >
                  <X size={15} />
                  <span>关闭 (Esc)</span>
                </button>
              </div>
              <div
                style={{
                  backgroundColor: "var(--color-surface-sunken)",
                  padding: "18px 20px",
                  borderRadius: "12px",
                  border: "1px solid var(--color-line)",
                  overflowY: "auto",
                  flex: 1,
                }}
              >
                <MathMarkdown content={viewModel.problem} />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "18px" }}>
                <button
                  type="button"
                  onClick={() => setShowFullProblem(false)}
                  className="zygos-btn-primary"
                  style={{ padding: "8px 22px", fontSize: "13px" }}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </header>
  );
}
