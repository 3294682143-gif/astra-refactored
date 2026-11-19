import React, { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Sparkles,
  BookOpen,
  Sliders,
  Send,
  Play,
  ArrowRight,
  ShieldCheck,
  FileText,
  Boxes,
  ShieldAlert,
  Award,
  ChevronDown,
  ChevronUp,
  GitBranch,
  ScanSearch,
} from "lucide-react";
import { MathMarkdown } from "../../../components/MathMarkdown";
import {
  compileP2TemplateClient,
  scanStructuralDimensionsClient,
} from "../../../domain/research/innovations";

export interface FeaturedCase {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly problem: string;
  readonly realRunId?: string;
  readonly frameCount?: number;
  readonly shortLabel?: string;
  readonly rationale: string;
}

export const FEATURED_CASES: readonly FeaturedCase[] = [
  {
    id: "case-flagship-full",
    title: "【全机制速通旗舰】五次不可约多项式 Galois 分裂域扩张次数精确求解",
    tag: "全机制速通 · 5+2+1全亮",
    shortLabel: "P(x)=x⁵-x-1 (97帧)",
    frameCount: 97,
    problem:
      "设整系数多项式 $P(x) = x^5 - x - 1 \\in \\mathbb{Q}[x]$。结合模素数同余约化不可约性检验、置换群与不变量分析，验证其无有理根且不存在可约反例，并计算 $P(x)$ 在 $\\mathbb{Q}$ 上的分裂域扩张次数 $[E:\\mathbb{Q}]$ 的精确值。",
    rationale:
      "97 帧真实归档 · 4 节点紧凑 DAG + 3 维结构雷达 + math.algebraic-structures:splitting_field_degree (<1s 求解 120) + R0 + 5+2+1（5盲解+2审计+CERT1+闭环）全亮",
    realRunId: "run-f5d6a68618a5",
  },
  {
    id: "case-gf2-complete",
    title: "【实证闭环示范】GF(2) 二元矩阵秩实证求解与双审计闭环",
    tag: "REVIEWS_COMPLETE · 61帧",
    shortLabel: "GF(2) 矩阵秩 (61帧)",
    frameCount: 61,
    problem:
      "在 GF(2) 上求由整数行向量 [13, 10, 7] 表示的 3x4 二元矩阵的秩，并简要给出行化简过程。",
    rationale:
      "61 帧完整归档 · math.linearization-spectral / gf2_rank 实证工具直接计算得 2 + 多专家共识与双轮审查全亮收敛",
    realRunId: "run-99774b9d5167",
  },
  {
    id: "case-flagship-galois",
    title: "【全机制旗舰 1】S6 轮换分解与 x⁵-x-1 伽罗瓦分裂域综合研判",
    tag: "全机制旗舰 · 16节点DAG",
    problem:
      "在 6 次对称群 $S_6$ 与有理多项式环 $\\mathbb{Q}[x]$ 中，考虑置换 $\\sigma = (1\\ 2\\ 3\\ 4\\ 5)$、$\\tau = (1\\ 2\\ 6)$ 与整系数多项式 $P(x) = x^5 - x - 1$（其五个复根记为 $\\alpha_1,\\dots,\\alpha_5$）：\n(a) 将置换复合 $\\sigma^{-2}$ 与共轭元 $\\sigma^{-1}\\tau\\sigma$ 化为不相交轮换乘积；\n(b) 证明全称命题：$P(x)$ 在模素数同余 $\\pmod{2}$ 与 $\\pmod{3}$ 下均无有理根且在 $\\mathbb{Q}[x]$ 上不可约，并检验不存在可约反例；\n(c) 计算 $P(x)=x^5-x-1$ 在 $\\mathbb{Q}$ 上的分裂域扩张次数，并求对称有理分式 $\\sum_{i=1}^5 \\frac{1}{\\alpha_i^2+1}$ 的精确值。",
    rationale:
      "触发 MULTIPART 16 节点 3 层 DAG（15 条依赖边）+ 置换/同余/反例 3 维结构雷达 + math.algebraic-structures:splitting_field_degree 实证资产 + R0 三角色读题与 5+2+1 质询闭环",
  },
  {
    id: "case-flagship-laplacian",
    title: "【全机制旗舰 2】圆环离散 Laplacian 谱分解、GF(2) 核与递推通解",
    tag: "全机制旗舰 · 11节点DAG",
    problem:
      "考察单位圆环上的离散拉普拉斯微分算子与状态转移递推链：\n(a) 计算圆环离散 Laplacian 算子 $L$ 的谱分解并求其在 GF(2) 上的零空间基向量；\n(b) 求解对应常微分边界线性递推 $a_{n+2} - 2a_{n+1} + a_n = 0$ 的通解，并检验全称命题：除常数函数外不存在满足周期离散调和方程的非零反例。",
    rationale:
      "触发 MULTIPART 11 节点 DAG（10 条依赖边）+ 微分算子/递推稳态/反例判定 3 维跨家族雷达 + math.differential:circle_laplacian 实证工具链 + R0/5+2+1/CERT1 协同校验",
  },
  {
    id: "case-irreducible",
    title: "整系数多项式的不可约性与对称分式精确值",
    tag: "数论与多项式代数",
    problem:
      "设整系数多项式 $P(x) = x^5 - x - 1 \\in \\mathbb{Z}[x]$，其五个复根记为 $\\alpha_1, \\alpha_2, \\alpha_3, \\alpha_4, \\alpha_5$。\n（1）通过模素数约化法，证明 $P(x)$ 在有理数域 $\\mathbb{Q}[x]$ 上不可约；\n（2）求对称有理分式 $\\sum_{i=1}^5 \\frac{1}{\\alpha_i^2 + 1}$ 的精确值。",
    rationale: "模素数约化不可约性判定 + 幂和/对称分式精确计算",
  },
  {
    id: "case-smith",
    title: "整数矩阵的 Smith 标准型与 Abel 群不变因子",
    tag: "线性代数与模论",
    shortLabel: "Smith 标准型 (32帧)",
    frameCount: 32,
    problem:
      "设整数环 $\\mathbb{Z}$ 上的三阶矩阵为\n$$A = \\begin{pmatrix} 2 & 4 & 4 \\\\ -6 & 6 & 12 \\\\ 10 & -4 & -16 \\end{pmatrix} \\in M_3(\\mathbb{Z}).$$\n求矩阵 $A$ 在 $\\mathbb{Z}$ 上的不变因子与 Smith 标准型 $\\operatorname{diag}(d_1, d_2, d_3)$（其中 $d_1 \\mid d_2 \\mid d_3$），并给出有限生成 Abel 商群 $\\mathbb{Z}^3 / A\\mathbb{Z}^3$ 的不变因子分解。",
    rationale: "初等/不变因子计算 + 有限生成 Abel 群结构定理",
    realRunId: "run-ea293cf3bac6",
  },
  {
    id: "case-lens",
    title: "透镜空间 L(p,q) 的同调与上同调",
    tag: "代数拓扑",
    shortLabel: "L(p,q) 同调 (33帧)",
    frameCount: 33,
    problem:
      "设三维透镜空间 $L(p,q)$（其中 $\\gcd(p,q)=1, p \\ge 2$）具有标准 CW 复形分解，在维度 $k=0,1,2,3$ 上各恰有一个 $k$-维胞腔 $e^k$，其胞腔链复形 $(C_*(L(p,q)), \\partial_*)$ 的边缘算子满足 $\\partial_1 = 0, \\partial_2(e^2) = p e^1, \\partial_3 = 0$。\n（1）计算 $L(p,q)$ 的整系数同调群 $H_k(L(p,q); \\mathbb{Z})$（$0 \\le k \\le 3$）；\n（2）利用上同调万有系数定理计算整系数上同调群 $H^k(L(p,q); \\mathbb{Z})$，并求模 $p$ 系数同调群 $H_k(L(p,q); \\mathbb{Z}_p)$。",
    rationale: "CW 链复形边缘算子 + 同调/上同调万有系数定理",
    realRunId: "run-81c56bf13f85",
  },
  {
    id: "case-s4",
    title: "S4 不可约表示与外/对称平方分解",
    tag: "抽象群表示论",
    shortLabel: "S4 表示分解 (42帧)",
    frameCount: 42,
    problem:
      "设 4 次对称群 $S_4$ 在 $\\mathbb{C}^4$ 上的自然置换表示分解为平凡表示 $\\mathbf{1}$ 与三维标准不可约表示 $V$ 的直和。记 $S_4$ 的全部 5 个不可约复表示分别为：平凡表示 $\\mathbf{1}$、符号表示 $\\epsilon$、二维不可约表示 $W$、三维标准表示 $V$ 以及扭曲标准表示 $V \\otimes \\epsilon$。\n（1）写出 $V$ 在 $S_4$ 五个共轭类（按轮换型 $1^4, 2^1 1^2, 2^2, 3^1 1^1, 4^1$ 排序）上的特征标值 $\\chi_V$；\n（2）利用特征标理论，将外平方 $\\Lambda^2(V)$、对称平方 $\\operatorname{Sym}^2(V)$ 以及张量积 $V \\otimes V$ 分解为不可约复表示的直和。",
    rationale: "特征标理论 + 外平方/对称平方/张量积分解",
    realRunId: "run-682fce1e126a",
  },
];

export function findArchivedRunForProblem(problemText: string): string | null {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const target = normalize(problemText);
  if (!target) return null;
  const matched = FEATURED_CASES.find(
    (c) => Boolean(c.realRunId) && normalize(c.problem) === target,
  );
  return matched?.realRunId ?? null;
}

const PIPELINE_STEPS = [
  {
    code: "01",
    title: "3-Agent 独立读题与规划",
    detail: "R0 题意·方法·工具三角色隔离审阅 -> P2 合同",
    icon: FileText,
    color: "#3b82f6",
  },
  {
    code: "02",
    title: "多-Agent 协同求解",
    detail: "旋转 Blind 盲解投票聚合 · 数学计算资产闭环",
    icon: Boxes,
    color: "#38bdf8",
  },
  {
    code: "03",
    title: "对抗审计与修复回流",
    detail: "2× 锚定对抗审计 · R2/R4 质询 · CERT1 自检",
    icon: ShieldAlert,
    color: "#f59e0b",
  },
  {
    code: "04",
    title: "答案闭合与明文交付",
    detail: "Answer Closure 全量校验 · 无符号纯文本直读",
    icon: Award,
    color: "#10b981",
  },
] as const;

export interface StartResearchOptions {
  max_model_calls: number;
  max_work_units: number;
  max_effects: number;
  max_reviews: number;
  max_method_loads: 0 | 1 | 2 | 3 | 4;
  max_repairs: number;
  max_consensus: number;
  max_r0: 0 | 1;
  problem_seconds: number;
}

type ResearchPreset = "demo" | "flagship" | "fast";

const PRESET_BUDGETS: Readonly<Record<ResearchPreset, StartResearchOptions>> = {
  demo: {
    max_model_calls: 32,
    max_work_units: 4,
    max_effects: 2,
    max_reviews: 2,
    max_method_loads: 1,
    max_repairs: 1,
    max_consensus: 4,
    max_r0: 1,
    problem_seconds: 600,
  },
  // Aligned with v15 full-capability architecture profile in 使用说明.md
  flagship: {
    max_model_calls: 200,
    max_work_units: 64,
    max_effects: 2,
    max_reviews: 2,
    max_method_loads: 2,
    max_repairs: 3,
    max_consensus: 8,
    max_r0: 1,
    problem_seconds: 1200,
  },
  fast: {
    max_model_calls: 16,
    max_work_units: 2,
    max_effects: 1,
    max_reviews: 1,
    max_method_loads: 0,
    max_repairs: 0,
    max_consensus: 0,
    max_r0: 0,
    problem_seconds: 300,
  },
};

interface UnstartedViewProps {
  onSubmit: (problem: string, options: StartResearchOptions) => void;
  isLoading: boolean;
}

export function UnstartedView({ onSubmit, isLoading }: UnstartedViewProps) {
  const [problem, setProblem] = useState("");
  const [preset, setPreset] = useState<ResearchPreset>("demo");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [hoveredStage, setHoveredStage] = useState<number>(0);

  const [maxModelCalls, setMaxModelCalls] = useState(PRESET_BUDGETS.demo.max_model_calls);
  const [maxWorkUnits, setMaxWorkUnits] = useState(PRESET_BUDGETS.demo.max_work_units);
  const [maxEffects, setMaxEffects] = useState(PRESET_BUDGETS.demo.max_effects);
  const [maxReviews, setMaxReviews] = useState(PRESET_BUDGETS.demo.max_reviews);
  const [maxMethodLoads, setMaxMethodLoads] = useState<0 | 1 | 2 | 3 | 4>(
    PRESET_BUDGETS.demo.max_method_loads,
  );
  const [maxRepairs, setMaxRepairs] = useState(PRESET_BUDGETS.demo.max_repairs);
  const [maxConsensus, setMaxConsensus] = useState(PRESET_BUDGETS.demo.max_consensus);
  const [maxR0, setMaxR0] = useState<0 | 1>(PRESET_BUDGETS.demo.max_r0);
  const [problemSeconds, setProblemSeconds] = useState(PRESET_BUDGETS.demo.problem_seconds);

  const applyPreset = (p: ResearchPreset) => {
    const cfg = PRESET_BUDGETS[p];
    setPreset(p);
    setMaxModelCalls(cfg.max_model_calls);
    setMaxWorkUnits(cfg.max_work_units);
    setMaxEffects(cfg.max_effects);
    setMaxReviews(cfg.max_reviews);
    setMaxMethodLoads(cfg.max_method_loads);
    setMaxRepairs(cfg.max_repairs);
    setMaxConsensus(cfg.max_consensus);
    setMaxR0(cfg.max_r0);
    setProblemSeconds(cfg.problem_seconds);
  };

  const getOptions = (): StartResearchOptions => ({
    max_model_calls: maxModelCalls,
    max_work_units: maxWorkUnits,
    max_effects: maxEffects,
    max_reviews: maxReviews,
    max_method_loads: maxMethodLoads,
    max_repairs: maxRepairs,
    max_consensus: maxConsensus,
    max_r0: maxR0,
    problem_seconds: problemSeconds,
  });

  const livePreview = useMemo(() => {
    const trimmed = problem.trim();
    if (!trimmed) return null;
    const compiled = compileP2TemplateClient(trimmed);
    const edgeCount = compiled.compiledTasks.reduce((sum, t) => sum + t.deps.length, 0);
    const dims = scanStructuralDimensionsClient(trimmed);
    const matchedDims = dims.filter((d) => d.matched);
    return {
      goalMeta: compiled.goalMeta,
      multipartLabels: compiled.multipartLabels,
      taskCount: compiled.compiledTasks.length,
      edgeCount,
      matchedDims,
    };
  }, [problem]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!problem.trim() || isLoading) return;
    onSubmit(problem.trim(), getOptions());
  };

  return (
    <div
      style={{
        maxWidth: "1080px",
        width: "100%",
        margin: "12px auto 64px auto",
        padding: "0 20px",
      }}
    >
      {/* Keynote Hero 舞台开场 */}
      <div className="zygos-animate-in" style={{ textAlign: "center", marginBottom: "32px" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "5px 15px",
            borderRadius: "9999px",
            backgroundColor: "var(--color-brand-tint)",
            border: "1px solid var(--color-brand-ring)",
            color: "var(--color-brand-deep)",
            fontSize: "12px",
            fontWeight: 600,
            marginBottom: "18px",
          }}
        >
          <Sparkles size={14} color="var(--color-brand-mid)" />
          <span>Zygos 天轭 · 面向 Intern-S1 的可审计数学推理运行时</span>
        </div>

        <h1
          className="zygos-keynote-title"
          style={{
            margin: "0 0 14px 0",
            fontSize: "clamp(28px, 4vw, 44px)",
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.16,
          }}
        >
          从一道数学命题，展开可信研究过程
        </h1>

        <p
          style={{
            margin: "0 auto 26px auto",
            maxWidth: "700px",
            fontSize: "15px",
            color: "var(--color-ink-soft)",
            lineHeight: 1.7,
          }}
        >
          完整呈现系统如何拆解证明义务、调度领域数学资产、形成多专家共识推导并经受反例质询与修复。
          候选结论受控交付，如实保持形式化验证边界。
        </p>

        {/* 四阶段机制动态预览条 */}
        <div
          className="zygos-glass"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(195px, 1fr))",
            gap: "8px",
            padding: "10px",
            borderRadius: "16px",
            maxWidth: "920px",
            margin: "0 auto",
            textAlign: "left",
          }}
        >
          {PIPELINE_STEPS.map((step, idx) => {
            const Icon = step.icon;
            const active = hoveredStage === idx;
            return (
              <div
                key={step.code}
                onMouseEnter={() => setHoveredStage(idx)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "10px 12px",
                  borderRadius: "11px",
                  backgroundColor: active ? "var(--color-brand-tint)" : "transparent",
                  border: active ? "1px solid var(--color-brand-ring)" : "1px solid transparent",
                  transition: "all 0.25s var(--ease-spring)",
                  cursor: "default",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "32px",
                    height: "32px",
                    borderRadius: "9px",
                    backgroundColor: `${step.color}22`,
                    color: step.color,
                    flexShrink: 0,
                  }}
                >
                  <Icon size={16} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink)" }}>
                    <span className="zygos-tabular" style={{ color: step.color, marginRight: "5px" }}>
                      {step.code}
                    </span>
                    {step.title}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "var(--color-ink-mute)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {step.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Spotlight 聚焦命题输入控制台 */}
      <div
        className="zygos-spotlight-box zygos-animate-in"
        style={{
          padding: "26px 28px",
          marginBottom: "44px",
          animationDelay: "80ms",
        }}
      >
        <form onSubmit={handleSubmit}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
            <label
              htmlFor="problem-input"
              style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)", display: "flex", alignItems: "center", gap: "8px" }}
            >
              <span>研究题目与数学命题</span>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 500,
                  padding: "2px 8px",
                  borderRadius: "9999px",
                  backgroundColor: "var(--color-surface-sunken)",
                  color: "var(--color-ink-mute)",
                }}
              >
                KaTeX / LaTeX Ready
              </span>
            </label>
            <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
              输入自定义命题，或从下方精选案例一键填入
            </span>
          </div>

          <textarea
            id="problem-input"
            rows={4}
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            placeholder="输入或粘贴数学命题（例如：设 P(x) = x^5 - x - 1 ∈ Z[x]...），或点击下方精选案例体验真实执行链与拓扑回放。"
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: "12px",
              border: "1px solid var(--color-line-strong)",
              backgroundColor: "var(--color-surface-sunken)",
              fontSize: "14px",
              lineHeight: 1.65,
              color: "var(--color-ink)",
              outline: "none",
              resize: "vertical",
              fontFamily: "var(--font-sans)",
              transition: "border-color 0.2s ease, background-color 0.2s ease",
            }}
          />

          {livePreview && (
            <div
              className="zygos-spring-card"
              style={{
                marginTop: "10px",
                padding: "9px 12px",
                borderRadius: "10px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "8px",
                fontSize: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "2px 8px",
                    borderRadius: "9999px",
                    backgroundColor: "var(--color-brand-tint)",
                    color: "var(--color-brand-deep)",
                    border: "1px solid var(--color-brand-ring)",
                    fontWeight: 600,
                  }}
                >
                  <GitBranch size={12} />
                  <span>M1 契约预编译: {livePreview.goalMeta.kind}</span>
                </span>
                <span className="zygos-tabular" style={{ color: "var(--color-ink-soft)", fontWeight: 500 }}>
                  {livePreview.taskCount} 个义务任务 · {livePreview.edgeCount} 条 DAG 依赖
                  {livePreview.multipartLabels.length >= 2 && ` · 子问 (${livePreview.multipartLabels.join("/")})`}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--color-ink-mute)", fontWeight: 500 }}>
                  <ScanSearch size={12} />
                  <span>8 维结构雷达:</span>
                </span>
                {livePreview.matchedDims.length > 0 ? (
                  <>
                    {livePreview.matchedDims.slice(0, 3).map((d) => (
                      <span
                        key={d.key}
                        style={{
                          padding: "2px 7px",
                          borderRadius: "9999px",
                          backgroundColor: "var(--color-state-success-bg)",
                          color: "var(--color-state-success)",
                          border: "1px solid var(--color-state-success-border)",
                          fontWeight: 600,
                          fontSize: "11px",
                        }}
                      >
                        {d.title}
                      </span>
                    ))}
                    {livePreview.matchedDims.length > 3 && (
                      <span style={{ fontSize: "11px", color: "var(--color-brand-deep)", fontWeight: 600 }}>
                        +{livePreview.matchedDims.length - 3}
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>
                    未命中专精词（走通用模板 + 26 项资产按需路由）
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 苹果风 Segmented Control 预设切换 */}
          <div style={{ marginTop: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "8px", letterSpacing: "0.02em" }}>
              执行预设与机制配置
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "10px",
                padding: "6px",
                borderRadius: "14px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
              }}
            >
              <button
                type="button"
                onClick={() => applyPreset("demo")}
                className="zygos-spring-card"
                style={{
                  textAlign: "left",
                  padding: "12px 15px",
                  borderRadius: "10px",
                  border: preset === "demo" ? "1px solid var(--color-brand-ring)" : "1px solid transparent",
                  backgroundColor: preset === "demo" ? "var(--color-surface-elevated)" : "transparent",
                  boxShadow: preset === "demo" ? "var(--shadow-card)" : "none",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: 700, fontSize: "13px", color: preset === "demo" ? "var(--color-brand-deep)" : "var(--color-ink-soft)" }}>
                    评委均衡全机制（推荐）
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      backgroundColor: "var(--color-state-success-bg)",
                      color: "var(--color-state-success)",
                      border: "1px solid var(--color-state-success-border)",
                      padding: "1px 8px",
                      borderRadius: "9999px",
                    }}
                  >
                    R0 + 共识
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginTop: "4px", lineHeight: 1.45 }}>
                  启用 R0 三方读题 + 1 路 Blind 盲解 + 2 轮对抗审计 + CERT1 + 修复闭环
                </div>
              </button>

              <button
                type="button"
                onClick={() => applyPreset("flagship")}
                className="zygos-spring-card"
                style={{
                  textAlign: "left",
                  padding: "12px 15px",
                  borderRadius: "10px",
                  border: preset === "flagship" ? "1px solid var(--color-brand-ring)" : "1px solid transparent",
                  backgroundColor: preset === "flagship" ? "var(--color-surface-elevated)" : "transparent",
                  boxShadow: preset === "flagship" ? "var(--shadow-card)" : "none",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: 700, fontSize: "13px", color: preset === "flagship" ? "var(--color-brand-deep)" : "var(--color-ink-soft)" }}>
                    5+2+1 协同旗舰
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      backgroundColor: "var(--color-brand-tint)",
                      color: "var(--color-brand-deep)",
                      border: "1px solid var(--color-brand-ring)",
                      padding: "1px 8px",
                      borderRadius: "9999px",
                    }}
                  >
                    完整创新
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginTop: "4px", lineHeight: 1.45 }}>
                  全开 R0 3-Agent 读题与 5 路旋转视角盲解投票 + 2 审计 + CERT1（耗时较长）
                </div>
              </button>

              <button
                type="button"
                onClick={() => applyPreset("fast")}
                className="zygos-spring-card"
                style={{
                  textAlign: "left",
                  padding: "12px 15px",
                  borderRadius: "10px",
                  border: preset === "fast" ? "1px solid var(--color-brand-ring)" : "1px solid transparent",
                  backgroundColor: preset === "fast" ? "var(--color-surface-elevated)" : "transparent",
                  boxShadow: preset === "fast" ? "var(--shadow-card)" : "none",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontWeight: 700, fontSize: "13px", color: preset === "fast" ? "var(--color-brand-deep)" : "var(--color-ink-soft)" }}>
                    快速基础推导
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      backgroundColor: "var(--color-surface-muted)",
                      color: "var(--color-ink-mute)",
                      border: "1px solid var(--color-line)",
                      padding: "1px 8px",
                      borderRadius: "9999px",
                    }}
                  >
                    轻量版
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginTop: "4px", lineHeight: 1.45 }}>
                  关闭 R0 与多路共识，单阶段直接符号推演与核心工具观察
                </div>
              </button>
            </div>
          </div>

          {/* 高级预算与滑块控制区 */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "none",
                border: "none",
                padding: "4px 0",
                color: "var(--color-brand-mid)",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <Sliders size={14} />
              <span>{showAdvanced ? "收起高级配额参数" : "展开有界预算与执行约束"}</span>
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showAdvanced && (
              <div
                className="zygos-animate-in"
                style={{
                  marginTop: "12px",
                  padding: "18px",
                  borderRadius: "14px",
                  backgroundColor: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-line)",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "16px",
                }}
              >
                <SliderField
                  id="max-calls"
                  label="最大模型调用次数"
                  value={maxModelCalls}
                  min={4}
                  max={256}
                  step={4}
                  hint="v15 推荐全量旗舰 200 次"
                  onChange={setMaxModelCalls}
                />

                <SliderField
                  id="max-work-units"
                  label="最大工作单元 (M3)"
                  value={maxWorkUnits}
                  min={1}
                  max={64}
                  step={1}
                  hint="DAG 并行分治单元上限"
                  onChange={setMaxWorkUnits}
                />

                <SliderField
                  id="problem-seconds"
                  label="单题最长限时（秒）"
                  value={problemSeconds}
                  min={120}
                  max={1200}
                  step={60}
                  hint="与官方端口 1200s 上限对齐"
                  onChange={setProblemSeconds}
                />

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
                    <span style={{ color: "var(--color-ink-soft)" }}>方法卡加载上限</span>
                    <span className="zygos-tabular" style={{ color: "var(--color-brand-mid)" }}>{maxMethodLoads} 张</span>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {([0, 1, 2, 3, 4] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setMaxMethodLoads(v)}
                        style={{
                          flex: 1,
                          padding: "6px 0",
                          borderRadius: "8px",
                          border: `1px solid ${maxMethodLoads === v ? "var(--color-brand-ring)" : "var(--color-line)"}`,
                          backgroundColor: maxMethodLoads === v ? "var(--color-brand-tint)" : "var(--color-surface)",
                          color: maxMethodLoads === v ? "var(--color-brand-deep)" : "var(--color-ink-mute)",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 600, marginBottom: "8px" }}>
                    <span style={{ color: "var(--color-ink-soft)" }}>R0 规划与反例预演</span>
                    <span style={{ color: maxR0 === 1 ? "var(--color-state-success)" : "var(--color-ink-mute)" }}>
                      {maxR0 === 1 ? "已启用" : "已关闭"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                    {([
                      { val: 1 as const, label: "启用 R0 预演" },
                      { val: 0 as const, label: "关闭" },
                    ]).map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => setMaxR0(opt.val)}
                        style={{
                          padding: "6px 8px",
                          borderRadius: "8px",
                          border: `1px solid ${maxR0 === opt.val ? "var(--color-brand-ring)" : "var(--color-line)"}`,
                          backgroundColor: maxR0 === opt.val ? "var(--color-brand-tint)" : "var(--color-surface)",
                          color: maxR0 === opt.val ? "var(--color-brand-deep)" : "var(--color-ink-mute)",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <SliderField
                  id="max-consensus"
                  label="多专家共识配额"
                  value={maxConsensus}
                  min={0}
                  max={8}
                  step={1}
                  hint="并行路线交叉共识上限"
                  onChange={setMaxConsensus}
                />

                <SliderField
                  id="max-repairs"
                  label="受控条件修复配额"
                  value={maxRepairs}
                  min={0}
                  max={3}
                  step={1}
                  hint="REPAIR 回流修订次数"
                  onChange={setMaxRepairs}
                />

                <SliderField
                  id="max-reviews"
                  label="独立审查轮次上限"
                  value={maxReviews}
                  min={0}
                  max={3}
                  step={1}
                  hint="R2/R4 门控审查轮次"
                  onChange={setMaxReviews}
                />
              </div>
            )}
          </div>

          {/* 底部提交栏 */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "20px",
              paddingTop: "16px",
              borderTop: "1px solid var(--color-line)",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
              <ShieldCheck size={15} color="var(--color-state-success)" />
              <span>官方 solve 入口 · 严格遵循可信验证边界（candidateVerified 恒为 false）</span>
            </div>

            <button
              type="submit"
              disabled={!problem.trim() || isLoading}
              className="zygos-btn-primary"
              style={{
                padding: "11px 26px",
                fontSize: "14px",
                borderRadius: "11px",
              }}
            >
              {isLoading ? (
                <span>正在启动研究任务...</span>
              ) : (
                <>
                  <Send size={15} />
                  <span>开始推导研究</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* 精选研究案例 Bento Grid */}
      <div className="zygos-animate-in" style={{ animationDelay: "140ms" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", marginBottom: "18px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
            <BookOpen size={18} color="var(--color-brand-mid)" />
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
              精选研究案例
            </h2>
          </div>
          <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
            支持直接填入命题，或零等待回放真实采集的执行拓扑轨迹
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(430px, 1fr))",
            gap: "18px",
          }}
        >
          {FEATURED_CASES.map((item, idx) => {
            const isFlagship = item.id.startsWith("case-flagship-");
            return (
            <div
              key={item.id}
              className="zygos-bento zygos-animate-in"
              style={{
                padding: "20px 22px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "14px",
                animationDelay: `${160 + idx * 55}ms`,
                border: isFlagship ? "1.5px solid var(--color-brand-ring)" : undefined,
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)", lineHeight: 1.4 }}>
                    {item.title}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "3px 10px",
                      borderRadius: "9999px",
                      backgroundColor: "var(--color-brand-tint)",
                      border: "1px solid var(--color-brand-ring)",
                      color: "var(--color-brand-mid)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {item.tag}
                  </span>
                </div>

                {/* 使用 KaTeX 正式排版矩阵与公式，彻底告别原始 LaTeX 源码暴露 */}
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "10px",
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                    marginBottom: "10px",
                  }}
                >
                  <MathMarkdown content={item.problem} compact />
                </div>

                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", lineHeight: 1.5 }}>
                  研究路径：{item.rationale}
                </div>
              </div>

              {/* 两个动作严格区分：填入题目 vs 查看真实回放 / 立即运行 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  borderTop: "1px solid var(--color-line)",
                  paddingTop: "12px",
                }}
              >
                <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--color-ink-mute)" }}>
                  {item.realRunId ? `Archive · ${item.realRunId}` : "Live Execution"}
                </span>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isFlagship) applyPreset("flagship");
                      setProblem(item.problem);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className="zygos-btn-ghost"
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                    }}
                  >
                    <ArrowRight size={13} />
                    <span>填入此题</span>
                  </button>

                  {item.realRunId ? (
                    <>
                      <Link
                        to={`/runs/${item.realRunId}`}
                        className="zygos-btn-ghost"
                        style={{
                          padding: "6px 11px",
                          fontSize: "12px",
                          borderRadius: "9px",
                          textDecoration: "none",
                        }}
                      >
                        <FileText size={12} />
                        <span>答案报告</span>
                      </Link>
                      <Link
                        to={`/runs/${item.realRunId}/replay?autoplay=1&speed=4`}
                        className="zygos-btn-primary"
                        style={{
                          padding: "6px 13px",
                          fontSize: "12px",
                          borderRadius: "9px",
                          textDecoration: "none",
                        }}
                      >
                        <Play size={13} />
                        <span>动态回放</span>
                      </Link>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (isFlagship) applyPreset("flagship");
                        const nextOptions: StartResearchOptions = isFlagship
                          ? PRESET_BUDGETS.flagship
                          : getOptions();
                        setProblem(item.problem);
                        onSubmit(item.problem, nextOptions);
                      }}
                      className="zygos-btn-primary"
                      style={{
                        padding: "6px 14px",
                        fontSize: "12px",
                        borderRadius: "9px",
                      }}
                    >
                      <Send size={12} />
                      <span>立即运行</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SliderField(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  onChange: (val: number) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <label htmlFor={props.id} style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
          {props.label}
        </label>
        <span
          className="zygos-tabular"
          style={{
            fontSize: "12px",
            fontWeight: 700,
            fontFamily: "var(--font-mono)",
            color: "var(--color-brand-deep)",
            padding: "1px 8px",
            borderRadius: "6px",
            backgroundColor: "var(--color-brand-tint)",
          }}
        >
          {props.value}
        </span>
      </div>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="zygos-slider"
        style={{ width: "100%" }}
      />
      <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", marginTop: "5px" }}>{props.hint}</div>
    </div>
  );
}
