/**
 * 天轭 Zygos · 研究工作台规范视图与契约类型定义 (T0 冻结版)
 *
 * 依据：《天轭前端Demo重构方案_评委版.md》第 6、8、11、12 节
 * 核心红线：
 *   1. candidateVerified 严格恒为 false（保留“尚未形式化验证”明确说明）。
 *   2. 真实执行语义与保真：不伪造角色意见、不伪造并发、不把未执行节点画成完成。
 *   3. 状态与证据分离：主图仅承载轻量结构，深度事实按 evidenceId 动态或按需挂载。
 */

import type { StopReason } from "@astra/web-contract";
import type { RunStatus, RunEventEnvelope } from "../reduceRun";

/** 页面三大顶层展示状态 (方案 4.1 节) */
export type WorkspaceMode = "unstarted" | "running" | "completed";

/** 四大宏观机制阶段 (方案 6.1 节) */
export type MacroStageId =
  | "stage_1_planning"   // 题意与规划 (R0三角色、义务与方法路由)
  | "stage_2_execution"  // 有界研究执行 (任务单元、数学资产、多路线共识)
  | "stage_3_review"     // 过程审查与修复 (R2质询、REPAIR子候选、R4复核)
  | "stage_4_delivery";  // 终态交付 (统一交付策略、候选/未解/失败)

export interface MacroStageMeta {
  readonly id: MacroStageId;
  readonly name: string;
  readonly subtitle: string;
  readonly order: number;
}

export const MACRO_STAGES: readonly MacroStageMeta[] = [
  { id: "stage_1_planning", name: "题意与规划", subtitle: "R0角色审阅 · 义务拆解 · 方法路由", order: 1 },
  { id: "stage_2_execution", name: "有界研究执行", subtitle: "就绪任务 · 数学资产调用 · 答案闭合", order: 2 },
  { id: "stage_3_review", name: "过程审查与修复", subtitle: "R2质询 · 受控子候选 · R4复核准入", order: 3 },
  { id: "stage_4_delivery", name: "终态交付", subtitle: "权威交付决策 · 证据覆盖 · 边界说明", order: 4 },
];

/** 节点运行状态（严禁将“未触发”与“未记录”混淆，方案 6.3 节） */
export type NodeExecutionStatus =
  | "pending"     // 等待执行
  | "running"     // 正在执行
  | "completed"   // 成功完成
  | "skipped"     // 依据规则跳过
  | "untriggered" // 本次预算/条件未触发（如未触发修复）
  | "failed"      // 执行失败/异常
  | "unrecorded"; // 历史记录缺失细节

/** 节点连线语义类别 (方案 4.3 节) */
export type EdgeKind =
  | "sequence"    // 顺序推进
  | "dependency"  // 数据或产物依赖
  | "evidence"    // 证据支持引用
  | "repair_loop";// 修复/复核回流

export interface ResearchEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: EdgeKind;
  readonly label?: string;
}

/** 统一节点详情数据结构 (方案 6.3 节统一模板) */
export interface ResearchNode {
  readonly id: string;
  readonly stage: MacroStageId;
  readonly label: string;
  /** 一句话：这一步要解决什么 */
  readonly summary: string;
  readonly status: NodeExecutionStatus;
  /** 耗时（ms），仅在真实数据可用时展示 */
  readonly durationMs?: number | null;
  /** 本次输入：关联题目、目标、任务、真实参数或候选 */
  readonly inputSummary?: string;
  /** 本次产出：意见、公式、结果表、候选或修订 */
  readonly outputSummary?: string;
  /** 依据与边界：工具回执、审查引用、验证范围、未知项 */
  readonly rationale?: string;
  /** 关联前置、使用资产或产物版本 */
  readonly relations?: {
    readonly taskId?: string;
    readonly assetName?: string;
    readonly candidateId?: string;
    readonly artifactVersion?: string;
  };
  /** 关联的具体证据引用 ID */
  readonly evidenceId?: string;
  /** 技术详情：事件编号与受控原始 payload（默认折叠） */
  readonly technical?: {
    readonly seq?: number;
    readonly eventKind?: string;
    readonly raw?: unknown;
  };
}

/** 结构化证据项 (方案 8.2 节) */
export interface ResearchEvidence {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly kind: "tool_receipt" | "model_opinion" | "review_challenge" | "repair_decision" | "contract" | "checkpoint";
  readonly timestamp?: number;
  /** 采用 Markdown/KaTeX 排版的详细正文 */
  readonly markdownContent: string;
  /** 验证标志：红线恒为 false，除非形式化逻辑完备 */
  readonly verified: false;
  readonly sourceEventSeq?: number;
  readonly rawPayload?: unknown;
}

/** 预算与资源消耗统计 (方案 4.1、6.1 节) */
export interface ResearchBudgetStats {
  readonly maxModelCalls: number;
  readonly usedModelCalls: number;
  readonly maxMethodLoads: number;
  readonly usedMethodLoads: number;
  readonly maxWorkUnits: number;
  readonly usedWorkUnits: number;
  readonly elapsedMs: number;
  readonly commitHash?: string;
}

/** 同题恢复能力状态机 (方案 9.2、9.3 节) */
export interface RecoveryEligibility {
  /** 是否满足恢复前置条件 */
  readonly eligible: boolean;
  /** 无法恢复时的明确业务原因 */
  readonly reason?: string;
  /** 可用于恢复的检查点事件序号与时间戳 */
  readonly checkpointSeq?: number;
  readonly checkpointTime?: number;
  readonly remainingBudget?: Partial<ResearchBudgetStats>;
}

/** 统一研究视图根模型 (ResearchView 冻结契约) */
export interface ResearchViewModel {
  readonly runId: string;
  readonly problem: string;
  readonly mode: WorkspaceMode;
  readonly status: RunStatus;
  readonly stopReason: StopReason | null;
  /** 恒为 false */
  readonly candidateVerified: false;
  readonly currentStage: MacroStageId;
  readonly nodes: readonly ResearchNode[];
  readonly edges: readonly ResearchEdge[];
  readonly evidences: Readonly<Record<string, ResearchEvidence>>;
  readonly budget: ResearchBudgetStats;
  readonly recovery: RecoveryEligibility;
  readonly finalAnswer?: string;
  readonly unresolvedObligations?: readonly string[];
  readonly rawEvents: readonly RunEventEnvelope[];
}
