import {
  Award,
  AlertTriangle,
  CheckCircle2,
  FileText,
  ShieldCheck,
} from "lucide-react";
import type { ResearchViewModel } from "../../../domain/research/types";
import { MathMarkdown } from "../../../components/MathMarkdown";

interface ResultDeliveryCardProps {
  viewModel: ResearchViewModel;
}

export function ResultDeliveryCard({ viewModel }: ResultDeliveryCardProps) {
  const isCandidate = viewModel.status === "candidate";
  const stopReason = viewModel.stopReason || "REVIEWS_COMPLETE";

  return (
    <div
      style={{
        backgroundColor: "var(--color-surface)",
        borderRadius: "12px",
        border: "1px solid var(--color-line-strong)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.03)",
        padding: "28px",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
      }}
    >
      {/* 终态横幅 */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--color-line)",
          paddingBottom: "18px",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", gap: "14px" }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "42px",
              height: "42px",
              borderRadius: "10px",
              backgroundColor: isCandidate ? "var(--color-brand-tint)" : "#fef2f2",
              color: isCandidate ? "var(--color-brand)" : "#dc2626",
            }}
          >
            {isCandidate ? <Award size={24} /> : <AlertTriangle size={24} />}
          </span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: "18px",
                  fontWeight: 800,
                  color: isCandidate ? "var(--color-brand-deep)" : "#991b1b",
                }}
              >
                {isCandidate ? "候选结论交付 (待形式化验证)" : "研究阶段收口"}
              </h2>
              <span
                style={{
                  fontSize: "12px",
                  padding: "2px 8px",
                  borderRadius: "9999px",
                  backgroundColor: isCandidate ? "#dbeafe" : "#fee2e2",
                  color: isCandidate ? "#1d4ed8" : "#991b1b",
                  fontWeight: 600,
                }}
              >
                代码: {stopReason}
              </span>
            </div>
            <div style={{ fontSize: "13px", color: "var(--color-ink-soft)", marginTop: "4px" }}>
              {isCandidate
                ? "经 R0角色审阅、有界资产调用、候选生成与专家一致性复核通过，向用户如实交付推导结论。"
                : "本次求解由于预算上限或约束未产出确认候选，交付当前已探索的范围与未解边界。"}
            </div>
          </div>
        </div>

        {/* 预算与消耗指标 */}
        <div
          style={{
            display: "flex",
            gap: "18px",
            fontSize: "12px",
            textAlign: "right",
            color: "var(--color-ink-soft)",
          }}
        >
          <div>
            <div style={{ color: "var(--color-ink-mute)", fontSize: "11px" }}>模型逻辑调用</div>
            <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--color-ink)" }}>
              {viewModel.budget.usedModelCalls} / {viewModel.budget.maxModelCalls}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--color-ink-mute)", fontSize: "11px" }}>数学资产加载</div>
            <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--color-ink)" }}>
              {viewModel.budget.usedMethodLoads} / {viewModel.budget.maxMethodLoads}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--color-ink-mute)", fontSize: "11px" }}>工作单元</div>
            <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--color-ink)" }}>
              {viewModel.budget.usedWorkUnits} 个
            </div>
          </div>
        </div>
      </div>

      {/* 严格红线免责/边界标注卡片 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "12px 18px",
          borderRadius: "8px",
          backgroundColor: isCandidate ? "#f0f9ff" : "#fef2f2",
          border: isCandidate ? "1px solid #bae6fd" : "1px solid #fecaca",
          fontSize: "13px",
          color: isCandidate ? "#0369a1" : "#991b1b",
          lineHeight: 1.5,
        }}
      >
        {isCandidate ? (
          <ShieldCheck size={20} style={{ flexShrink: 0 }} />
        ) : (
          <AlertTriangle size={20} style={{ flexShrink: 0 }} />
        )}
        <div>
          <strong>可信边界说明（红线声明）：</strong>
          {isCandidate ? (
            <>
              系统交付的上述结论为形式化前置候选推演，<code>candidate_verified 恒为 false</code>
              。在接入 Isabelle / Lean 等外部形式化完备定理证明器核验之前，保持“未形式化验证候选”定位，绝不夸大结论等级。
            </>
          ) : (
            <>
              本次求解未达成收敛候选结论（状态：{viewModel.status}，终止原因：{stopReason}），<code>candidate_verified 恒为 false</code>
              。无形式化候选结论交付，已完整保留审计记录与未闭合责任边界。
            </>
          )}
        </div>
      </div>

      {/* 宽幅数学证明 / 候选结论正文 */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "12px" }}>
          <FileText size={16} color="var(--color-brand)" />
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            {isCandidate ? "交付结论正文" : "阶段推导与未解记录正文"}
          </h3>
        </div>

        <div
          style={{
            backgroundColor: "var(--color-surface-muted)",
            border: "1px solid var(--color-line-strong)",
            borderRadius: "10px",
            padding: "20px 24px",
          }}
        >
          {viewModel.finalAnswer ? (
            <MathMarkdown content={viewModel.finalAnswer} />
          ) : (
            <div style={{ color: "var(--color-ink-mute)", fontStyle: "italic" }}>
              未生成文本结论（终态未记录或收口异常）
            </div>
          )}
        </div>
      </div>

      {/* 义务覆盖与审查结论 */}
      <div>
        <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          规划目标与义务覆盖
        </h3>

        {(() => {
          // 动态提取合同与交付节点中的义务与审查事实
          const contractNode = viewModel.nodes.find((n) => n.id.includes("node-contract"));
          const contractRaw = (contractNode?.technical?.raw as Record<string, unknown>) || {};
          const deliveryNode = viewModel.nodes.find((n) => n.id === "node-delivery-final");
          const deliveryRaw = (deliveryNode?.technical?.raw as Record<string, unknown>) || {};

          const unresolvedList: string[] = Array.isArray(deliveryRaw.unresolvedObligations)
            ? (deliveryRaw.unresolvedObligations as string[])
            : Array.isArray(viewModel.unresolvedObligations)
            ? (viewModel.unresolvedObligations as string[])
            : [];

          const toolNodes = viewModel.nodes.filter(
            (n) => n.stage === "stage_2_execution" && n.id.includes("tool")
          );
          const reviewNodes = viewModel.nodes.filter((n) => n.stage === "stage_3_review");

          // 动态提取合同中规划的义务项（仅从可信合同读取真实离散清单，禁止臆造虚假身份，Spec R1）
          const rawList = contractRaw.obligationList || contractRaw.obligationsList;
          const formalItems: { id: string; title: string; task?: string; asset?: string }[] = [];
          if (Array.isArray(rawList) && rawList.length > 0) {
            rawList.forEach((item, idx) => {
              if (typeof item === "string") {
                formalItems.push({ id: `OBL-0${idx + 1}`, title: item });
              } else if (item && typeof item === "object") {
                const obj = item as Record<string, unknown>;
                formalItems.push({
                  id: String(obj.id || `OBL-0${idx + 1}`),
                  title: String(obj.title || obj.name || obj.description || `形式化证明义务 #${idx + 1}`),
                  task: obj.task ? String(obj.task) : undefined,
                  asset: obj.asset ? String(obj.asset) : undefined,
                });
              }
            });
          }

          const isItemUnresolved = (item: { id: string; title: string }) => {
            const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
            const itemIdNorm = norm(item.id);
            return unresolvedList.some((u) => {
              const uNorm = norm(u);
              return (
                uNorm === itemIdNorm ||
                u === item.title ||
                itemIdNorm.includes(uNorm) ||
                uNorm.includes(itemIdNorm)
              );
            });
          };

          if (formalItems.length > 0) {
            return (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "13px",
                  textAlign: "left",
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--color-line)", backgroundColor: "#f8fafc" }}>
                    <th style={{ padding: "10px 14px", color: "var(--color-ink-soft)", fontWeight: 600 }}>规划义务项</th>
                    <th style={{ padding: "10px 14px", color: "var(--color-ink-soft)", fontWeight: 600 }}>关联任务</th>
                    <th style={{ padding: "10px 14px", color: "var(--color-ink-soft)", fontWeight: 600 }}>调用资产</th>
                    <th style={{ padding: "10px 14px", color: "var(--color-ink-soft)", fontWeight: 600 }}>覆盖与复核状态</th>
                  </tr>
                </thead>
                <tbody>
                  {formalItems.map((item) => {
                    const isUnresolved = isItemUnresolved(item);
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid var(--color-line)" }}>
                        <td style={{ padding: "12px 14px", fontWeight: 500 }}>
                          <span style={{ color: "var(--color-brand)", marginRight: "6px" }}>{item.id}</span>
                          {item.title}
                        </td>
                        <td style={{ padding: "12px 14px" }}>
                          <code>{item.task || "task-01"}</code>
                        </td>
                        <td style={{ padding: "12px 14px" }}>
                          <code>{item.asset || (toolNodes[0]?.relations?.assetName as string) || "无外部资产"}</code>
                        </td>
                        <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                          {isUnresolved ? (
                            <span style={{ color: "#dc2626", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <AlertTriangle size={14} /> 未闭合 (Unresolved)
                            </span>
                          ) : isCandidate ? (
                            <span style={{ color: "var(--color-brand)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <CheckCircle2 size={14} /> 流程闭合 (待形式化核验)
                            </span>
                          ) : (
                            <span style={{ color: "#d97706", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <AlertTriangle size={14} /> 探索中断未闭合
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          }

          // 未记录离散清单时的如实审计卡
          return (
            <div
              style={{
                padding: "16px 20px",
                backgroundColor: "#f8fafc",
                border: "1px solid var(--color-line)",
                borderRadius: "8px",
                fontSize: "13px",
                color: "var(--color-ink-soft)",
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "6px" }}>
                📋 运行过程事实与审计记录
              </div>
              <div>
                {typeof contractRaw.obligations === "number" && contractRaw.obligations > 0
                  ? `合同规划了 ${contractRaw.obligations} 项证明义务（离散明细未记录，采用有界符号推导模式）。`
                  : "本次推导未记录离散的形式化义务拆解清单（采用有界符号推导模式）。"}
              </div>
              <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                <div>
                  • <strong>执行工作单元</strong>：共完成 {viewModel.budget.usedWorkUnits} 个推导单元
                </div>
                <div>
                  • <strong>数学资产调用</strong>：
                  {toolNodes.length > 0 ? (
                    toolNodes.map((t) => t.label).join("、")
                  ) : (
                    <span style={{ color: "var(--color-ink-mute)" }}>未记录外部符号计算资产调用</span>
                  )}
                </div>
                <div>
                  • <strong>审查与准入机制</strong>：
                  {reviewNodes.length > 0 ? (
                    reviewNodes
                      .map((r) => `${r.label}（${r.status === "completed" ? "准入生效" : "拒绝/回流"}）`)
                      .join("；")
                  ) : (
                    <span style={{ color: "var(--color-ink-mute)" }}>未记录独立审查质询（由主干收口）</span>
                  )}
                </div>
                {unresolvedList.length > 0 ? (
                  <div style={{ color: "#b91c1c", fontWeight: 600 }}>
                    • <strong>未解决形式化义务</strong>：{unresolvedList.join("、")}
                  </div>
                ) : (
                  <div>
                    • <strong>义务收口状态</strong>：
                    {isCandidate ? (
                      <span style={{ color: "var(--color-brand)", fontWeight: 600 }}>主干流程已交付（待形式化核验）</span>
                    ) : (
                      <span style={{ color: "#d97706", fontWeight: 600 }}>探索中断，未形成收敛候选</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
