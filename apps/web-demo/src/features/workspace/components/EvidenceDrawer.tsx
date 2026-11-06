import { useState } from "react";
import {
  X,
  FileCheck2,
  ChevronDown,
  ChevronUp,
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
}

export function EvidenceDrawer({ node, evidence, onClose }: EvidenceDrawerProps) {
  const [showTechnical, setShowTechnical] = useState(false);

  if (!node) return null;

  return (
    <aside
      aria-label="节点详情与真实证据"
      style={{
        width: "420px",
        flexShrink: 0,
        backgroundColor: "var(--color-surface)",
        borderLeft: "1px solid var(--color-line-strong)",
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 56px)",
        position: "sticky",
        top: "56px",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.03)",
        overflowY: "auto",
        zIndex: 20,
      }}
    >
      {/* 抽屉顶栏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 20px",
          borderBottom: "1px solid var(--color-line)",
          backgroundColor: "#fcfdfe",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-brand)", textTransform: "uppercase" }}>
            机制节点真实证据
          </div>
          <div
            style={{
              fontSize: "15px",
              fontWeight: 700,
              color: "var(--color-brand-deep)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {node.label}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            border: "none",
            backgroundColor: "transparent",
            cursor: "pointer",
            color: "var(--color-ink-mute)",
            padding: "4px",
            borderRadius: "4px",
            display: "inline-flex",
          }}
          title="关闭面板"
        >
          <X size={18} />
        </button>
      </div>

      {/* 统一 7 项模板内容区 */}
      <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "20px" }}>
        {/* 1. 一句话：这一步要解决什么 */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "4px" }}>
            1. 解决目标
          </div>
          <div
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              color: "var(--color-ink)",
              backgroundColor: "var(--color-surface-muted)",
              padding: "10px 14px",
              borderRadius: "6px",
              border: "1px solid var(--color-line)",
            }}
          >
            {node.summary}
          </div>
        </div>

        {/* 2. 状态与结果摘要 */}
        <div>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "6px" }}>
            2. 状态与耗时
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "3px 10px",
                borderRadius: "9999px",
                fontSize: "12px",
                fontWeight: 600,
                backgroundColor: node.status === "completed" ? "#dcfce7" : "#f1f5f9",
                color: node.status === "completed" ? "#15803d" : "#475569",
              }}
            >
              <ShieldCheck size={13} />
              {node.status === "completed"
                ? "执行完成"
                : node.status === "untriggered"
                ? "未触发"
                : node.status === "unrecorded"
                ? "记录缺失"
                : node.status}
            </span>
            {node.durationMs != null && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                <Clock size={13} />
                耗时 {node.durationMs}ms
              </span>
            )}
          </div>
        </div>

        {/* 3. 本次输入 */}
        {node.inputSummary && (
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "4px" }}>
              3. 本次输入（题目/参数/前置候选）
            </div>
            <pre
              style={{
                margin: 0,
                padding: "10px 12px",
                borderRadius: "6px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
                fontSize: "12px",
                lineHeight: 1.5,
                fontFamily: "var(--font-mono)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                color: "#1e293b",
              }}
            >
              {node.inputSummary}
            </pre>
          </div>
        )}

        {/* 4. 本次产出 */}
        {node.outputSummary && (
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "4px" }}>
              4. 本次产出（意见/公式/候选/修订）
            </div>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                backgroundColor: "#f8fafc",
                border: "1px solid var(--color-line-strong)",
                fontSize: "13px",
                lineHeight: 1.6,
                color: "var(--color-ink)",
              }}
            >
              {node.outputSummary}
            </div>
          </div>
        )}

        {/* 5. 依据与边界 */}
        {node.rationale && (
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "4px" }}>
              5. 依据与边界说明
            </div>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                borderLeft: "3px solid var(--color-brand)",
                backgroundColor: "var(--color-brand-tint)",
                fontSize: "12px",
                lineHeight: 1.5,
                color: "var(--color-brand-deep)",
              }}
            >
              {node.rationale}
            </div>
          </div>
        )}

        {/* 6. 关联关系 */}
        {node.relations && (
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "6px" }}>
              6. 关联对象与版本
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "12px" }}>
              {node.relations.assetName && (
                <span style={{ padding: "3px 8px", backgroundColor: "#f1f5f9", borderRadius: "4px" }}>
                  资产: <code>{node.relations.assetName}</code>
                </span>
              )}
              {node.relations.taskId && (
                <span style={{ padding: "3px 8px", backgroundColor: "#f1f5f9", borderRadius: "4px" }}>
                  任务: <code>{node.relations.taskId}</code>
                </span>
              )}
            </div>
          </div>
        )}

        {/* 真实证据正文渲染 (如有) */}
        {evidence && (
          <div style={{ borderTop: "1px solid var(--color-line)", paddingTop: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 700, color: "var(--color-brand-deep)", marginBottom: "10px" }}>
              <FileCheck2 size={16} color="var(--color-brand)" />
              {evidence.title}
            </div>

            <MathMarkdown content={evidence.markdownContent} />

            {/* 明确的红线提示 */}
            <div
              style={{
                marginTop: "12px",
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: "#fffbeb",
                border: "1px solid #fef3c7",
                fontSize: "11px",
                color: "#92400e",
                lineHeight: 1.4,
              }}
            >
              <AlertTriangle size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} />
              <strong>验证状态：未形式化证明</strong>。本证据仅供审查链与人工核验，模型/协议通过不直接等于数学逻辑成立。
            </div>
          </div>
        )}

        {/* 7. 受控技术详情 (默认折叠) */}
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
                7. 受控技术详情 (事件编号 #{node.technical.seq ?? "N/A"})
              </span>
              {showTechnical ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showTechnical && (
              <pre
                style={{
                  margin: "8px 0 0 0",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  backgroundColor: "#0f1b2d",
                  color: "#e2e8f0",
                  fontSize: "11px",
                  lineHeight: 1.4,
                  fontFamily: "var(--font-mono)",
                  overflowX: "auto",
                  maxHeight: "220px",
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
