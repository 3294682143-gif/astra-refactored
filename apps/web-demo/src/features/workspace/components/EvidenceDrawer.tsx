import { useState } from "react";
import {
  X,
  FileCheck2,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Clock,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import type { ResearchNode, ResearchEvidence } from "../../../domain/research/types";
import { MathMarkdown } from "../../../components/MathMarkdown";

interface EvidenceDrawerProps {
  node: ResearchNode | null;
  evidence: ResearchEvidence | null;
  onClose: () => void;
  onPrevNode?: () => void;
  onNextNode?: () => void;
  nodeIndex?: number;
  totalNodes?: number;
}

export function EvidenceDrawer({
  node,
  evidence,
  onClose,
  onPrevNode,
  onNextNode,
  nodeIndex,
  totalNodes,
}: EvidenceDrawerProps) {
  const [showTechnical, setShowTechnical] = useState(false);

  if (!node) return null;

  const hasNavigation = typeof nodeIndex === "number" && typeof totalNodes === "number" && totalNodes > 1;

  return (
    <aside
      aria-label="节点详情与真实证据"
      className="zygos-glass zygos-drawer-panel"
      style={{
        width: "430px",
        maxWidth: "100%",
        flexShrink: 0,
        borderTop: "none",
        borderBottom: "none",
        borderRight: "none",
        borderRadius: 0,
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 60px)",
        position: "sticky",
        top: "60px",
        overflowY: "auto",
        zIndex: 20,
      }}
    >
      {/* 抽屉顶栏 + 步进控制 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 20px",
          borderBottom: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface-sunken)",
          gap: "10px",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--color-brand-mid)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            机制节点真实证据检查器
          </div>
          <div
            style={{
              fontSize: "15px",
              fontWeight: 700,
              color: "var(--color-brand-deep)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: "2px",
            }}
          >
            {node.label}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
          {hasNavigation && (
            <>
              <button
                type="button"
                onClick={onPrevNode}
                disabled={nodeIndex === 0}
                className="zygos-btn-ghost"
                style={{ padding: "5px", borderRadius: "7px" }}
                title="上一节点"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="zygos-tabular" style={{ fontSize: "11px", color: "var(--color-ink-mute)", padding: "0 4px", fontFamily: "var(--font-mono)" }}>
                {nodeIndex! + 1}/{totalNodes}
              </span>
              <button
                type="button"
                onClick={onNextNode}
                disabled={nodeIndex === totalNodes! - 1}
                className="zygos-btn-ghost"
                style={{ padding: "5px", borderRadius: "7px" }}
                title="下一节点"
              >
                <ChevronRight size={15} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="zygos-btn-ghost"
            style={{ padding: "5px", borderRadius: "7px", marginLeft: "4px" }}
            title="关闭面板"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* 统一 7 项模板内容区 */}
      <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "18px" }}>
        {/* 1. 解决目标 */}
        <div>
          <SectionLabel>1. 解决目标</SectionLabel>
          <div
            style={{
              fontSize: "13.5px",
              lineHeight: 1.65,
              color: "var(--color-ink)",
              backgroundColor: "var(--color-surface-sunken)",
              padding: "11px 14px",
              borderRadius: "10px",
              border: "1px solid var(--color-line)",
            }}
          >
            {node.summary}
          </div>
        </div>

        {/* 2. 状态与耗时 */}
        <div>
          <SectionLabel>2. 状态与耗时</SectionLabel>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 11px",
                borderRadius: "9999px",
                fontSize: "12px",
                fontWeight: 600,
                backgroundColor:
                  node.status === "completed"
                    ? "var(--color-state-success-bg)"
                    : node.status === "failed"
                    ? "var(--color-state-error-bg)"
                    : "var(--color-surface-sunken)",
                color:
                  node.status === "completed"
                    ? "var(--color-state-success)"
                    : node.status === "failed"
                    ? "var(--color-state-error)"
                    : "var(--color-ink-soft)",
                border: `1px solid ${
                  node.status === "completed"
                    ? "var(--color-state-success-border)"
                    : node.status === "failed"
                    ? "var(--color-state-error-border)"
                    : "var(--color-line)"
                }`,
              }}
            >
              <ShieldCheck size={13} />
              {node.status === "completed"
                ? "执行完成"
                : node.status === "untriggered"
                ? "未触发"
                : node.status === "unrecorded"
                ? "记录缺失"
                : node.status === "failed"
                ? "未通过/异常"
                : node.status}
            </span>

            {node.durationMs != null && (
              <span className="zygos-tabular" style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--color-ink-mute)", fontFamily: "var(--font-mono)" }}>
                <Clock size={13} />
                耗时 {node.durationMs}ms
              </span>
            )}
          </div>
        </div>

        {/* 3. 本次输入 */}
        {node.inputSummary && (
          <div>
            <SectionLabel>3. 本次输入（题目/参数/前置候选）</SectionLabel>
            <pre
              style={{
                margin: 0,
                padding: "11px 13px",
                borderRadius: "10px",
                backgroundColor: "var(--color-code-bg)",
                border: "1px solid var(--color-line)",
                fontSize: "12px",
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--color-ink-soft)",
              }}
            >
              {node.inputSummary}
            </pre>
          </div>
        )}

        {/* 4. 本次产出 */}
        {node.outputSummary && (
          <div>
            <SectionLabel>4. 本次产出（意见/公式/候选/修订）</SectionLabel>
            <div
              style={{
                padding: "11px 13px",
                borderRadius: "10px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line-strong)",
                fontSize: "13px",
                lineHeight: 1.65,
                color: "var(--color-ink)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {node.outputSummary}
            </div>
          </div>
        )}

        {/* 5. 依据与边界 */}
        {node.rationale && (
          <div>
            <SectionLabel>5. 依据与边界说明</SectionLabel>
            <div
              style={{
                padding: "11px 13px",
                borderRadius: "10px",
                borderLeft: "3px solid var(--color-brand-mid)",
                backgroundColor: "var(--color-brand-tint)",
                fontSize: "12.5px",
                lineHeight: 1.6,
                color: "var(--color-brand-deep)",
              }}
            >
              {node.rationale}
            </div>
          </div>
        )}

        {/* 6. 关联对象 */}
        {node.relations && (node.relations.assetName || node.relations.taskId) && (
          <div>
            <SectionLabel>6. 关联对象与版本</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "12px" }}>
              {node.relations.assetName && (
                <span
                  style={{
                    padding: "4px 10px",
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                    borderRadius: "8px",
                    color: "var(--color-ink-soft)",
                  }}
                >
                  资产: <code style={{ fontFamily: "var(--font-mono)", color: "var(--color-brand-mid)" }}>{node.relations.assetName}</code>
                </span>
              )}
              {node.relations.taskId && (
                <span
                  style={{
                    padding: "4px 10px",
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                    borderRadius: "8px",
                    color: "var(--color-ink-soft)",
                  }}
                >
                  任务: <code style={{ fontFamily: "var(--font-mono)", color: "var(--color-brand-mid)" }}>{node.relations.taskId}</code>
                </span>
              )}
            </div>
          </div>
        )}

        {/* 真实证据正文渲染 */}
        {evidence && (
          <div style={{ borderTop: "1px solid var(--color-line)", paddingTop: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13.5px", fontWeight: 700, color: "var(--color-brand-deep)", marginBottom: "10px" }}>
              <FileCheck2 size={16} color="var(--color-brand-mid)" />
              <span>{evidence.title}</span>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: "12px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
              }}
            >
              <MathMarkdown content={evidence.markdownContent} compact />
            </div>

            {/* 明确红线提示 */}
            <div
              style={{
                marginTop: "12px",
                padding: "9px 12px",
                borderRadius: "9px",
                backgroundColor: "var(--color-state-candidate-bg)",
                border: "1px solid var(--color-state-candidate-border)",
                fontSize: "11.5px",
                color: "var(--color-state-candidate)",
                lineHeight: 1.5,
              }}
            >
              <AlertTriangle size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: "5px" }} />
              <strong>验证状态：未形式化证明</strong>。本证据仅供审查链与人工核验，模型/协议通过不直接等于数学逻辑成立。
            </div>
          </div>
        )}

        {/* 7. 受控技术详情 */}
        {node.technical && (
          <div style={{ borderTop: "1px solid var(--color-line)", paddingTop: "12px" }}>
            <button
              type="button"
              onClick={() => setShowTechnical(!showTechnical)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "none",
                border: "none",
                padding: "6px 0",
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--color-ink-soft)",
                cursor: "pointer",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                <Cpu size={14} />
                <span>7. 受控技术详情 (事件编号 #{node.technical.seq ?? "N/A"})</span>
              </span>
              {showTechnical ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showTechnical && (
              <pre
                style={{
                  margin: "8px 0 0 0",
                  padding: "12px",
                  borderRadius: "10px",
                  backgroundColor: "var(--color-code-bg)",
                  border: "1px solid var(--color-line)",
                  color: "var(--color-ink-soft)",
                  fontSize: "11px",
                  lineHeight: 1.45,
                  fontFamily: "var(--font-mono)",
                  overflowX: "auto",
                  maxHeight: "240px",
                }}
              >
                {JSON.stringify(node.technical.raw, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-ink-mute)", marginBottom: "6px", letterSpacing: "0.02em" }}>
      {children}
    </div>
  );
}
