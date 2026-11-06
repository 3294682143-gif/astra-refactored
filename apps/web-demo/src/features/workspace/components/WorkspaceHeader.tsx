import { useState, Fragment } from "react";
import { Link } from "react-router";
import {
  Sparkles,
  Play,
  RotateCcw,
  CheckCircle2,
  Clock,
  FileText,
  ChevronRight,
} from "lucide-react";
import { MACRO_STAGES, type ResearchViewModel } from "../../../domain/research/types";

interface WorkspaceHeaderProps {
  viewModel: ResearchViewModel;
  isReplay: boolean;
  onToggleReplay?: () => void;
  onResume?: () => void;
}

export function WorkspaceHeader({
  viewModel,
  isReplay,
  onToggleReplay,
  onResume,
}: WorkspaceHeaderProps) {
  const [showFullProblem, setShowFullProblem] = useState(false);

  const getStatusBadge = () => {
    if (isReplay) {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 10px",
            borderRadius: "9999px",
            backgroundColor: "#ede9fe",
            color: "#6d28d9",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          <RotateCcw size={13} />
          真实回放
        </span>
      );
    }
    if (viewModel.mode === "running") {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 10px",
            borderRadius: "9999px",
            backgroundColor: "#dbeafe",
            color: "#1d4ed8",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          <span
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              backgroundColor: "#2563eb",
              animation: "pulse 1.5s infinite",
            }}
          />
          实时推演中
        </span>
      );
    }
    if (viewModel.status === "candidate") {
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 10px",
            borderRadius: "9999px",
            backgroundColor: "#e0f2fe",
            color: "#0369a1",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          <CheckCircle2 size={13} />
          候选已收敛（待形式化验证）
        </span>
      );
    }
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "3px 10px",
          borderRadius: "9999px",
          backgroundColor: "#f1f5f9",
          color: "#475569",
          fontSize: "12px",
          fontWeight: 600,
        }}
      >
        <Clock size={13} />
        {viewModel.status || "未开始"}
      </span>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: "56px",
        padding: "0 24px",
        backgroundColor: "var(--color-surface)",
        borderBottom: "1px solid var(--color-line)",
        gap: "16px",
      }}
    >
      {/* 左侧：题目概览与原题查看 */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
        {getStatusBadge()}

        <div
          style={{
            fontSize: "14px",
            fontWeight: 600,
            color: "var(--color-ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "380px",
          }}
          title={viewModel.problem}
        >
          {viewModel.problem || "新建研究题目"}
        </div>

        {viewModel.problem && (
          <button
            type="button"
            onClick={() => setShowFullProblem(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "4px",
              border: "1px solid var(--color-line)",
              backgroundColor: "transparent",
              color: "var(--color-ink-soft)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            <FileText size={13} />
            查看原题
          </button>
        )}
      </div>

      {/* 中间：四大宏观阶段进展指示 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        {MACRO_STAGES.map((st, idx) => {
          const isActive = viewModel.currentStage === st.id;
          const isPast =
            MACRO_STAGES.findIndex((s) => s.id === viewModel.currentStage) > idx;

          return (
            <Fragment key={st.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: isActive ? 600 : 500,
                  backgroundColor: isActive
                    ? "var(--color-brand-tint)"
                    : isPast
                    ? "#f8fafc"
                    : "transparent",
                  color: isActive
                    ? "var(--color-brand)"
                    : isPast
                    ? "var(--color-ink)"
                    : "var(--color-ink-mute)",
                  border: isActive
                    ? "1px solid var(--color-brand-ring)"
                    : "1px solid transparent",
                }}
              >
                <span
                  style={{
                    width: "16px",
                    height: "16px",
                    borderRadius: "50%",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    backgroundColor: isActive
                      ? "var(--color-brand)"
                      : isPast
                      ? "#94a3b8"
                      : "#cbd5e1",
                    color: "#ffffff",
                  }}
                >
                  {st.order}
                </span>
                <span>{st.name}</span>
              </div>
              {idx < MACRO_STAGES.length - 1 && (
                <ChevronRight size={14} color="var(--color-line-strong)" />
              )}
            </Fragment>
          );
        })}
      </div>

      {/* 右侧：操作区 */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {viewModel.recovery.eligible && onResume && (
          <button
            type="button"
            onClick={onResume}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "6px",
              backgroundColor: "var(--color-brand)",
              color: "#ffffff",
              fontSize: "12px",
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            <RotateCcw size={14} />
            恢复同题研究
          </button>
        )}

        {viewModel.runId && onToggleReplay && (
          <button
            type="button"
            onClick={onToggleReplay}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid var(--color-line-strong)",
              backgroundColor: isReplay ? "var(--color-brand-tint)" : "var(--color-surface)",
              color: isReplay ? "var(--color-brand)" : "var(--color-ink)",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Play size={14} />
            {isReplay ? "退出回放" : "全过程回放"}
          </button>
        )}

        <Link
          to="/solve"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "6px 12px",
            borderRadius: "6px",
            backgroundColor: "var(--color-surface-sunken)",
            color: "var(--color-ink)",
            fontSize: "12px",
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          <Sparkles size={14} />
          新建
        </Link>
      </div>

      {/* 查看原题弹窗 */}
      {showFullProblem && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 999,
            backgroundColor: "rgba(15, 27, 45, 0.45)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
          onClick={() => setShowFullProblem(false)}
        >
          <div
            style={{
              backgroundColor: "var(--color-surface)",
              borderRadius: "12px",
              padding: "24px",
              maxWidth: "600px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                研究题目完整定义
              </h3>
              <button
                type="button"
                onClick={() => setShowFullProblem(false)}
                style={{ border: "none", background: "none", fontSize: "18px", cursor: "pointer", color: "var(--color-ink-mute)" }}
              >
                ×
              </button>
            </div>
            <div
              style={{
                fontSize: "15px",
                lineHeight: 1.8,
                color: "var(--color-ink)",
                backgroundColor: "var(--color-surface-muted)",
                padding: "16px",
                borderRadius: "8px",
                border: "1px solid var(--color-line)",
                fontFamily: "var(--font-sans)",
              }}
            >
              {viewModel.problem}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "18px" }}>
              <button
                type="button"
                onClick={() => setShowFullProblem(false)}
                style={{
                  padding: "8px 18px",
                  borderRadius: "6px",
                  backgroundColor: "var(--color-brand)",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
