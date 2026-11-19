import {
  ArrowRight,
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  FileText,
  GitBranch,
  Layers,
  Radar,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { MathMarkdown } from "../../../../components/MathMarkdown";
import type { ResearchViewModel } from "../../../../domain/research/types";
import {
  THREE_INNOVATION_SPECS,
  type DerivedThreeInnovationsMetrics,
  type InnovationId,
  type InnovationPhaseStatus,
} from "./innovationSpecs";
import {
  InnovationOneArchitectureSvg,
  InnovationTwoArchitectureSvg,
  InnovationThreeArchitectureSvg,
} from "./InnovationArchitectureSvgs";

interface InnovationOverviewPipelineProps {
  viewModel: ResearchViewModel;
  metrics: DerivedThreeInnovationsMetrics;
  expandedIds: ReadonlySet<InnovationId>;
  onToggleExpand: (id: InnovationId) => void;
}

function getMacroStatusMeta(status: InnovationPhaseStatus) {
  if (status === "completed") {
    return {
      label: "已完成",
      color: "var(--color-state-success)",
      bg: "var(--color-state-success-bg)",
      border: "var(--color-state-success-border)",
    };
  }
  if (status === "active") {
    return {
      label: "推演中",
      color: "var(--color-brand-deep)",
      bg: "var(--color-brand-tint)",
      border: "var(--color-brand-ring)",
    };
  }
  if (status === "error") {
    return {
      label: "异常/截断",
      color: "var(--color-state-error)",
      bg: "var(--color-state-error-bg)",
      border: "var(--color-state-error-border)",
    };
  }
  return {
    label: "待调度",
    color: "var(--color-ink-mute)",
    bg: "var(--color-surface-sunken)",
    border: "var(--color-line)",
  };
}

function FlowBridgeArrow({
  active,
  accentFrom,
  accentTo,
}: {
  active: boolean;
  accentFrom: string;
  accentTo: string;
}) {
  return (
    <div className="zygos-pipeline-connector" aria-hidden="true">
      <svg viewBox="0 0 32 72" width="32" height="72">
        <defs>
          <linearGradient id={`bridge-${accentFrom}-${accentTo}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accentFrom} />
            <stop offset="100%" stopColor={accentTo} />
          </linearGradient>
        </defs>
        <path
          d="M 2 36 H 24 M 18 28 L 26 36 L 18 44"
          stroke={`url(#bridge-${accentFrom}-${accentTo})`}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          className={active ? "zygos-svg-flow" : ""}
        />
        {active && (
          <circle r="3" fill={accentTo}>
            <animateMotion dur="1.5s" repeatCount="indefinite" path="M 2 36 H 26" />
          </circle>
        )}
      </svg>
    </div>
  );
}

function MacroOverviewGraphic({
  id,
  animated,
  metrics,
}: {
  id: InnovationId;
  accent: string;
  animated: boolean;
  metrics: DerivedThreeInnovationsMetrics;
}) {
  if (id === "inn1") {
    return <InnovationOneArchitectureSvg metrics={metrics} animated={animated} />;
  }
  if (id === "inn2") {
    return <InnovationTwoArchitectureSvg metrics={metrics} animated={animated} />;
  }
  return <InnovationThreeArchitectureSvg metrics={metrics} animated={animated} />;
}

function stopReasonReadable(stopReason: string | null): string {
  if (!stopReason) return "审校流转闭环校验中";
  if (stopReason === "REVIEWS_COMPLETE") return "双对抗审计一致收敛放行 (REVIEWS_COMPLETE)";
  if (stopReason === "REVISE_REJECTED") return "防退化双锁拦截降级微修，保留最优候选 (REVISE_REJECTED)";
  if (stopReason === "REVIEW_STOP") return "审查门控按界止步并保留已验候选 (REVIEW_STOP)";
  if (stopReason === "NO_CANDIDATE") return "未闭合充分证据，如实拒答交付边界 (NO_CANDIDATE)";
  return `终态裁决码: ${stopReason}`;
}

export function InnovationOverviewPipeline({
  viewModel,
  metrics,
  expandedIds,
  onToggleExpand,
}: InnovationOverviewPipelineProps) {
  const isRunning = viewModel.mode === "running";
  const statuses: readonly InnovationPhaseStatus[] = [
    metrics.inn1Status,
    metrics.inn2Status,
    metrics.inn3Status,
  ];
  const { taskDag, routing, controlPlane } = metrics.projection;
  const matchedDims = routing.dimensions.filter((d) => d.matched);

  const spineSteps = [
    {
      code: "00",
      title: "题目输入",
      detail: `${taskDag.goalMeta.kind} · 原题入栈`,
      active: true,
      done: true,
      color: "#6366f1",
    },
    {
      code: "01",
      title: "创新点一 · 契约调度",
      detail: `${taskDag.tasks.length} 义务 DAG · R0 ${metrics.r0DoneCount}/3 · 命中 ${routing.matchedCount} 维`,
      active: metrics.inn1Status === "active",
      done: metrics.inn1Status === "completed",
      color: "#3b82f6",
    },
    {
      code: "02",
      title: "创新点二 · 协同取证",
      detail:
        metrics.topCandidateText
          ? `${metrics.topCandidateText.slice(0, 14)} (${metrics.topCandidateVotes}票) · ${metrics.toolCount} 资产`
          : `${metrics.ballotCount > 0 ? metrics.ballotCount : 5} 盲解 · ${metrics.toolCount} 算子`,
      active: metrics.inn2Status === "active",
      done: metrics.inn2Status === "completed",
      color: "#38bdf8",
    },
    {
      code: "03",
      title: "创新点三 · 校验交付",
      detail: `${metrics.eventCount} 帧溯源 · 审${controlPlane.reviewCount}/修${controlPlane.repairAttempts}`,
      active: metrics.inn3Status === "active",
      done: metrics.inn3Status === "completed",
      color: "#10b981",
    },
    {
      code: "04",
      title: "得出结果",
      detail:
        metrics.isTerminal && metrics.answerHeadline
          ? `候选: ${metrics.answerHeadline.slice(0, 18)}`
          : "收敛汇总中…",
      active: !metrics.isTerminal && metrics.inn3Status === "active",
      done: metrics.isTerminal,
      color: "#10b981",
    },
  ];

  return (
    <section
      className="zygos-glass zygos-animate-in"
      aria-label="三大核心创新点系统总览舞台"
      style={{
        borderRadius: "20px",
        padding: "18px 20px 20px",
        border: isRunning
          ? "1.5px solid var(--color-brand-ring)"
          : "1px solid var(--color-line-strong)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      {/* 1. 输入命题展示 + 实测规模摘要 */}
      <div
        style={{
          borderRadius: "14px",
          padding: "13px 16px",
          backgroundColor: "var(--color-surface-sunken)",
          border: "1px solid var(--color-line)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "3px 10px",
                borderRadius: "999px",
                fontSize: "11px",
                fontWeight: 700,
                backgroundColor: "var(--color-brand-tint)",
                color: "var(--color-brand-deep)",
                border: "1px solid var(--color-brand-ring)",
              }}
            >
              <FileText size={12} />
              <span>题目输入</span>
            </span>
            <span style={{ fontSize: "12px", color: "var(--color-ink-mute)", fontWeight: 500 }}>
              从题目输入触发「创新点一 ➔ 创新点二 ➔ 创新点三」串行接力，实时收敛出候选结论
            </span>
          </div>

          <div
            className="zygos-tabular"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              fontSize: "11.5px",
              color: "var(--color-ink-mute)",
            }}
          >
            <span>
              目标契约: <strong style={{ color: "var(--color-ink)" }}>{taskDag.goalMeta.kind}</strong>
            </span>
            <span>
              模型调用: <strong style={{ color: "var(--color-ink)" }}>{metrics.modelCallCount}</strong>
            </span>
            <span>
              记录事件: <strong style={{ color: "var(--color-ink)" }}>{metrics.eventCount}</strong> 帧
            </span>
          </div>
        </div>

        <div style={{ fontSize: "13.5px", color: "var(--color-ink)", lineHeight: 1.55 }}>
          <MathMarkdown content={viewModel.problem || "（暂无题面文本）"} compact />
        </div>
      </div>

      {/* 2. 解题全链路串联导轨（输入 -> 创新一 -> 创新二 -> 创新三 -> 得出结果） */}
      <div
        style={{
          borderRadius: "14px",
          padding: "10px 12px",
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-line)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: "8px",
        }}
      >
        {spineSteps.map((step, i) => (
          <div
            key={step.code}
            style={{
              position: "relative",
              padding: "8px 10px",
              borderRadius: "10px",
              backgroundColor: step.active
                ? `${step.color}18`
                : step.done
                  ? "var(--color-surface-sunken)"
                  : "transparent",
              border: step.active
                ? `1.5px solid ${step.color}`
                : step.done
                  ? `1px solid ${step.color}55`
                  : "1px dashed var(--color-line)",
              display: "flex",
              flexDirection: "column",
              gap: "3px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
              <span className="zygos-tabular" style={{ fontSize: "11px", fontWeight: 800, color: step.color }}>
                {step.code} · {step.title}
              </span>
              {i < spineSteps.length - 1 && (
                <ArrowRight size={12} color={step.done || step.active ? step.color : "var(--color-ink-mute)"} />
              )}
            </div>
            <div
              className="zygos-tabular"
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--color-ink-soft)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={step.detail}
            >
              {step.detail}
            </div>
          </div>
        ))}
      </div>

      {/* 3. 三大核心创新点动态串联舞台（带卡间流动接力箭头 + 本题实时推演过程） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "8px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg, #2563eb 0%, #38bdf8 50%, #10b981 100%)",
              color: "#ffffff",
            }}
          >
            <Layers size={14} />
          </span>
          <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-ink)" }}>
            三大核心创新点总览与本题求解串联过程
          </h2>
        </div>
        <span style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>
          每项均展示「本题实时串联过程 + 总机制动图」；下方折叠区支持横向展开 3 大子机理动图
        </span>
      </div>

      <div className="zygos-pipeline-3col">
        {THREE_INNOVATION_SPECS.map((spec, idx) => {
          const st = statuses[idx];
          const pill = getMacroStatusMeta(st);
          const isExpanded = expandedIds.has(spec.id);
          const isAnimated = isRunning ? st === "active" || st === "completed" : st !== "pending";

          return (
            <div key={spec.id} style={{ display: "contents" }}>
              <div
                className="zygos-spring-card"
                style={{
                  borderRadius: "16px",
                  border:
                    st === "active"
                      ? `1.5px solid ${spec.accentColor}`
                      : isExpanded
                        ? "1.5px solid var(--color-brand-ring)"
                        : "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface)",
                  boxShadow:
                    st === "active"
                      ? `0 12px 30px -14px ${spec.accentColor}`
                      : "var(--shadow-card)",
                  padding: "14px 15px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: "10px",
                  minWidth: 0,
                }}
              >
                {/* Header */}
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      marginBottom: "6px",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "2px 9px",
                        borderRadius: "999px",
                        fontSize: "11px",
                        fontWeight: 700,
                        backgroundColor: `${spec.accentColor}20`,
                        color: spec.accentColor,
                        border: `1px solid ${spec.accentColor}55`,
                      }}
                    >
                      {spec.index === 1 && <GitBranch size={11} />}
                      {spec.index === 2 && <Cpu size={11} />}
                      {spec.index === 3 && <ShieldCheck size={11} />}
                      <span>{spec.shortName}</span>
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "2px 8px",
                        borderRadius: "999px",
                        fontSize: "10.5px",
                        fontWeight: 700,
                        backgroundColor: pill.bg,
                        color: pill.color,
                        border: `1px solid ${pill.border}`,
                      }}
                    >
                      {st === "active" && (
                        <span
                          className="zygos-live-dot"
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            backgroundColor: spec.accentColor,
                          }}
                        />
                      )}
                      {pill.label}
                    </span>
                  </div>

                  <div
                    className="zygos-heading-balance"
                    style={{
                      fontSize: "13.5px",
                      fontWeight: 700,
                      color: "var(--color-ink)",
                      lineHeight: 1.38,
                      marginBottom: "2px",
                    }}
                  >
                    {spec.title}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>
                    {spec.slogan}
                  </div>
                </div>

                {/* Macro Animated Architecture Diagram */}
                <div
                  className="zygos-blueprint-canvas"
                  style={{
                    borderRadius: "11px",
                    border: "1px solid var(--color-line)",
                    padding: "6px 7px",
                  }}
                >
                  <MacroOverviewGraphic
                    id={spec.id}
                    accent={spec.accentColor}
                    animated={isAnimated || !isRunning}
                    metrics={metrics}
                  />
                </div>

                {/* 本题实时解题串联实录（把当前题在每一步做了什么、产出了什么接力数据说清楚） */}
                <div
                  style={{
                    borderRadius: "11px",
                    padding: "9px 11px",
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "7px",
                    flex: 1,
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: spec.accentColor,
                      display: "flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    <Sparkles size={11} />
                    <span>本题实时推演串联</span>
                  </div>

                  {spec.id === "inn1" && (
                    <>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                        {taskDag.tasks.slice(0, 4).map((t) => {
                          const done = t.status === "completed";
                          return (
                            <span
                              key={t.taskId}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "3px",
                                padding: "2px 6px",
                                borderRadius: "6px",
                                fontSize: "10.5px",
                                fontWeight: 600,
                                backgroundColor: done
                                  ? "var(--color-state-success-bg)"
                                  : "var(--color-surface)",
                                border: `1px solid ${done ? "var(--color-state-success-border)" : "var(--color-line)"}`,
                                color: done ? "var(--color-state-success)" : "var(--color-ink-soft)",
                              }}
                            >
                              <CheckCircle2 size={10} />
                              <span>{t.title}</span>
                            </span>
                          );
                        })}
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "4px" }}>
                        {(metrics.r0Agents.length > 0
                          ? metrics.r0Agents
                          : [
                              { role: "MEANING", title: "题意", verdict: metrics.r0DoneCount >= 1 ? "NO_ISSUE" : null },
                              { role: "METHOD", title: "方法域", verdict: metrics.r0DoneCount >= 2 ? "NO_ISSUE" : null },
                              { role: "TASK_TOOL", title: "工具覆盖", verdict: metrics.r0DoneCount >= 3 ? "NO_ISSUE" : null },
                            ]
                        ).map((ag) => (
                          <div
                            key={ag.role}
                            style={{
                              padding: "3px 5px",
                              borderRadius: "6px",
                              backgroundColor: "var(--color-surface)",
                              border: "1px solid var(--color-line)",
                              fontSize: "10px",
                              textAlign: "center",
                            }}
                          >
                            <div style={{ color: "var(--color-ink-mute)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {ag.title.replace("审查", "")}
                            </div>
                            <div style={{ fontWeight: 700, color: ag.verdict === "NO_ISSUE" ? "var(--color-state-success)" : "var(--color-brand-deep)" }}>
                              {ag.verdict === "UNKNOWN"
                                ? "已审完"
                                : ag.verdict || (isRunning ? "并行审阅" : "就绪")}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.45 }}>
                        <Radar size={11} color="#3b82f6" style={{ verticalAlign: "-2px", marginRight: "4px" }} />
                        命中特征：
                        <strong style={{ color: "var(--color-ink)" }}>
                          {matchedDims.length > 0
                            ? matchedDims.slice(0, 2).map((d) => d.title).join(" · ")
                            : "通用稳健模板"}
                        </strong>
                        <span style={{ color: spec.accentColor, fontWeight: 700 }}>
                          {" "}
                          ➔ 传出 {taskDag.tasks.length} 义务 DAG
                        </span>
                      </div>
                    </>
                  )}

                  {spec.id === "inn2" && (
                    <>
                      {/* Vote groups live bar */}
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        {metrics.voteGroups.length > 0 ? (
                          metrics.voteGroups.slice(0, 2).map((vg) => {
                            const pct =
                              metrics.ballotCount > 0
                                ? Math.max(18, Math.round((vg.count / metrics.ballotCount) * 100))
                                : 100;
                            return (
                              <div key={vg.key}>
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10.5px", marginBottom: "2px" }}>
                                  <span style={{ fontWeight: 700, color: vg.isFrontRunner ? "var(--color-state-success)" : "var(--color-ink-soft)", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    候选：{vg.displayPlain}
                                  </span>
                                  <span className="zygos-tabular" style={{ fontWeight: 700, color: "var(--color-ink)" }}>
                                    {vg.count} 票
                                  </span>
                                </div>
                                <div style={{ height: "6px", borderRadius: "999px", backgroundColor: "var(--color-surface)", overflow: "hidden" }}>
                                  <div
                                    style={{
                                      width: `${pct}%`,
                                      height: "100%",
                                      borderRadius: "999px",
                                      background: vg.isFrontRunner
                                        ? "linear-gradient(90deg, #3b82f6, #10b981)"
                                        : "#6366f1",
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>
                            5 路盲解正从直接推导/逆向/换路等视角独立求解…
                          </div>
                        )}
                      </div>

                      {/* Real tool receipts + Dual Audit & CERT1 status */}
                      <div
                        style={{
                          padding: "5px 8px",
                          borderRadius: "7px",
                          backgroundColor: "var(--color-surface)",
                          border: "1px solid var(--color-line)",
                          fontSize: "10.5px",
                          color: "var(--color-ink-soft)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "3px",
                        }}
                      >
                        {routing.toolReceipts.length > 0 && (() => {
                          const bestTool =
                            routing.toolReceipts.find((tr) => Boolean(tr.valuePreview)) ??
                            routing.toolReceipts.find((tr) => tr.toolName !== "math_asset") ??
                            routing.toolReceipts[0];
                          return (
                            <div>
                              <span style={{ fontWeight: 700, color: "var(--color-state-success)" }}>
                                算子取证：
                              </span>
                              <span style={{ fontFamily: "var(--font-mono)" }}>
                                {bestTool.valuePreview || bestTool.toolName}
                              </span>
                              {bestTool.sourceInputHash && (
                                <span style={{ color: "var(--color-ink-mute)", fontFamily: "var(--font-mono)" }}>
                                  {" "}
                                  (#{bestTool.sourceInputHash.slice(0, 6)})
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        <div>
                          双对抗审计 {metrics.auditCount} 路 · CERT1 {metrics.certObserved ? "已核验" : "待汇聚"}
                        </div>
                      </div>

                      <div style={{ fontSize: "11px", color: "var(--color-ink-soft)" }}>
                        <span style={{ color: spec.accentColor, fontWeight: 700 }}>
                          ➔ 传出领先候选
                          {metrics.topCandidateText ? `「${metrics.topCandidateText.slice(0, 14)}」` : ""}
                          及取证回执
                        </span>
                      </div>
                    </>
                  )}

                  {spec.id === "inn3" && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "5px" }}>
                        <div style={{ padding: "4px 7px", borderRadius: "6px", backgroundColor: "var(--color-surface)", border: "1px solid var(--color-line)", fontSize: "10.5px" }}>
                          <div style={{ color: "var(--color-ink-mute)", fontSize: "9.5px" }}>链式溯源日志</div>
                          <div className="zygos-tabular" style={{ fontWeight: 700, color: "var(--color-ink)" }}>
                            {metrics.eventCount} 帧只增账本
                          </div>
                        </div>
                        <div style={{ padding: "4px 7px", borderRadius: "6px", backgroundColor: "var(--color-surface)", border: "1px solid var(--color-line)", fontSize: "10.5px" }}>
                          <div style={{ color: "var(--color-ink-mute)", fontSize: "9.5px" }}>R2/R4 审修计数</div>
                          <div className="zygos-tabular" style={{ fontWeight: 700, color: "#f59e0b" }}>
                            审查 {controlPlane.reviewCount} · 修复 {controlPlane.repairAttempts}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          padding: "5px 8px",
                          borderRadius: "7px",
                          backgroundColor: "var(--color-surface)",
                          border: "1px solid var(--color-line)",
                          fontSize: "10.5px",
                          color: "var(--color-ink-soft)",
                          lineHeight: 1.45,
                        }}
                      >
                        {stopReasonReadable(metrics.stopReason)}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", fontSize: "11px" }}>
                        <span style={{ fontWeight: 700, color: "var(--color-state-candidate)" }}>
                          红线 Verified=false
                        </span>
                        <span style={{ fontWeight: 700, color: "var(--color-state-success)" }}>
                          {metrics.isTerminal && metrics.answerHeadline
                            ? `➔ 交付答案: ${metrics.answerHeadline.slice(0, 14)}`
                            : "➔ 准备终态交卷"}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                {/* Expand Action */}
                <button
                  type="button"
                  onClick={() => onToggleExpand(spec.id)}
                  className="zygos-btn-ghost"
                  style={{
                    width: "100%",
                    justifyContent: "space-between",
                    padding: "6px 10px",
                    fontSize: "11.5px",
                    borderRadius: "9px",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                    <ArrowRight size={12} color={spec.accentColor} />
                    <span>{isExpanded ? "收起 3 块机制动图" : "展开 3 块机制动图"}</span>
                  </span>
                  {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              </div>

              {idx === 0 && (
                <FlowBridgeArrow
                  active={metrics.inn1Status !== "pending"}
                  accentFrom="#3b82f6"
                  accentTo="#38bdf8"
                />
              )}
              {idx === 1 && (
                <FlowBridgeArrow
                  active={metrics.inn2Status !== "pending"}
                  accentFrom="#38bdf8"
                  accentTo="#10b981"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 4. 底部串联汇聚出口：三大创新点 ➔ 得出最终答案 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "10px",
          paddingTop: "4px",
        }}
      >
        <div style={{ height: "1px", flex: 1, background: "linear-gradient(90deg, transparent, var(--color-line-strong))" }} />
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "7px",
            padding: "4px 14px",
            borderRadius: "999px",
            backgroundColor: metrics.isTerminal ? "var(--color-state-success-bg)" : "var(--color-brand-tint)",
            border: `1px solid ${metrics.isTerminal ? "var(--color-state-success-border)" : "var(--color-brand-ring)"}`,
            fontSize: "11.5px",
            fontWeight: 700,
            color: metrics.isTerminal ? "var(--color-state-success)" : "var(--color-brand-deep)",
          }}
        >
          <ArrowDown size={13} />
          <span>
            {metrics.isTerminal && metrics.answerHeadline
              ? `三大创新机制接力完成 · 得出最终候选结论：${metrics.answerHeadline.slice(0, 26)}`
              : "三大创新机制实时接力 · 收敛后将在下方直接呈现候选结果"}
          </span>
        </div>
        <div style={{ height: "1px", flex: 1, background: "linear-gradient(90deg, var(--color-line-strong), transparent)" }} />
      </div>
    </section>
  );
}
