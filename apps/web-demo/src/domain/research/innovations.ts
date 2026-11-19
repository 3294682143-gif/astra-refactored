/**
 * 代码实证创新机制投影器（纯前端推导，100% 对齐最新分支源码）
 *
 * 对照源码：
 *   - packages/math-contract/src/p2-compiler.ts (M1 题型分类、义务集合、任务 DAG 依赖编译)
 *   - apps/stdio-runtime/src/agent-semantics.ts (8 维数学结构签名与统一数学计算资产路由)
 *   - apps/stdio-runtime/src/agent-loop.ts (R2/R4 审查、REPAIR 有界退避、Answer Closure 闭环)
 */

import type { NodeExecutionStatus, ResearchViewModel } from "./types";

export type P2GoalKind =
  | "VALUE"
  | "ALL_SOLUTIONS"
  | "COUNT"
  | "OPTIMIZATION"
  | "PROOF"
  | "PARAMETER"
  | "MULTIPART"
  | "UNKNOWN";

export interface P2GoalMeta {
  readonly kind: P2GoalKind;
  readonly label: string;
  readonly description: string;
}

const GOAL_KIND_LABELS: Readonly<Record<P2GoalKind, { label: string; description: string }>> = {
  VALUE: { label: "数值 / 表达式求值 (VALUE)", description: "确立定义域、候选合法性、独立第二推导与输出覆盖" },
  ALL_SOLUTIONS: { label: "全解与完备集合 (ALL_SOLUTIONS)", description: "追加边界例外检验与全解完备性汇聚任务" },
  COUNT: { label: "计数与去重构造 (COUNT)", description: "核对计数对象基准、不重不漏与独立复算" },
  OPTIMIZATION: { label: "极值与最优化 (OPTIMIZATION)", description: "拆分可行域、全局界约束与取等可达性" },
  PROOF: { label: "严谨逻辑证明 (PROOF)", description: "显式拆解前提、量词结构与核心证明目标" },
  PARAMETER: { label: "参数分类讨论 (PARAMETER)", description: "覆盖参数域划分与退化临界情形" },
  MULTIPART: { label: "多小问复合结构 (MULTIPART)", description: "按 (a)(b)... 子问并行扇出并汇聚子目标覆盖" },
  UNKNOWN: { label: "保守通用模板 (UNKNOWN)", description: "多类命中或无明确关键词时保持保守通用三义务" },
};

const KIND_OBLIGATIONS: Readonly<Record<P2GoalKind, readonly string[]>> = {
  VALUE: ["DOMAIN_VALIDITY", "CANDIDATE_VALIDITY", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  ALL_SOLUTIONS: [
    "DOMAIN_VALIDITY",
    "CANDIDATE_VALIDITY",
    "BOUNDARY_EXCEPTIONS",
    "EXHAUSTIVENESS",
    "INDEPENDENT_DERIVATION",
    "OUTPUT_COVERAGE",
  ],
  COUNT: ["COUNT_OBJECTS", "NO_DUPLICATES", "EXHAUSTIVENESS", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  OPTIMIZATION: ["FEASIBILITY", "GLOBAL_BOUND", "ATTAINMENT", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  PROOF: ["PREMISES", "QUANTIFIERS", "PROOF_GOAL", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  PARAMETER: ["DOMAIN_VALIDITY", "BOUNDARY_EXCEPTIONS", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  MULTIPART: ["SUBGOAL_COVERAGE", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
  UNKNOWN: ["ANSWER_REQUEST", "INDEPENDENT_DERIVATION", "OUTPUT_COVERAGE"],
};

const OBLIGATION_ZH: Readonly<Record<string, { title: string; role: string }>> = {
  DOMAIN_VALIDITY: { title: "定义域合法性", role: "校验前置条件与变量取值约束" },
  CANDIDATE_VALIDITY: { title: "候选答案合法性", role: "构建与检验核心候选结论" },
  BOUNDARY_EXCEPTIONS: { title: "边界与退化例外", role: "排查端点、零因子与临界分枝" },
  EXHAUSTIVENESS: { title: "解集完备性聚合", role: "汇聚候选与边界约束以证明无遗漏" },
  COUNT_OBJECTS: { title: "计数对象界定", role: "明确组合/计数样本空间与准则" },
  NO_DUPLICATES: { title: "无重复计数校验", role: "确认等价类划分无重叠计入" },
  FEASIBILITY: { title: "可行域校验", role: "核实最优化约束边界可达" },
  GLOBAL_BOUND: { title: "全局上/下界论证", role: "证明目标函数在全域内的界" },
  ATTAINMENT: { title: "取等可达点构造", role: "给出到达最值的具体构型" },
  PREMISES: { title: "前提条件梳理", role: "显式声明引用的公理与题设" },
  QUANTIFIERS: { title: "量词作用域检验", role: "校验全称/存在量词与顺序" },
  PROOF_GOAL: { title: "核心命题推导", role: "构建从前提到结论的完整推演链" },
  SUBGOAL_COVERAGE: { title: "子目标覆盖汇总", role: "确认所有拆分子问结果完整收口" },
  INDEPENDENT_DERIVATION: { title: "独立第二推导", role: "脱离首条思路重新核算并核对一致性" },
  OUTPUT_COVERAGE: { title: "终态输出覆盖汇总", role: "汇聚前置所有义务产物并对齐题面要求" },
  ANSWER_REQUEST: { title: "核心答案请求", role: "针对命题核心提问形成候选回答" },
};

const ALL_SOLUTIONS_PATTERN = /(?:全部|所有)(?:实数|复数)?解|all\s+(?:real\s+|complex\s+)?solutions?/;
const MULTIPART_PART_PATTERN = /(?:^|[\s,;:。；：])(?:\(([a-h])\)|([a-h])\))\s*\S/gu;
const KEYWORD_RULES: readonly (readonly [P2GoalKind, readonly string[]])[] = [
  ["COUNT", ["number of", "how many", "计数", "个数"]],
  ["OPTIMIZATION", ["maximum", "minimum", "maximize", "minimize", "最大", "最小"]],
  ["PROOF", ["prove", "proof", "证明"]],
  ["VALUE", ["compute", "evaluate", "calculate", "计算", "求值"]],
];
const PARAMETER_SUBJECT_PATTERN = /parameter|参数/;
const PARAMETER_REQUEST_PATTERN =
  /classify|classification|分类|取值范围|range of values|value of the parameter|parameter values?/;

export function detectMultipartLabels(problem: string): readonly string[] {
  const labels: string[] = [];
  for (const match of problem.matchAll(MULTIPART_PART_PATTERN)) {
    const label = match[1] ?? match[2];
    if (typeof label !== "string") continue;
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length < 2) return [];
  const sorted = [...labels].sort();
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] !== sorted[i]) return [];
  }
  return labels;
}

export function selectP2GoalKindClient(problem: string): P2GoalKind {
  if (!problem.trim()) return "UNKNOWN";
  const lowered = problem.toLowerCase();
  if (detectMultipartLabels(problem).length >= 2) return "MULTIPART";
  if (PARAMETER_SUBJECT_PATTERN.test(lowered) && PARAMETER_REQUEST_PATTERN.test(lowered)) {
    return "PARAMETER";
  }
  if (ALL_SOLUTIONS_PATTERN.test(lowered)) {
    return "ALL_SOLUTIONS";
  }
  const matched: P2GoalKind[] = [];
  for (const [kind, words] of KEYWORD_RULES) {
    if (words.some((w) => lowered.includes(w))) {
      matched.push(kind);
    }
  }
  return matched.length === 1 ? matched[0] : "UNKNOWN";
}

export interface TaskDagNodeView {
  readonly taskId: string;
  readonly goalId: string;
  readonly obligationKind: string;
  readonly title: string;
  readonly roleDesc: string;
  readonly layer: 1 | 2 | 3;
  readonly dependencyTaskIds: readonly string[];
  readonly status: NodeExecutionStatus;
  readonly artifactId?: string;
  readonly artifactVersion?: number;
  readonly sourceRequestId?: string;
  readonly nodeId?: string;
}

export interface TaskDagEdgeView {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly source: "compiler" | "runtime_receipt";
}

export interface P2TaskDagProjection {
  readonly goalMeta: P2GoalMeta;
  readonly contractVersion: number;
  readonly multipartLabels: readonly string[];
  readonly tasks: readonly TaskDagNodeView[];
  readonly edges: readonly TaskDagEdgeView[];
  readonly executedArtifactCount: number;
  readonly runtimeDependencyCount: number;
}

export interface StructuralDimensionItem {
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  readonly matched: boolean;
}

export interface ToolReceiptProjection {
  readonly id: string;
  readonly toolName: string;
  readonly status: string;
  readonly exactness?: string;
  readonly taskId?: string;
  readonly sourceInputHash?: string;
  readonly valuePreview?: string;
  readonly nodeId?: string;
}

export interface StructuralRoutingProjection {
  readonly totalCatalogAssets: 26;
  readonly totalCatalogBehaviors: 96;
  readonly dimensions: readonly StructuralDimensionItem[];
  readonly matchedCount: number;
  readonly methodRoutes: readonly string[];
  readonly loadedMethods: readonly string[];
  readonly toolReceipts: readonly ToolReceiptProjection[];
}

export interface ControlPlaneSummary {
  readonly reviewCount: number;
  readonly reviewChallengesCount: number;
  readonly repairAttempts: number;
  readonly repairRejected: number;
  readonly forcedRetries: number;
  readonly refutationRequests: number;
  readonly closureDefects: number;
}

export interface CodebaseInnovationsProjection {
  readonly taskDag: P2TaskDagProjection;
  readonly routing: StructuralRoutingProjection;
  readonly controlPlane: ControlPlaneSummary;
}

function obligationMeta(kind: string): { title: string; role: string } {
  if (kind.startsWith("cover:")) {
    const sub = kind.slice("cover:".length);
    return { title: `汇总子问 ${sub}`, role: `归并子目标 ${sub} 的终态输出` };
  }
  return OBLIGATION_ZH[kind] ?? { title: kind, role: "P2 合同研究义务任务" };
}

export function scanStructuralDimensionsClient(problem: string): StructuralDimensionItem[] {
  return [
    {
      key: "hasPermutationCycles",
      title: "置换群与轮换词",
      hint: "s_n / permutation / cycle / 对换",
      matched: /(?:s_\d+|置换|轮换|对换|permutation|disjoint cycle|sigma\^|\\sigma\^|\\tau\^|\(\d+\s+\d+)/iu.test(problem),
    },
    {
      key: "hasLaurentOrParametricMatrixDet",
      title: "Laurent / 参数行列式",
      hint: "Alexander / knot / polynomial matrix",
      matched: /(?:alexander|knot|laurent|纽结|亚历山大|多项式矩阵|fitting ideal|minor_submatrix|参数矩阵行列式)/iu.test(problem),
    },
    {
      key: "hasRecurrenceOrMarkovStationary",
      title: "递推与马尔可夫稳态",
      hint: "a_{n+k} / 特征多项式 / 平稳分布",
      matched: /(?:a_\{?n\+?\d*\}?|x_\{?n\+?\d*\}?|线性递推|特征多项式|通解|平稳分布|不变测度|转移概率|随机游走|调和函数|Lf\s*=\s*0|stationary distribution|recurrence)/iu.test(problem),
    },
    {
      key: "hasStatisticalInference",
      title: "统计推断与分位数",
      hint: "MLE / Fisher / 置信区间 / quantile",
      matched: /(?:似然|mle|fisher|极大似然|正态分位数|标准正态|正态函数|\\Phi\s*\(|置信区间|显著性|anova|残差平方和|ols|quantile|hypothesis test)/iu.test(problem),
    },
    {
      key: "hasTopologyOrManifoldAxioms",
      title: "拓扑流形与同调群",
      hint: "同调群 / H_k / Hausdorff / 紧致 / 单纯形",
      matched: /(?:拓扑|开集|闭集|hausdorff|t_[0-4]|紧致|连通|单纯形|欧拉示性数|同调群|betti|fundamental group|simplicial)/iu.test(problem),
    },
    {
      key: "hasDifferentialOperatorOrODE",
      title: "微分算子与常微方程",
      hint: "Laplacian / 曲率 / 散度 / ODE",
      matched: /(?:微分算子|拉普拉斯|laplac|曲率|梯度|散度|旋度|二阶常微分|初值问题|differential equation)/iu.test(problem),
    },
    {
      key: "hasNumberTheoryCongruence",
      title: "数论同余与整除链",
      hint: "pmod / 同余 / 丢番图 / 原根",
      matched: /(?:\\pmod|同余|整除|丢番图|原根|二次剩余|diophantine|congruence)/iu.test(problem),
    },
    {
      key: "hasFormalProofOrCounterexample",
      title: "形式逻辑与反例判定",
      hint: "全称命题 / 反例 / 可判定 / 重言式",
      matched: /(?:下列命题|反例|可判定|tautology|重言式|真值表|全称命题|证明义务|counterexample)/iu.test(problem),
    },
  ];
}

export interface CompiledTaskTemplate {
  readonly taskId: string;
  readonly goalId: string;
  readonly obligationKind: string;
  readonly deps: string[];
}

export function compileP2TemplateClient(problem: string): {
  goalMeta: P2GoalMeta;
  multipartLabels: readonly string[];
  compiledTasks: CompiledTaskTemplate[];
} {
  const multipartLabels = detectMultipartLabels(problem);
  const goalKind = selectP2GoalKindClient(problem);
  const goalMeta: P2GoalMeta = { kind: goalKind, ...GOAL_KIND_LABELS[goalKind] };
  const compiledTasks: CompiledTaskTemplate[] = [];

  if (goalKind === "MULTIPART" && multipartLabels.length >= 2) {
    const leafObs = KIND_OBLIGATIONS.VALUE;
    for (const lbl of multipartLabels) {
      const subGoalId = `goal-1-${lbl}`;
      const subIds: string[] = [];
      for (const ob of leafObs) {
        const tid = `${subGoalId}:${ob}`;
        subIds.push(tid);
        compiledTasks.push({
          taskId: tid,
          goalId: subGoalId,
          obligationKind: ob,
          deps: ob === "OUTPUT_COVERAGE" ? subIds.filter((id) => id !== tid) : [],
        });
      }
      compiledTasks.push({
        taskId: `goal-1:cover:${subGoalId}`,
        goalId: "goal-1",
        obligationKind: `cover:${subGoalId}`,
        deps: [`${subGoalId}:OUTPUT_COVERAGE`],
      });
    }
    compiledTasks.push({
      taskId: "goal-1:OUTPUT_COVERAGE",
      goalId: "goal-1",
      obligationKind: "OUTPUT_COVERAGE",
      deps: multipartLabels.map((lbl) => `goal-1:cover:goal-1-${lbl}`),
    });
  } else {
    const obs = KIND_OBLIGATIONS[goalKind];
    const allGoalTaskIds = obs.map((ob) => `goal-1:${ob}`);
    for (const ob of obs) {
      const tid = `goal-1:${ob}`;
      let deps: string[] = [];
      if (ob === "EXHAUSTIVENESS") {
        deps = ["goal-1:CANDIDATE_VALIDITY", "goal-1:BOUNDARY_EXCEPTIONS"].filter((id) =>
          allGoalTaskIds.includes(id)
        );
      } else if (ob === "OUTPUT_COVERAGE") {
        deps = allGoalTaskIds.filter((id) => id !== tid);
      }
      compiledTasks.push({ taskId: tid, goalId: "goal-1", obligationKind: ob, deps });
    }
  }

  return { goalMeta, multipartLabels, compiledTasks };
}

export function extractInnovationsProjection(viewModel: ResearchViewModel): CodebaseInnovationsProjection {
  const problem = viewModel.problem || "";
  const { goalMeta, multipartLabels, compiledTasks } = compileP2TemplateClient(problem);

  // Extract runtime task & artifact state from real events
  let contractVersion = viewModel.r0Reading?.contractVersion ?? 1;
  const startedTasks = new Set<string>();
  const workByTaskId = new Map<
    string,
    {
      artifactId?: string;
      artifactVersion?: number;
      deliveryStatus?: string;
      sourceRequestId?: string;
      nodeId: string;
      depArtifactIds: string[];
    }
  >();
  const taskIdByArtifactId = new Map<string, string>();
  const methodRoutesSet = new Set<string>(viewModel.multiAgentSolving?.methodRoutes ?? []);
  const loadedMethodsSet = new Set<string>();
  const toolReceiptMap = new Map<string, ToolReceiptProjection>();

  let reviewCount = 0;
  let reviewChallengesCount = 0;
  let repairAttempts = 0;
  let repairRejected = 0;
  let forcedRetries = 0;
  let refutationRequests = 0;

  const fallbackNodesEvents = (Array.isArray(viewModel.nodes) ? viewModel.nodes : [])
    .map((n) => ({
      seq: n.technical?.seq ?? 0,
      kind: n.technical?.eventKind ?? "",
      type: n.technical?.eventKind ?? "",
      payload: n.technical?.raw as Record<string, unknown> | undefined,
      data: n.technical?.raw as Record<string, unknown> | undefined,
    }))
    .filter((ev) => Boolean(ev.kind));

  const sourceEvents =
    Array.isArray(viewModel.rawEvents) && viewModel.rawEvents.length > 0
      ? viewModel.rawEvents
      : fallbackNodesEvents;

  for (const ev of sourceEvents) {
    const kind = ev.kind || ev.type || "";
    const p = ((ev.payload ?? ev.data ?? {}) || {}) as Record<string, unknown>;
    const seq = ev.seq ?? 0;

    if ((kind === "CONTRACT" || kind === "CONTRACT_REVISED") && typeof p.contractVersion === "number") {
      contractVersion = p.contractVersion;
    } else if (kind === "TASK_STARTED" && typeof p.taskId === "string") {
      startedTasks.add(p.taskId);
    } else if (kind === "WORKUNIT") {
      const taskId = typeof p.taskId === "string" ? p.taskId : `work-${seq}`;
      const artifactId = typeof p.artifactId === "string" ? p.artifactId : undefined;
      const artifactVersion = typeof p.artifactVersion === "number" ? p.artifactVersion : undefined;
      const deliveryStatus = typeof p.deliveryStatus === "string" ? p.deliveryStatus : "COMPLETE";
      const sourceRequestId = typeof p.sourceRequestId === "string" ? p.sourceRequestId : undefined;
      const depArtifactIds: string[] = [];

      const wr = p.workReceipt as Record<string, unknown> | undefined;
      if (wr && typeof wr.text === "string") {
        try {
          const parsed = JSON.parse(wr.text) as { dependencies?: unknown };
          if (Array.isArray(parsed.dependencies)) {
            for (const dep of parsed.dependencies) {
              if (dep && typeof dep === "object" && typeof (dep as Record<string, unknown>).artifactId === "string") {
                depArtifactIds.push(String((dep as Record<string, unknown>).artifactId));
              }
            }
          }
        } catch {
          // ignore non-JSON receipt text
        }
      }

      if (artifactId) {
        taskIdByArtifactId.set(artifactId, taskId);
      }
      workByTaskId.set(taskId, {
        artifactId,
        artifactVersion,
        deliveryStatus,
        sourceRequestId,
        nodeId: `node-work-${seq}`,
        depArtifactIds,
      });
    } else if (kind === "METHOD_LOAD") {
      const m = p.method ?? p.methodId ?? p.name;
      if (typeof m === "string" && m.trim()) loadedMethodsSet.add(m.trim());
    } else if (kind === "TOOL_OBSERVATION" || kind === "effect_returned") {
      const innerTool =
        p.TOOL_OBSERVATION && typeof p.TOOL_OBSERVATION === "object"
          ? (p.TOOL_OBSERVATION as Record<string, unknown>)
          : null;
      const innerEff =
        p.effect_returned && typeof p.effect_returned === "object"
          ? (p.effect_returned as Record<string, unknown>)
          : null;
      const merged = innerTool || innerEff ? { ...innerEff, ...innerTool, ...p } : p;
      const cid = String(merged.id || merged.effectId || `seq-${seq}`);
      const toolName = String(
        merged.tool || merged.name || merged.action || "math_asset",
      );
      let exactness: string | undefined = toolReceiptMap.get(cid)?.exactness;
      let taskId: string | undefined = toolReceiptMap.get(cid)?.taskId;
      let sourceInputHash: string | undefined =
        toolReceiptMap.get(cid)?.sourceInputHash;
      let valuePreview: string | undefined = toolReceiptMap.get(cid)?.valuePreview;

      const obs = Array.isArray(merged.observation)
        ? merged.observation
        : Array.isArray(merged.output)
          ? merged.output
          : null;
      if (obs && obs.length > 0 && obs[0] && typeof obs[0] === "object") {
        const first = obs[0] as Record<string, unknown>;
        if (typeof first.exactness === "string") exactness = first.exactness;
        if (typeof first.taskId === "string") taskId = first.taskId;
        if (typeof first.sourceInputHash === "string")
          sourceInputHash = first.sourceInputHash;
        if (first.value !== undefined) {
          valuePreview = `${String(first.quantity || toolName)} = ${JSON.stringify(first.value)}`;
        }
      }

      const rawStatus = String(
        merged.status || toolReceiptMap.get(cid)?.status || "COMPLETE",
      );
      toolReceiptMap.set(cid, {
        id: cid,
        toolName,
        status: rawStatus,
        exactness,
        taskId,
        sourceInputHash,
        valuePreview,
        nodeId: `node-tool-${cid}`,
      });
    } else if (kind === "REVIEW_CHALLENGE" && String(p.round || "").toUpperCase() !== "R0") {
      reviewCount += 1;
      reviewChallengesCount += Number(p.challenges ?? 0);
    } else if (kind === "REPAIR") {
      const rk = String(p.kind || "");
      if (rk === "METHOD_ROUTE" && Array.isArray(p.candidates)) {
        for (const c of p.candidates) {
          if (typeof c === "string" && c.trim()) methodRoutesSet.add(c.trim());
        }
      } else if (rk === "FORCED_TURN_RETRY") {
        forcedRetries += 1;
      } else if (rk === "REFUTATION_REQUEST") {
        refutationRequests += 1;
      } else if (rk === "REPAIR_PACKET_REJECTED" || p.rejected === true) {
        repairRejected += 1;
        repairAttempts += 1;
      } else {
        repairAttempts += 1;
      }
    } else if ((kind === "RESULT" || kind === "FINAL") && p.metrics && typeof p.metrics === "object") {
      const m = p.metrics as Record<string, unknown>;
      if (Array.isArray(m.method_ids)) {
        const hasLoad = typeof m.method_loads === "number" && m.method_loads > 0;
        for (const mid of m.method_ids) {
          if (typeof mid === "string" && mid.trim()) {
            methodRoutesSet.add(mid.trim());
            if (hasLoad) loadedMethodsSet.add(mid.trim());
          }
        }
      }
      if (reviewCount === 0) {
        const r2 = typeof m.r2_review_calls === "number" ? m.r2_review_calls : 0;
        const r4 = typeof m.r4_review_calls === "number" ? m.r4_review_calls : 0;
        if (r2 + r4 > 0) reviewCount = r2 + r4;
      }
      if (reviewChallengesCount === 0) {
        const c2 = typeof m.r2_challenges === "number" ? m.r2_challenges : 0;
        const c4 = typeof m.r4_challenges === "number" ? m.r4_challenges : 0;
        if (c2 + c4 > 0) reviewChallengesCount = c2 + c4;
      }
      if (repairAttempts === 0) {
        const rep = typeof m.repair_model_calls === "number" ? m.repair_model_calls : 0;
        if (rep > 0) repairAttempts = rep;
      }
      if (repairRejected === 0) {
        const rej =
          (typeof m.repair_rejected === "number" ? m.repair_rejected : 0) +
          (typeof m.repair_packet_rejected === "number" ? m.repair_packet_rejected : 0);
        if (rej > 0) repairRejected = rej;
      }
    }
  }

  // Merge compiled tasks with any dynamic WORKUNIT tasks observed at runtime
  const seenTaskIds = new Set(compiledTasks.map((t) => t.taskId));
  for (const runtimeTaskId of workByTaskId.keys()) {
    if (!seenTaskIds.has(runtimeTaskId)) {
      seenTaskIds.add(runtimeTaskId);
      const parts = runtimeTaskId.split(":");
      compiledTasks.push({
        taskId: runtimeTaskId,
        goalId: parts[0] || "goal-1",
        obligationKind: parts.slice(1).join(":") || runtimeTaskId,
        deps: [],
      });
    }
  }

  const edges: TaskDagEdgeView[] = [];
  const edgeSeen = new Set<string>();
  const pushEdge = (fromTaskId: string, toTaskId: string, source: TaskDagEdgeView["source"]) => {
    const key = `${fromTaskId}->${toTaskId}`;
    if (fromTaskId === toTaskId) return;
    const existingIdx = edges.findIndex((e) => `${e.fromTaskId}->${e.toTaskId}` === key);
    if (existingIdx >= 0) {
      if (source === "runtime_receipt") {
        edges[existingIdx] = { fromTaskId, toTaskId, source: "runtime_receipt" };
      }
      return;
    }
    edgeSeen.add(key);
    edges.push({ fromTaskId, toTaskId, source });
  };

  for (const t of compiledTasks) {
    for (const d of t.deps) {
      pushEdge(d, t.taskId, "compiler");
    }
    const w = workByTaskId.get(t.taskId);
    if (w) {
      for (const depArtId of w.depArtifactIds) {
        const depTaskId = taskIdByArtifactId.get(depArtId);
        if (depTaskId) {
          pushEdge(depTaskId, t.taskId, "runtime_receipt");
        }
      }
    }
  }

  // Assign topological layers cleanly: Layer 1 (roots), Layer 2 (intermediate), Layer 3 (sinks like OUTPUT_COVERAGE)
  const taskNodes: TaskDagNodeView[] = compiledTasks.map((t) => {
    const w = workByTaskId.get(t.taskId);
    const meta = obligationMeta(t.obligationKind);
    const status: NodeExecutionStatus = w
      ? w.deliveryStatus === "BLOCKED"
        ? "failed"
        : "completed"
      : startedTasks.has(t.taskId)
      ? "running"
      : viewModel.mode === "unstarted"
      ? "pending"
      : "untriggered";

    const layer: 1 | 2 | 3 = t.taskId.endsWith(":OUTPUT_COVERAGE")
      ? 3
      : t.deps.length > 0
      ? 2
      : 1;

    return {
      taskId: t.taskId,
      goalId: t.goalId,
      obligationKind: t.obligationKind,
      title: meta.title,
      roleDesc: meta.role,
      layer,
      dependencyTaskIds: t.deps,
      status,
      artifactId: w?.artifactId,
      artifactVersion: w?.artifactVersion,
      sourceRequestId: w?.sourceRequestId,
      nodeId: w?.nodeId,
    };
  });

  const runtimeDependencyCount = edges.filter((e) => e.source === "runtime_receipt").length;

  const dimensions = scanStructuralDimensionsClient(problem);
  const matchedCount = dimensions.filter((d) => d.matched).length;

  return {
    taskDag: {
      goalMeta,
      contractVersion,
      multipartLabels,
      tasks: taskNodes,
      edges,
      executedArtifactCount: workByTaskId.size,
      runtimeDependencyCount,
    },
    routing: {
      totalCatalogAssets: 26,
      totalCatalogBehaviors: 96,
      dimensions,
      matchedCount,
      methodRoutes: Array.from(methodRoutesSet),
      loadedMethods: Array.from(loadedMethodsSet),
      toolReceipts: Array.from(toolReceiptMap.values()),
    },
    controlPlane: {
      reviewCount,
      reviewChallengesCount,
      repairAttempts,
      repairRejected,
      forcedRetries,
      refutationRequests,
      closureDefects: viewModel.multiAgentSolving?.closure?.defects?.length ?? 0,
    },
  };
}
