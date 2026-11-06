import React, { useState } from "react";
import { Link } from "react-router";
import {
  Sparkles,
  BookOpen,
  Sliders,
  Send,
  Play,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";

export interface FeaturedCase {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly problem: string;
  readonly realRunId?: string;
  readonly rationale: string;
}

export const FEATURED_CASES: readonly FeaturedCase[] = [
  {
    id: "case-poly",
    title: "整系数多项式完全平方判定",
    tag: "数论与多项式代数",
    problem:
      "设 P(x) 为整系数多项式，满足对所有正整数 n 均有 P(n) 为完全平方数。证明 P(x) 是某整系数多项式的平方。",
    realRunId: "run-16a5b148239f",
    rationale: "包含二阶展开资产调用、判别式检验、专家审查与代数恒等引理闭合",
  },
  {
    id: "case-gf2",
    title: "有限域 GF(2) 矩阵秩与通解",
    tag: "线性代数与符号计算",
    problem:
      "已知线性系统方程 Ax=b，求 GF(2) 秩及通解，并验证齐次空间正交基。",
    realRunId: "run-c4c0292f1708",
    rationale: "包含高斯消元算子、有限域秩计算资产与齐次解空间一致性验证",
  },
  {
    id: "case-alexander",
    title: "Alexander 纽结多项式拓扑不变性",
    tag: "拓扑与低维流形",
    problem:
      "设 K 为三维球面中的规范纽结投影，计算其 Seifert 矩阵并推导 Alexander 多项式，验证对称性质。",
    rationale: "多角色分工推理、拓扑不变性检验与代数关系约束",
  },
  {
    id: "case-d8",
    title: "二面体群 D₈ 对称性与特征标表",
    tag: "抽象代数与群表示",
    problem:
      "构造正方形对称群 D_8 的所有共轭类与不可约复表示，生成特征标表并检验正交恒等式。",
    rationale: "群论结构拆解、子群共轭分类与反例防御闭合",
  },
];

export interface StartResearchOptions {
  max_model_calls: number;
  max_work_units: number;
  max_effects: number;
  max_reviews: number;
  max_method_loads: 0 | 1 | 2 | 3 | 4;
  max_repairs: number;
  max_consensus: number;
  max_r0: 0 | 1;
}

interface UnstartedViewProps {
  onSubmit: (problem: string, options: StartResearchOptions) => void;
  isLoading: boolean;
}

export function UnstartedView({ onSubmit, isLoading }: UnstartedViewProps) {
  const [problem, setProblem] = useState("");
  const [preset, setPreset] = useState<"demo" | "fast">("demo");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxModelCalls, setMaxModelCalls] = useState(32);
  const [maxWorkUnits, setMaxWorkUnits] = useState(4);
  const [maxEffects, setMaxEffects] = useState(2);
  const [maxReviews, setMaxReviews] = useState(2);
  const [maxMethodLoads, setMaxMethodLoads] = useState<0 | 1 | 2 | 3 | 4>(1);
  const [maxRepairs, setMaxRepairs] = useState(1);
  const [maxConsensus, setMaxConsensus] = useState(1);
  const [maxR0, setMaxR0] = useState<0 | 1>(1);

  const applyPreset = (p: "demo" | "fast") => {
    setPreset(p);
    if (p === "demo") {
      setMaxModelCalls(32);
      setMaxWorkUnits(4);
      setMaxEffects(2);
      setMaxReviews(2);
      setMaxMethodLoads(1);
      setMaxRepairs(1);
      setMaxConsensus(1);
      setMaxR0(1);
    } else {
      setMaxModelCalls(16);
      setMaxWorkUnits(2);
      setMaxEffects(1);
      setMaxReviews(1);
      setMaxMethodLoads(0);
      setMaxRepairs(0);
      setMaxConsensus(0);
      setMaxR0(0);
    }
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
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!problem.trim() || isLoading) return;
    onSubmit(problem.trim(), getOptions());
  };

  return (
    <div
      style={{
        maxWidth: "960px",
        margin: "20px auto 60px auto",
        padding: "0 20px",
      }}
    >
      {/* 首屏引导标语 */}
      <div style={{ textAlign: "center", marginBottom: "36px" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            padding: "4px 14px",
            borderRadius: "9999px",
            backgroundColor: "var(--color-brand-tint)",
            color: "var(--color-brand)",
            fontSize: "13px",
            fontWeight: 600,
            marginBottom: "16px",
          }}
        >
          <Sparkles size={15} />
          面向数学研究记录的可信推理运行时
        </div>
        <h1
          style={{
            margin: "0 0 12px 0",
            fontSize: "30px",
            fontWeight: 800,
            color: "var(--color-brand-deep)",
            letterSpacing: "-0.5px",
          }}
        >
          从一道数学命题，展开可信研究过程
        </h1>
        <p
          style={{
            margin: "0 auto",
            maxWidth: "680px",
            fontSize: "15px",
            color: "var(--color-ink-soft)",
            lineHeight: 1.6,
          }}
        >
          看懂系统如何拆解题目义务、选择专业数学资产、形成候选推导并经受严格审查。
          候选结论受控交付，如实保持数学验证边界。
        </p>
      </div>

      {/* 居中问题输入卡片 */}
      <div
        style={{
          backgroundColor: "var(--color-surface)",
          borderRadius: "14px",
          border: "1px solid var(--color-line-strong)",
          boxShadow: "0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01)",
          padding: "24px",
          marginBottom: "40px",
        }}
      >
        <form onSubmit={handleSubmit}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <label
              htmlFor="problem-input"
              style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}
            >
              研究题目与命题
            </label>
            <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
              支持 LaTeX 公式与数学证明目标
            </span>
          </div>

          <textarea
            id="problem-input"
            rows={4}
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            placeholder="输入或粘贴数学命题（例如：设 P(x) 为整系数多项式...），或直接在下方点击精选案例体验完整研究链。"
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: "8px",
              border: "1px solid var(--color-line-strong)",
              backgroundColor: "var(--color-surface-muted)",
              fontSize: "14px",
              lineHeight: 1.6,
              color: "var(--color-ink)",
              outline: "none",
              resize: "vertical",
              fontFamily: "var(--font-sans)",
            }}
          />

          {/* 推理机制演示预设 (Spec R3) */}
          <div style={{ marginTop: "16px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-brand-deep)", marginBottom: "8px" }}>
              执行预设与机制配置
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div
                onClick={() => applyPreset("demo")}
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  border: `2px solid ${preset === "demo" ? "var(--color-brand)" : "var(--color-line)"}`,
                  backgroundColor: preset === "demo" ? "var(--color-brand-tint)" : "var(--color-surface)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: "13px", color: preset === "demo" ? "var(--color-brand-deep)" : "var(--color-ink)" }}>
                    评委演示全机制 (推荐)
                  </span>
                  <span style={{ fontSize: "11px", backgroundColor: "#059669", color: "#ffffff", padding: "1px 6px", borderRadius: "4px" }}>
                    全流程
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", marginTop: "4px", lineHeight: 1.4 }}>
                  开启 R0 规划预演、多专家共识、代数审查与条件受控修复
                </div>
              </div>

              <div
                onClick={() => applyPreset("fast")}
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  border: `2px solid ${preset === "fast" ? "var(--color-brand)" : "var(--color-line)"}`,
                  backgroundColor: preset === "fast" ? "var(--color-brand-tint)" : "var(--color-surface)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: "13px", color: preset === "fast" ? "var(--color-brand-deep)" : "var(--color-ink)" }}>
                    快速基础推导
                  </span>
                  <span style={{ fontSize: "11px", backgroundColor: "var(--color-line-strong)", color: "var(--color-ink-mute)", padding: "1px 6px", borderRadius: "4px" }}>
                    基础版
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", marginTop: "4px", lineHeight: 1.4 }}>
                  单阶段直接符号推演，仅保留主干求解与资产调用
                </div>
              </div>
            </div>
          </div>

          {/* 高级参数展开 */}
          <div style={{ marginTop: "14px" }}>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--color-brand)",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <Sliders size={14} />
              {showAdvanced ? "收起高级配置" : "展开预算与执行约束"}
            </button>

            {showAdvanced && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "16px",
                  borderRadius: "8px",
                  backgroundColor: "var(--color-surface-sunken)",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "14px",
                }}
              >
                <div>
                  <label
                    htmlFor="max-calls"
                    style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    最大模型调用次数
                  </label>
                  <input
                    id="max-calls"
                    type="number"
                    min={1}
                    max={64}
                    value={maxModelCalls}
                    onChange={(e) => setMaxModelCalls(Number(e.target.value))}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      fontSize: "13px",
                    }}
                  />
                  <span style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>
                    默认 32 次；有界配额防止发散
                  </span>
                </div>

                <div>
                  <label
                    htmlFor="max-loads"
                    style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    允许方法卡加载上限 (0~4)
                  </label>
                  <select
                    id="max-loads"
                    value={maxMethodLoads}
                    onChange={(e) => setMaxMethodLoads(Number(e.target.value) as any)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      fontSize: "13px",
                      backgroundColor: "#ffffff",
                    }}
                  >
                    <option value={0}>0（纯内核推理，不加载额外卡）</option>
                    <option value={1}>1（针对性加载 1 张方法卡）</option>
                    <option value={2}>2（加载至多 2 张方法卡）</option>
                    <option value={3}>3（至多 3 张）</option>
                    <option value={4}>4（允许最大 4 张卡）</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="max-r0"
                    style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    R0 规划与反例预演
                  </label>
                  <select
                    id="max-r0"
                    value={maxR0}
                    onChange={(e) => setMaxR0(Number(e.target.value) as any)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      fontSize: "13px",
                      backgroundColor: "#ffffff",
                    }}
                  >
                    <option value={1}>1（启用 R0 规划与反例预演）</option>
                    <option value={0}>0（关闭 R0 预演）</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="max-consensus"
                    style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    多专家共识配额 (0~8)
                  </label>
                  <input
                    id="max-consensus"
                    type="number"
                    min={0}
                    max={8}
                    value={maxConsensus}
                    onChange={(e) => setMaxConsensus(Number(e.target.value))}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      fontSize: "13px",
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="max-repairs"
                    style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    受控条件修复配额 (0~3)
                  </label>
                  <input
                    id="max-repairs"
                    type="number"
                    min={0}
                    max={3}
                    value={maxRepairs}
                    onChange={(e) => setMaxRepairs(Number(e.target.value))}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      fontSize: "13px",
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="max-reviews"
                    style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    独立审查轮次上限 (0~3)
                  </label>
                  <input
                    id="max-reviews"
                    type="number"
                    min={0}
                    max={3}
                    value={maxReviews}
                    onChange={(e) => setMaxReviews(Number(e.target.value))}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      fontSize: "13px",
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 提交按钮栏 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
              <ShieldCheck size={14} color="#059669" />
              <span>官方 solve 入口 · 运行时可信边界受控保证</span>
            </div>

            <button
              type="submit"
              disabled={!problem.trim() || isLoading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 24px",
                borderRadius: "8px",
                backgroundColor: problem.trim() && !isLoading ? "var(--color-brand)" : "#94a3b8",
                color: "#ffffff",
                fontSize: "14px",
                fontWeight: 600,
                border: "none",
                cursor: problem.trim() && !isLoading ? "pointer" : "not-allowed",
                transition: "all 0.15s ease",
              }}
            >
              {isLoading ? (
                <>正在启动研究任务...</>
              ) : (
                <>
                  <Send size={15} />
                  开始推导研究
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* 精选研究案例（真实案例与回放明确分开，方案 5 节） */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
          <BookOpen size={18} color="var(--color-brand)" />
          <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            精选研究案例
          </h2>
          <span style={{ fontSize: "13px", color: "var(--color-ink-mute)" }}>
            （支持直接填入题目或查看已记录的真实执行回放）
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
            gap: "18px",
          }}
        >
          {FEATURED_CASES.map((item) => (
            <div
              key={item.id}
              style={{
                backgroundColor: "var(--color-surface)",
                borderRadius: "10px",
                border: "1px solid var(--color-line)",
                padding: "18px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "14px",
                boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                    {item.title}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "2px 8px",
                      borderRadius: "9999px",
                      backgroundColor: "var(--color-brand-tint)",
                      color: "var(--color-brand)",
                      fontWeight: 500,
                    }}
                  >
                    {item.tag}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    lineHeight: 1.6,
                    color: "var(--color-ink)",
                    margin: "8px 0",
                  }}
                >
                  {item.problem}
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", lineHeight: 1.4 }}>
                  {item.rationale}
                </div>
              </div>

              {/* 两个动作严格区分：填入题目 vs 查看真实回放 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: "10px",
                  borderTop: "1px solid var(--color-surface-sunken)",
                  paddingTop: "12px",
                }}
              >
                <button
                  type="button"
                  onClick={() => setProblem(item.problem)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--color-line-strong)",
                    backgroundColor: "transparent",
                    color: "var(--color-ink-soft)",
                    fontSize: "12px",
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  <ArrowRight size={13} />
                  填入此题
                </button>

                {item.realRunId ? (
                  <Link
                    to={`/runs/${item.realRunId}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      padding: "6px 14px",
                      borderRadius: "6px",
                      backgroundColor: "var(--color-brand-tint)",
                      color: "var(--color-brand)",
                      fontSize: "12px",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    <Play size={13} />
                    查看真实回放
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setProblem(item.problem);
                      onSubmit(item.problem, getOptions());
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "6px 14px",
                      borderRadius: "6px",
                      backgroundColor: "var(--color-brand)",
                      color: "#ffffff",
                      fontSize: "12px",
                      fontWeight: 600,
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    立即运行
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
