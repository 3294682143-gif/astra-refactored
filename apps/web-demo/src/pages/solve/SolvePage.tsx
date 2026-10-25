import { useState, useRef, useEffect } from "react";
import { Link } from "react-router";
import { Play, Square, Sparkles, BookOpen, ExternalLink, Activity, AlertTriangle } from "lucide-react";
import { ResultCard } from "@/components/ResultCard";
import { StatusBadge, type StatusKind } from "@/components/StatusBadge";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import {
  createRun,
  fetchCapabilities,
  fetchRun,
  fetchRuntimeInfo,
  readTerminalFacts,
  resolveTraceLevel,
  type ApiResult,
  type CapabilitiesResponse,
  type RunSummaryItem,
  type RuntimeInfoResponse,
  type TraceLevel,
} from "@/api/client.ts";
import { describeStopReason } from "@/domain/stopReasonView.ts";
import {
  parseTerminalFrame,
  stableIdempotencyKey,
  toTerminalEnvelope,
  type TerminalFrame,
} from "@/domain/terminalFrame.ts";
import {
  createInitialRunViewState,
  getEventKind,
  reduceRun,
  type RunEventEnvelope,
  type RunViewState,
} from "@/domain/reduceRun.ts";

/** 终态状态集合：到达后不再期待更多事件。 */
const TERMINAL_RUN_STATUSES: readonly RunViewState["status"][] = [
  "candidate",
  "unsolved",
  "aborted",
  "error",
  "timeout",
  "failed",
  "cancelled",
  "unknown",
];

/** 实时求解流不携带存档路径，因此数据级别只能记为 UNKNOWN（绝不冒充 L3）。 */
const LIVE_STREAM_LEVEL: TraceLevel = "UNKNOWN";

function toStatusKind(status: RunViewState["status"]): StatusKind {
  switch (status) {
    case "candidate":
      return "candidate";
    case "unsolved":
      return "unsolved";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "timeout":
      return "timeout";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "finished":
      return "finished";
    default:
      return "unknown";
  }
}

function formatEventTime(at: number | undefined): string {
  return typeof at === "number" && Number.isFinite(at)
    ? new Date(at).toLocaleTimeString()
    : "未知";
}

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

/** POST /api/runs 的真实响应元信息（首次执行 vs 幂等重放必须可区分）。 */
interface PostMeta {
  readonly httpStatus: number;
  readonly idempotencyKey: string;
  readonly idempotentReplay: boolean;
  readonly started: boolean | null;
  readonly terminal: boolean | null;
}

export function SolvePage() {
  const [problem, setProblem] = useState(SAMPLE_PROBLEMS[0]!.text);
  const [maxModelCalls, setMaxModelCalls] = useState(8);
  const [maxEffects, setMaxEffects] = useState<0 | 1 | 2>(1);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfoResponse | null>(null);
  const defaultsAppliedRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  /** 真实失败态文本（请求失败 / 事件流中断）。绝不回落演示数据。 */
  const [failure, setFailure] = useState<string | null>(null);
  /** 用户本地中止监听（未向服务端发送取消请求，故不冒充 CANCELLED 终态）。 */
  const [localAborted, setLocalAborted] = useState(false);
  /** SSE close 帧携带的真实终态事实（后端自述，非推测）。 */
  const [terminalFrame, setTerminalFrame] = useState<TerminalFrame | null>(null);
  /** 收流后回读的运行记录（权威 detail_level 与保真终态字段）。 */
  const [runRecord, setRunRecord] = useState<ApiResult<RunSummaryItem> | null>(null);
  /** POST 响应元信息：区分首次执行与幂等重放。 */
  const [postMeta, setPostMeta] = useState<PostMeta | null>(null);

  const [state, setState] = useState<RunViewState>(() =>
    createInitialRunViewState("live-solve")
  );

  const eventSourceRef = useRef<EventSource | null>(null);
  /** 是否已收到 FINAL / RESULT 终态事件（用于区分「流正常收口」与「流中断」）。 */
  const terminalSeenRef = useRef(false);
  /** SSE 断线后浏览器是否正在自动重连（真实连接状态，非推测）。 */
  const [reconnecting, setReconnecting] = useState(false);
  /** 真实发生过的断线重连次数（由 EventSource 的 error 事件累加，可审计）。 */
  const [reconnectCount, setReconnectCount] = useState(0);

  const cleanupStreams = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  useEffect(() => {
    return cleanupStreams;
  }, []);

  useEffect(() => {
    let alive = true;
    fetchCapabilities().then((res) => {
      if (!alive || !res.ok) return;
      setCapabilities(res.data);
      if (!defaultsAppliedRef.current) {
        const budget = res.data.default_budget ?? {};
        if (typeof budget["max_model_calls"] === "number") setMaxModelCalls(budget["max_model_calls"]);
        if (budget["max_effects"] === 0 || budget["max_effects"] === 1 || budget["max_effects"] === 2) {
          setMaxEffects(budget["max_effects"]);
        }
        defaultsAppliedRef.current = true;
      }
    });
    fetchRuntimeInfo().then((res) => {
      if (alive && res.ok) setRuntimeInfo(res.data);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const handleApplyEvent = (ev: RunEventEnvelope) => {
    const kind = getEventKind(ev);
    if (kind === "FINAL" || kind === "RESULT" || kind === "error") {
      terminalSeenRef.current = true;
    }
    setState((prev) => reduceRun(prev, ev));
  };

  const handleStartSolve = async () => {
    cleanupStreams();
    const newRunId = `run-${Date.now().toString(36)}`;
    setFailure(null);
    setLocalAborted(false);
    setTerminalFrame(null);
    setRunRecord(null);
    setPostMeta(null);
    terminalSeenRef.current = false;
    setCurrentRunId(newRunId);
    setState(createInitialRunViewState(newRunId));
    setIsRunning(true);
    setReconnecting(false);
    setReconnectCount(0);

    // 幂等键由「题目 + 预算配置」确定性推导：同题同配置重复提交会被后端识别为重放（HTTP 200），
    // 不再新起执行；界面据 httpStatus / idempotent_replay 明确区分呈现。
    const idempotencyKey = stableIdempotencyKey(problem, maxModelCalls, maxEffects);

    // 真实请求：失败即显示真实错误态，绝不回落演示 / 样例数据。
    const created = await createRun(
      {
        problem,
        engine: "ts",
        max_model_calls: maxModelCalls,
        max_effects: maxEffects,
        max_method_loads: 0,
      },
      idempotencyKey,
    );

    if (!created.ok) {
      cleanupStreams();
      setIsRunning(false);
      setFailure(
        `求解请求失败：${created.error.message}（接口：${created.error.url}）。未回落演示数据，未生成任何候选。`,
      );
      return;
    }

    const activeId = created.data.run_id;
    setCurrentRunId(activeId);
    setPostMeta({
      httpStatus: created.httpStatus,
      idempotencyKey,
      idempotentReplay: created.data.idempotent_replay === true,
      started: created.data.started ?? null,
      terminal: created.data.terminal ?? null,
    });

    const es = new EventSource(`/api/runs/${encodeURIComponent(activeId)}/events`);
    eventSourceRef.current = es;

    // 真实事件名来自 Host observer（BFF 不改名）。旧的 MODEL_REQUEST /
    // TOOL_OBSERVATION 监听保留，但真实链路的进展必须由这三个名字驱动。
    const kinds = [
      "model_dispatched",
      "model_returned",
      "effect_returned",
      "SESSION_INIT",
      "CONTRACT",
      "TASK_STARTED",
      "MODEL_REQUEST",
      "METHOD_LOAD",
      "TOOL_OBSERVATION",
      "WORKUNIT",
      "REVIEW_CHALLENGE",
      "FINAL",
      "RESULT",
      "error",
    ];

    kinds.forEach((k) => {
      es.addEventListener(k, (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data) as RunEventEnvelope;
          handleApplyEvent(ev);
        } catch {
          // 单帧解析失败由归约器的畸变防护记录，不伪造事件内容
        }
      });
    });

    es.addEventListener("close", (ev: Event) => {
      cleanupStreams();
      setIsRunning(false);
      // 命名 SSE 事件在运行时以 MessageEvent 投递，data 即后端自述的终态事实。
      const frame = parseTerminalFrame((ev as MessageEvent).data);
      if (frame) {
        terminalSeenRef.current = true;
        setTerminalFrame(frame);
        // 把后端自述的真实终态登记进时间线并驱动终态状态机（字段改名，非伪造事件）。
        setState((prev) => reduceRun(prev, toTerminalEnvelope(frame, activeId)));
      }
      // 收流后回读运行记录，取得权威 detail_level 与保真终态字段。
      fetchRun(activeId).then((res) => {
        setRunRecord(res);
        if (!frame && !res.ok) {
          setFailure(
            `事件流已关闭，且未能读取运行终态（${res.error.message}）。未回落演示数据，也不推测结果。`,
          );
        }
      });
    });

    // EventSource 自己在 CONNECTING 状态会自动带 Last-Event-ID 重连；
    // 只有真正 CLOSED（浏览器放弃、或我们主动 close）才收口。
    es.onerror = () => {
      if (terminalSeenRef.current) return;
      if (es.readyState === EventSource.CLOSED) {
        cleanupStreams();
        setIsRunning(false);
        setReconnecting(false);
        setFailure(
          "事件流已关闭：连接错误后浏览器不再重试，且未收到任何终态事实。未回落演示数据。",
        );
        return;
      }
      // 仍在重连：保持监听并如实呈现「正在重连」，不提前宣布失败。
      setReconnecting(true);
      setReconnectCount((n) => n + 1);
    };

    es.onopen = () => {
      setReconnecting(false);
    };
  };

  const handleStop = () => {
    cleanupStreams();
    setIsRunning(false);
    setLocalAborted(true);
  };

  const isCompleted = state.resultSeen || TERMINAL_RUN_STATUSES.includes(state.status);
  const lastEvent = state.events.length > 0 ? state.events[state.events.length - 1] : undefined;

  // 保真终态：优先取运行记录（GET /api/runs/{id}），其次取 SSE 关闭帧；缺失字段保持 null，不推测。
  const recorded = readTerminalFacts(runRecord && runRecord.ok ? runRecord.data : null);
  const facts = {
    status: recorded.status ?? terminalFrame?.status ?? null,
    stopReason: recorded.stopReason ?? terminalFrame?.stopReason ?? state.stopReason ?? null,
    terminalKind: recorded.terminalKind ?? terminalFrame?.terminalKind ?? null,
    finalResponse: recorded.finalResponse ?? terminalFrame?.finalResponse ?? null,
    executed: recorded.executed ?? terminalFrame?.executed ?? null,
    code: recorded.code ?? terminalFrame?.code ?? null,
  };
  /** 后端明确声明「未执行任何求解」（当前 BFF 未接线真实求解入口时恒为 true）。 */
  const notExecuted = facts.executed === false;
  const traceLevel: TraceLevel =
    runRecord && runRecord.ok ? resolveTraceLevel(runRecord.data) : "UNKNOWN";
  const effectiveStop = describeStopReason(facts.stopReason ?? state.stopReason);
  const statusDetail =
    state.resultSeen || facts.stopReason
      ? `${effectiveStop.title}（${effectiveStop.categoryTitle}）：${effectiveStop.description}`
      : failure ?? "未取得任何终态事实（界面不推测结论）。";

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
          {runtimeInfo && !runtimeInfo.solverConfigured ? (
            <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--color-state-unsolved)" }}>
              服务端未配置正式 solver：请求会明确返回未执行状态，不会自动回退演示数据。
            </p>
          ) : null}
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
                  数学资产调用额度 (max_effects)
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "2px" }}>
                  {([0, 1, 2] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setMaxEffects(value)}
                      style={{
                        flex: 1,
                        padding: "6px 0",
                        borderRadius: "6px",
                        border: `1px solid ${maxEffects === value ? "var(--color-brand)" : "var(--color-line)"}`,
                        backgroundColor: maxEffects === value ? "var(--color-brand-tint)" : "#ffffff",
                        color: maxEffects === value ? "var(--color-brand)" : "var(--color-ink-soft)",
                        fontWeight: 500,
                        fontSize: "12px",
                        cursor: "pointer",
                      }}
                    >
                      {value} 次
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: "10px", color: "var(--color-ink-mute)", marginTop: "4px" }}>
                  max_method_loads 固定为 0；调用额度只计真实数学资产/工具效果。
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
                <span>{isRunning ? "正在进行实时推导..." : "开始单循环求解"}</span>
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
                  <span>中止推导流</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* 右栏：实时执行反馈与终态卡片 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {!isRunning && (failure || localAborted) ? (
            <div
              style={{
                borderRadius: "var(--radius-card)",
                border: `1px solid ${failure ? "#fecaca" : "#fde68a"}`,
                backgroundColor: failure ? "#fef2f2" : "#fffbeb",
                color: failure ? "#b91c1c" : "#92400e",
                padding: "14px 18px",
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                fontSize: "12px",
                lineHeight: 1.6,
              }}
            >
              <AlertTriangle size={16} style={{ marginTop: "1px", flexShrink: 0 }} />
              <span>
                {failure ?? "已由用户本地中止监听（未向服务端发送取消请求，故不显示为 CANCELLED 终态）。"}
              </span>
            </div>
          ) : null}

          {reconnecting && isRunning ? (
            <div
              style={{
                borderRadius: "var(--radius-card)",
                border: "1px solid #fde68a",
                backgroundColor: "#fffbeb",
                color: "#92400e",
                padding: "14px 18px",
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                fontSize: "12px",
                lineHeight: 1.6,
              }}
            >
              <Activity size={16} style={{ marginTop: "1px", flexShrink: 0 }} />
              <span>事件流连接中断，浏览器正在按 Last-Event-ID 自动重连；未收到终态事实前不会推测结论。</span>
            </div>
          ) : null}

          {reconnectCount > 0 ? (
            <div
              data-testid="reconnect-count"
              style={{
                fontSize: "11px",
                color: "var(--color-ink-soft)",
                borderLeft: "3px solid var(--color-brand)",
                paddingLeft: "8px",
              }}
            >
              事件流重连 {reconnectCount} 次（Last-Event-ID 续传，不重复计数）
            </div>
          ) : null}

          {postMeta ? (
            <div
              style={{
                borderRadius: "8px",
                border: `1px solid ${postMeta.idempotentReplay ? "#fde68a" : "var(--color-line)"}`,
                backgroundColor: postMeta.idempotentReplay ? "#fffbeb" : "var(--color-surface-muted)",
                padding: "10px 14px",
                fontSize: "11px",
                color: postMeta.idempotentReplay ? "#92400e" : "var(--color-ink-soft)",
                lineHeight: 1.7,
              }}
            >
              {postMeta.idempotentReplay
                ? `本次为幂等重放（HTTP ${postMeta.httpStatus}，idempotent_replay=true）：未新起执行，返回既有运行 ${currentRunId ?? "未知"} 的终态。`
                : `本次为首次执行（HTTP ${postMeta.httpStatus}）；幂等键 ${postMeta.idempotencyKey} —— 同题同配置重复提交将返回 200 重放而不新建运行。`}
              <br />
              started: {postMeta.started === null ? "未知" : String(postMeta.started)} · terminal（响应时是否已终态）:
              {postMeta.terminal === null ? " 未知" : ` ${String(postMeta.terminal)}`}
              <br />
              本次生效配置：engine=ts · max_model_calls={maxModelCalls} · max_effects={maxEffects} · max_method_loads=0
              {capabilities ? `（服务端默认 max_model_calls=${String(capabilities.default_budget?.["max_model_calls"] ?? "未知")}）` : ""}
            </div>
          ) : null}

          {isRunning && (
            <div
              style={{
                borderRadius: "var(--radius-card)",
                border: "1px solid var(--color-brand)",
                backgroundColor: "var(--color-brand-tint)",
                padding: "16px 20px",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand-deep)", fontWeight: 600, fontSize: "14px" }}>
                <Activity size={18} />
                <span>实时推导执行流中 (已接收 {state.events.length} 帧)...</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-ink-soft)" }}>
                当前阶段: <code>{state.events.length > 0 ? state.events[state.events.length - 1]?.kind : "初始化"}</code>
              </div>
            </div>
          )}

          {state.steps.length > 0 || state.toolCalls.length > 0 ? (
            <div
              data-testid="live-activity"
              style={{
                borderRadius: "var(--radius-card)",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface-muted)",
                padding: "14px 18px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                fontSize: "12px",
                color: "var(--color-ink-soft)",
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--color-brand-deep)" }}>实时执行活动（真实事件）</div>
              {state.steps.map((step) => (
                <div key={`step-${step.stepId}`} data-testid="live-step">
                  模型调用 · {step.name ?? step.stepId} ·{" "}
                  <code data-testid={`live-step-status-${step.stepId}`}>{step.status}</code>
                  {step.detail ? `（${step.detail}）` : ""}
                </div>
              ))}
              {state.toolCalls.map((call) => (
                <div key={`call-${call.id}`} data-testid="live-effect">
                  effect 观测 · <code>{call.name}</code> · {call.id} · 状态 {call.status}
                </div>
              ))}
            </div>
          ) : null}

          {notExecuted ? (
            <div
              style={{
                borderRadius: "var(--radius-card)",
                border: "1px solid #fecaca",
                backgroundColor: "#fef2f2",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <AlertTriangle size={18} color="#b91c1c" />
                <span style={{ fontSize: "15px", fontWeight: 700, color: "#b91c1c" }}>
                  本运行未执行（executed = false）
                </span>
                <StatusBadge status={toStatusKind(state.status)} size="sm" />
                <DataSourceBadge level={traceLevel} size="sm" />
              </div>
              <div style={{ fontSize: "12px", color: "#7f1d1d", lineHeight: 1.9 }}>
                <div>
                  status: <code>{facts.status ?? "未知"}</code> · stopReason: <code>{facts.stopReason ?? "未知"}</code> · terminalKind: <code>{facts.terminalKind ?? "未知"}</code>
                </div>
                <div>
                  code: <code>{facts.code ?? "未知"}</code>
                  {facts.code === "SOLVER_NOT_CONFIGURED" ? "（BFF 尚未接线真实求解入口）" : ""}
                </div>
                <div>
                  final_response: <code>{facts.finalResponse ?? "未提供"}</code>
                  （官方契约的未执行占位文本，<strong>不是候选答案</strong>）
                </div>
                <div>
                  数据级别: {traceLevel === "UNKNOWN" ? "未知（接口未确证，不冒充 L3）" : traceLevel}
                </div>
              </div>
              <div style={{ fontSize: "11px", color: "#7f1d1d", lineHeight: 1.7, borderTop: "1px solid #fecaca", paddingTop: "10px" }}>
                本次运行未执行任何求解，因此不存在候选产物：界面不显示为 candidate，也不回落演示数据。
                红线：candidate_verified = false。
              </div>
            </div>
          ) : isCompleted ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <ResultCard
                title="当前推导产物（待审候选）"
                status={toStatusKind(state.status)}
                source={LIVE_STREAM_LEVEL}
                answer={state.candidateProposal ?? undefined}
                unsolvedReason={state.status === "unsolved" ? statusDetail : undefined}
                errorMessage={
                  state.status === "candidate" || state.status === "unsolved"
                    ? undefined
                    : statusDetail
                }
                updatedAt={formatEventTime(lastEvent?.at ?? lastEvent?.ts)}
                note={
                  state.finalResponseMissing
                    ? "红线：candidate_verified = false。本次终态事件未携带 final_response，界面不填充任何结论文本。"
                    : "红线：candidate_verified = false。产物仅为模型自主推导候选，未经形式化验证，也不构成数学结论可靠性的保证。"
                }
              />

              <RunFacts summary={runRecord && runRecord.ok ? runRecord.data.summary ?? null : null} />

              <div style={{ display: "flex", gap: "12px" }}>
                <Link
                  to={`/runs/${currentRunId ?? ""}`}
                  style={{
                    flex: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    border: "1px solid var(--color-brand)",
                    backgroundColor: "#ffffff",
                    color: "var(--color-brand-deep)",
                    fontSize: "13px",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  <span>查看七标签审计页</span>
                  <ExternalLink size={14} />
                </Link>

                <Link
                  to={`/runs/${currentRunId ?? ""}/replay`}
                  style={{
                    flex: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    padding: "10px 16px",
                    borderRadius: "8px",
                    backgroundColor: "var(--color-brand)",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  <span>进入时间胶囊回放</span>
                  <ExternalLink size={14} />
                </Link>
              </div>
            </div>
          ) : !isRunning && postMeta === null ? (
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
                尚未提交求解请求
              </div>
              <div style={{ fontSize: "12px" }}>
                输入题目并点击「开始单循环求解」，观察执行链展开
              </div>
            </div>
          ) : !isRunning ? (
            <div
              style={{
                borderRadius: "var(--radius-card)",
                border: "1px dashed #fde68a",
                backgroundColor: "#fffbeb",
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#92400e" }}>运行终态未知</div>
              <div style={{ fontSize: "12px", color: "#92400e", lineHeight: 1.7 }}>
                已提交运行 <code>{currentRunId ?? "未知"}</code>，但既未从 SSE 关闭帧、也未从
                <code>/api/runs/{"{runId}"}</code> 取得终态事实（原因：{failure ?? "未收到终态事实"}）。
                界面不推测结论、不显示为 candidate、不回落演示数据。
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function metricValue(metrics: Record<string, unknown>, key: string): string {
  const value = metrics[key];
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "未知";
}

function RunFacts(props: { summary: Record<string, unknown> | null }) {
  const summary = props.summary ?? {};
  const metrics = (summary["metrics"] && typeof summary["metrics"] === "object"
    ? summary["metrics"] as Record<string, unknown>
    : {});
  const unknownUsage = metrics["reported_tokens"] == null;
  const rows: Array<[string, string]> = [
    ["executed", summary["executed"] === true ? "true" : summary["executed"] === false ? "false" : "未知"],
    ["childReaped", summary["childReaped"] === true ? "true" : summary["childReaped"] === false ? "false" : "未知"],
    ["tool_effect_calls", metricValue(metrics, "tool_effect_calls")],
    ["logical_model_calls", metricValue(metrics, "logical_model_calls")],
    ["reported_tokens", unknownUsage ? "未知（不是 0）" : metricValue(metrics, "reported_tokens")],
    ["remote_outcome_unknown", metrics["remote_outcome_unknown"] === true ? "true" : metrics["remote_outcome_unknown"] === false ? "false" : "未知"],
  ];
  return (
    <div style={{ borderRadius: "10px", border: "1px solid var(--color-line)", backgroundColor: "var(--color-surface-muted)", padding: "12px 14px", fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.8 }}>
      <div style={{ fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "4px" }}>运行事实（来自 BFF 落盘 summary）</div>
      {rows.map(([key, value]) => (
        <div key={key}><code>{key}</code>: {value}</div>
      ))}
    </div>
  );
}
