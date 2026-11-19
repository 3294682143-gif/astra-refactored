import { useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Award,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  GitBranch,
  Layers,
  Play,
  Sparkles,
} from "lucide-react";
import type { ResearchViewModel } from "../../../domain/research/types";
import {
  extractFinalAnswerPresentation,
  toPlainAnswerText,
} from "../../../domain/research/plainAnswer";
import { describeStopReason } from "../../../domain/stopReasonView";

interface AnswerPresentationPageProps {
  viewModel: ResearchViewModel;
  onShowProcess: () => void;
  isReplay?: boolean;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function AnswerPresentationPage({
  viewModel,
  onShowProcess,
  isReplay = false,
}: AnswerPresentationPageProps) {
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const presentation = extractFinalAnswerPresentation(viewModel);
  const stopInfo = describeStopReason(viewModel.stopReason);
  const isCandidate =
    viewModel.status === "candidate" || viewModel.status === "finished";
  const plainProblem = toPlainAnswerText(viewModel.problem, { singleLine: true });

  const handleCopyPlain = () => {
    const textToCopy = presentation.fullPlainText || presentation.headline || "";
    if (!textToCopy || !navigator.clipboard) return;
    void navigator.clipboard.writeText(textToCopy).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div
      className="zygos-animate-in"
      style={{
        width: "100%",
        maxWidth: "980px",
        margin: "0 auto",
        padding: "8px 8px 40px",
        display: "flex",
        flexDirection: "column",
        gap: "20px",
      }}
    >
      {/* 顶部独立答案页面控制条 */}
      <div
        className="zygos-glass"
        style={{
          borderRadius: "16px",
          padding: "12px 18px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "10px",
              background: isCandidate
                ? "linear-gradient(135deg, #2563eb 0%, #10b981 100%)"
                : "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)",
              color: "#ffffff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Award size={17} />
          </span>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
              最终答案呈现页面{isReplay ? "（回放终态提取）" : ""}
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
              已屏蔽四阶段中间流程与符号化语法，仅保留直接数字与纯文本结果
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onShowProcess}
            className="zygos-btn-ghost"
            style={{ padding: "7px 14px", fontSize: "12.5px" }}
          >
            <GitBranch size={14} />
            <span>查看四阶段运行过程 ({viewModel.nodes.length})</span>
          </button>

          {viewModel.runId && !isReplay && (
            <Link
              to={`/runs/${encodeURIComponent(viewModel.runId)}/replay`}
              className="zygos-btn-ghost"
              style={{ padding: "7px 14px", fontSize: "12.5px", textDecoration: "none" }}
            >
              <Play size={14} />
              <span>过程回放</span>
            </Link>
          )}

          <Link
            to="/solve"
            className="zygos-btn-primary"
            style={{ padding: "7px 15px", fontSize: "12.5px", textDecoration: "none" }}
          >
            <Sparkles size={14} />
            <span>新建提问</span>
          </Link>
        </div>
      </div>

      {/* 非候选终态快速导航条（如实时运行因网络瞬断终止时，方便直达同题完整归档演示） */}
      {!isCandidate && viewModel.mode === "completed" && (
        <div
          className="zygos-glass"
          style={{
            borderRadius: "16px",
            padding: "14px 18px",
            border: "1px solid var(--color-state-error-border)",
            backgroundColor: "var(--color-state-error-bg)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: "1 1 320px" }}>
            <AlertTriangle size={18} color="var(--color-state-error)" style={{ flexShrink: 0 }} />
            <div style={{ fontSize: "12.5px", color: "var(--color-ink)", lineHeight: 1.55 }}>
              <strong>该次历史运行已在 {stopInfo.code} 处提前收口</strong>（未跑完后续协同链）。
              若需录制完整 5+2+1 演进过程，可直接切换至已完整落盘的同题旗舰实录。
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <Link
              to="/runs/run-f5d6a68618a5/replay?autoplay=1"
              className="zygos-btn-primary"
              style={{ padding: "7px 13px", fontSize: "12px", textDecoration: "none" }}
            >
              <Play size={13} />
              <span>播放完整旗舰实录 (120)</span>
            </Link>
            <Link
              to="/solve"
              className="zygos-btn-ghost"
              style={{ padding: "7px 12px", fontSize: "12px", textDecoration: "none" }}
            >
              <span>返回演示首页</span>
            </Link>
          </div>
        </div>
      )}

      {/* 核心纯文本 / 直接数值答案主舞台 */}
      <section
        className="zygos-glass"
        style={{
          borderRadius: "24px",
          overflow: "hidden",
          border: "1px solid var(--color-line-strong)",
          boxShadow: "var(--shadow-ambient)",
        }}
      >
        <div className="astra-brand-rule" style={{ height: "5px", width: "100%" }} />

        <div style={{ padding: "30px 32px", display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* 状态摘要与复制操作 */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "5px 13px",
                  borderRadius: "999px",
                  fontSize: "12.5px",
                  fontWeight: 700,
                  backgroundColor: isCandidate
                    ? "var(--color-state-candidate-bg)"
                    : "var(--color-state-error-bg)",
                  border: `1px solid ${
                    isCandidate
                      ? "var(--color-state-candidate-border)"
                      : "var(--color-state-error-border)"
                  }`,
                  color: isCandidate
                    ? "var(--color-state-candidate)"
                    : "var(--color-state-error)",
                }}
              >
                {isCandidate ? "研究完成 · 候选结论（待形式化验证）" : `研究终止：${stopInfo.title}`}
              </span>

              <span style={{ fontSize: "12px", color: "var(--color-ink-mute)", fontFamily: "var(--font-mono)" }}>
                终止码：{stopInfo.code}
              </span>
            </div>

            {presentation.hasAnswer && (
              <button
                type="button"
                onClick={handleCopyPlain}
                className="zygos-btn-ghost"
                style={{
                  padding: "7px 14px",
                  fontSize: "12.5px",
                  color: copied ? "var(--color-state-success)" : undefined,
                  borderColor: copied ? "var(--color-state-success-border)" : undefined,
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                <span>{copied ? "已复制纯文本答案" : "复制纯文本答案"}</span>
              </button>
            )}
          </div>

          {/* 对应原题一句话（纯文本） */}
          {plainProblem && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "12px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
                fontSize: "13.5px",
                lineHeight: 1.65,
                color: "var(--color-ink-soft)",
              }}
            >
              <strong style={{ color: "var(--color-ink)", marginRight: "8px" }}>所求题目：</strong>
              {plainProblem}
            </div>
          )}

          {/* 超大字号直接数值/核心结果框（若有提取出的单值或短结论） */}
          {presentation.headline && (
            <div
              style={{
                padding: "24px 28px",
                borderRadius: "18px",
                background:
                  "linear-gradient(135deg, var(--color-brand-tint) 0%, var(--color-surface-sunken) 100%)",
                border: "1px solid var(--color-brand-ring)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "var(--color-brand-mid)",
                }}
              >
                直接答案输出
              </div>
              <div
                className="zygos-tabular"
                style={{
                  fontSize: "clamp(26px, 3.6vw, 42px)",
                  fontWeight: 800,
                  lineHeight: 1.35,
                  color: "var(--color-brand-deep)",
                  wordBreak: "break-word",
                }}
              >
                {presentation.headline}
              </div>
            </div>
          )}

          {/* 清晰分条纯文本答案内容 */}
          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: "var(--color-ink-mute)",
                marginBottom: "12px",
                letterSpacing: "0.03em",
              }}
            >
              完整答案内容（纯文本 / 直接数字）
            </div>

            {!presentation.hasAnswer ? (
              <div
                style={{
                  padding: "28px 24px",
                  borderRadius: "16px",
                  backgroundColor: "var(--color-surface-sunken)",
                  border: "1px dashed var(--color-line-strong)",
                  fontSize: "15px",
                  color: "var(--color-ink-soft)",
                  textAlign: "center",
                }}
              >
                本次运行已进入终态，但模型与引擎未产出可显示的最终答案文本（终止原因：{stopInfo.description}）。
              </div>
            ) : (
              <div
                style={{
                  padding: "24px 26px",
                  borderRadius: "18px",
                  backgroundColor: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-line-strong)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "14px",
                }}
              >
                {presentation.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="zygos-tabular"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "12px",
                      fontSize: "19px",
                      fontWeight: 600,
                      lineHeight: 1.75,
                      color: "var(--color-ink)",
                      paddingBottom: idx < presentation.items.length - 1 ? "14px" : 0,
                      borderBottom:
                        idx < presentation.items.length - 1
                          ? "1px solid var(--color-line)"
                          : "none",
                      wordBreak: "break-word",
                    }}
                  >
                    {presentation.items.length > 1 && (
                      <span
                        style={{
                          minWidth: "28px",
                          height: "28px",
                          marginTop: "3px",
                          borderRadius: "999px",
                          backgroundColor: "var(--color-brand-tint)",
                          border: "1px solid var(--color-brand-ring)",
                          color: "var(--color-brand-deep)",
                          fontSize: "13px",
                          fontWeight: 800,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {idx + 1}
                      </span>
                    )}
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 真实工具计算数值回执（如有，纯数字展示） */}
          {presentation.numericObservations.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ fontSize: "12.5px", fontWeight: 700, color: "var(--color-ink-mute)" }}>
                数学计算工具实测数值回执
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "10px",
                }}
              >
                {presentation.numericObservations.map((obs, idx) => (
                  <div
                    key={`${obs.quantity}-${idx}`}
                    style={{
                      padding: "14px 16px",
                      borderRadius: "14px",
                      backgroundColor: "var(--color-surface-sunken)",
                      border: "1px solid var(--color-line)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "12.5px", fontWeight: 700, color: "var(--color-ink-soft)" }}>
                        {obs.quantity}
                      </div>
                      {obs.exactness && (
                        <div style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>
                          口径：{obs.exactness}
                        </div>
                      )}
                    </div>
                    <div
                      className="zygos-tabular"
                      style={{
                        fontSize: "26px",
                        fontWeight: 800,
                        color: "var(--color-state-success)",
                      }}
                    >
                      {obs.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 未关闭义务警告（如有） */}
          {viewModel.unresolvedObligations && viewModel.unresolvedObligations.length > 0 && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "12px",
                backgroundColor: "var(--color-state-error-bg)",
                border: "1px solid var(--color-state-error-border)",
                color: "var(--color-state-error)",
                fontSize: "13px",
                lineHeight: 1.6,
              }}
            >
              <strong>未解决义务项提示：</strong>
              {viewModel.unresolvedObligations.join("；")}
            </div>
          )}

          {/* 可信声明（简明清晰） */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "12px 16px",
              borderRadius: "12px",
              backgroundColor: "var(--color-state-candidate-bg)",
              border: "1px solid var(--color-state-candidate-border)",
              color: "var(--color-state-candidate)",
              fontSize: "12.5px",
              lineHeight: 1.55,
            }}
          >
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>
              <strong>可信红线说明（candidateVerified = false）：</strong>
              以上答案由受控推理与审查流程生成，未经外部形式化证明内核（如 Lean/Coq）验证，供研究者直观读取与核验。
            </span>
          </div>

          {/* 3-Agent 读题与多-Agent 协同校验摘要胶囊 */}
          {(viewModel.r0Reading || viewModel.multiAgentSolving) && (
            <div
              className="zygos-spring-card"
              style={{
                padding: "12px 14px",
                borderRadius: "14px",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface-sunken)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "12px", color: "var(--color-ink-soft)" }}>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontWeight: 700,
                    backgroundColor: "var(--color-brand-tint)",
                    color: "var(--color-brand-deep)",
                    border: "1px solid var(--color-brand-ring)",
                  }}
                >
                  协同机制摘要
                </span>
                {viewModel.r0Reading && (
                  <span className="zygos-tabular">
                    R0 三方读题：{viewModel.r0Reading.agents.filter((a) => a.status === "completed" || a.status === "failed").length}/3 角色
                    {viewModel.r0Reading.revisionTriggered ? "（触发合同修订）" : ""}
                  </span>
                )}
                {viewModel.multiAgentSolving && (
                  <span className="zygos-tabular">
                    · 多路选票 {viewModel.multiAgentSolving.ballots.length} 份 · 审计 {viewModel.multiAgentSolving.audits.length} 轮
                    {viewModel.multiAgentSolving.certificate.observed ? " · CERT1 已核查" : ""}
                    {viewModel.multiAgentSolving.closure.observed ? " · 答案闭合通过" : ""}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={onShowProcess}
                className="zygos-btn-ghost"
                style={{ padding: "5px 12px", fontSize: "12px" }}
              >
                <GitBranch size={13} />
                <span>查看 3-Agent 与多-Agent 求解全过程</span>
              </button>
            </div>
          )}

          {/* 精简统计与折叠原始交付文本 */}
          <div
            style={{
              paddingTop: "14px",
              borderTop: "1px solid var(--color-line)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <div
              className="zygos-tabular"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "18px",
                flexWrap: "wrap",
                fontSize: "12.5px",
                color: "var(--color-ink-mute)",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <Cpu size={14} />
                模型调用：{viewModel.budget.usedModelCalls} / {viewModel.budget.maxModelCalls}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <Layers size={14} />
                工作单元：{viewModel.budget.usedWorkUnits} / {viewModel.budget.maxWorkUnits}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <Clock size={14} />
                观测耗时：{formatDuration(viewModel.budget.elapsedMs)}
              </span>
            </div>

            {presentation.rawSourceText && (
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                style={{
                  border: "none",
                  background: "none",
                  color: "var(--color-ink-soft)",
                  fontSize: "12px",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <span>{showRaw ? "收起原始交付原文" : "查看原始交付原文（核对符号源串）"}</span>
                {showRaw ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>

          {showRaw && presentation.rawSourceText && (
            <pre
              style={{
                margin: 0,
                padding: "14px 16px",
                borderRadius: "12px",
                backgroundColor: "var(--color-code-bg)",
                border: "1px solid var(--color-line)",
                color: "var(--color-ink-soft)",
                fontFamily: "var(--font-mono)",
                fontSize: "12.5px",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {presentation.rawSourceText}
            </pre>
          )}
        </div>
      </section>
    </div>
  );
}
