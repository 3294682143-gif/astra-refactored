import { useState } from "react";
import { Play, Square, Sparkles, BookOpen } from "lucide-react";
import { ResultCard } from "@/components/ResultCard";

const SAMPLE_PROBLEMS = [
  {
    title: "代数多项式恒等定理检验",
    text: "设 P(x) 为整系数多项式，满足对所有正整数 n 均有 P(n) 为完全平方数。证明 P(x) 是某整系数多项式的平方。",
  },
  {
    title: "初等数论同余方程组求解",
    text: "求所有正整数对 (m, n)，满足 2^m + 3^n 为完全平方数。",
  },
  {
    title: "组合离散极值分析",
    text: "在一个 2026 阶的完全图中，每条边染成红或蓝两色之一。求至少包含的单色三角形数目的最小值。",
  },
];

export function SolvePage() {
  const [problem, setProblem] = useState(SAMPLE_PROBLEMS[0]!.text);
  const [maxModelCalls, setMaxModelCalls] = useState(24);
  const [maxMethodLoads, setMaxMethodLoads] = useState<0 | 1>(1);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{
    status: "candidate" | "unsolved";
    answer: string;
    stopReason: string;
  } | null>(null);

  const handleStartSolve = () => {
    setIsRunning(true);
    setResult(null);
    // 模拟运行收敛过程（或调用本地 BFF）
    setTimeout(() => {
      setIsRunning(false);
      setResult({
        status: "candidate",
        answer: "设 P(x) = (Q(x))^2，其中 Q(x) 为整系数多项式。\n构造辅助序列并在素数模下利用二次剩余分布论证，即得证结论成立。",
        stopReason: "REVIEWS_COMPLETE",
      });
    }, 1200);
  };

  const handleStop = () => {
    setIsRunning(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* 顶部标题区 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            数学智能体求解工作台
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
            支持 Markdown 与 LaTeX 公式输入，驱动 M1 契约、M2 准入、M3 调度、M4 评审与 M5 审计单循环。
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {SAMPLE_PROBLEMS.map((sample, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setProblem(sample.text)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "6px",
                border: "1px solid var(--color-line)",
                backgroundColor: "#ffffff",
                padding: "6px 10px",
                fontSize: "12px",
                color: "var(--color-ink-soft)",
                cursor: "pointer",
              }}
            >
              <BookOpen size={13} />
              <span>例题 {idx + 1}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 主体两栏网格 */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: "24px" }}>
        {/* 左栏：输入与配置 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* 输入框卡片 */}
          <div
            style={{
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-line)",
              backgroundColor: "#ffffff",
              padding: "20px",
              boxShadow: "0 1px 3px rgba(15,38,92,0.04)",
            }}
          >
            <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "8px" }}>
              题目描述与约束 (LaTeX 支持)
            </label>
            <textarea
              rows={6}
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              placeholder="请输入数学题目描述，支持使用 $...$ 编写 LaTeX 公式..."
              style={{
                width: "100%",
                borderRadius: "8px",
                border: "1px solid var(--color-line-strong)",
                padding: "12px",
                fontSize: "14px",
                fontFamily: "var(--font-sans)",
                lineHeight: 1.6,
                color: "var(--color-ink)",
                outline: "none",
                resize: "vertical",
              }}
            />

            {/* 预算与策略配置 */}
            <div style={{ marginTop: "16px", paddingTop: "16px", borderTop: "1px solid var(--color-line)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--color-ink-soft)", marginBottom: "6px" }}>
                  最大模型调用配额 (max_model_calls)
                </label>
                <select
                  value={maxModelCalls}
                  onChange={(e) => setMaxModelCalls(Number(e.target.value))}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid var(--color-line-strong)", fontSize: "13px" }}
                >
                  <option value={8}>8 次 (轻量调试)</option>
                  <option value={24}>24 次 (演示均衡推荐档)</option>
                  <option value={48}>48 次 (深度搜索)</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 500, color: "var(--color-ink-soft)", marginBottom: "6px" }}>
                  方法卡准入开关 (max_method_loads)
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "2px" }}>
                  <button
                    type="button"
                    onClick={() => setMaxMethodLoads(1)}
                    style={{
                      flex: 1,
                      padding: "6px 0",
                      borderRadius: "6px",
                      border: `1px solid ${maxMethodLoads === 1 ? "var(--color-brand)" : "var(--color-line)"}`,
                      backgroundColor: maxMethodLoads === 1 ? "var(--color-brand-tint)" : "#ffffff",
                      color: maxMethodLoads === 1 ? "var(--color-brand)" : "var(--color-ink-soft)",
                      fontWeight: 500,
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    启用准入 (1)
                  </button>
                  <button
                    type="button"
                    onClick={() => setMaxMethodLoads(0)}
                    style={{
                      flex: 1,
                      padding: "6px 0",
                      borderRadius: "6px",
                      border: `1px solid ${maxMethodLoads === 0 ? "var(--color-brand)" : "var(--color-line)"}`,
                      backgroundColor: maxMethodLoads === 0 ? "var(--color-brand-tint)" : "#ffffff",
                      color: maxMethodLoads === 0 ? "var(--color-brand)" : "var(--color-ink-soft)",
                      fontWeight: 500,
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    禁用准入 (0)
                  </button>
                </div>
              </div>
            </div>

            {/* 控制按钮 */}
            <div style={{ marginTop: "20px", display: "flex", gap: "12px" }}>
              <button
                type="button"
                onClick={handleStartSolve}
                disabled={isRunning}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  borderRadius: "8px",
                  backgroundColor: isRunning ? "var(--color-brand-mid)" : "var(--color-brand)",
                  color: "#ffffff",
                  border: "none",
                  padding: "10px 20px",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor: isRunning ? "not-allowed" : "pointer",
                }}
              >
                {isRunning ? <Sparkles size={16} /> : <Play size={16} fill="#ffffff" />}
                <span>{isRunning ? "正在进行数学推理..." : "开始单循环求解"}</span>
              </button>

              {isRunning ? (
                <button
                  type="button"
                  onClick={handleStop}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    borderRadius: "8px",
                    border: "1px solid #fecaca",
                    backgroundColor: "#fee2e2",
                    color: "#b91c1c",
                    padding: "10px 16px",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  <Square size={14} fill="#b91c1c" />
                  <span>断开会话</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* 右栏：结果反馈 */}
        <div>
          {result ? (
            <ResultCard
              title="当前求解执行产物"
              status={result.status}
              source="L1"
              answer={result.answer}
              unsolvedReason={result.stopReason}
              updatedAt="刚刚"
              note="依据官方赛题合规约束：所有生成结果均为「候选答案」，不构成形式化数学验证。"
            />
          ) : (
            <div
              style={{
                borderRadius: "var(--radius-card)",
                border: "1px dashed var(--color-line-strong)",
                backgroundColor: "rgba(255,255,255,0.6)",
                padding: "60px 24px",
                textAlign: "center",
                color: "var(--color-ink-mute)",
              }}
            >
              <Sparkles size={32} style={{ margin: "0 auto 12px", opacity: 0.4 }} />
              <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--color-ink-soft)", marginBottom: "4px" }}>
                就绪，等待派发求解
              </div>
              <div style={{ fontSize: "12px" }}>
                输入题目并点击「开始单循环求解」，观察执行链展开
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
