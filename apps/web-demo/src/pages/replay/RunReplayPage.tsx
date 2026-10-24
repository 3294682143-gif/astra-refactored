import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, Link } from "react-router";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ArrowLeft,
  Wrench,
  AlertTriangle,
  RotateCcw,
  Gauge,
  ListOrdered,
  FileCode2,
} from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import { PlaybackController, type PlaybackSpeed } from "@/domain/playback.ts";
import {
  fetchReplay,
  fetchRun,
  readTerminalFacts,
  resolveTraceLevel,
  type ApiResult,
  type ReplayPayload,
  type RunSummaryItem,
  type TraceLevel,
} from "@/api/client.ts";
import { describeStopReason } from "@/domain/stopReasonView.ts";
import { getEventKind, getEventPayload } from "@/domain/reduceRun.ts";

export function RunReplayPage() {
  const { runId } = useParams();
  const activeRunId = runId ?? "";

  const controllerRef = useRef<PlaybackController | null>(null);
  const [, setTick] = useState(0);
  const [replay, setReplay] = useState<ApiResult<ReplayPayload> | null>(null);
  const [runRecord, setRunRecord] = useState<ApiResult<RunSummaryItem> | null>(null);

  // 初始化 PlaybackController
  useEffect(() => {
    const ctrl = new PlaybackController({
      initialRunId: activeRunId || "unknown-run",
      snapshotInterval: 10,
    });
    controllerRef.current = ctrl;
    setReplay(null);
    setRunRecord(null);

    const unsubscribe = ctrl.subscribe(() => {
      setTick((t) => t + 1);
    });

    if (activeRunId) {
      fetchReplay(activeRunId).then((res) => {
        setReplay(res);
        ctrl.loadEvents(res.ok ? res.data.events : [], true);
      });
      fetchRun(activeRunId).then((res) => {
        setRunRecord(res);
      });
    }

    return () => {
      ctrl.destroy();
      unsubscribe();
    };
  }, [activeRunId]);

  const ctrl = controllerRef.current;
  const state = ctrl ? ctrl.state : null;
  const runMeta = runRecord && runRecord.ok ? runRecord.data : null;
  const facts = readTerminalFacts(runMeta);
  const notExecuted = facts.executed === false;
  // 与 RunDetailPage 共用 resolveTraceLevel：优先后端权威 detail_level，取不到才回退 l2_path/l3_path。
  const traceLevel: TraceLevel = runMeta ? resolveTraceLevel(runMeta) : "L2";
  const stopInfo = describeStopReason(state?.stopReason);
  const currentEvent = ctrl && ctrl.currentIndex >= 0 && ctrl.currentIndex < ctrl.events.length
    ? ctrl.events[ctrl.currentIndex]
    : null;

  const currentPayloadJson = useMemo(() => {
    if (!currentEvent) return "";
    return JSON.stringify(getEventPayload(currentEvent), null, 2);
  }, [currentEvent]);

  if (replay === null || !ctrl || !state) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-ink-soft)" }}>
        正在载入运行回放数据流与状态快照...
      </div>
    );
  }

  if (!replay.ok) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {runMeta ? (
          <div
            style={{
              borderRadius: "8px",
              border: "1px solid #fde68a",
              backgroundColor: "#fffbeb",
              color: "#92400e",
              padding: "12px 16px",
              fontSize: "12px",
              lineHeight: 1.8,
            }}
          >
            该运行真实存在，但无 L2 回放存档。其真实终态：status <code>{facts.status ?? "未知"}</code> ·
            stopReason <code>{facts.stopReason ?? "未知"}</code> · terminalKind <code>{facts.terminalKind ?? "未知"}</code> ·
            executed <code>{facts.executed === null ? "未知" : String(facts.executed)}</code> · code <code>{facts.code ?? "未知"}</code> ·
            final_response <code>{facts.finalResponse ?? "未提供"}</code>
            {notExecuted ? "（官方契约的未执行占位文本，不是候选答案）" : ""} · 数据级别 <strong>{traceLevel}</strong>
          </div>
        ) : null}
        <PanelEmptyState
          variant="missing"
          title={runId ? "回放存档不存在或不可读（真实错误态）" : "URL 缺少 run_id 参数"}
          description={
            runId
              ? `${replay.error.message}（接口：${replay.error.url}）`
              : "请从「求解运行历史」列表进入回放控制台。"
          }
          hint={`未回落演示数据；数据可观测级别记为 ${runMeta ? traceLevel : "UNKNOWN"}，不标注 L3。`}
          action={
            <Link
              to="/runs"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "8px",
                border: "1px solid var(--color-brand)",
                backgroundColor: "var(--color-brand-tint)",
                color: "var(--color-brand-deep)",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              <span>返回运行历史</span>
            </Link>
          }
        />
      </div>
    );
  }

  const speeds: PlaybackSpeed[] = [0.5, 1, 2, 5];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* 顶部导航与状态条 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Link
            to={`/runs/${activeRunId}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid var(--color-line)",
              backgroundColor: "#ffffff",
              fontSize: "13px",
              color: "var(--color-ink)",
              textDecoration: "none",
            }}
          >
            <ArrowLeft size={14} />
            <span>返回详情</span>
          </Link>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            答辩回放控制台 · 确定性时间胶囊
          </h2>
          <DataSourceBadge level={traceLevel} size="sm" />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
            会话: <code style={{ fontFamily: "var(--font-mono)" }}>{state.runId}</code>
          </span>
          <StatusBadge status={state.status} size="sm" />
        </div>
      </div>

      {/* 播放器核心控制面板 */}
      <div
        style={{
          borderRadius: "var(--radius-card)",
          border: "1px solid var(--color-line)",
          backgroundColor: "#ffffff",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          boxShadow: "0 2px 8px rgba(15,38,92,0.04)",
        }}
      >
        {/* 时间线拖动条 */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--color-ink-mute)", marginBottom: "6px" }}>
            <span>
              游标位置: 第 <strong>{ctrl.currentIndex + 1}</strong> / {ctrl.totalEvents} 帧 (Seq #{ctrl.currentSeq})
            </span>
            <span>
              进度: {Math.round(ctrl.progressRatio * 100)}%
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(0, ctrl.totalEvents - 1)}
            value={Math.max(0, ctrl.currentIndex)}
            onChange={(e) => {
              ctrl.jumpToIndex(Number(e.target.value));
            }}
            style={{
              width: "100%",
              cursor: "pointer",
              accentColor: "var(--color-brand)",
            }}
          />
        </div>

        {/* 播放控制按钮栏 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button
              type="button"
              onClick={() => ctrl.jumpToIndex(0)}
              title="重头开始"
              style={{
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid var(--color-line)",
                backgroundColor: "#ffffff",
                cursor: "pointer",
                display: "inline-flex",
              }}
            >
              <RotateCcw size={16} />
            </button>

            <button
              type="button"
              onClick={() => ctrl.stepBackward()}
              title="单步后退"
              disabled={ctrl.currentIndex <= 0}
              style={{
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid var(--color-line)",
                backgroundColor: "#ffffff",
                cursor: ctrl.currentIndex <= 0 ? "not-allowed" : "pointer",
                display: "inline-flex",
                opacity: ctrl.currentIndex <= 0 ? 0.5 : 1,
              }}
            >
              <SkipBack size={16} />
            </button>

            <button
              type="button"
              onClick={() => ctrl.togglePlay()}
              style={{
                padding: "8px 20px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "var(--color-brand)",
                color: "#ffffff",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                fontWeight: 600,
                fontSize: "13px",
              }}
            >
              {ctrl.isPlaying ? <Pause size={16} /> : <Play size={16} />}
              <span>{ctrl.isPlaying ? "暂停" : "播放"}</span>
            </button>

            <button
              type="button"
              onClick={() => ctrl.stepForward()}
              title="单步前进"
              disabled={ctrl.currentIndex >= ctrl.totalEvents - 1}
              style={{
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid var(--color-line)",
                backgroundColor: "#ffffff",
                cursor: ctrl.currentIndex >= ctrl.totalEvents - 1 ? "not-allowed" : "pointer",
                display: "inline-flex",
                opacity: ctrl.currentIndex >= ctrl.totalEvents - 1 ? 0.5 : 1,
              }}
            >
              <SkipForward size={16} />
            </button>
          </div>

          {/* 倍速控制 */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Gauge size={14} color="var(--color-ink-mute)" />
            <span style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginRight: "4px" }}>倍速:</span>
            {speeds.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ctrl.setSpeed(s)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "4px",
                  border: "1px solid",
                  borderColor: ctrl.speed === s ? "var(--color-brand)" : "var(--color-line)",
                  backgroundColor: ctrl.speed === s ? "var(--color-brand-tint)" : "#ffffff",
                  color: ctrl.speed === s ? "var(--color-brand-deep)" : "var(--color-ink)",
                  fontSize: "12px",
                  fontWeight: ctrl.speed === s ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 告警与降级提示（如果有） */}
      {state.conflicts.length > 0 && (
        <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "12px 16px", color: "#b91c1c", fontSize: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
          <AlertTriangle size={16} />
          <span>检测到序列冲突事件 ({state.conflicts.length} 处)，冲突已隔离并记录至审计轨迹。</span>
        </div>
      )}

      {/* 回放分栏内容区 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
        {/* 左栏：当前状态与推导候选 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* 候选结果卡片（严格红线：未经验证标记） */}
          <div
            style={{
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-line)",
              backgroundColor: "#ffffff",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                推导候选状态与收口结论
              </h3>
              <StatusBadge status={state.status} size="sm" />
            </div>

            <div style={{ backgroundColor: "var(--color-surface-muted)", borderRadius: "8px", padding: "14px", border: "1px solid var(--color-line)" }}>
              <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", marginBottom: "4px" }}>当前暂定候选提案 (Candidate Proposal)</div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-ink)", fontFamily: "var(--font-mono)" }}>
                {state.candidateProposal ?? (state.resultSeen ? "（无候选产物 / final_response 缺失）" : "未到达终态，尚无候选产物")}
              </div>
            </div>

            {/* 红线红字警示条 */}
            <div
              style={{
                marginTop: "12px",
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: "#fffbeb",
                border: "1px solid #fde68a",
                fontSize: "11px",
                color: "#92400e",
                lineHeight: 1.5,
              }}
            >
              ● <strong>红线免责声明</strong>: <code>candidate_verified: false</code>。所有结论仅为模型自主推导产出的待审候选，未经形式化确认，也不构成数学结论可靠性的保证。
              <br />
              真实终态: <code>{state.status}</code> · 终止原因: <code>{stopInfo.code}</code>（{stopInfo.title} / {stopInfo.categoryTitle}）· final_response: {state.resultSeen ? (state.finalResponseMissing ? "缺失（未伪造）" : "已收到") : "未到达终态"}
            </div>
          </div>

          {/* 工具调用观测 */}
          <div
            style={{
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-line)",
              backgroundColor: "#ffffff",
              padding: "20px",
              minHeight: "180px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <Wrench size={16} color="var(--color-brand)" />
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                工具调用与代数求解观测 ({state.toolCalls.length})
              </h3>
            </div>

            {state.toolCalls.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", padding: "16px", textAlign: "center" }}>
                当前游标位置尚未触发工具调用
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {state.toolCalls.map((tc, idx) => (
                  <div key={idx} style={{ padding: "10px", borderRadius: "6px", backgroundColor: "var(--color-surface-muted)", border: "1px solid var(--color-line)", fontSize: "12px" }}>
                    <div style={{ fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "4px" }}>
                      #{idx + 1} 工具: {tc.name} ({tc.status})
                    </div>
                    {Boolean(tc.output) && (
                      <pre style={{ margin: 0, fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--color-ink-soft)", maxHeight: "100px", overflowY: "auto" }}>
                        {JSON.stringify(tc.output, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右栏：当前事件流水与原始 Payload */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* 当前帧事件详情 */}
          <div
            style={{
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-line)",
              backgroundColor: "#ffffff",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <FileCode2 size={16} color="var(--color-brand)" />
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                当前事件载荷 (Seq #{currentEvent ? currentEvent.seq : 0})
              </h3>
            </div>

            {currentEvent ? (
              <div>
                <div style={{ display: "flex", gap: "16px", fontSize: "12px", marginBottom: "10px" }}>
                  <span>类型: <strong>{getEventKind(currentEvent)}</strong></span>
                  <span>来源: <code>{currentEvent.sourceKind || "session_log"}</code></span>
                </div>
                <pre
                  style={{
                    backgroundColor: "var(--color-surface-sunken)",
                    padding: "14px",
                    borderRadius: "8px",
                    fontSize: "11px",
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-ink)",
                    maxHeight: "220px",
                    overflowY: "auto",
                    margin: 0,
                  }}
                >
                  {currentPayloadJson}
                </pre>
              </div>
            ) : (
              <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>未选中事件</div>
            )}
          </div>

          {/* 执行日志流 */}
          <div
            style={{
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-line)",
              backgroundColor: "#ffffff",
              padding: "20px",
              flex: 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <ListOrdered size={16} color="var(--color-brand)" />
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                时间线事件流水 ({state.logs.length})
              </h3>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "200px", overflowY: "auto" }}>
              {state.logs.map((log, idx) => (
                <div key={idx} style={{ fontSize: "11px", display: "flex", gap: "8px", lineHeight: 1.5 }}>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-ink-mute)", minWidth: "40px" }}>#{log.seq}</span>
                  <span style={{ color: log.level === "error" ? "#b91c1c" : log.level === "warn" ? "#d97706" : "var(--color-ink-soft)" }}>
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
