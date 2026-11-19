import { useMemo, useState } from "react";
import {
  Activity,
  Award,
  CheckCircle2,
  Cpu,
  EyeOff,
  FileCheck2,
  GitBranch,
  Layers,
  Lock,
  Network,
  Radar,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import type {
  MacroStageId,
  MultiAgentAuditView,
  MultiAgentBallotView,
  MultiAgentSolvingView,
  R0RoleAgentView,
  ResearchViewModel,
  ThreeAgentReadingView,
} from "../../../domain/research/types";
import { toPlainAnswerText } from "../../../domain/research/plainAnswer";
import {
  extractInnovationsProjection,
  type TaskDagNodeView,
} from "../../../domain/research/innovations";

interface MultiAgentSynergyStageProps {
  viewModel: ResearchViewModel;
  r0Reading?: ThreeAgentReadingView;
  multiAgentSolving?: MultiAgentSolvingView;
  activeStage: MacroStageId;
  isRunning: boolean;
  problemText?: string;
  onSelectNode: (nodeId: string) => void;
}

type StageFilter = "all" | "dag" | "r0" | "consensus" | "assets";

const CANONICAL_BLIND_SLOTS = [
  { index: 1, title: "盲解 #1 · 直接推导", shortDesc: "沿原始命题条件独立展开完整推演" },
  { index: 2, title: "盲解 #2 · 对偶变换", shortDesc: "换元或等价代数/几何结构重写重算" },
  { index: 3, title: "盲解 #3 · 反例边界", shortDesc: "优先试探退化极限与构造潜在反例" },
  { index: 4, title: "盲解 #4 · 不变量模验", shortDesc: "借助守恒量、对称性与商空间交叉核算" },
  { index: 5, title: "盲解 #5 · 逆向回代", shortDesc: "从候选结果反向代回原约束验证唯一性" },
] as const;

function formatLatency(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "--";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function getR0RoleIcon(role: R0RoleAgentView["role"]) {
  if (role === "MEANING") return <FileCheck2 size={14} />;
  if (role === "METHOD") return <Scale size={14} />;
  return <Wrench size={14} />;
}

function renderCompactVerdict(agent: R0RoleAgentView) {
  if (agent.status === "running") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "1px 7px",
          borderRadius: "999px",
          fontSize: "10.5px",
          fontWeight: 700,
          backgroundColor: "var(--color-brand-tint)",
          color: "var(--color-brand-deep)",
          border: "1px solid var(--color-brand-ring)",
        }}
      >
        <span
          className="zygos-live-dot"
          style={{ width: "5px", height: "5px", borderRadius: "50%", backgroundColor: "var(--color-brand-deep)" }}
        />
        并行审阅中
      </span>
    );
  }
  if (agent.verdict === "NO_ISSUE") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "3px",
          padding: "1px 7px",
          borderRadius: "999px",
          fontSize: "10.5px",
          fontWeight: 700,
          backgroundColor: "var(--color-state-candidate-bg)",
          color: "var(--color-state-candidate)",
          border: "1px solid var(--color-state-candidate-border)",
        }}
      >
        <CheckCircle2 size={11} />
        NO_ISSUE
      </span>
    );
  }
  if (agent.verdict === "ISSUES") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "3px",
          padding: "1px 7px",
          borderRadius: "999px",
          fontSize: "10.5px",
          fontWeight: 700,
          backgroundColor: "var(--color-state-error-bg)",
          color: "var(--color-state-error)",
          border: "1px solid var(--color-state-error-border)",
        }}
      >
        <ShieldAlert size={11} />
        ISSUES ({agent.issueCount || 1})
      </span>
    );
  }
  if (agent.verdict === "UNKNOWN") {
    return (
      <span
        style={{
          padding: "1px 7px",
          borderRadius: "999px",
          fontSize: "10.5px",
          fontWeight: 700,
          backgroundColor: "var(--color-surface-sunken)",
          color: "var(--color-ink-soft)",
          border: "1px solid var(--color-line)",
        }}
      >
        UNKNOWN
      </span>
    );
  }
  if (agent.status === "completed") {
    return (
      <span
        style={{
          padding: "1px 7px",
          borderRadius: "999px",
          fontSize: "10.5px",
          fontWeight: 600,
          backgroundColor: "var(--color-surface-sunken)",
          color: "var(--color-ink-soft)",
          border: "1px solid var(--color-line)",
        }}
      >
        已调用
      </span>
    );
  }
  return (
    <span
      style={{
        padding: "1px 7px",
        borderRadius: "999px",
        fontSize: "10.5px",
        fontWeight: 600,
        backgroundColor: "var(--color-surface-sunken)",
        color: "var(--color-ink-mute)",
        border: "1px solid var(--color-line)",
      }}
    >
      未触发
    </span>
  );
}

function PortDot({
  side,
  color,
  active = true,
}: {
  side: "left" | "right";
  color: string;
  active?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: "50%",
        left: side === "left" ? "0px" : undefined,
        right: side === "right" ? "0px" : undefined,
        transform: side === "left" ? "translate(-50%, -50%)" : "translate(50%, -50%)",
        width: "8px",
        height: "8px",
        borderRadius: "999px",
        backgroundColor: active ? color : "var(--color-surface)",
        border: `2px solid ${active ? "#ffffff" : "var(--color-line-strong)"}`,
        boxShadow: active ? `0 0 0 2px color-mix(in oklab, ${color} 35%, transparent)` : "none",
        pointerEvents: "none",
        zIndex: 3,
      }}
    />
  );
}

function getConsensusBadgeText(maxConsensusBudget: number | null): string {
  if (maxConsensusBudget === null) return "默认调度配额";
  if (maxConsensusBudget >= 8) return `5+2+1 满血并行集群 (配额=${maxConsensusBudget})`;
  if (maxConsensusBudget >= 2) {
    const blind = Math.max(0, maxConsensusBudget - 3);
    const audit = Math.min(2, Math.max(0, maxConsensusBudget - 1 - blind));
    return `受控协同集群 (${blind} 盲解 + ${audit} 审计 + CERT1)`;
  }
  if (maxConsensusBudget === 1) return "轻量自检模式 (maxConsensus=1 · Seed + CERT1 + 闭环)";
  return "未启用多 Agent 共识 (maxConsensus=0)";
}

export function MultiAgentSynergyStage({
  viewModel,
  r0Reading,
  multiAgentSolving,
  activeStage,
  isRunning,
  problemText,
  onSelectNode,
}: MultiAgentSynergyStageProps) {
  const [filter, setFilter] = useState<StageFilter>("all");
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [hoveredR0, setHoveredR0] = useState<number | null>(null);
  const [hoveredLane, setHoveredLane] = useState<number | null>(null);
  const [hoveredAudit, setHoveredAudit] = useState<number | null>(null);

  const innovations = useMemo(() => extractInnovationsProjection(viewModel), [viewModel]);
  const { taskDag, routing, controlPlane } = innovations;

  const inFlight = multiAgentSolving?.inFlightRequests ?? [];
  const plainExcerpt = (problemText || viewModel.problem)
    ? toPlainAnswerText(problemText || viewModel.problem, { singleLine: true }).slice(0, 60)
    : "当前数学命题";

  // ------------------------------------------------------------------
  // Layout Geometry 1: Task Decomposition DAG (M1 -> Parallel Tasks -> Outputs)
  // ------------------------------------------------------------------
  const layer1Tasks = taskDag.tasks.filter((t) => t.layer === 1);
  const layer2Tasks = taskDag.tasks.filter((t) => t.layer === 2);
  const layer3Tasks = taskDag.tasks.filter((t) => t.layer === 3);
  const hasLayer2 = layer2Tasks.length > 0;
  const maxDagRows = Math.max(1, layer1Tasks.length, layer2Tasks.length, layer3Tasks.length);
  const taskBoxH = 52;
  const taskGap = 10;
  const dagH = Math.max(246, maxDagRows * (taskBoxH + taskGap) + 28);

  const taskPosMap = new Map<
    string,
    {
      task: TaskDagNodeView;
      leftPct: number;
      widthPct: number;
      leftX: number;
      rightX: number;
      topPx: number;
      cy: number;
    }
  >();

  const placeColumn = (list: TaskDagNodeView[], leftPct: number, widthPct: number) => {
    const n = list.length;
    if (n === 0) return;
    const totalH = n * taskBoxH + (n - 1) * taskGap;
    const startY = (dagH - totalH) / 2;
    list.forEach((task, i) => {
      const topPx = startY + i * (taskBoxH + taskGap);
      taskPosMap.set(task.taskId, {
        task,
        leftPct,
        widthPct,
        leftX: Math.round(leftPct * 10),
        rightX: Math.round((leftPct + widthPct) * 10),
        topPx,
        cy: Math.round(topPx + taskBoxH / 2),
      });
    });
  };

  if (hasLayer2) {
    placeColumn(layer1Tasks, 24, 24);
    placeColumn(layer2Tasks, 54, 21);
    placeColumn(layer3Tasks, 80, 18.5);
  } else {
    placeColumn(layer1Tasks, 28, 34);
    placeColumn(layer3Tasks, 71, 27);
  }
  const goalRightX = hasLayer2 ? 175 : 190;
  const goalWidthPct = hasLayer2 ? 16 : 17.5;

  // ------------------------------------------------------------------
  // Layout Geometry 2: R0 3-Agent Parallel Fork-Join
  // ------------------------------------------------------------------
  const r0LaneCenters = [51, 139, 227] as const;
  const r0DoneCount = r0Reading
    ? r0Reading.agents.filter((a) => a.status === "completed" || a.status === "failed").length
    : 0;
  const r0Active = r0DoneCount > 0 || r0Reading?.status === "running";

  // ------------------------------------------------------------------
  // Layout Geometry 3: Multi-Agent 5+2+1 Parallel Cluster
  // ------------------------------------------------------------------
  const ballots = multiAgentSolving?.ballots ?? [];
  const seedBallot = ballots.find((b) => b.kind === "SEED");
  const independentBallots = ballots.filter((b) => b.kind === "INDEPENDENT");
  const voteGroups = multiAgentSolving?.voteGroups ?? [];
  const audits = multiAgentSolving?.audits ?? [];
  const cert = multiAgentSolving?.certificate;
  const closure = multiAgentSolving?.closure;
  const methodRoutes = multiAgentSolving?.methodRoutes ?? [];
  const maxCons = multiAgentSolving?.maxConsensusBudget ?? null;
  const budgetedBlindCount =
    maxCons === null ? 0 : maxCons >= 8 ? maxCons - 3 : maxCons >= 2 ? 1 : 0;
  const auditsEnabled = maxCons !== null && maxCons >= 2;
  const consensusRunning = isRunning && inFlight.some((r) => r.phase === "CONSENSUS");

  const laneTops = [12, 74, 136, 198, 260, 322] as const;
  const laneCenters = [39, 101, 163, 225, 287, 349] as const;
  const auditTops = [72, 220] as const;
  const auditCenters = [125, 273] as const;

  const laneEntries: {
    slotIdx: number;
    title: string;
    subtitle: string;
    ballot?: MultiAgentBallotView;
    isExecuted: boolean;
    isInFlight: boolean;
    isBudgeted: boolean;
  }[] = [
    {
      slotIdx: 0,
      title: "Seed · 主路径首解",
      subtitle: "基于规划合同与数学工具观测生成",
      ballot: seedBallot,
      isExecuted: Boolean(seedBallot),
      isInFlight: false,
      isBudgeted: true,
    },
    ...CANONICAL_BLIND_SLOTS.map((slot, idx) => {
      const matched =
        independentBallots.find((b) => b.index === slot.index) ?? independentBallots[idx];
      const isBudgeted = slot.index <= budgetedBlindCount;
      const isNextInFlight =
        consensusRunning && !matched && idx === independentBallots.length && isBudgeted;
      return {
        slotIdx: slot.index,
        title: matched?.lensTitle ? `盲解 #${slot.index} · ${matched.lensTitle}` : slot.title,
        subtitle: slot.shortDesc,
        ballot: matched,
        isExecuted: Boolean(matched),
        isInFlight: isNextInFlight,
        isBudgeted,
      };
    }),
  ];

  const hasAnyBallot = ballots.length > 0;
  const totalVotedBallots = ballots.filter((b) => Boolean(b.candidateRaw)).length;

  return (
    <section
      className="zygos-glass zygos-reveal-item"
      aria-label="代码实证创新工作台"
      style={{
        borderRadius: "20px",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        border: "1px solid var(--color-line-strong)",
      }}
    >
      {/* 顶部控制台：标题 + Segmented Switcher */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "10px",
              background: "linear-gradient(135deg, #2563eb 0%, #6366f1 100%)",
              color: "#ffffff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 12px rgba(37, 99, 235, 0.25)",
            }}
          >
            <Sparkles size={16} />
          </span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-ink)" }}>
                代码实证创新拓扑台 · 契约 DAG × 并行协同 × 结构路由
              </h2>
              {isRunning && inFlight.length > 0 && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "2px 9px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 700,
                    backgroundColor: "var(--color-brand-tint)",
                    color: "var(--color-brand-deep)",
                    border: "1px solid var(--color-brand-ring)",
                  }}
                >
                  <span
                    className="zygos-live-dot"
                    style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--color-brand-deep)" }}
                  />
                  活跃分支: {inFlight[inFlight.length - 1]?.phase} ({inFlight[inFlight.length - 1]?.requestId})
                </span>
              )}
            </div>
            <p style={{ margin: "2px 0 0", fontSize: "11.5px", color: "var(--color-ink-soft)" }}>
              忠实呈现 M1 任务依赖 DAG、R0 三方并行读题、5+2+1 多路协同集群、8 维结构签名与 26 项统一数学计算资产取证
            </p>
          </div>
        </div>

        <div className="zygos-segmented" role="tablist" aria-label="核心创新模块切换">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            data-active={filter === "all"}
            className="zygos-segmented-btn"
            onClick={() => setFilter("all")}
          >
            <Layers size={13} />
            <span>创新全景</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "dag"}
            data-active={filter === "dag"}
            className="zygos-segmented-btn"
            onClick={() => setFilter("dag")}
          >
            <Network size={13} />
            <span>任务 DAG</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "r0"}
            data-active={filter === "r0"}
            className="zygos-segmented-btn"
            onClick={() => setFilter("r0")}
          >
            <FileCheck2 size={13} />
            <span>3-Agent 读题</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "consensus"}
            data-active={filter === "consensus"}
            className="zygos-segmented-btn"
            onClick={() => setFilter("consensus")}
          >
            <GitBranch size={13} />
            <span>5+2+1 并行</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "assets"}
            data-active={filter === "assets"}
            className="zygos-segmented-btn"
            onClick={() => setFilter("assets")}
          >
            <Radar size={13} />
            <span>结构路由 & 资产</span>
          </button>
        </div>
      </div>

      {/* 顶部 4 枚互动机理汇总徽章 */}
      <div
        className="zygos-tabular"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: "10px",
        }}
      >
        <button
          type="button"
          onClick={() => setFilter(filter === "dag" ? "all" : "dag")}
          className="zygos-spring-card"
          style={{
            textAlign: "left",
            padding: "9px 12px",
            borderRadius: "12px",
            border: `1px solid ${filter === "dag" ? "var(--color-brand-ring)" : "var(--color-line)"}`,
            backgroundColor: "var(--color-surface)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontWeight: 600 }}>① M1 契约与任务 DAG</div>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-ink)", marginTop: "1px" }}>
              {taskDag.goalMeta.kind} · {taskDag.tasks.length} 义务节点
            </div>
          </div>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            已交付 {taskDag.executedArtifactCount} 产物
          </span>
        </button>

        <button
          type="button"
          onClick={() => setFilter(filter === "r0" ? "all" : "r0")}
          className="zygos-spring-card"
          style={{
            textAlign: "left",
            padding: "9px 12px",
            borderRadius: "12px",
            border: `1px solid ${filter === "r0" ? "var(--color-brand-ring)" : "var(--color-line)"}`,
            backgroundColor: "var(--color-surface)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontWeight: 600 }}>② R0 三-Agent 并行读题</div>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-ink)", marginTop: "1px" }}>
              {r0DoneCount}/3 隔离角色 · 合同 v{taskDag.contractVersion}
            </div>
          </div>
          <span style={{ fontSize: "11px", fontWeight: 700, color: r0Reading?.revisionTriggered ? "var(--color-state-error)" : "var(--color-state-candidate)" }}>
            {r0Reading?.aggregateConclusion ?? (isRunning ? "待汇总" : "未执行")}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setFilter(filter === "consensus" ? "all" : "consensus")}
          className="zygos-spring-card"
          style={{
            textAlign: "left",
            padding: "9px 12px",
            borderRadius: "12px",
            border: `1px solid ${filter === "consensus" ? "var(--color-brand-ring)" : "var(--color-line)"}`,
            backgroundColor: "var(--color-surface)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontWeight: 600 }}>③ 5+2+1 多-Agent 并行</div>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-ink)", marginTop: "1px" }}>
              {ballots.length} 选票 · {audits.length} 审计 · CERT1
            </div>
          </div>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-state-candidate)" }}>
            配额 {maxCons ?? "--"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setFilter(filter === "assets" ? "all" : "assets")}
          className="zygos-spring-card"
          style={{
            textAlign: "left",
            padding: "9px 12px",
            borderRadius: "12px",
            border: `1px solid ${filter === "assets" ? "var(--color-brand-ring)" : "var(--color-line)"}`,
            backgroundColor: "var(--color-surface)",
            cursor: "pointer",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontWeight: 600 }}>④ 8 维结构签名 × 26 资产</div>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-ink)", marginTop: "1px" }}>
              命中 {routing.matchedCount}/8 维 · {routing.toolReceipts.length} 取证
            </div>
          </div>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "#6366f1" }}>
            {routing.totalCatalogBehaviors}  catalog 行为
          </span>
        </button>
      </div>

      {/* =================================================================
          第一行双栏（全景下并排）：左 Task DAG  |  右 8 维结构签名 & 资产控制面
      ================================================================= */}
      {(filter === "all" || filter === "dag" || filter === "assets") && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              filter === "all" ? "repeat(auto-fit, minmax(480px, 1fr))" : "1fr",
            gap: "14px",
          }}
        >
          {/* 模块 ①：M1 契约拆解 & 任务依赖 DAG */}
          {(filter === "all" || filter === "dag") && (
            <div
              className="zygos-blueprint-canvas"
              style={{
                borderRadius: "16px",
                border: "1px solid var(--color-line)",
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: "7px",
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: "rgba(99, 102, 241, 0.12)",
                      color: "#6366f1",
                      border: "1px solid rgba(99, 102, 241, 0.3)",
                    }}
                  >
                    ① M1 契约编译 & 任务依赖 DAG
                  </span>
                  <span style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--color-ink)" }}>
                    {taskDag.goalMeta.label}
                  </span>
                </div>
                <span className="zygos-tabular" style={{ fontSize: "10.5px", color: "var(--color-ink-mute)" }}>
                  {taskDag.edges.length} 条 DAG 依赖边 ({taskDag.runtimeDependencyCount} 实证回执)
                </span>
              </div>

              <div style={{ overflowX: "auto" }}>
                <div style={{ position: "relative", minWidth: "520px", height: `${dagH}px` }}>
                  <svg
                    viewBox={`0 0 1000 ${dagH}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      pointerEvents: "none",
                    }}
                  >
                    {/* Goal -> Layer 1 parallel tasks */}
                    {layer1Tasks.map((t) => {
                      const dst = taskPosMap.get(t.taskId);
                      if (!dst) return null;
                      const cyMid = Math.round(dagH / 2);
                      const midX = Math.round((goalRightX + dst.leftX) / 2);
                      const active = t.status === "completed" || t.status === "running";
                      const isHi = hoveredTaskId === null || hoveredTaskId === t.taskId;
                      return (
                        <path
                          key={`g-${t.taskId}`}
                          d={`M ${goalRightX} ${cyMid} C ${midX} ${cyMid}, ${midX} ${dst.cy}, ${dst.leftX} ${dst.cy}`}
                          fill="none"
                          stroke={active ? "#3b82f6" : "#94a3b8"}
                          strokeWidth={hoveredTaskId === t.taskId ? 2.4 : 1.5}
                          strokeOpacity={active ? (isHi ? 0.82 : 0.22) : 0.35}
                          vectorEffect="non-scaling-stroke"
                          className={`zygos-dag-spline ${active ? "zygos-svg-flow" : ""}`}
                        />
                      );
                    })}

                    {/* Task -> Dependent Task edges (compiler + runtime WORKUNIT dependencies) */}
                    {taskDag.edges.map((edge, i) => {
                      const src = taskPosMap.get(edge.fromTaskId);
                      const dst = taskPosMap.get(edge.toTaskId);
                      if (!src || !dst) return null;
                      const midX = Math.round((src.rightX + dst.leftX) / 2);
                      const isRt = edge.source === "runtime_receipt";
                      const isRelated =
                        hoveredTaskId === null ||
                        hoveredTaskId === edge.fromTaskId ||
                        hoveredTaskId === edge.toTaskId;
                      return (
                        <path
                          key={`e-${i}-${edge.fromTaskId}-${edge.toTaskId}`}
                          d={`M ${src.rightX} ${src.cy} C ${midX} ${src.cy}, ${midX} ${dst.cy}, ${dst.leftX} ${dst.cy}`}
                          fill="none"
                          stroke={isRt ? "#10b981" : "#6366f1"}
                          strokeWidth={
                            hoveredTaskId && (hoveredTaskId === edge.fromTaskId || hoveredTaskId === edge.toTaskId)
                              ? 2.5
                              : isRt
                              ? 1.9
                              : 1.4
                          }
                          strokeDasharray={isRt ? undefined : "4 3"}
                          strokeOpacity={isRelated ? (isRt ? 0.88 : 0.6) : 0.16}
                          vectorEffect="non-scaling-stroke"
                          className={`zygos-dag-spline ${isRt ? "zygos-svg-flow" : ""}`}
                        />
                      );
                    })}
                  </svg>

                  {/* Col 0: Goal Root */}
                  <div
                    style={{
                      position: "absolute",
                      left: "1.5%",
                      top: `${Math.round(dagH / 2 - 52)}px`,
                      width: `${goalWidthPct}%`,
                      height: "104px",
                      borderRadius: "13px",
                      border: "1px solid var(--color-line-strong)",
                      backgroundColor: "var(--color-surface)",
                      padding: "9px 10px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      boxShadow: "var(--shadow-card)",
                    }}
                  >
                    <span style={{ fontSize: "11px", fontWeight: 700, color: "#6366f1" }}>
                      goal-1 · v{taskDag.contractVersion}
                    </span>
                    <div style={{ fontSize: "10.5px", color: "var(--color-ink-soft)", lineHeight: 1.4 }}>
                      {taskDag.goalMeta.kind}
                      <br />
                      {taskDag.multipartLabels.length >= 2
                        ? `子问: (${taskDag.multipartLabels.join(")(")})`
                        : "单目标 DAG"}
                    </div>
                    <span style={{ fontSize: "9.5px", fontFamily: "var(--font-mono)", color: "var(--color-ink-mute)" }}>
                      semantic: UNKNOWN
                    </span>
                    <PortDot side="right" color="#3b82f6" active />
                  </div>

                  {/* Layer 1, 2, 3 Task Nodes */}
                  {Array.from(taskPosMap.values()).map((pos) => {
                    const { task } = pos;
                    const done = task.status === "completed";
                    const failed = task.status === "failed";
                    const active = done || task.status === "running";
                    const isHover = hoveredTaskId === task.taskId;

                    return (
                      <button
                        key={task.taskId}
                        type="button"
                        onMouseEnter={() => setHoveredTaskId(task.taskId)}
                        onMouseLeave={() => setHoveredTaskId(null)}
                        onClick={() => task.nodeId && onSelectNode(task.nodeId)}
                        disabled={!task.nodeId}
                        className="zygos-spring-card"
                        style={{
                          position: "absolute",
                          left: `${pos.leftPct}%`,
                          top: `${pos.topPx}px`,
                          width: `${pos.widthPct}%`,
                          height: `${taskBoxH}px`,
                          borderRadius: "11px",
                          border: `1px ${active ? "solid" : "dashed"} ${
                            failed
                              ? "var(--color-state-error-border)"
                              : done
                              ? "var(--color-state-candidate-border)"
                              : isHover
                              ? "var(--color-brand-ring)"
                              : "var(--color-line-strong)"
                          }`,
                          backgroundColor: failed
                            ? "var(--color-state-error-bg)"
                            : "var(--color-surface)",
                          padding: "6px 10px",
                          textAlign: "left",
                          cursor: task.nodeId ? "pointer" : "default",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                        }}
                      >
                        <PortDot side="left" color={done ? "#10b981" : "#3b82f6"} active={active} />
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              color: "var(--color-ink)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {task.title}
                          </span>
                          {task.artifactId ? (
                            <span
                              style={{
                                fontSize: "9.5px",
                                fontFamily: "var(--font-mono)",
                                padding: "0px 5px",
                                borderRadius: "999px",
                                backgroundColor: "var(--color-state-candidate-bg)",
                                color: "var(--color-state-candidate)",
                                flexShrink: 0,
                              }}
                            >
                              {task.artifactId}
                            </span>
                          ) : null}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "9.5px", color: "var(--color-ink-mute)" }}>
                          <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {task.obligationKind}
                          </span>
                          <span style={{ flexShrink: 0 }}>
                            {task.sourceRequestId ??
                              (done
                                ? "DELIVERED"
                                : failed
                                ? "ABORTED"
                                : task.status === "running"
                                ? "RUNNING"
                                : isRunning
                                ? "READY"
                                : "NOT_RUN")}
                          </span>
                        </div>
                        {task.layer !== 3 && (
                          <PortDot side="right" color={done ? "#10b981" : "#6366f1"} active={active} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 模块 ④：8 维数学结构签名 × 26 项统一资产取证与控制面 */}
          {(filter === "all" || filter === "assets") && (
            <div
              className="zygos-blueprint-canvas"
              style={{
                borderRadius: "16px",
                border: "1px solid var(--color-line)",
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "7px",
                    fontSize: "11px",
                    fontWeight: 700,
                    backgroundColor: "var(--color-brand-tint)",
                    color: "var(--color-brand-deep)",
                    border: "1px solid var(--color-brand-ring)",
                  }}
                >
                  ④ 8 维结构签名路由 × {routing.totalCatalogAssets} 资产 / {routing.totalCatalogBehaviors} 行为
                </span>
                <span className="zygos-tabular" style={{ fontSize: "11px", color: "var(--color-ink-soft)" }}>
                  结构命中 {routing.matchedCount}/8 · 工具取证 {routing.toolReceipts.length} 项
                </span>
              </div>

              {/* 8 维结构签名 4x2 矩阵 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))",
                  gap: "7px",
                }}
              >
                {routing.dimensions.map((dim) => (
                  <div
                    key={dim.key}
                    title={dim.hint}
                    style={{
                      padding: "7px 9px",
                      borderRadius: "10px",
                      border: `1px solid ${dim.matched ? "var(--color-state-candidate-border)" : "var(--color-line)"}`,
                      backgroundColor: dim.matched
                        ? "var(--color-state-candidate-bg)"
                        : "var(--color-surface)",
                      opacity: dim.matched ? 1 : 0.65,
                      display: "flex",
                      flexDirection: "column",
                      gap: "2px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                      <span
                        style={{
                          fontSize: "10.5px",
                          fontWeight: 700,
                          color: dim.matched ? "var(--color-state-candidate)" : "var(--color-ink-soft)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {dim.title}
                      </span>
                      <span
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          backgroundColor: dim.matched ? "#10b981" : "var(--color-line-strong)",
                          flexShrink: 0,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: "9.5px",
                        color: "var(--color-ink-mute)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {dim.hint}
                    </div>
                  </div>
                ))}
              </div>

              {/* 结构路由结果 + 真实 Tool Observation 证据卡片 */}
              <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                {(routing.methodRoutes.length > 0 || routing.loadedMethods.length > 0) && (
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontSize: "11px" }}>
                    <span style={{ color: "var(--color-ink-mute)", fontWeight: 600 }}>路由方法栈:</span>
                    {routing.methodRoutes.map((m) => (
                      <span
                        key={m}
                        style={{
                          padding: "2px 8px",
                          borderRadius: "999px",
                          fontFamily: "var(--font-mono)",
                          backgroundColor: "var(--color-surface)",
                          border: "1px solid var(--color-brand-ring)",
                          color: "var(--color-brand-deep)",
                        }}
                      >
                        {m}
                      </span>
                    ))}
                    {routing.loadedMethods.map((m) => (
                      <span
                        key={`loaded-${m}`}
                        style={{
                          padding: "2px 8px",
                          borderRadius: "999px",
                          fontFamily: "var(--font-mono)",
                          backgroundColor: "var(--color-state-candidate-bg)",
                          border: "1px solid var(--color-state-candidate-border)",
                          color: "var(--color-state-candidate)",
                        }}
                      >
                        已加载: {m}
                      </span>
                    ))}
                  </div>
                )}

                {routing.toolReceipts.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" }}>
                    {routing.toolReceipts.map((tr) => (
                      <button
                        key={tr.id}
                        type="button"
                        onClick={() => tr.nodeId && onSelectNode(tr.nodeId)}
                        className="zygos-spring-card"
                        style={{
                          textAlign: "left",
                          padding: "8px 11px",
                          borderRadius: "11px",
                          border: "1px solid var(--color-brand-ring)",
                          backgroundColor: "var(--color-surface)",
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          gap: "3px",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                          <span style={{ fontSize: "11.5px", fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--color-brand-deep)" }}>
                            {tr.toolName}
                          </span>
                          <span
                            style={{
                              padding: "0px 6px",
                              borderRadius: "999px",
                              fontSize: "9.5px",
                              fontWeight: 700,
                              backgroundColor: "var(--color-state-candidate-bg)",
                              color: "var(--color-state-candidate)",
                            }}
                          >
                            {tr.exactness || tr.status}
                          </span>
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--color-ink)", fontFamily: "var(--font-mono)" }}>
                          {tr.valuePreview || `effect ${tr.id}`}
                        </div>
                        <div style={{ fontSize: "9.5px", color: "var(--color-ink-mute)", fontFamily: "var(--font-mono)" }}>
                          {tr.taskId ? `绑定 ${tr.taskId}` : ""}
                          {tr.sourceInputHash ? ` · #${tr.sourceInputHash.slice(0, 8)}` : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "8px 11px",
                      borderRadius: "10px",
                      border: "1px dashed var(--color-line-strong)",
                      backgroundColor: "var(--color-surface)",
                      fontSize: "11px",
                      color: "var(--color-ink-mute)",
                    }}
                  >
                    当前尚未执行数学计算资产效应（纯符号推理或未匹配参数模板）
                  </div>
                )}

                {/* 控制面审查与受控修复计数器 */}
                <div
                  className="zygos-tabular"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "8px",
                    padding: "6px 10px",
                    borderRadius: "9px",
                    backgroundColor: "var(--color-surface)",
                    border: "1px solid var(--color-line)",
                    fontSize: "10.5px",
                    color: "var(--color-ink-soft)",
                  }}
                >
                  <span>R2/R4 审查: {controlPlane.reviewCount} 轮 (质询 {controlPlane.reviewChallengesCount})</span>
                  <span>REPAIR 尝试: {controlPlane.repairAttempts} (驳回 {controlPlane.repairRejected})</span>
                  <span>协议纠偏重试: {controlPlane.forcedRetries}</span>
                  <span>反例拒斥: {controlPlane.refutationRequests}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================
          图二：创新点 2 · R0 三-Agent 并行独立读题 Fork-Join 拓扑
      ================================================================= */}
      {r0Reading && (filter === "all" || filter === "r0") && (
        <div
          className="zygos-blueprint-canvas"
          style={{
            borderRadius: "16px",
            border: activeStage === "stage_1_planning" ? "1.5px solid var(--color-brand-ring)" : "1px solid var(--color-line)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "7px",
                  fontSize: "11px",
                  fontWeight: 700,
                  backgroundColor: "var(--color-brand-tint)",
                  color: "var(--color-brand-deep)",
                  border: "1px solid var(--color-brand-ring)",
                }}
              >
                ② R0 三方并行读题 (1 ➔ 3 隔离扇出 ➔ 聚合门控)
              </span>
              <span className="zygos-tabular" style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
                完成 {r0DoneCount}/3 分支
                {r0Reading.totalR0Calls > 0 ? ` · ${r0Reading.totalR0Calls} 次独立调用` : ""}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {r0Reading.revisionTriggered && (
                <span
                  style={{
                    padding: "2px 9px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 700,
                    backgroundColor: "var(--color-state-error-bg)",
                    border: "1px solid var(--color-state-error-border)",
                    color: "var(--color-state-error)",
                  }}
                >
                  已触发合同修订{r0Reading.recheckObserved ? " + R0 复检" : ""}
                </span>
              )}
              <span
                className="zygos-tabular"
                style={{
                  padding: "2px 9px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: 700,
                  backgroundColor: "var(--color-surface)",
                  border: "1px solid var(--color-line)",
                  color: "var(--color-ink)",
                }}
              >
                P2 合同 v{r0Reading.contractVersion}
              </span>
            </div>
          </div>

          <div style={{ overflowX: "auto", paddingBottom: "2px" }}>
            <div style={{ position: "relative", minWidth: "880px", height: "278px" }}>
              <svg
                viewBox="0 0 1000 278"
                preserveAspectRatio="none"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              >
                {r0LaneCenters.map((cy, idx) => {
                  const isFocused = hoveredR0 === null || hoveredR0 === idx;
                  const agent = r0Reading.agents[idx];
                  const isActiveLane = agent && (agent.status === "completed" || agent.status === "failed" || agent.status === "running");
                  const color = agent?.verdict === "ISSUES" ? "#ef4444" : isActiveLane ? "#2563eb" : "#94a3b8";
                  const dFork =
                    cy === 139
                      ? `M 175 139 L 265 139`
                      : `M 175 139 C 220 139, 220 ${cy}, 265 ${cy}`;
                  const dJoin =
                    cy === 139
                      ? `M 600 139 L 680 139`
                      : `M 600 ${cy} C 640 ${cy}, 640 139, 680 139`;

                  return (
                    <g key={idx}>
                      <path
                        d={dFork}
                        fill="none"
                        stroke={color}
                        strokeWidth={hoveredR0 === idx ? 2.5 : 1.7}
                        strokeOpacity={isActiveLane ? (isFocused ? 0.85 : 0.24) : 0.28}
                        vectorEffect="non-scaling-stroke"
                        className={`zygos-dag-spline ${isActiveLane ? "zygos-svg-flow" : ""}`}
                      />
                      <path
                        d={dJoin}
                        fill="none"
                        stroke={color}
                        strokeWidth={hoveredR0 === idx ? 2.5 : 1.7}
                        strokeOpacity={isActiveLane ? (isFocused ? 0.85 : 0.24) : 0.28}
                        vectorEffect="non-scaling-stroke"
                        className={`zygos-dag-spline ${isActiveLane ? "zygos-svg-flow" : ""}`}
                      />
                    </g>
                  );
                })}

                <path
                  d="M 825 139 L 865 139"
                  fill="none"
                  stroke={r0Active ? "#10b981" : "#94a3b8"}
                  strokeWidth={2}
                  strokeOpacity={r0Active ? 0.9 : 0.35}
                  vectorEffect="non-scaling-stroke"
                  className={r0Active ? "zygos-svg-flow" : undefined}
                />

                <line
                  x1="252"
                  y1="18"
                  x2="252"
                  y2="260"
                  stroke="#6366f1"
                  strokeWidth="1.2"
                  strokeDasharray="4 4"
                  strokeOpacity="0.4"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              <div
                style={{
                  position: "absolute",
                  left: "18.8%",
                  top: "10px",
                  padding: "2px 7px",
                  borderRadius: "999px",
                  fontSize: "10px",
                  fontWeight: 700,
                  backgroundColor: "var(--color-surface)",
                  border: "1px dashed var(--color-line-strong)",
                  color: "var(--color-ink-mute)",
                  pointerEvents: "none",
                }}
              >
                上下文隔离扇出
              </div>

              <div
                style={{
                  position: "absolute",
                  left: "1.5%",
                  top: "84px",
                  width: "16%",
                  height: "110px",
                  borderRadius: "14px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface)",
                  padding: "11px 12px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                  <span style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                    M1 原始命题
                  </span>
                  <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--color-ink-mute)" }}>Fork 起点</span>
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    lineHeight: 1.45,
                    color: "var(--color-ink-soft)",
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {plainExcerpt}
                </div>
                <PortDot side="right" color="#2563eb" active />
              </div>

              {r0Reading.agents.map((agent, idx) => {
                const topPx = 14 + idx * 88;
                const isIssue = agent.verdict === "ISSUES";
                const isActive = agent.status === "completed" || agent.status === "failed" || agent.status === "running";
                const borderColor = isIssue
                  ? "var(--color-state-error-border)"
                  : hoveredR0 === idx
                  ? "var(--color-brand-ring)"
                  : "var(--color-line-strong)";
                const portColor = isIssue ? "#ef4444" : "#2563eb";

                return (
                  <button
                    key={agent.role}
                    type="button"
                    onMouseEnter={() => setHoveredR0(idx)}
                    onMouseLeave={() => setHoveredR0(null)}
                    onClick={() => agent.nodeId && onSelectNode(agent.nodeId)}
                    disabled={!agent.nodeId}
                    className="zygos-spring-card"
                    style={{
                      position: "absolute",
                      left: "26.5%",
                      top: `${topPx}px`,
                      width: "33.5%",
                      height: "74px",
                      borderRadius: "13px",
                      border: `1px solid ${borderColor}`,
                      backgroundColor: "var(--color-surface)",
                      padding: "9px 13px",
                      textAlign: "left",
                      cursor: agent.nodeId ? "pointer" : "default",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      opacity: hoveredR0 !== null && hoveredR0 !== idx ? 0.55 : 1,
                    }}
                  >
                    <PortDot side="left" color={portColor} active={isActive} />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "12.5px",
                          fontWeight: 700,
                          color: "var(--color-ink)",
                        }}
                      >
                        <span style={{ color: isIssue ? "#ef4444" : "var(--color-brand-deep)" }}>
                          {getR0RoleIcon(agent.role)}
                        </span>
                        {agent.title}
                      </span>
                      {renderCompactVerdict(agent)}
                    </div>

                    <div
                      className="zygos-tabular"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "10.5px",
                        color: "var(--color-ink-mute)",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Lock size={10} />
                        隔离维度: {agent.dimension}
                      </span>
                      <span style={{ flexShrink: 0, fontWeight: 600, color: "var(--color-ink-soft)" }}>
                        {agent.requestId ? `${agent.requestId} · ` : ""}
                        {formatLatency(agent.latencyMs)}
                      </span>
                    </div>
                    <PortDot side="right" color={portColor} active={isActive} />
                  </button>
                );
              })}

              <div
                style={{
                  position: "absolute",
                  left: "68%",
                  top: "84px",
                  width: "14.5%",
                  height: "110px",
                  borderRadius: "14px",
                  border:
                    r0Reading.aggregateConclusion === "ISSUES"
                      ? "1px solid var(--color-state-error-border)"
                      : "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface)",
                  padding: "11px 12px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <PortDot side="left" color="#6366f1" active={r0Active} />
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <Cpu size={14} style={{ color: "#6366f1" }} />
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink)" }}>
                    确定性汇聚
                  </span>
                </div>
                <div style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                  {r0Reading.aggregateConclusion
                    ? `结论: ${r0Reading.aggregateConclusion}`
                    : r0Reading.status === "skipped"
                    ? "已跳过 (R0=0)"
                    : r0DoneCount === 3
                    ? "3 路调用已收敛"
                    : isRunning
                    ? "待三方收敛"
                    : "前序中止 · 未收敛"}
                </div>
                <div style={{ fontSize: "10px", fontFamily: "var(--font-mono)", color: "var(--color-ink-mute)" }}>
                  {r0Reading.stageAction ? `动作 ${r0Reading.stageAction}` : "门控裁决"}
                </div>
                <PortDot side="right" color="#10b981" active={r0Active} />
              </div>

              <div
                style={{
                  position: "absolute",
                  left: "86.5%",
                  top: "84px",
                  width: "12%",
                  height: "110px",
                  borderRadius: "14px",
                  border: "1px solid var(--color-state-candidate-border)",
                  backgroundColor: "var(--color-state-candidate-bg)",
                  padding: "11px 12px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <PortDot side="left" color="#10b981" active={r0Active} />
                <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-state-candidate)" }}>
                  P2 合同 v{r0Reading.contractVersion}
                </span>
                <div className="zygos-tabular" style={{ fontSize: "11px", color: "var(--color-ink)", lineHeight: 1.45 }}>
                  {r0Reading.obligationsCount ?? taskDag.tasks.length} 项义务
                  <br />
                  {r0Reading.tasksCount ?? taskDag.tasks.length} 个任务
                </div>
                <span style={{ fontSize: "10px", color: "var(--color-state-candidate)", fontWeight: 600 }}>
                  {r0Reading.revisionTriggered ? "修订重编生效" : "准入 M2 DAG"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================
          图三：创新点 3 · 多-Agent 协同求解 (5+2+1 Fork-Join + 对抗审计拓扑)
      ================================================================= */}
      {multiAgentSolving && (filter === "all" || filter === "consensus") && (
        <div
          className="zygos-blueprint-canvas"
          style={{
            borderRadius: "16px",
            border: activeStage === "stage_2_execution" ? "1.5px solid var(--color-state-candidate-border)" : "1px solid var(--color-line)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "7px",
                  fontSize: "11px",
                  fontWeight: 700,
                  backgroundColor: "var(--color-state-candidate-bg)",
                  color: "var(--color-state-candidate)",
                  border: "1px solid var(--color-state-candidate-border)",
                }}
              >
                ③ 多-Agent 并行求解集群 (1 ➔ 6 盲解泳道 ➔ 投票归并 ➔ 双审计并行 ➔ 闭环门)
              </span>
              <span className="zygos-tabular" style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
                {getConsensusBadgeText(maxCons)}
              </span>
            </div>

            {methodRoutes.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>方法路由:</span>
                {methodRoutes.map((route) => (
                  <span
                    key={route}
                    style={{
                      padding: "1px 8px",
                      borderRadius: "999px",
                      fontSize: "10.5px",
                      fontFamily: "var(--font-mono)",
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-line)",
                      color: "var(--color-ink-soft)",
                    }}
                  >
                    {route}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ overflowX: "auto", paddingBottom: "2px" }}>
            <div style={{ position: "relative", minWidth: "1020px", height: "398px" }}>
              <svg
                viewBox="0 0 1000 398"
                preserveAspectRatio="none"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              >
                {laneCenters.map((cy, idx) => {
                  const lane = laneEntries[idx];
                  const isActive = lane.isExecuted || lane.isInFlight;
                  const isDimmed = hoveredLane !== null && hoveredLane !== idx;
                  const strokeColor = lane.isExecuted ? "#10b981" : lane.isInFlight ? "#2563eb" : "#94a3b8";
                  const dFork = `M 140 199 C 165 199, 165 ${cy}, 190 ${cy}`;
                  const dJoin = `M 430 ${cy} C 455 ${cy}, 455 199, 480 199`;

                  return (
                    <g key={idx}>
                      <path
                        d={dFork}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={hoveredLane === idx ? 2.4 : isActive ? 1.7 : 1.1}
                        strokeOpacity={isActive ? (isDimmed ? 0.2 : 0.8) : lane.isBudgeted ? 0.38 : 0.18}
                        strokeDasharray={isActive ? undefined : "4 4"}
                        vectorEffect="non-scaling-stroke"
                        className={`zygos-dag-spline ${isActive ? "zygos-svg-flow" : ""}`}
                      />
                      <path
                        d={dJoin}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={hoveredLane === idx ? 2.4 : isActive ? 1.7 : 1.1}
                        strokeOpacity={isActive ? (isDimmed ? 0.2 : 0.8) : lane.isBudgeted ? 0.38 : 0.18}
                        strokeDasharray={isActive ? undefined : "4 4"}
                        vectorEffect="non-scaling-stroke"
                        className={`zygos-dag-spline ${isActive ? "zygos-svg-flow" : ""}`}
                      />
                    </g>
                  );
                })}

                {auditCenters.map((cy, idx) => {
                  const auditItem = audits[idx];
                  const isActive = Boolean(auditItem);
                  const isDimmed = hoveredAudit !== null && hoveredAudit !== idx;
                  const color = auditItem?.agreement === false ? "#ef4444" : isActive ? "#f59e0b" : "#94a3b8";
                  return (
                    <g key={idx}>
                      <path
                        d={`M 640 199 C 662 199, 662 ${cy}, 685 ${cy}`}
                        fill="none"
                        stroke={color}
                        strokeWidth={hoveredAudit === idx ? 2.4 : 1.6}
                        strokeOpacity={isActive ? (isDimmed ? 0.22 : 0.85) : 0.22}
                        strokeDasharray={isActive ? undefined : "4 4"}
                        vectorEffect="non-scaling-stroke"
                        className={`zygos-dag-spline ${isActive ? "zygos-svg-flow" : ""}`}
                      />
                      <path
                        d={`M 820 ${cy} C 842 ${cy}, 842 125, 865 125`}
                        fill="none"
                        stroke={color}
                        strokeWidth={hoveredAudit === idx ? 2.4 : 1.6}
                        strokeOpacity={isActive ? (isDimmed ? 0.22 : 0.85) : 0.22}
                        strokeDasharray={isActive ? undefined : "4 4"}
                        vectorEffect="non-scaling-stroke"
                        className={`zygos-dag-spline ${isActive ? "zygos-svg-flow" : ""}`}
                      />
                    </g>
                  );
                })}

                {!auditsEnabled && audits.length === 0 && (
                  <>
                    <path
                      d="M 640 199 C 745 199, 770 125, 865 125"
                      fill="none"
                      stroke={cert?.observed ? "#6366f1" : "#94a3b8"}
                      strokeWidth={1.8}
                      strokeOpacity={cert?.observed ? 0.8 : 0.35}
                      vectorEffect="non-scaling-stroke"
                      className={cert?.observed ? "zygos-svg-flow" : undefined}
                    />
                    <path
                      d="M 640 199 C 745 199, 770 273, 865 273"
                      fill="none"
                      stroke={closure?.observed ? "#10b981" : "#94a3b8"}
                      strokeWidth={1.8}
                      strokeOpacity={closure?.observed ? 0.8 : 0.35}
                      vectorEffect="non-scaling-stroke"
                      className={closure?.observed ? "zygos-svg-flow" : undefined}
                    />
                  </>
                )}

                <line
                  x1="927"
                  y1="178"
                  x2="927"
                  y2="220"
                  stroke={closure?.observed ? "#10b981" : "#94a3b8"}
                  strokeWidth="1.8"
                  strokeOpacity={closure?.observed ? 0.85 : 0.3}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              <div
                style={{
                  position: "absolute",
                  left: "19.2%",
                  top: "-2px",
                  fontSize: "10px",
                  fontWeight: 700,
                  color: "var(--color-brand-deep)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  pointerEvents: "none",
                }}
              >
                <EyeOff size={10} />
                隔离并行盲解泳道（屏蔽历史候选）
              </div>

              <div
                style={{
                  position: "absolute",
                  left: "1%",
                  top: "136px",
                  width: "13%",
                  height: "126px",
                  borderRadius: "14px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface)",
                  padding: "11px 12px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <span style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                  M2 任务与资产
                </span>
                <div className="zygos-tabular" style={{ fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
                  工作调用 {multiAgentSolving.totalWorkModelCalls} 次
                  <br />
                  资产观测 {closure?.observationViews ?? 0} 项
                </div>
                <span style={{ fontSize: "10px", color: "var(--color-ink-mute)" }}>
                  同步扇出各求解支路
                </span>
                <PortDot side="right" color="#2563eb" active={hasAnyBallot} />
              </div>

              {laneEntries.map((lane, idx) => {
                const topPx = laneTops[idx];
                const b = lane.ballot;
                const borderColor = lane.isExecuted
                  ? hoveredLane === idx
                    ? "#10b981"
                    : "var(--color-state-candidate-border)"
                  : lane.isInFlight
                  ? "var(--color-brand-ring)"
                  : "var(--color-line)";

                return (
                  <button
                    key={lane.slotIdx}
                    type="button"
                    onMouseEnter={() => setHoveredLane(idx)}
                    onMouseLeave={() => setHoveredLane(null)}
                    onClick={() => b?.nodeId && onSelectNode(b.nodeId)}
                    disabled={!b?.nodeId}
                    className="zygos-spring-card"
                    style={{
                      position: "absolute",
                      left: "19%",
                      top: `${topPx}px`,
                      width: "24%",
                      height: "54px",
                      borderRadius: "11px",
                      border: `1px ${lane.isExecuted || lane.isInFlight ? "solid" : "dashed"} ${borderColor}`,
                      backgroundColor: lane.isExecuted ? "var(--color-surface)" : "color-mix(in oklab, var(--color-surface) 65%, transparent)",
                      padding: "6px 11px",
                      textAlign: "left",
                      cursor: b?.nodeId ? "pointer" : "default",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      opacity: !lane.isExecuted && !lane.isInFlight && !lane.isBudgeted ? 0.52 : hoveredLane !== null && hoveredLane !== idx ? 0.55 : 1,
                    }}
                  >
                    <PortDot
                      side="left"
                      color={lane.isExecuted ? "#10b981" : "#2563eb"}
                      active={lane.isExecuted || lane.isInFlight}
                    />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                      <span
                        style={{
                          fontSize: "11.5px",
                          fontWeight: 700,
                          color: lane.isExecuted ? "var(--color-ink)" : "var(--color-ink-soft)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lane.title}
                      </span>
                      {lane.isExecuted ? (
                        b?.agreesWithPrevious !== null && b?.agreesWithPrevious !== undefined ? (
                          <span
                            style={{
                              padding: "0px 6px",
                              borderRadius: "999px",
                              fontSize: "10px",
                              fontWeight: 700,
                              backgroundColor: b.agreesWithPrevious ? "var(--color-state-candidate-bg)" : "var(--color-state-error-bg)",
                              color: b.agreesWithPrevious ? "var(--color-state-candidate)" : "var(--color-state-error)",
                              flexShrink: 0,
                            }}
                          >
                            {b.agreesWithPrevious ? "一致" : "分歧"}
                          </span>
                        ) : (
                          <CheckCircle2 size={12} color="#10b981" style={{ flexShrink: 0 }} />
                        )
                      ) : lane.isInFlight ? (
                        <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-brand-deep)", flexShrink: 0 }}>
                          推理中
                        </span>
                      ) : (
                        <span style={{ fontSize: "10px", color: "var(--color-ink-mute)", flexShrink: 0 }}>
                          {!lane.isBudgeted ? "未开启" : isRunning ? "待调度" : "未进入阶段"}
                        </span>
                      )}
                    </div>

                    <div
                      className="zygos-tabular"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "6px",
                        fontSize: "10.5px",
                        color: "var(--color-ink-mute)",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {b?.candidatePlain ? `候选: ${b.candidatePlain}` : lane.subtitle}
                      </span>
                      {b?.latencyMs ? (
                        <span style={{ flexShrink: 0, fontWeight: 600 }}>{formatLatency(b.latencyMs)}</span>
                      ) : null}
                    </div>
                    <PortDot
                      side="right"
                      color={lane.isExecuted ? "#10b981" : "#2563eb"}
                      active={lane.isExecuted || lane.isInFlight}
                    />
                  </button>
                );
              })}

              <div
                style={{
                  position: "absolute",
                  left: "48%",
                  top: "88px",
                  width: "16%",
                  height: "220px",
                  borderRadius: "15px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface)",
                  padding: "11px 12px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <PortDot side="left" color="#10b981" active={hasAnyBallot} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink)", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                    <Award size={13} style={{ color: "var(--color-state-candidate)" }} />
                    答案键计票
                  </span>
                  <span className="zygos-tabular" style={{ fontSize: "10.5px", color: "var(--color-ink-mute)" }}>
                    {totalVotedBallots} 票
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px", overflow: "hidden", flex: 1, justifyContent: "center" }}>
                  {voteGroups.length > 0 ? (
                    voteGroups.slice(0, 4).map((group) => {
                      const pct = totalVotedBallots > 0 ? Math.round((group.count / totalVotedBallots) * 100) : 0;
                      return (
                        <div key={group.key} style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", gap: "4px" }}>
                            <strong
                              style={{
                                color: group.isFrontRunner ? "var(--color-state-candidate)" : "var(--color-ink)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={group.displayPlain}
                            >
                              {group.displayPlain}
                            </strong>
                            <span className="zygos-tabular" style={{ flexShrink: 0, color: "var(--color-ink-soft)" }}>
                              {group.count}票
                            </span>
                          </div>
                          <div style={{ height: "5px", borderRadius: "999px", backgroundColor: "var(--color-surface-sunken)", overflow: "hidden" }}>
                            <div
                              className="zygos-vote-bar-fill"
                              style={{
                                height: "100%",
                                width: `${Math.max(8, pct)}%`,
                                borderRadius: "999px",
                                background: group.isFrontRunner ? "linear-gradient(90deg, #2563eb, #10b981)" : "var(--color-line-strong)",
                              }}
                            />
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", lineHeight: 1.45 }}>
                      {isRunning ? "等待盲解选票汇聚归并..." : "前序已终止，未进入多票归并阶段"}
                    </div>
                  )}
                </div>

                <div style={{ fontSize: "10px", color: "var(--color-ink-mute)", borderTop: "1px dashed var(--color-line)", paddingTop: "5px" }}>
                  禁止拼接片段，按规范键取胜者
                </div>
                <PortDot side="right" color="#f59e0b" active={hasAnyBallot} />
              </div>

              {[
                { idx: 0, fallbackTitle: "审计 #1 · 反例攻防", fallbackMode: "构造极端反例冲击领先候选" },
                { idx: 1, fallbackTitle: "审计 #2 · 证明审计", fallbackMode: "核查前置假设与步骤严密性" },
              ].map((slot) => {
                const auditItem: MultiAgentAuditView | undefined = audits[slot.idx];
                const topPx = auditTops[slot.idx];
                const isFailed = auditItem?.agreement === false;
                const isDone = Boolean(auditItem);

                return (
                  <button
                    key={slot.idx}
                    type="button"
                    onMouseEnter={() => setHoveredAudit(slot.idx)}
                    onMouseLeave={() => setHoveredAudit(null)}
                    onClick={() => auditItem?.nodeId && onSelectNode(auditItem.nodeId)}
                    disabled={!auditItem?.nodeId}
                    className="zygos-spring-card"
                    style={{
                      position: "absolute",
                      left: "68.5%",
                      top: `${topPx}px`,
                      width: "13.5%",
                      height: "106px",
                      borderRadius: "14px",
                      border: `1px ${isDone ? "solid" : "dashed"} ${
                        isFailed
                          ? "var(--color-state-error-border)"
                          : isDone
                          ? "rgba(245, 158, 11, 0.45)"
                          : "var(--color-line)"
                      }`,
                      backgroundColor: isFailed
                        ? "var(--color-state-error-bg)"
                        : isDone
                        ? "var(--color-surface)"
                        : "color-mix(in oklab, var(--color-surface) 60%, transparent)",
                      padding: "10px 11px",
                      textAlign: "left",
                      cursor: auditItem?.nodeId ? "pointer" : "default",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      opacity: isDone ? 1 : 0.56,
                    }}
                  >
                    <PortDot side="left" color={isFailed ? "#ef4444" : "#f59e0b"} active={isDone} />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                      <span style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-ink)" }}>
                        {auditItem ? `审计 #${auditItem.index}` : slot.fallbackTitle}
                      </span>
                      {isDone ? (
                        isFailed ? <XCircle size={13} color="#ef4444" /> : <ShieldCheck size={13} color="#10b981" />
                      ) : null}
                    </div>
                    <div style={{ fontSize: "10.5px", color: "var(--color-ink-soft)", lineHeight: 1.4 }}>
                      {auditItem ? auditItem.modeLabel : slot.fallbackMode}
                    </div>
                    <div className="zygos-tabular" style={{ fontSize: "10px", color: "var(--color-ink-mute)" }}>
                      {auditItem
                        ? `${auditItem.agreement === false ? "修正候选" : "维持主票"} · ${formatLatency(auditItem.latencyMs)}`
                        : !auditsEnabled
                        ? "轻量配置未触发"
                        : isRunning
                        ? "等待审计执行"
                        : "未进入审计"}
                    </div>
                    <PortDot side="right" color={isFailed ? "#ef4444" : "#f59e0b"} active={isDone} />
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => cert?.nodeId && onSelectNode(cert.nodeId)}
                disabled={!cert?.nodeId}
                className={`zygos-spring-card ${cert?.observed ? "zygos-accent-cert" : ""}`}
                style={{
                  position: "absolute",
                  left: "86.5%",
                  top: "72px",
                  width: "12.5%",
                  height: "106px",
                  borderRadius: "14px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: cert?.observed ? undefined : "var(--color-surface)",
                  padding: "10px 11px",
                  textAlign: "left",
                  cursor: cert?.nodeId ? "pointer" : "default",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <PortDot side="left" color="#6366f1" active={Boolean(cert?.observed)} />
                <span style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-ink)" }}>
                  CERT1 自检
                </span>
                <div className="zygos-tabular" style={{ fontSize: "10.5px", color: "var(--color-ink-soft)", lineHeight: 1.45 }}>
                  检查 {cert?.certificateChecks ?? 0} 项
                  <br />
                  {cert?.observed
                    ? cert.certificateCertified
                      ? "证书通过"
                      : "已签发记录"
                    : isRunning
                    ? "待触发"
                    : "未进入自检"}
                </div>
                <span className="zygos-tabular" style={{ fontSize: "10px", color: "var(--color-ink-mute)" }}>
                  {cert?.latencyMs ? formatLatency(cert.latencyMs) : "结构化核验"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => closure?.nodeId && onSelectNode(closure.nodeId)}
                disabled={!closure?.nodeId}
                className="zygos-spring-card"
                style={{
                  position: "absolute",
                  left: "86.5%",
                  top: "220px",
                  width: "12.5%",
                  height: "106px",
                  borderRadius: "14px",
                  border: `1px solid ${
                    closure && closure.remainingDefects.length > 0
                      ? "var(--color-state-error-border)"
                      : closure?.observed
                      ? "var(--color-state-candidate-border)"
                      : "var(--color-line)"
                  }`,
                  backgroundColor:
                    closure && closure.remainingDefects.length > 0
                      ? "var(--color-state-error-bg)"
                      : "var(--color-surface)",
                  padding: "10px 11px",
                  textAlign: "left",
                  cursor: closure?.nodeId ? "pointer" : "default",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <PortDot side="left" color="#10b981" active={Boolean(closure?.observed)} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                  <span style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-ink)" }}>
                    答案闭环
                  </span>
                  <Activity size={12} color={closure?.remainingDefects.length ? "#ef4444" : "#10b981"} />
                </div>
                <div className="zygos-tabular" style={{ fontSize: "10.5px", color: "var(--color-ink-soft)", lineHeight: 1.45 }}>
                  观测 {closure?.observationViews ?? 0} 视图
                  <br />
                  {!closure?.observed
                    ? isRunning
                      ? "待收口"
                      : "未进入闭环"
                    : closure.remainingDefects.length > 0
                    ? `${closure.remainingDefects.length} 项缺陷`
                    : "全量闭合通过"}
                </div>
                <span style={{ fontSize: "10px", color: "var(--color-ink-mute)" }}>
                  红线 Verified=false
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
