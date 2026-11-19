import { useMemo } from "react";
import { Link } from "react-router";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Award,
  Boxes,
  CheckCircle2,
  Clock,
  Cpu,
  FileText,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { ResearchViewModel } from "../../../domain/research/types";
import { extractFinalAnswerPresentation } from "../../../domain/research/plainAnswer";
import { MathMarkdown } from "../../../components/MathMarkdown";

export interface ResultDeliveryCardProps {
  viewModel: ResearchViewModel;
  onOpenAnswerPage?: () => void;
}

interface ObligationRow {
  readonly id: string;
  readonly statement: string;
  readonly resolved: boolean;
  readonly note?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function extractStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    } else {
      const rec = asRecord(item);
      const label =
        asString(rec?.["id"]) ??
        asString(rec?.["obligation_id"]) ??
        asString(rec?.["title"]) ??
        asString(rec?.["statement"]) ??
        asString(rec?.["description"]);
      if (label) out.push(label);
    }
  }
  return out;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function normalizeObligations(
  contractRaw: Record<string, unknown> | null,
  deliveryRaw: Record<string, unknown> | null,
): {
  formalItems: ObligationRow[];
  unresolvedList: string[];
} {
  const contractPayload = asRecord(contractRaw?.["payload"]) ?? contractRaw;
  const contractObj = asRecord(contractPayload?.["contract"]) ?? contractPayload;
  const deliveryPayload = asRecord(deliveryRaw?.["payload"]) ?? deliveryRaw;
  const deliverySummary = asRecord(deliveryPayload?.["summary"]) ?? deliveryPayload;

  const rawUnresolved =
    deliverySummary?.["unresolved_obligations"] ??
    deliverySummary?.["unresolvedObligations"] ??
    deliverySummary?.["unresolved_list"] ??
    deliverySummary?.["unresolvedList"] ??
    deliverySummary?.["unresolved"] ??
    deliverySummary?.["open_obligations"];
  const unresolvedList = extractStringArray(rawUnresolved);
  const unresolvedSet = new Set(unresolvedList.map((s) => s.toLowerCase()));

  const rawObligations =
    contractObj?.["obligationList"] ??
    contractObj?.["obligation_list"] ??
    contractObj?.["obligations"] ??
    contractObj?.["formal_obligations"] ??
    deliverySummary?.["obligationList"] ??
    deliverySummary?.["obligation_list"] ??
    deliverySummary?.["obligations"];

  if (!Array.isArray(rawObligations) || rawObligations.length === 0) {
    return { formalItems: [], unresolvedList };
  }

  const formalItems: ObligationRow[] = [];
  rawObligations.forEach((entry, idx) => {
    if (typeof entry === "string" && entry.trim()) {
      const id = `OBL-${idx + 1}`;
      const text = entry.trim();
      const isOpen =
        unresolvedSet.has(id.toLowerCase()) || unresolvedSet.has(text.toLowerCase());
      formalItems.push({ id, statement: text, resolved: !isOpen });
      return;
    }

    const rec = asRecord(entry);
    if (!rec) return;
    const id =
      asString(rec["id"]) ??
      asString(rec["obligation_id"]) ??
      asString(rec["code"]) ??
      `OBL-${idx + 1}`;
    const statement =
      asString(rec["statement"]) ??
      asString(rec["description"]) ??
      asString(rec["title"]) ??
      asString(rec["goal"]) ??
      id;
    const note = asString(rec["note"]) ?? asString(rec["status"]) ?? undefined;
    const explicitResolved =
      typeof rec["resolved"] === "boolean" ? rec["resolved"] : undefined;
    const matchedOpen =
      unresolvedSet.has(id.toLowerCase()) ||
      unresolvedSet.has(statement.toLowerCase()) ||
      unresolvedList.some(
        (u) =>
          u.toLowerCase().includes(id.toLowerCase()) ||
          id.toLowerCase().includes(u.toLowerCase()),
      );

    formalItems.push({
      id,
      statement,
      resolved: explicitResolved !== undefined ? explicitResolved : !matchedOpen,
      note,
    });
  });

  return { formalItems, unresolvedList };
}

export function ResultDeliveryCard({ viewModel, onOpenAnswerPage }: ResultDeliveryCardProps) {
  const contractNode = useMemo(
    () => viewModel.nodes.find((n) => n.id === "node-contract") ?? null,
    [viewModel.nodes],
  );
  const deliveryNode = useMemo(
    () => viewModel.nodes.find((n) => n.id === "node-delivery-final") ?? null,
    [viewModel.nodes],
  );

  const deliveryEvidence = deliveryNode?.evidenceId
    ? viewModel.evidences[deliveryNode.evidenceId] ?? null
    : null;

  const contractRaw = asRecord(contractNode?.technical?.raw);
  const deliveryRaw = asRecord(deliveryNode?.technical?.raw);

  const { formalItems, unresolvedList } = useMemo(
    () => normalizeObligations(contractRaw, deliveryRaw),
    [contractRaw, deliveryRaw],
  );

  const plainPresentation = useMemo(
    () => extractFinalAnswerPresentation(viewModel),
    [viewModel],
  );

  const deliveryMarkdown = useMemo(() => {
    if (viewModel.finalAnswer && viewModel.finalAnswer.trim()) {
      return viewModel.finalAnswer.trim();
    }
    if (deliveryEvidence?.markdownContent?.trim()) {
      return deliveryEvidence.markdownContent;
    }
    const payload = asRecord(deliveryRaw?.["payload"]) ?? deliveryRaw;
    const summary = asRecord(payload?.["summary"]) ?? payload;
    const rawResp =
      asString(payload?.["final_response"]) ??
      asString(payload?.["finalResponse"]) ??
      asString(summary?.["final_response"]) ??
      asString(summary?.["finalResponse"]) ??
      asString(payload?.["markdown"]) ??
      deliveryNode?.outputSummary ??
      deliveryNode?.summary;
    return (
      rawResp ??
      "本次运行已进入终态，但事件流中未携带完整数学交付文本。请点击阶段 4 节点检查技术详情。"
    );
  }, [viewModel.finalAnswer, deliveryEvidence, deliveryRaw, deliveryNode]);

  const stopReasonText = useMemo(() => {
    const payload = asRecord(deliveryRaw?.["payload"]) ?? deliveryRaw;
    const summary = asRecord(payload?.["summary"]) ?? payload;
    return (
      asString(payload?.["stopReason"]) ??
      asString(summary?.["stopReason"]) ??
      asString(payload?.["stop_reason"]) ??
      null
    );
  }, [deliveryRaw]);

  const { budget } = viewModel;
  const kpiCards = [
    {
      label: "模型逻辑调用",
      value: `${budget.usedModelCalls}`,
      sub: `上限 ${budget.maxModelCalls || "∞"}`,
      icon: Cpu,
      accent: "#3b82f6",
    },
    {
      label: "数学资产加载",
      value: `${budget.usedMethodLoads}`,
      sub: `配额 ${budget.maxMethodLoads}`,
      icon: Boxes,
      accent: "#38bdf8",
    },
    {
      label: "研究工作单元",
      value: `${budget.usedWorkUnits}`,
      sub: `上限 ${budget.maxWorkUnits || "∞"}`,
      icon: Activity,
      accent: "#10b981",
    },
    {
      label: "端到端观测耗时",
      value: formatDuration(budget.elapsedMs),
      sub: `${viewModel.nodes.length} 个机制节点`,
      icon: Clock,
      accent: "#818cf8",
    },
  ];

  const resolvedCount = formalItems.filter((item) => item.resolved).length;
  const unresolvedCount = formalItems.length - resolvedCount;

  return (
    <section
      aria-label="研究结论交付与可信审计报告"
      className="zygos-glass zygos-animate-in"
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: "20px",
        border: "1px solid var(--color-line-strong)",
        boxShadow: "var(--shadow-ambient)",
      }}
    >
      {/* Keynote Top Brand Rule */}
      <div className="astra-brand-rule" style={{ height: "4px", width: "100%" }} />

      <div style={{ padding: "26px 28px", display: "flex", flexDirection: "column", gap: "22px" }}>
        {/* Header Bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "13px",
                backgroundColor: "var(--color-state-candidate-bg)",
                border: "1px solid var(--color-state-candidate-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-state-candidate)",
                flexShrink: 0,
              }}
            >
              <Award size={22} />
            </div>
            <div>
              <div
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--color-brand-mid)",
                }}
              >
                CONCLUSION REVEAL · 阶段 4 交付报告
              </div>
              <h2
                className="zygos-keynote-title"
                style={{
                  margin: "2px 0 0",
                  fontSize: "22px",
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                }}
              >
                候选数学推导结果与约束审查摘要
              </h2>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {stopReasonText && (
              <span
                style={{
                  padding: "5px 12px",
                  borderRadius: "999px",
                  backgroundColor: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-line)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11.5px",
                  color: "var(--color-ink-soft)",
                }}
              >
                终止码: {stopReasonText}
              </span>
            )}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "5px 13px",
                borderRadius: "999px",
                backgroundColor: "var(--color-state-candidate-bg)",
                border: "1px solid var(--color-state-candidate-border)",
                color: "var(--color-state-candidate)",
                fontSize: "12px",
                fontWeight: 700,
              }}
            >
              <ShieldAlert size={14} />
              <span>candidate_verified 恒为 false</span>
            </span>
          </div>
        </div>

        {/* Plain Text Direct Answer Highlight + Dedicated Page Action */}
        {plainPresentation.hasAnswer && (
          <div
            style={{
              padding: "18px 22px",
              borderRadius: "16px",
              background: "linear-gradient(135deg, var(--color-brand-tint) 0%, var(--color-surface-sunken) 100%)",
              border: "1px solid var(--color-brand-ring)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0, flex: "1 1 380px" }}>
              <div style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-brand-mid)", marginBottom: "6px" }}>
                直接纯文本 / 数值答案摘要（无符号化）
              </div>
              <div
                className="zygos-tabular"
                style={{
                  fontSize: "17px",
                  fontWeight: 700,
                  lineHeight: 1.65,
                  color: "var(--color-brand-deep)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {plainPresentation.fullPlainText}
              </div>
            </div>

            {onOpenAnswerPage ? (
              <button
                type="button"
                onClick={onOpenAnswerPage}
                className="zygos-btn-primary"
                style={{ padding: "9px 16px", fontSize: "13px", flexShrink: 0 }}
              >
                <span>打开单独答案呈现页</span>
                <ArrowUpRight size={15} />
              </button>
            ) : (
              viewModel.runId && (
                <Link
                  to={`/runs/${encodeURIComponent(viewModel.runId)}/answer`}
                  className="zygos-btn-primary"
                  style={{ padding: "9px 16px", fontSize: "13px", textDecoration: "none", flexShrink: 0 }}
                >
                  <span>打开单独答案呈现页</span>
                  <ArrowUpRight size={15} />
                </Link>
              )
            )}
          </div>
        )}

        {/* Strict Honesty Red-line Notice */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
            padding: "14px 16px",
            borderRadius: "13px",
            backgroundColor: "var(--color-state-candidate-bg)",
            border: "1px solid var(--color-state-candidate-border)",
            color: "var(--color-state-candidate)",
            fontSize: "13px",
            lineHeight: 1.6,
          }}
        >
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <strong>可信边界声明（candidateVerified = {String(viewModel.candidateVerified)}）：</strong>
            本控制台展示的是引擎经结构化审查与受控反例校验后收敛得到的
            <strong>候选研究交付物</strong>，未接入 Lean / Coq 等外部形式化证明内核；
            任何“已收敛 / 自报完成”均不等于形式化定理成立，最终数学正确性仍须人工学者复核。
          </div>
        </div>

        {/* Bento KPI Telemetry Row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: "12px",
          }}
        >
          {kpiCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.label}
                className="zygos-bento"
                style={{
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  backgroundColor: "var(--color-surface-sunken)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink-mute)" }}>
                    {card.label}
                  </span>
                  <Icon size={15} color={card.accent} />
                </div>
                <div
                  className="zygos-tabular"
                  style={{
                    fontSize: "22px",
                    fontWeight: 800,
                    color: "var(--color-brand-deep)",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {card.value}
                </div>
                <div className="zygos-tabular" style={{ fontSize: "11.5px", color: "var(--color-ink-soft)" }}>
                  {card.sub}
                </div>
              </div>
            );
          })}
        </div>

        {/* Mathematical Proof & Final Conclusion */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "10px",
              gap: "12px",
            }}
          >
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
              <FileText size={16} color="var(--color-brand-mid)" />
              <span>完整推导与结论正文（KaTeX 数学排版）</span>
            </span>
          </div>

          <div
            style={{
              padding: "20px 24px",
              borderRadius: "14px",
              backgroundColor: "var(--color-surface-sunken)",
              border: "1px solid var(--color-line-strong)",
              boxShadow: "inset 0 1px 0 var(--color-specular)",
            }}
          >
            <MathMarkdown content={deliveryMarkdown} />
          </div>
        </div>

        {/* Obligations Coverage Table OR Honest Fallback Card */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "10px",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
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
              <ShieldCheck size={16} color="var(--color-brand-mid)" />
              <span>研究契约义务项收敛覆盖核对表</span>
            </span>

            {formalItems.length > 0 && (
              <span className="zygos-tabular" style={{ fontSize: "12px", color: "var(--color-ink-soft)" }}>
                共 {formalItems.length} 项 · 已响应收口 {resolvedCount} 项 · 未决/敞口{" "}
                <strong style={{ color: unresolvedCount > 0 ? "var(--color-state-error)" : "var(--color-state-success)" }}>
                  {unresolvedCount}
                </strong>{" "}
                项
              </span>
            )}
          </div>

          {formalItems.length > 0 ? (
            <div
              style={{
                borderRadius: "14px",
                border: "1px solid var(--color-line)",
                overflow: "hidden",
                backgroundColor: "var(--color-surface-sunken)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr
                    style={{
                      backgroundColor: "var(--color-surface-muted)",
                      borderBottom: "1px solid var(--color-line)",
                      textAlign: "left",
                      color: "var(--color-ink-mute)",
                      fontSize: "11.5px",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    <th style={{ padding: "11px 14px", width: "130px" }}>义务编号</th>
                    <th style={{ padding: "11px 14px" }}>契约目标 / 子命题</th>
                    <th style={{ padding: "11px 14px", width: "180px" }}>状态归属</th>
                  </tr>
                </thead>
                <tbody>
                  {formalItems.map((row) => (
                    <tr
                      key={row.id}
                      style={{
                        borderBottom: "1px solid var(--color-line)",
                      }}
                    >
                      <td
                        style={{
                          padding: "12px 14px",
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          color: "var(--color-brand-mid)",
                          verticalAlign: "top",
                        }}
                      >
                        {row.id}
                      </td>
                      <td style={{ padding: "12px 14px", color: "var(--color-ink)", lineHeight: 1.55 }}>
                        <MathMarkdown content={row.statement} compact />
                      </td>
                      <td style={{ padding: "12px 14px", verticalAlign: "top" }}>
                        {row.resolved ? (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              padding: "3px 10px",
                              borderRadius: "999px",
                              backgroundColor: "var(--color-state-candidate-bg)",
                              border: "1px solid var(--color-state-candidate-border)",
                              color: "var(--color-state-candidate)",
                              fontSize: "11.5px",
                              fontWeight: 600,
                            }}
                          >
                            <CheckCircle2 size={12} />
                            <span>候选收口 · 待核验</span>
                          </span>
                        ) : (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              padding: "3px 10px",
                              borderRadius: "999px",
                              backgroundColor: "var(--color-state-error-bg)",
                              border: "1px solid var(--color-state-error-border)",
                              color: "var(--color-state-error)",
                              fontSize: "11.5px",
                              fontWeight: 600,
                            }}
                          >
                            <AlertTriangle size={12} />
                            <span>未解决 / 敞口</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div
              style={{
                padding: "16px 18px",
                borderRadius: "14px",
                border: "1px dashed var(--color-line-strong)",
                backgroundColor: "var(--color-surface-sunken)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                fontSize: "13px",
                color: "var(--color-ink-soft)",
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontWeight: 700, color: "var(--color-ink)" }}>
                诚实审计说明：当前记录未附带离散契约义务清单（obligationList）
              </div>
              <div>
                为遵守可信数据契约，控制台不会自动拆分或伪造虚拟义务表。
                {unresolvedList.length > 0
                  ? ` 终端摘要显式标记了 ${unresolvedList.length} 项未决条目：${unresolvedList.join("、")}。`
                  : " 如需逐项追溯阶段 1 的研究契约与阶段 3 的反例审校过程，请直接点击上方拓扑图节点打开证据检查器。"}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
