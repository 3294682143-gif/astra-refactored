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
    }

    if (kind === "CONTRACT" || kind === "CONTRACT_REVISED") {
      currentStage = "stage_1_planning";
      const obligations = payload.obligations ?? "若干";
      const tasks = payload.tasks ?? "若干";
      const node: ResearchNode = {
        id: `node-contract-${seq}`,
        stage: "stage_1_planning",
        label: "题意解析与合同义务",
        summary: `解析题目目标，确立 ${obligations} 项证明义务与 ${tasks} 个执行阶段`,
        status: "completed",
        inputSummary: resolvedProblem || "当前数学命题",
        outputSummary: `确立目标义务表，分派初始研究任务`,
        rationale: "依据形式化约束与题目结构化解析协议",
        evidenceId: `ev-contract-${seq}`,
        technical: { seq, eventKind: kind, raw: payload },
      };
      nodes.push(node);

      evidences[`ev-contract-${seq}`] = {
        id: `ev-contract-${seq}`,
        runId: state.runId,
        title: "题意解析与规划义务合同",
        kind: "contract",
        timestamp: at,
        markdownContent: `### 题目命题\n\n${resolvedProblem || "未记录题目文本"}\n\n### 规划合同义务\n\n* **义务总数**：${obligations}\n* **子任务数**：${tasks}\n* **状态**：已准入并初始化工作视图`,
        verified: false,
        sourceEventSeq: seq,
        rawPayload: payload,
      };
    }

    if (kind === "MODEL_REQUEST" || kind === "model_dispatched") {
      modelCallCount++;
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

    if (kind === "FINAL" || kind === "RESULT") {
      currentStage = "stage_4_delivery";
      const ans = payload.final_response || payload.answer;
      if (typeof ans === "string" && ans) {
        finalAnswerText = ans;
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
    rawEvents: state.events,
  };
}
