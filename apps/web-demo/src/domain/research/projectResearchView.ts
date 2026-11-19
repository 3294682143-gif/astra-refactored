/**
 * 统一研究视图模型投影器 (T0 / T2 纯函数投影)
 *
 * 依据：《天轭前端Demo重构方案_评委版.md》第 6、8、11.2 节
 * 保证：
 *   1. 纯函数：不依赖浏览器全局变量，不发起网络请求，不修改入参。
 *   2. 保真度：节点与状态严格依据 events 真实事实映射，不臆造角色意见与依赖。
 *   3. 红线红守：candidateVerified 恒为 false。
 */

import type { RunViewState, RunEventEnvelope } from "../reduceRun";
import { toPlainAnswerText } from "./plainAnswer";
import type {
  ResearchViewModel,
  WorkspaceMode,
  MacroStageId,
  ResearchNode,
  ResearchEdge,
  ResearchEvidence,
  ResearchBudgetStats,
  RecoveryEligibility,
  NodeExecutionStatus,
  R0RoleKind,
  R0RoleAgentView,
  ThreeAgentReadingView,
  MultiAgentBallotView,
  ConsensusVoteGroupView,
  MultiAgentAuditView,
  MultiAgentCertificateView,
  MultiAgentClosureView,
  MultiAgentSolvingView,
} from "./types";

function extractPayload(event: RunEventEnvelope): Record<string, unknown> {
  const p = event.payload ?? event.data;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

export interface ProjectResearchViewOptions {
  serverBaseline?: Partial<ResearchViewModel>;
  isReplay?: boolean;
}

export function projectRunToResearchView(
  state: RunViewState,
  problemText?: string,
  options?: ProjectResearchViewOptions
): ResearchViewModel {
  const isTerminal = [
    "candidate",
    "unsolved",
    "aborted",
    "error",
    "timeout",
    "failed",
    "cancelled",
    "finished",
  ].includes(state.status);

  const mode: WorkspaceMode =
    !state.runId || state.status === "idle"
      ? "unstarted"
      : isTerminal
      ? "completed"
      : "running";

  const nodes: ResearchNode[] = [];
  const edges: ResearchEdge[] = [];
  const evidences: Record<string, ResearchEvidence> = {};
  const toolNodeMap = new Map<string, ResearchNode>();

  let currentStage: MacroStageId = "stage_1_planning";
  let resolvedProblem = problemText || "";
  let finalAnswerText: string | undefined = state.candidateProposal || undefined;

  let modelCallCount = 0;
  let methodLoadCount = 0;
  let workUnitCount = 0;
  let lastTimestamp = 0;
  let firstTimestamp = 0;

  // Per-request live & historical model telemetry
  const dispatchedAtMap = new Map<string, number>();
  const requestPhaseMap = new Map<string, string>();
  const requestLatencyMs = new Map<string, number>();
  const inFlightRequestsMap = new Map<string, string>();
  const r0OrderedRequestIds: string[] = [];

  // R0 三角色读题状态累积
  const R0_ROLE_META: Record<R0RoleKind, { title: string; dimension: string; focus: string }> = {
    MEANING: {
      title: "题意对齐审查",
      dimension: "PROBLEM_ALIGNMENT",
      focus: "核对命题条件、边界约束、量化对象与目标一致",
    },
    METHOD: {
      title: "方法与域审查",
      dimension: "SCOPE",
      focus: "核对解题路线、领域域边界、反例风险与适用定理",
    },
    TASK_TOOL: {
      title: "任务与工具审查",
      dimension: "TASK_COVERAGE",
      focus: "核对子任务拆分完整性与计算资产/脚本调度需求",
    },
  };
  let r0BudgetEnabled: boolean | null = null;
  const seenR0Roles = new Set<string>();
  let seenR0Aggregate = false;
  const r0RoleMap = new Map<R0RoleKind, R0RoleAgentView>([
    ["MEANING", { role: "MEANING", ...R0_ROLE_META.MEANING, status: "untriggered", verdict: null, issueCount: 0 }],
    ["METHOD", { role: "METHOD", ...R0_ROLE_META.METHOD, status: "untriggered", verdict: null, issueCount: 0 }],
    ["TASK_TOOL", { role: "TASK_TOOL", ...R0_ROLE_META.TASK_TOOL, status: "untriggered", verdict: null, issueCount: 0 }],
  ]);
  let r0AggregateConclusion: "NO_ISSUE" | "ISSUES" | "UNKNOWN" | null = null;
  let r0IssueDimensions: string[] = [];
  let r0StageAction: string | null = null;
  let r0StageReason: string | null = null;
  let r0RevisionTriggered = false;
  let r0RecheckObserved = false;
  let r0ContractVersion = 1;
  let r0ObligationsCount: number | null = null;
  let r0TasksCount: number | null = null;

  // 多-Agent 协同求解状态累积 (5+2+1 共识 + 资产闭环)
  const INDEPENDENT_LENS_FALLBACKS: readonly { title: string; desc: string }[] = [
    { title: "直推符号与条件核验视角", desc: "沿原始数学陈述独立展开完整推导并逐项校验前提" },
    { title: "对偶变换与等价重表征视角", desc: "尝试变换变量、几何/代数等价转译后重新独立求解" },
    { title: "极端边界与反例构造视角", desc: "优先检验边界值、退化情形与潜在反例以锁定唯一解" },
    { title: "不变量与模约化交叉视角", desc: "借助守恒量、对称性或商结构进行跨尺度独立计算" },
    { title: "逆向代回与完备性证明视角", desc: "从候选答案反向代回原约束并核查解集完备无遗漏" },
  ];
  let maxConsensusBudget: number | null = null;
  let totalWorkModelCalls = 0;
  let totalConsensusModelCalls = 0;
  let seedCandidateRaw: string | undefined = undefined;
  let seedNodeId: string | undefined = undefined;
  let seedEvidenceId: string | undefined = undefined;
  const independentBallots: MultiAgentBallotView[] = [];
  const audits: MultiAgentAuditView[] = [];
  let certificateState: MultiAgentCertificateView = {
    observed: false,
    agreement: null,
    certificateChecks: null,
    certificateCertified: null,
    auditOverrideDetected: false,
  };
  let closureState: MultiAgentClosureView = {
    observed: false,
    closureRequested: false,
    observationViews: 0,
    observationUsed: false,
    candidateChanged: false,
    defects: [],
    remainingDefects: [],
  };
  const methodRoutesSet = new Set<string>();
  const closureDefectsSet = new Set<string>();

  function normalizeVerdict(raw: unknown): "NO_ISSUE" | "ISSUES" | "UNKNOWN" | null {
    const s = String(raw || "").toUpperCase();
    if (s === "NO_ISSUE" || s === "PASS" || s === "PASSED" || s === "OK") return "NO_ISSUE";
    if (s === "ISSUES" || s === "ISSUE" || s === "FAIL" || s === "REJECT" || s === "CHALLENGE") return "ISSUES";
    if (s === "UNKNOWN") return "UNKNOWN";
    return null;
  }

  function upsertR0Role(
    role: R0RoleKind,
    verdict: "NO_ISSUE" | "ISSUES" | "UNKNOWN" | null,
    issueCount: number,
    dimensionRaw: unknown,
    requestId: string | undefined,
    nodeId: string | undefined,
    evidenceId: string | undefined
  ) {
    const prev = r0RoleMap.get(role)!;
    const req = requestId || prev.requestId;
    const lat = req && requestLatencyMs.has(req) ? requestLatencyMs.get(req)! : prev.latencyMs ?? null;
    const status: R0RoleAgentView["status"] =
      verdict === "ISSUES" ? "failed" : verdict !== null ? "completed" : prev.status;
    r0RoleMap.set(role, {
      ...prev,
      dimension: typeof dimensionRaw === "string" && dimensionRaw ? dimensionRaw : prev.dimension,
      status,
      verdict: verdict ?? prev.verdict,
      issueCount: Number.isFinite(issueCount) ? issueCount : prev.issueCount,
      requestId: req,
      latencyMs: lat,
      nodeId: nodeId || prev.nodeId,
      evidenceId: evidenceId || prev.evidenceId,
    });
  }

  // 遍历事件流投影机制节点与证据
  for (const ev of state.events) {
    const kind = ev.kind || ev.type || "";
    const payload = extractPayload(ev);
    const seq = ev.seq;
    const at = ev.at || ev.ts;

    if (at) {
      if (!firstTimestamp) firstTimestamp = at;
      lastTimestamp = at;
    }

    if (kind === "SESSION_INIT") {
      if (typeof payload.problem === "string" && !resolvedProblem) {
        resolvedProblem = payload.problem;
      }
      const budgets = payload.budgets;
      if (budgets && typeof budgets === "object") {
        const b = budgets as Record<string, unknown>;
        if (typeof b.maxR0 === "number") r0BudgetEnabled = b.maxR0 > 0;
        if (typeof b.maxConsensus === "number") maxConsensusBudget = b.maxConsensus;
      }
    }

    if (kind === "MODEL_REQUEST" || kind === "model_dispatched") {
      modelCallCount++;
      const reqId = String(payload.requestId || payload.id || `req-${seq}`);
      const phase = String(payload.phase || "WORK").toUpperCase();
      requestPhaseMap.set(reqId, phase);
      if (at) dispatchedAtMap.set(reqId, at);
      inFlightRequestsMap.set(reqId, phase);

      if (phase === "R0") {
        r0OrderedRequestIds.push(reqId);
        const roleOrder: R0RoleKind[] = ["MEANING", "METHOD", "TASK_TOOL"];
        const slot = (r0OrderedRequestIds.length - 1) % 3;
        const targetRole = roleOrder[slot];
        const prev = r0RoleMap.get(targetRole)!;
        if (prev.verdict === null) {
          r0RoleMap.set(targetRole, {
            ...prev,
            status: "running",
            requestId: reqId,
          });
        }
      } else if (phase === "WORK") {
        totalWorkModelCalls++;
      } else if (phase === "CONSENSUS") {
        totalConsensusModelCalls++;
      }
    }

    if (kind === "model_returned") {
      const reqId = String(payload.requestId || payload.id || "");
      const phase = String(payload.phase || requestPhaseMap.get(reqId) || "").toUpperCase();
      if (reqId) {
        inFlightRequestsMap.delete(reqId);
        const startAt = dispatchedAtMap.get(reqId);
        if (at && startAt && at >= startAt) {
          requestLatencyMs.set(reqId, at - startAt);
        }
        if (phase === "R0") {
          for (const role of ["MEANING", "METHOD", "TASK_TOOL"] as const) {
            const cur = r0RoleMap.get(role)!;
            if (cur.requestId === reqId) {
              r0RoleMap.set(role, {
                ...cur,
                status: cur.verdict === "ISSUES" ? "failed" : "completed",
                latencyMs: requestLatencyMs.get(reqId) ?? cur.latencyMs ?? null,
              });
            }
          }
        }
      }
    }

    if (kind === "R0_REVIEW") {
      currentStage = "stage_1_planning";
      r0BudgetEnabled = true;
      const roleRaw = String(payload.role || "").toUpperCase();
      if (payload.recheck === true) {
        r0RecheckObserved = true;
      }

      if (roleRaw === "MEANING" || roleRaw === "METHOD" || roleRaw === "TASK_TOOL") {
        const role = roleRaw as R0RoleKind;
        seenR0Roles.add(`${role}:${payload.recheck ? "recheck" : "init"}`);
        const verdict = normalizeVerdict(payload.verdict) ?? "UNKNOWN";
        const issueCount = Number(payload.issueCount ?? 0);
        const reqId = typeof payload.requestId === "string" ? payload.requestId : undefined;
        const meta = R0_ROLE_META[role];
        const nodeId = `node-r0-${role.toLowerCase()}-${seq}`;
        const evidenceId = `ev-r0-${role.toLowerCase()}-${seq}`;
        const latencyMs = reqId && requestLatencyMs.has(reqId) ? requestLatencyMs.get(reqId)! : null;

        upsertR0Role(role, verdict, issueCount, payload.dimension, reqId, nodeId, evidenceId);

        nodes.push({
          id: nodeId,
          stage: "stage_1_planning",
          label: `R0 读题 · ${meta.title}`,
          summary: `${meta.focus}（结论：${verdict}${issueCount > 0 ? ` · ${issueCount} 项关注点` : ""}）`,
          status: verdict === "ISSUES" ? "failed" : "completed",
          durationMs: latencyMs,
          inputSummary: resolvedProblem || "原始数学命题",
          outputSummary: `维度 ${payload.dimension || meta.dimension} · 结论 ${verdict}`,
          rationale: "R0 三方并行独立审题协议，彼此隔离不交叉污染",
          relations: reqId ? { taskId: reqId } : undefined,
          evidenceId,
          technical: { seq, eventKind: kind, raw: payload },
        });

        evidences[evidenceId] = {
          id: evidenceId,
          runId: state.runId,
          title: `R0 独立读题审查：${meta.title}`,
          kind: "review_challenge",
          timestamp: at,
          markdownContent: `### ${meta.title} (${role})\n\n* **审查维度**：${payload.dimension || meta.dimension}\n* **审查结论**：${verdict}\n* **关注/问题数**：${issueCount}\n* **关联请求**：${reqId || "未记录"}${latencyMs !== null ? `\n* **真实响应耗时**：${(latencyMs / 1000).toFixed(2)} s` : ""}\n\n> ${meta.focus}`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      } else if (roleRaw === "AGGREGATE") {
        seenR0Aggregate = true;
        const conclusion = normalizeVerdict(payload.conclusion ?? payload.verdict) ?? "UNKNOWN";
        r0AggregateConclusion = conclusion;
        if (Array.isArray(payload.issueDimensions)) {
          r0IssueDimensions = payload.issueDimensions.map((d) => String(d));
        }
        if (conclusion === "ISSUES") {
          r0RevisionTriggered = true;
        }
        const nodeId = `node-r0-aggregate-${seq}`;
        const evidenceId = `ev-r0-aggregate-${seq}`;
        nodes.push({
          id: nodeId,
          stage: "stage_1_planning",
          label: "R0 三方读题聚合门控",
          summary: `确定性聚合三角色评审结论：${conclusion}${r0IssueDimensions.length ? `（涉及维度：${r0IssueDimensions.join(" / ")}）` : ""}`,
          status: conclusion === "ISSUES" ? "failed" : "completed",
          inputSummary: "MEANING / METHOD / TASK_TOOL 三方独立评审结果",
          outputSummary: `聚合结论：${conclusion}`,
          rationale: "确定性汇总门控：任一方发现关键歧义或漏项即触发规划合同修订与重审",
          evidenceId,
          technical: { seq, eventKind: kind, raw: payload },
        });
        evidences[evidenceId] = {
          id: evidenceId,
          runId: state.runId,
          title: "R0 读题确定性聚合结论",
          kind: "review_challenge",
          timestamp: at,
          markdownContent: `### R0 读题聚合结论\n\n* **最终结论**：${conclusion}\n* **问题维度**：${r0IssueDimensions.length ? r0IssueDimensions.join(", ") : "无"}\n* **是否复检**：${payload.recheck ? "是 (Recheck)" : "首轮聚合"}`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      } else if (roleRaw === "STAGE") {
        r0StageAction = typeof payload.action === "string" ? payload.action : null;
        r0StageReason = typeof payload.reason === "string" ? payload.reason : null;
        if (r0StageAction === "REVISE" || r0StageAction === "REVISED") {
          r0RevisionTriggered = true;
        }
      }
    }

    if (kind === "CONTRACT" || kind === "CONTRACT_REVISED") {
      currentStage = "stage_1_planning";
      const obligations = payload.obligations ?? "若干";
      const tasks = payload.tasks ?? "若干";
      const contractVersion = Number(payload.contractVersion ?? (kind === "CONTRACT_REVISED" ? r0ContractVersion + 1 : 1));
      r0ContractVersion = contractVersion;
      if (typeof payload.obligations === "number") r0ObligationsCount = payload.obligations;
      if (typeof payload.tasks === "number") r0TasksCount = payload.tasks;
      if (kind === "CONTRACT_REVISED") {
        r0RevisionTriggered = true;
      }

      const node: ResearchNode = {
        id: `node-contract-${seq}`,
        stage: "stage_1_planning",
        label: kind === "CONTRACT_REVISED" ? `规划合同修订 (v${contractVersion})` : "题意解析与合同义务",
        summary: `确立 v${contractVersion} 执行合同：${obligations} 项证明义务与 ${tasks} 个子任务`,
        status: "completed",
        inputSummary: resolvedProblem || "当前数学命题",
        outputSummary: `合同版本 v${contractVersion}，分派 ${tasks} 项研究任务`,
        rationale: kind === "CONTRACT_REVISED" ? "依据 R0 读题聚合反馈执行合同增量修订" : "依据形式化约束与题目结构化解析协议",
        relations: { artifactVersion: `v${contractVersion}` },
        evidenceId: `ev-contract-${seq}`,
        technical: { seq, eventKind: kind, raw: payload },
      };
      nodes.push(node);

      evidences[`ev-contract-${seq}`] = {
        id: `ev-contract-${seq}`,
        runId: state.runId,
        title: kind === "CONTRACT_REVISED" ? `规划合同修订记录 (v${contractVersion})` : "题意解析与规划义务合同",
        kind: "contract",
        timestamp: at,
        markdownContent: `### 题目命题\n\n${resolvedProblem || "未记录题目文本"}\n\n### 规划合同义务 (v${contractVersion})\n\n* **义务总数**：${obligations}\n* **子任务数**：${tasks}\n* **状态**：${kind === "CONTRACT_REVISED" ? "已完成 R0 后修订重编" : "已准入并初始化工作视图"}`,
        verified: false,
        sourceEventSeq: seq,
        rawPayload: payload,
      };
    }

    if (kind === "METHOD_LOAD") {
      methodLoadCount++;
      currentStage = "stage_2_execution";
      const methodId = String(payload.methodId || "algebra_v1");
      const rationale = String(payload.rationale || "加载针对性数学方法卡");

      const node: ResearchNode = {
        id: `node-method-${seq}`,
        stage: "stage_2_execution",
        label: `方法路由: ${methodId}`,
        summary: rationale,
        status: "completed",
        inputSummary: `方法标识: ${methodId}`,
        outputSummary: "完成方法卡准入与上下文绑定",
        rationale,
        technical: { seq, eventKind: kind, raw: payload },
      };
      nodes.push(node);
    }

    if (kind === "TOOL_OBSERVATION" || kind === "effect_returned") {
      currentStage = "stage_2_execution";
      const callId = String(payload.effectId || payload.id || `tool-${seq}`);
      const toolName = String(payload.tool || payload.name || "math_tool");
      const rawArgs = payload.args;
      const rawObs = payload.observation !== undefined ? payload.observation : payload.result;
      const statusVal = String(payload.status || "").toUpperCase();
      const checkRes = String(payload.checkResult || "").toUpperCase();
      const errVal = payload.error || payload.reason;
      const isFailed =
        ["ERROR", "FAILED", "FAILURE"].includes(statusVal) ||
        ["FAILURE", "REJECTED"].includes(checkRes) ||
        Boolean(payload.error);

      const evId = `ev-tool-${callId}`;
      const nodeId = `node-tool-${callId}`;

      const existingNode = toolNodeMap.get(callId);
      if (existingNode) {
        const ev = evidences[evId];
        let assetName = existingNode.relations?.assetName || toolName;
        if (
          toolName !== "math_tool" &&
          (!existingNode.relations?.assetName || existingNode.relations.assetName === "math_tool")
        ) {
          assetName = toolName;
        }

        const newStatus: NodeExecutionStatus =
          isFailed || existingNode.status === "failed" ? "failed" : "completed";
        const newLabel = newStatus === "failed" ? `资产调用失败: ${assetName}` : `资产调用: ${assetName}`;

        let inputSummary = existingNode.inputSummary;
        if (rawArgs !== undefined) {
          inputSummary = typeof rawArgs === "object" ? JSON.stringify(rawArgs, null, 2) : String(rawArgs);
        }

        let outputSummary = existingNode.outputSummary;
        if (rawObs !== undefined) {
          outputSummary = typeof rawObs === "object" ? JSON.stringify(rawObs, null, 2) : String(rawObs);
        } else if (
          errVal !== undefined &&
          (!outputSummary || outputSummary === "回执与观测未记录")
        ) {
          outputSummary = String(errVal);
        }

        const updatedRaw =
          existingNode.technical?.raw && typeof existingNode.technical.raw === "object"
            ? { ...existingNode.technical.raw, [kind]: payload }
            : { [kind]: payload };

        const updatedNode: ResearchNode = {
          ...existingNode,
          status: newStatus,
          label: newLabel,
          relations: { ...existingNode.relations, assetName },
          inputSummary,
          outputSummary,
          technical: {
            ...existingNode.technical,
            raw: updatedRaw,
          },
        };

        toolNodeMap.set(callId, updatedNode);
        const nodeIdx = nodes.findIndex((n) => n.id === nodeId);
        if (nodeIdx >= 0) {
          nodes[nodeIdx] = updatedNode;
        }

        if (ev) {
          const stStr = newStatus === "failed" ? "调用失败" : "调用成功";
          evidences[evId] = {
            ...ev,
            title: `数学资产调用回执: ${assetName}`,
            markdownContent: `### 资产名称\n\`${assetName}\`\n\n### 执行状态\n\`${stStr}\`\n\n### 调用参数\n\`\`\`\n${inputSummary}\n\`\`\`\n\n### 真实返回与观测\n\`\`\`\n${outputSummary}\n\`\`\``,
            rawPayload: updatedRaw,
          };
        }
      } else {
        const formattedArgs =
          rawArgs !== undefined
            ? typeof rawArgs === "object"
              ? JSON.stringify(rawArgs, null, 2)
              : String(rawArgs)
            : "调用参数未记录";
        let formattedObs = "回执与观测未记录";
        if (rawObs !== undefined) {
          formattedObs = typeof rawObs === "object" ? JSON.stringify(rawObs, null, 2) : String(rawObs);
        } else if (errVal !== undefined) {
          formattedObs = String(errVal);
        }

        const st: NodeExecutionStatus = isFailed ? "failed" : "completed";
        const lbl = isFailed ? `资产调用失败: ${toolName}` : `资产调用: ${toolName}`;

        const node: ResearchNode = {
          id: nodeId,
          stage: "stage_2_execution",
          label: lbl,
          summary: `调用领域数学计算资产 ${toolName} 进行符号与结构验算`,
          status: st,
          inputSummary: formattedArgs,
          outputSummary: formattedObs,
          rationale: "统一数学资产执行回执与观测",
          evidenceId: evId,
          relations: { assetName: toolName },
          technical: { seq, eventKind: kind, raw: { [kind]: payload } },
        };
        toolNodeMap.set(callId, node);
        nodes.push(node);

        const stStr = isFailed ? "调用失败" : "调用成功";
        evidences[evId] = {
          id: evId,
          runId: state.runId,
          title: `数学资产调用回执: ${toolName}`,
          kind: "tool_receipt",
          timestamp: at,
          markdownContent: `### 资产名称\n\`${toolName}\`\n\n### 执行状态\n\`${stStr}\`\n\n### 调用参数\n\`\`\`\n${formattedArgs}\n\`\`\`\n\n### 真实返回与观测\n\`\`\`\n${formattedObs}\n\`\`\``,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      }
    }

    if (kind === "WORKUNIT") {
      workUnitCount++;
      currentStage = "stage_2_execution";
      const proposal = typeof payload.candidateProposal === "string" ? payload.candidateProposal : "";
      if (proposal) finalAnswerText = proposal;

      const node: ResearchNode = {
        id: `node-work-${seq}`,
        stage: "stage_2_execution",
        label: `研究工作单元 #${workUnitCount}`,
        summary: "根据数学资产与推导生成阶段性候选推演",
        status: "completed",
        inputSummary: `任务项 ${payload.taskId || workUnitCount}`,
        outputSummary: proposal ? proposal.slice(0, 120) + (proposal.length > 120 ? "..." : "") : "产出推导片段",
        rationale: "单步推导与形式化目标闭合",
        evidenceId: `ev-work-${seq}`,
        technical: { seq, eventKind: kind, raw: payload },
      };
      nodes.push(node);

      if (proposal) {
        evidences[`ev-work-${seq}`] = {
          id: `ev-work-${seq}`,
          runId: state.runId,
          title: `工作单元推导候选 #${workUnitCount}`,
          kind: "model_opinion",
          timestamp: at,
          markdownContent: `### 推导内容\n\n${proposal}\n\n> [!NOTE]\n> 本推导系研究单元生成候选，尚未通过形式化验证。`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      }
    }

    if (kind === "REVIEW_CHALLENGE" || kind === "REPAIR") {
      if (kind === "REPAIR" && String(payload.kind || "") === "METHOD_ROUTE" && Array.isArray(payload.candidates)) {
        for (const c of payload.candidates) {
          if (typeof c === "string" && c.trim()) {
            methodRoutesSet.add(c.trim());
          }
        }
      }

      const roundTag = String(payload.round || "").toUpperCase();
      if (kind === "REVIEW_CHALLENGE" && roundTag === "R0") {
        currentStage = "stage_1_planning";
        r0BudgetEnabled = true;
        const roleRaw = String(payload.role || "").toUpperCase();
        const recheckSuffix = payload.recheck ? "recheck" : "init";
        if (roleRaw === "MEANING" || roleRaw === "METHOD" || roleRaw === "TASK_TOOL") {
          const role = roleRaw as R0RoleKind;
          const verdict = normalizeVerdict(payload.verdict) ?? "UNKNOWN";
          const issueCount = Number(payload.issueCount ?? 0);
          if (!seenR0Roles.has(`${role}:${recheckSuffix}`)) {
            seenR0Roles.add(`${role}:${recheckSuffix}`);
            const meta = R0_ROLE_META[role];
            const nodeId = `node-r0-${role.toLowerCase()}-${seq}`;
            const evidenceId = `ev-r0-${role.toLowerCase()}-${seq}`;
            upsertR0Role(role, verdict, issueCount, payload.dimension, undefined, nodeId, evidenceId);
            nodes.push({
              id: nodeId,
              stage: "stage_1_planning",
              label: `R0 读题 · ${meta.title}`,
              summary: String(payload.rationale || `${meta.focus}（结论：${verdict}）`),
              status: verdict === "ISSUES" ? "failed" : "completed",
              inputSummary: resolvedProblem || "原始数学命题",
              outputSummary: `结论 ${verdict}`,
              rationale: "R0 三方独立审题协议",
              evidenceId,
              technical: { seq, eventKind: kind, raw: payload },
            });
            evidences[evidenceId] = {
              id: evidenceId,
              runId: state.runId,
              title: `R0 独立读题审查：${meta.title}`,
              kind: "review_challenge",
              timestamp: at,
              markdownContent: `### ${meta.title} (${role})\n\n* **结论**：${verdict}\n* **说明**：${payload.rationale || meta.focus}`,
              verified: false,
              sourceEventSeq: seq,
              rawPayload: payload,
            };
          }
        } else if (roleRaw === "AGGREGATE") {
          if (!seenR0Aggregate) {
            seenR0Aggregate = true;
            const conclusion = normalizeVerdict(payload.verdict ?? payload.conclusion) ?? "UNKNOWN";
            r0AggregateConclusion = conclusion;
            if (Array.isArray(payload.issueDimensions)) {
              r0IssueDimensions = payload.issueDimensions.map((d) => String(d));
            }
            const nodeId = `node-r0-aggregate-${seq}`;
            const evidenceId = `ev-r0-aggregate-${seq}`;
            nodes.push({
              id: nodeId,
              stage: "stage_1_planning",
              label: "R0 三方读题聚合门控",
              summary: String(payload.rationale || `聚合结论：${conclusion}`),
              status: conclusion === "ISSUES" ? "failed" : "completed",
              inputSummary: "MEANING / METHOD / TASK_TOOL 三方评审结果",
              outputSummary: `聚合结论：${conclusion}`,
              rationale: "R0 确定性聚合门控",
              evidenceId,
              technical: { seq, eventKind: kind, raw: payload },
            });
            evidences[evidenceId] = {
              id: evidenceId,
              runId: state.runId,
              title: "R0 读题确定性聚合结论",
              kind: "review_challenge",
              timestamp: at,
              markdownContent: `### R0 读题聚合结论\n\n* **最终结论**：${conclusion}\n* **说明**：${payload.rationale || ""}`,
              verified: false,
              sourceEventSeq: seq,
              rawPayload: payload,
            };
          }
        }
        continue;
      }

      currentStage = "stage_3_review";
      const rationale = String(payload.rationale || payload.reason || "专家与审查机制复核");
      const isChallenge = kind === "REVIEW_CHALLENGE";
      const specialKind = String(payload.kind || "");
      const decision = String(payload.decision || "");
      const rawStatus = String(payload.status || "");
      const challengesCount = Number(payload.challenges || 0);

      const isRejected =
        payload.rejected === true ||
        ["rejected", "REVISE_REJECTED", "REJECT", "failed"].includes(decision) ||
        ["rejected", "failed"].includes(rawStatus) ||
        ["G2_ROUTE_REJECT", "G2_ROUTE_CONTEXT_REJECTED", "REPAIR_PACKET_REJECTED"].includes(specialKind) ||
        (isChallenge && challengesCount > 0);

      const isAccepted =
        payload.accepted === true ||
        ["accepted", "ADMIT", "passed", "admitted"].includes(decision) ||
        ["completed", "passed", "accepted"].includes(rawStatus) ||
        ["G2_ROUTE_ADMIT", "G2_ROUTE_PICK"].includes(specialKind);

      let nodeStatus: ResearchNode["status"] = "completed";
      let decisionLabel = "合规受控";
      let decisionSummary = `审查记录：${rationale}`;
      let nodeLabel = isChallenge ? "独立审查与质询 (R2/R4)" : "受控修复机制 (REPAIR)";

      if (isRejected) {
        nodeStatus = "failed";
        decisionLabel = "拒绝准入";
        decisionSummary = `准入决策：已拒绝 (${rationale})`;
        nodeLabel = isChallenge ? "审查质询 (发现缺陷/未通过)" : "受控修复机制 (REPAIR - 拒绝准入)";
      } else if (isAccepted) {
        nodeStatus = "completed";
        decisionLabel = "合规准入";
        decisionSummary = `准入决策：已通过准入 (${rationale})`;
        nodeLabel = isChallenge ? "独立审查与质询 (R2/R4 - 已复核)" : "受控修复机制 (REPAIR - 准入生效)";
      }

      const node: ResearchNode = {
        id: `node-review-${seq}`,
        stage: "stage_3_review",
        label: nodeLabel,
        summary: rationale,
        status: nodeStatus,
        inputSummary: "阶段候选与前置证明链",
        outputSummary: decisionSummary,
        rationale: "依据反例搜索、边界检查与代数一致性",
        evidenceId: `ev-review-${seq}`,
        technical: { seq, eventKind: kind, raw: payload },
      };
      nodes.push(node);

      evidences[`ev-review-${seq}`] = {
        id: `ev-review-${seq}`,
        runId: state.runId,
        title: isChallenge
          ? isRejected
            ? "审查与质询发现"
            : "审查与复核结论"
          : isRejected
          ? "修复修订拒绝记录"
          : "修复准入与修订记录",
        kind: isChallenge ? "review_challenge" : "repair_decision",
        timestamp: at,
        markdownContent: `### 审查依据与结论\n\n${rationale}\n\n* **审查类型**：${
          isChallenge ? "专家交叉复核" : "受控反例修复"
        }\n* **准入决策**：${decisionLabel}\n* **复核结论**：${
          isRejected
            ? "未通过准入门禁，修订已废弃并回流"
            : isAccepted
            ? "已通过合规审查并准入生效"
            : "已完成过程记录"
        }`,
        verified: false,
        sourceEventSeq: seq,
        rawPayload: payload,
      };
    }

    if (kind === "CONSENSUS") {
      const stageRaw = String(payload.stage || "").toUpperCase();
      const reqId = typeof payload.requestId === "string" ? payload.requestId : undefined;
      const latencyMs = reqId && requestLatencyMs.has(reqId) ? requestLatencyMs.get(reqId)! : null;
      const prevCand = typeof payload.previousCandidate === "string" ? payload.previousCandidate : undefined;
      const nextCand = typeof payload.nextCandidate === "string" ? payload.nextCandidate : undefined;
      const agreement = typeof payload.agreement === "boolean" ? payload.agreement : null;

      if (!seedCandidateRaw && prevCand) {
        seedCandidateRaw = prevCand;
      }

      if (stageRaw === "INDEPENDENT") {
        currentStage = "stage_2_execution";
        const idx = Number(payload.round ?? independentBallots.length + 1);
        const fallback = INDEPENDENT_LENS_FALLBACKS[(Math.max(1, idx) - 1) % INDEPENDENT_LENS_FALLBACKS.length];
        const lensTitle = String(payload.lensTitle || payload.lens || payload.perspective || fallback.title);
        const lensDescription = String(payload.lensDescription || fallback.desc);
        const nodeId = `node-consensus-independent-${seq}`;
        const evidenceId = `ev-consensus-independent-${seq}`;
        const candPlain = nextCand ? toPlainAnswerText(nextCand) : undefined;
        const canonicalKey = nextCand ? (toPlainAnswerText(nextCand) || nextCand).replace(/\s+/g, " ").trim().toLowerCase() : undefined;

        independentBallots.push({
          id: `ballot-ind-${idx}-${seq}`,
          kind: "INDEPENDENT",
          index: idx,
          roleLabel: `独立盲解 #${idx}`,
          lensTitle,
          lensDescription,
          requestId: reqId,
          status: "completed",
          latencyMs,
          candidateRaw: nextCand,
          candidatePlain: candPlain,
          agreesWithPrevious: agreement,
          canonicalKey,
          nodeId,
          evidenceId,
        });

        nodes.push({
          id: nodeId,
          stage: "stage_2_execution",
          label: `多 Agent 盲解 #${idx} · ${lensTitle}`,
          summary: `屏蔽历史候选独立重算，输出候选答案${candPlain ? `：${candPlain.slice(0, 60)}` : ""}`,
          status: "completed",
          durationMs: latencyMs,
          inputSummary: `旋转求解视角：${lensTitle}`,
          outputSummary: candPlain ? `独立候选：${candPlain.slice(0, 80)}` : "完成独立推导",
          rationale: "Blind Independent Solve：隔离上下文与前置答案，防止共识从众",
          relations: reqId ? { taskId: reqId } : undefined,
          evidenceId,
          technical: { seq, eventKind: kind, raw: payload },
        });
        evidences[evidenceId] = {
          id: evidenceId,
          runId: state.runId,
          title: `独立盲解 #${idx} (${lensTitle})`,
          kind: "model_opinion",
          timestamp: at,
          markdownContent: `### 独立盲解轮次 #${idx}\n\n* **探索视角**：${lensTitle}\n* **与上一轮候选一致**：${agreement === true ? "一致" : agreement === false ? "分歧" : "未比对"}\n* **输出摘要**：${candPlain || "（无文本候选）"}${latencyMs !== null ? `\n* **模型耗时**：${(latencyMs / 1000).toFixed(2)} s` : ""}`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      } else if (stageRaw === "AUDIT") {
        currentStage = "stage_3_review";
        const idx = audits.length + 1;
        const modeRaw = String(payload.auditMode || payload.mode || (idx % 2 === 1 ? "COUNTEREXAMPLE" : "PROOF_AUDIT"));
        const modeLabel =
          modeRaw.toUpperCase().includes("COUNTER")
            ? "反例攻防与边界证伪"
            : "证明链严密性与步骤审计";
        const nodeId = `node-consensus-audit-${seq}`;
        const evidenceId = `ev-consensus-audit-${seq}`;
        const prevPlain = prevCand ? toPlainAnswerText(prevCand) : undefined;
        const nextPlain = nextCand ? toPlainAnswerText(nextCand) : undefined;

        audits.push({
          id: `audit-${idx}-${seq}`,
          index: idx,
          modeLabel,
          requestId: reqId,
          latencyMs,
          previousCandidate: prevCand,
          nextCandidate: nextCand,
          previousPlain: prevPlain,
          nextPlain: nextPlain,
          agreement,
          nodeId,
          evidenceId,
        });

        nodes.push({
          id: nodeId,
          stage: "stage_3_review",
          label: `锚定对抗审计 #${idx} · ${modeLabel}`,
          summary:
            agreement === false
              ? `对抗审计检出分歧或修正了主票候选（${nextPlain?.slice(0, 50) || "已修订"}）`
              : `对抗审计维持多数派主票结论（一致确认）`,
          status: agreement === false ? "failed" : "completed",
          durationMs: latencyMs,
          inputSummary: prevPlain ? `待审主票：${prevPlain.slice(0, 60)}` : "多数派汇总候选",
          outputSummary: agreement === false ? "提出修订或风险标注" : "确认无推翻性反例或逻辑断层",
          rationale: "Anchored Adversarial Audit：基于投票聚类的主票候选实施高压证伪",
          relations: reqId ? { taskId: reqId } : undefined,
          evidenceId,
          technical: { seq, eventKind: kind, raw: payload },
        });
        evidences[evidenceId] = {
          id: evidenceId,
          runId: state.runId,
          title: `对抗审计 #${idx}：${modeLabel}`,
          kind: "review_challenge",
          timestamp: at,
          markdownContent: `### 对抗审计 #${idx} (${modeLabel})\n\n* **审计结论**：${agreement === false ? "检出分歧/修正候选" : "确认主票成立"}\n* **审计前候选**：${prevPlain || "无"}\n* **审计后候选**：${nextPlain || "无"}`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      } else if (stageRaw === "CERTIFICATE") {
        currentStage = "stage_2_execution";
        const nodeId = `node-consensus-certificate-${seq}`;
        const evidenceId = `ev-consensus-certificate-${seq}`;
        const checks = typeof payload.certificateChecks === "number" ? payload.certificateChecks : null;
        const certified = typeof payload.certificateCertified === "boolean" ? payload.certificateCertified : null;
        const overrideDetected = Boolean(payload.auditOverrideDetected);
        const prevPlain = prevCand ? toPlainAnswerText(prevCand) : undefined;
        const nextPlain = nextCand ? toPlainAnswerText(nextCand) : undefined;

        certificateState = {
          observed: true,
          requestId: reqId,
          latencyMs,
          previousCandidate: prevCand,
          nextCandidate: nextCand,
          previousPlain: prevPlain,
          nextPlain: nextPlain,
          agreement,
          certificateChecks: checks,
          certificateCertified: certified,
          auditOverrideDetected: overrideDetected,
          nodeId,
          evidenceId,
        };

        nodes.push({
          id: nodeId,
          stage: "stage_2_execution",
          label: "CERT1 一致性自检证书",
          summary: `执行确定性检验 ${checks ?? 0} 项 · 候选${agreement === false ? "发生修订" : "保持一致"}（certified=${String(certified ?? false)}）`,
          status: "completed",
          durationMs: latencyMs,
          inputSummary: prevPlain || "当前共识候选",
          outputSummary: nextPlain || "自检输出候选",
          rationale: "CERT1 机制对最终候选做条件回代与独立性自洽核查",
          relations: reqId ? { taskId: reqId } : undefined,
          evidenceId,
          technical: { seq, eventKind: kind, raw: payload },
        });
        evidences[evidenceId] = {
          id: evidenceId,
          runId: state.runId,
          title: "CERT1 结构化自检证书",
          kind: "checkpoint",
          timestamp: at,
          markdownContent: `### CERT1 自检证书\n\n* **核验条目数**：${checks ?? 0}\n* **证书认证标志**：${certified ? "已通过自检项" : "待人工/形式化复核"}\n* **前后一致**：${agreement === true ? "一致" : agreement === false ? "有变更" : "未对比"}\n* **覆盖检测**：${overrideDetected ? "检测到审计覆盖" : "无"}`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      } else if (stageRaw === "ANSWER_CLOSURE") {
        currentStage = "stage_2_execution";
        const nodeId = `node-consensus-closure-${seq}`;
        const evidenceId = `ev-consensus-closure-${seq}`;
        const defects = Array.isArray(payload.defects) ? payload.defects.map((d) => String(d)) : [];
        const remainingDefects = Array.isArray(payload.remainingDefects) ? payload.remainingDefects.map((d) => String(d)) : [];
        for (const d of defects) closureDefectsSet.add(d);
        const obsViews = Number(payload.observationViews ?? 0);
        const obsUsed = Boolean(payload.observationUsed);
        const closureReq = Boolean(payload.closureRequested);
        const candChanged = Boolean(payload.candidateChanged);

        closureState = {
          observed: true,
          closureRequested: closureReq,
          observationViews: obsViews,
          observationUsed: obsUsed,
          candidateChanged: candChanged,
          defects: Array.from(closureDefectsSet),
          remainingDefects,
          previousCandidate: prevCand,
          nextCandidate: nextCand,
          nodeId,
          evidenceId,
        };

        nodes.push({
          id: nodeId,
          stage: "stage_2_execution",
          label: "答案闭合与资产对齐校验",
          summary:
            remainingDefects.length > 0
              ? `存在 ${remainingDefects.length} 项未闭合缺陷（观测视角 ${obsViews} 个）`
              : `全量证明义务与观测视图（${obsViews} 项）闭合通过`,
          status: remainingDefects.length > 0 ? "failed" : "completed",
          inputSummary: `程序计算观测视图 ${obsViews} 项`,
          outputSummary: remainingDefects.length > 0 ? `残余缺陷：${remainingDefects.join("; ")}` : "答案闭合完整无缺陷",
          rationale: "Answer Closure 对齐工具真值观测与最终候选表述，杜绝晚到观测漏引",
          evidenceId,
          technical: { seq, eventKind: kind, raw: payload },
        });
        evidences[evidenceId] = {
          id: evidenceId,
          runId: state.runId,
          title: "答案闭合与工具回执一致性校验",
          kind: "checkpoint",
          timestamp: at,
          markdownContent: `### 答案闭合报告\n\n* **观测视角数**：${obsViews}\n* **是否直接引用观测**：${obsUsed ? "是" : "否"}\n* **触发二次收口请求**：${closureReq ? "是" : "否"}\n* **检出缺陷**：${defects.length ? defects.join(", ") : "无"}\n* **残余缺陷**：${remainingDefects.length ? remainingDefects.join(", ") : "无"}`,
          verified: false,
          sourceEventSeq: seq,
          rawPayload: payload,
        };
      } else if (stageRaw === "LATE_OBSERVATION_DEFECT" || stageRaw === "UNSOLVED_REFUSAL") {
        closureDefectsSet.add(String(payload.reason || payload.defect || stageRaw));
        closureState = {
          ...closureState,
          observed: true,
          defects: Array.from(closureDefectsSet),
        };
      }
    }

    if (kind === "FINAL" || kind === "RESULT") {
      currentStage = "stage_4_delivery";
      const ans = payload.final_response || payload.answer;
      if (typeof ans === "string" && ans) {
        finalAnswerText = ans;
      }
      if (maxConsensusBudget === null && payload.metrics && typeof payload.metrics === "object") {
        const m = payload.metrics as Record<string, unknown>;
        if (typeof m.consensus_independent_ballots === "number" && m.consensus_independent_ballots > 0 && maxConsensusBudget === null) {
          maxConsensusBudget = Number(m.consensus_independent_ballots) + 3;
        }
      }
    }
  }

  // 提取真实未闭合义务清单 (Spec R1 / Spec R3)
  const unresolvedObs: string[] = [];
  for (const ev of state.events) {
    if (ev.kind === "RESULT" || ev.type === "RESULT") {
      const p = extractPayload(ev);
      if (Array.isArray(p.unresolvedObligations)) {
        for (const u of p.unresolvedObligations) {
          if (typeof u === "string") unresolvedObs.push(u);
        }
        break;
      }
    }
  }
  // 服务端基准对齐：若事件流未解项为空但服务端基准中存在权威未解项，如实同步 (Spec R1)
  if (unresolvedObs.length === 0 && Array.isArray(options?.serverBaseline?.unresolvedObligations)) {
    for (const u of options.serverBaseline.unresolvedObligations) {
      if (typeof u === "string") unresolvedObs.push(u);
    }
  }

  // 若已有终态，追加 Stage 4 交付节点
  if (isTerminal || state.resultSeen) {
    currentStage = "stage_4_delivery";
    const stopReasonText = state.stopReason || "REVIEWS_COMPLETE";
    const isSuccessCandidate = state.status === "candidate";

    nodes.push({
      id: "node-delivery-final",
      stage: "stage_4_delivery",
      label: isSuccessCandidate ? "候选结论交付" : "研究收口 (未解/受限)",
      summary: isSuccessCandidate
        ? "满足审查约束，交付可信数学证明候选（待形式化验证）"
        : `因 ${stopReasonText} 终止，交付当前已探索范围与未解说明`,
      status: isSuccessCandidate ? "completed" : "failed",
      outputSummary: finalAnswerText ? finalAnswerText.slice(0, 150) + "..." : "无可用终态答案",
      rationale: `收口原因代码: ${stopReasonText}`,
      technical: {
        eventKind: "RESULT",
        raw: {
          status: state.status,
          stopReason: state.stopReason,
          unresolvedObligations: unresolvedObs,
        },
      },
    });
  }

  // 构建拓扑边（拒绝基于节点位置的猜测，Spec R2）
  // 1. 顺序执行流：工作流中按时间顺序发生的主干演进
  for (let i = 0; i < nodes.length - 1; i++) {
    const cur = nodes[i];
    const nxt = nodes[i + 1];
    edges.push({
      id: `edge-${cur.id}->${nxt.id}`,
      source: cur.id,
      target: nxt.id,
      kind: "sequence",
    });
  }

  // 2. 因果依赖与修复回流：仅在有显式精确引用时建立，严禁按时间或阶段顺序臆造因果 (Spec R2)
  function isWorkRevisionOfReview(subWork: ResearchNode, reviewNode: ResearchNode): boolean {
    const revRaw = (reviewNode.technical?.raw as Record<string, unknown>) || {};
    const workRaw = (subWork.technical?.raw as Record<string, unknown>) || {};

    const targetTask = String(revRaw.targetTaskId || revRaw.targetTask || revRaw.taskId || "").trim();
    const targetWork = String(revRaw.targetWorkUnitId || revRaw.targetNodeId || "").trim();
    const targetArt = String(
      revRaw.targetArtifactId ||
        (revRaw.targetArtifactRef && typeof revRaw.targetArtifactRef === "object"
          ? (revRaw.targetArtifactRef as Record<string, unknown>).artifactId
          : revRaw.targetArtifactRef) ||
        ""
    ).trim();

    // 1. supersedes 声明检查
    const supersedes = workRaw.supersedes;
    if (supersedes) {
      const supArt = String(
        typeof supersedes === "object" && supersedes !== null
          ? (supersedes as Record<string, unknown>).artifactId
          : supersedes
      ).trim();
      const supTask = String(
        typeof supersedes === "object" && supersedes !== null
          ? (supersedes as Record<string, unknown>).taskId || ""
          : ""
      ).trim();
      if (targetArt && supArt === targetArt) return true;
      if (targetTask && (supArt === targetTask || supTask === targetTask)) return true;
      if (targetWork && supArt === targetWork) return true;
    }

    // 2. revisedFrom / parentArtifactId 检查
    const revisedFrom = String(workRaw.revisedFrom || workRaw.parentArtifactId || "").trim();
    if (revisedFrom) {
      if (targetArt && revisedFrom === targetArt) return true;
      if (targetTask && revisedFrom === targetTask) return true;
      if (targetWork && revisedFrom === targetWork) return true;
    }

    // 3. 显式 isRevision / is_repair 且 taskId 匹配 targetTask
    const isRevFlag = Boolean(workRaw.isRevision || workRaw.is_repair || workRaw.isRepair);
    const workTask = String(workRaw.taskId || "").trim();
    if (isRevFlag && targetTask && workTask === targetTask) return true;

    // 4. review 显式指定 targetWorkUnitId 精确匹配 subWork 的 id 或 workUnitId
    const workId = String(workRaw.workUnitId || "").trim();
    if (targetWork && (targetWork === subWork.id || (workId && targetWork === workId))) return true;

    return false;
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.stage === "stage_3_review") {
      // 遍历后续工作节点，仅当存在可追溯的显式修订身份时建立修复回流边；若执行无关任务则保持时间顺序，无回流边 (Spec R2)
      for (const subWork of nodes.slice(i + 1)) {
        if (subWork.stage === "stage_2_execution" && subWork.id.includes("work")) {
          if (isWorkRevisionOfReview(subWork, node)) {
            edges.push({
              id: `edge-repair-${node.id}->${subWork.id}`,
              source: node.id,
              target: subWork.id,
              kind: "repair_loop",
            });
          }
        }
      }
    } else if (node.evidenceId && node.id.includes("tool")) {
      const rawData = (node.technical?.raw as Record<string, unknown>) || {};
      let tRef: string | undefined = undefined;
      for (const val of Object.values(rawData)) {
        if (val && typeof val === "object") {
          const sub = val as Record<string, unknown>;
          if (sub.taskId || sub.workUnitId) {
            tRef = String(sub.taskId || sub.workUnitId).trim();
            break;
          }
        }
      }
      if (tRef) {
        const matchedWork = nodes.find(
          (n) =>
            n.stage === "stage_2_execution" &&
            (((n.technical?.raw as Record<string, unknown>)?.taskId === tRef) ||
              ((n.technical?.raw as Record<string, unknown>)?.workUnitId === tRef) ||
              n.id === tRef)
        );
        if (matchedWork) {
          edges.push({
            id: `edge-evidence-${node.id}->${matchedWork.id}`,
            source: node.id,
            target: matchedWork.id,
            kind: "evidence",
          });
        }
      }
    }
  }

  const durationMs =
    lastTimestamp && firstTimestamp ? Math.max(0, lastTimestamp - firstTimestamp) : 0;

  const budget: ResearchBudgetStats = {
    maxModelCalls: options?.serverBaseline?.budget?.maxModelCalls ?? 32,
    usedModelCalls: modelCallCount,
    maxMethodLoads: options?.serverBaseline?.budget?.maxMethodLoads ?? 4,
    usedMethodLoads: methodLoadCount,
    maxWorkUnits: options?.serverBaseline?.budget?.maxWorkUnits ?? 8,
    usedWorkUnits: workUnitCount,
    elapsedMs: durationMs || (options?.serverBaseline?.budget?.elapsedMs ?? 0),
    commitHash: options?.serverBaseline?.budget?.commitHash,
  };

  // 权威恢复资格：历史回放游标不能改变真实运行的恢复资格
  let recovery: RecoveryEligibility = {
    eligible: false,
    reason: options?.isReplay
      ? "回放模式仅供过程复盘与证据核查，不可由此直接触发恢复"
      : "未检测到可信中间检查点，无法执行受约束续推",
  };
  if (!options?.isReplay && options?.serverBaseline?.recovery) {
    recovery = { ...options.serverBaseline.recovery };
  }

  // 若未从 CONSENSUS 捕获 Seed，从首个含 candidateProposal 的 WORKUNIT 回填真实关联
  const firstWorkWithCandidate = nodes.find(
    (n) =>
      n.id.startsWith("node-work-") &&
      typeof ((n.technical?.raw as Record<string, unknown> | undefined)?.candidateProposal) === "string" &&
      String((n.technical?.raw as Record<string, unknown>).candidateProposal).trim() !== ""
  );
  if (firstWorkWithCandidate) {
    seedNodeId = firstWorkWithCandidate.id;
    seedEvidenceId = firstWorkWithCandidate.evidenceId;
    if (!seedCandidateRaw) {
      seedCandidateRaw = String((firstWorkWithCandidate.technical?.raw as Record<string, unknown>).candidateProposal);
    }
  }

  const allBallots: MultiAgentBallotView[] = [];
  if (seedCandidateRaw) {
    const seedPlain = toPlainAnswerText(seedCandidateRaw);
    const seedKey = (seedPlain || seedCandidateRaw).replace(/\s+/g, " ").trim().toLowerCase();
    allBallots.push({
      id: "ballot-seed-0",
      kind: "SEED",
      index: 0,
      roleLabel: "初始种子候选 (Seed)",
      lensTitle: "主推理链首轮生成",
      lensDescription: "基于规划合同与数学工具观测生成的初始候选解答",
      status: "completed",
      candidateRaw: seedCandidateRaw,
      candidatePlain: seedPlain,
      agreesWithPrevious: null,
      canonicalKey: seedKey,
      nodeId: seedNodeId,
      evidenceId: seedEvidenceId,
    });
  }
  allBallots.push(...independentBallots);

  const voteBucketMap = new Map<
    string,
    {
      displayCandidate: string;
      displayPlain: string;
      count: number;
      ballotLabels: string[];
      firstOrder: number;
    }
  >();
  allBallots.forEach((b, idx) => {
    if (!b.candidateRaw || !b.canonicalKey) return;
    const existing = voteBucketMap.get(b.canonicalKey);
    const label = b.kind === "SEED" ? "Seed" : `Agent #${b.index}`;
    if (existing) {
      existing.count += 1;
      existing.ballotLabels.push(label);
    } else {
      voteBucketMap.set(b.canonicalKey, {
        displayCandidate: b.candidateRaw,
        displayPlain: b.candidatePlain || b.candidateRaw,
        count: 1,
        ballotLabels: [label],
        firstOrder: idx,
      });
    }
  });

  const sortedBuckets = Array.from(voteBucketMap.entries()).sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[1].firstOrder - b[1].firstOrder;
  });
  const topKey = sortedBuckets[0]?.[0];
  const voteGroups: ConsensusVoteGroupView[] = sortedBuckets.map(([key, bucket]) => ({
    key,
    displayCandidate: bucket.displayCandidate,
    displayPlain: bucket.displayPlain,
    count: bucket.count,
    ballotLabels: bucket.ballotLabels,
    isFrontRunner: key === topKey,
  }));
  const frontRunnerCandidate = sortedBuckets[0]?.[1].displayPlain;

  const r0Agents = (["MEANING", "METHOD", "TASK_TOOL"] as const).map((r) => r0RoleMap.get(r)!);
  const anyR0Running = r0Agents.some((a) => a.status === "running");
  const anyR0Done = r0Agents.some((a) => a.status === "completed" || a.status === "failed") || seenR0Aggregate;
  const r0Status: ThreeAgentReadingView["status"] =
    r0BudgetEnabled === false && !anyR0Running && !anyR0Done
      ? "skipped"
      : anyR0Running
      ? "running"
      : anyR0Done
      ? "completed"
      : "idle";

  const computedR0Reading: ThreeAgentReadingView = {
    enabled: r0BudgetEnabled ?? (anyR0Done || anyR0Running ? true : null),
    status: r0Status,
    agents: r0Agents,
    aggregateConclusion: r0AggregateConclusion,
    issueDimensions: r0IssueDimensions,
    stageAction: r0StageAction,
    stageReason: r0StageReason,
    revisionTriggered: r0RevisionTriggered,
    recheckObserved: r0RecheckObserved,
    contractVersion: r0ContractVersion,
    obligationsCount: r0ObligationsCount,
    tasksCount: r0TasksCount,
    totalR0Calls: r0OrderedRequestIds.length,
  };

  const inFlightRequests = Array.from(inFlightRequestsMap.entries()).map(([requestId, phase]) => ({
    requestId,
    phase,
  }));

  const computedMultiAgentSolving: MultiAgentSolvingView = {
    maxConsensusBudget,
    totalWorkModelCalls,
    totalConsensusModelCalls,
    inFlightRequests,
    ballots: allBallots,
    voteGroups,
    frontRunnerCandidate,
    audits,
    certificate: certificateState,
    closure: closureState,
    methodRoutes: Array.from(methodRoutesSet),
  };

  const r0Reading =
    state.events.length === 0 && options?.serverBaseline?.r0Reading
      ? options.serverBaseline.r0Reading
      : computedR0Reading;

  const multiAgentSolving =
    state.events.length === 0 && options?.serverBaseline?.multiAgentSolving
      ? options.serverBaseline.multiAgentSolving
      : computedMultiAgentSolving;

  return {
    runId: state.runId,
    problem: resolvedProblem,
    mode,
    status: state.status,
    stopReason: state.stopReason,
    candidateVerified: false,
    currentStage,
    nodes,
    edges,
    evidences,
    budget,
    recovery,
    finalAnswer: finalAnswerText,
    unresolvedObligations: unresolvedObs,
    r0Reading,
    multiAgentSolving,
    rawEvents: state.events,
  };
}
