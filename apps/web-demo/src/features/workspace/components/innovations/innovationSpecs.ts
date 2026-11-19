import { extractInnovationsProjection } from "../../../../domain/research/innovations";
import { extractFinalAnswerPresentation } from "../../../../domain/research/plainAnswer";
import type {
  ConsensusVoteGroupView,
  MacroStageId,
  MultiAgentAuditView,
  MultiAgentBallotView,
  MultiAgentClosureView,
  R0RoleAgentView,
  ResearchViewModel,
} from "../../../../domain/research/types";

export type InnovationId = "inn1" | "inn2" | "inn3";
export type InnovationPhaseStatus = "pending" | "active" | "completed" | "error";

export interface InnovationSubSpec {
  readonly code: string;
  readonly title: string;
  readonly moduleTag: string;
}

export interface InnovationSpec {
  readonly id: InnovationId;
  readonly index: 1 | 2 | 3;
  readonly shortName: string;
  readonly title: string;
  readonly slogan: string;
  readonly accentColor: string;
  readonly subSpecs: readonly [
    InnovationSubSpec,
    InnovationSubSpec,
    InnovationSubSpec,
  ];
}

export const THREE_INNOVATION_SPECS: readonly [
  InnovationSpec,
  InnovationSpec,
  InnovationSpec,
] = [
  {
    id: "inn1",
    index: 1,
    shortName: "创新点一 · 契约驱动调度",
    title: "契约 DAG 编排、R0 三方互盲与八维结构路由",
    slogan: "M1 契约拆解 · R0 互盲审校 · 8 维探针调度",
    accentColor: "#3b82f6",
    subSpecs: [
      { code: "①", title: "M1 契约编译与分层义务 DAG", moduleTag: "p2-compiler" },
      { code: "②", title: "R0 三角色互盲并行审查", moduleTag: "p4-r0" },
      { code: "③", title: "8 维签名路由与优先级队列", moduleTag: "p2-gate" },
    ],
  },
  {
    id: "inn2",
    index: 2,
    shortName: "创新点二 · 协同求解取证",
    title: "五路隔离盲解、双对抗审计与受控沙箱取证",
    slogan: "5 路隔离视角 · 双审一致改锚 · 26×96 防伪沙箱",
    accentColor: "#38bdf8",
    subSpecs: [
      { code: "①", title: "5 路互盲独立完整求解", moduleTag: "context-v7" },
      { code: "②", title: "规范键归并、双审与 CERT1", moduleTag: "answer-key" },
      { code: "③", title: "26×96 控制核防伪沙箱回执", moduleTag: "math_asset" },
    ],
  },
  {
    id: "inn3",
    index: 3,
    shortName: "创新点三 · 溯源校验交付",
    title: "链式账本溯源、局部 STALE 传播与双锁终审",
    slogan: "链式重放 · STALE 精确重核 · 18 类病历双锁红线",
    accentColor: "#10b981",
    subSpecs: [
      { code: "①", title: "Append-only 链式日志与局部 STALE", moduleTag: "p4-revise" },
      { code: "②", title: "18 类结构病历与双锁微修", moduleTag: "p4-repair" },
      { code: "③", title: "Fail-Closed 终态红线裁决", moduleTag: "p4-candidate" },
    ],
  },
];

export interface DerivedThreeInnovationsMetrics {
  readonly overallStage: MacroStageId;
  readonly inn1Status: InnovationPhaseStatus;
  readonly inn2Status: InnovationPhaseStatus;
  readonly inn3Status: InnovationPhaseStatus;
  readonly inn1SubStatuses: readonly [
    InnovationPhaseStatus,
    InnovationPhaseStatus,
    InnovationPhaseStatus,
  ];
  readonly inn2SubStatuses: readonly [
    InnovationPhaseStatus,
    InnovationPhaseStatus,
    InnovationPhaseStatus,
  ];
  readonly inn3SubStatuses: readonly [
    InnovationPhaseStatus,
    InnovationPhaseStatus,
    InnovationPhaseStatus,
  ];
  readonly projection: ReturnType<typeof extractInnovationsProjection>;
  readonly r0Agents: readonly R0RoleAgentView[];
  readonly r0DoneCount: number;
  readonly r0TotalCalls: number;
  readonly r0Conclusion: string | null;
  readonly ballots: readonly MultiAgentBallotView[];
  readonly ballotCount: number;
  readonly voteGroups: readonly ConsensusVoteGroupView[];
  readonly topCandidateVotes: number;
  readonly topCandidateText: string | null;
  readonly audits: readonly MultiAgentAuditView[];
  readonly auditCount: number;
  readonly auditChallengeCount: number;
  readonly certObserved: boolean;
  readonly certCertified: boolean | null;
  readonly closure: MultiAgentClosureView | null;
  readonly toolCount: number;
  readonly topToolName: string | null;
  readonly topToolHash: string | null;
  readonly topToolValue: string | null;
  readonly eventCount: number;
  readonly modelCallCount: number;
  readonly terminalStatus: string;
  readonly stopReason: string | null;
  readonly answerHeadline: string | null;
  readonly isTerminal: boolean;
}

export function deriveThreeInnovationsMetrics(
  viewModel: ResearchViewModel,
  observedEventCount?: number,
): DerivedThreeInnovationsMetrics {
  const projection = extractInnovationsProjection(viewModel);
  const r0 = viewModel.r0Reading;
  const multi = viewModel.multiAgentSolving;

  const r0DoneCount =
    r0?.agents.filter((a) => a.status === "completed" || a.status === "failed").length ?? 0;
  const r0RunningCount = r0?.agents.filter((a) => a.status === "running").length ?? 0;

  const ballots = multi?.ballots ?? [];
  const ballotCount = ballots.length;
  const sortedVotes = [...(multi?.voteGroups ?? [])].sort((a, b) => b.count - a.count);
  const topVote = sortedVotes[0];
  const auditCount = multi?.audits.length ?? 0;
  const auditRunning = Boolean(
    multi?.inFlightRequests?.some(
      (r) => r.phase.includes("AUDIT") || r.phase.includes("REVIEW"),
    ),
  );
  const certObserved = Boolean(multi?.certificate?.observed);
  const toolCount = projection.routing.toolReceipts.length;
  const firstTool =
    projection.routing.toolReceipts.find((tr) => Boolean(tr.valuePreview)) ??
    projection.routing.toolReceipts.find((tr) => tr.toolName !== "math_asset") ??
    projection.routing.toolReceipts[0];

  const isTerminal = viewModel.mode === "completed";
  const isErrorTerminal =
    viewModel.status === "error" ||
    viewModel.status === "failed" ||
    viewModel.status === "timeout";

  const hasExecutionActivity =
    ballotCount > 0 ||
    toolCount > 0 ||
    projection.taskDag.executedArtifactCount > 0 ||
    Boolean(multi?.inFlightRequests?.some((r) => r.phase.includes("WORK") || r.phase.includes("CONSENSUS")));

  const hasValidationActivity =
    auditCount > 0 ||
    certObserved ||
    projection.controlPlane.reviewCount > 0 ||
    projection.controlPlane.repairAttempts > 0 ||
    Boolean(multi?.closure?.observed) ||
    isTerminal;

  // Compute sub-statuses for Innovation 1
  const dagDone = projection.taskDag.tasks.length > 0 && (r0DoneCount > 0 || hasExecutionActivity || isTerminal);
  const inn1S1: InnovationPhaseStatus = dagDone
    ? "completed"
    : projection.taskDag.tasks.length > 0
      ? "active"
      : "pending";
  const inn1S2: InnovationPhaseStatus =
    r0RunningCount > 0
      ? "active"
      : r0DoneCount > 0 || hasExecutionActivity || isTerminal
        ? "completed"
        : "pending";
  const inn1S3: InnovationPhaseStatus =
    hasExecutionActivity || isTerminal
      ? "completed"
      : projection.routing.matchedCount > 0 || r0RunningCount > 0
        ? "active"
        : "pending";
  const inn1Status: InnovationPhaseStatus =
    inn1S1 === "completed" && inn1S2 === "completed" && inn1S3 === "completed"
      ? "completed"
      : inn1S1 === "active" || inn1S2 === "active" || inn1S3 === "active" || viewModel.mode === "running"
        ? "active"
        : "pending";

  // Compute sub-statuses for Innovation 2
  const inConsensusRun = Boolean(
    multi?.inFlightRequests?.some((r) => r.phase.includes("CONSENSUS") || r.phase.includes("WORK")),
  );
  const inn2S1: InnovationPhaseStatus =
    ballotCount > 0 && (auditCount > 0 || certObserved || isTerminal)
      ? "completed"
      : ballotCount > 0 || inConsensusRun
        ? "active"
        : "pending";
  const inn2S2: InnovationPhaseStatus =
    certObserved || (isTerminal && auditCount > 0) || (isTerminal && ballotCount > 0)
      ? "completed"
      : auditCount > 0 || auditRunning || sortedVotes.length > 0
        ? "active"
        : "pending";
  const inn2S3: InnovationPhaseStatus =
    toolCount > 0
      ? "completed"
      : projection.routing.loadedMethods.length > 0 || projection.routing.methodRoutes.length > 0
        ? isTerminal
          ? "completed"
          : "active"
        : isTerminal
          ? "completed"
          : "pending";
  const inn2Status: InnovationPhaseStatus =
    isTerminal && !isErrorTerminal
      ? "completed"
      : isErrorTerminal && !ballotCount && !toolCount
        ? "error"
        : inn2S1 === "active" || inn2S2 === "active" || inn2S3 === "active"
          ? "active"
          : hasExecutionActivity
            ? "completed"
            : "pending";

  // Compute sub-statuses for Innovation 3
  const rawLen = viewModel.rawEvents?.length ?? 0;
  const eventCount =
    rawLen > 0
      ? rawLen
      : typeof observedEventCount === "number" && observedEventCount > 0
        ? observedEventCount
        : viewModel.nodes.length;
  const answerPreview = extractFinalAnswerPresentation(viewModel);
  const inn3S1: InnovationPhaseStatus =
    isTerminal
      ? "completed"
      : eventCount > 2
        ? "active"
        : "pending";
  const inn3S2: InnovationPhaseStatus =
    isTerminal
      ? isErrorTerminal && projection.controlPlane.reviewCount === 0
        ? "error"
        : "completed"
      : projection.controlPlane.reviewCount > 0 ||
          projection.controlPlane.repairAttempts > 0 ||
          auditCount > 0
        ? "active"
        : "pending";
  const inn3S3: InnovationPhaseStatus = isTerminal
    ? isErrorTerminal
      ? "error"
      : "completed"
    : "pending";
  const inn3Status: InnovationPhaseStatus =
    isTerminal
      ? isErrorTerminal
        ? "error"
        : "completed"
      : hasValidationActivity || inn3S2 === "active"
        ? "active"
        : "pending";

  return {
    overallStage: viewModel.currentStage,
    inn1Status,
    inn2Status,
    inn3Status,
    inn1SubStatuses: [inn1S1, inn1S2, inn1S3],
    inn2SubStatuses: [inn2S1, inn2S2, inn2S3],
    inn3SubStatuses: [inn3S1, inn3S2, inn3S3],
    projection,
    r0Agents: r0?.agents ?? [],
    r0DoneCount,
    r0TotalCalls: r0?.totalR0Calls ?? 0,
    r0Conclusion: r0?.aggregateConclusion ?? null,
    ballots,
    ballotCount,
    voteGroups: sortedVotes,
    topCandidateVotes: topVote?.count ?? 0,
    topCandidateText: topVote?.displayPlain ?? null,
    audits: multi?.audits ?? [],
    auditCount,
    auditChallengeCount: projection.controlPlane.reviewChallengesCount,
    certObserved,
    certCertified: multi?.certificate?.certificateCertified ?? null,
    closure: multi?.closure ?? null,
    toolCount,
    topToolName: firstTool?.toolName ?? null,
    topToolHash: firstTool?.sourceInputHash ?? null,
    topToolValue: firstTool?.valuePreview ?? null,
    eventCount,
    modelCallCount: viewModel.budget.usedModelCalls,
    terminalStatus: viewModel.status,
    stopReason: viewModel.stopReason ?? null,
    answerHeadline:
      answerPreview.headline || answerPreview.fullPlainText || null,
    isTerminal,
  };
}
