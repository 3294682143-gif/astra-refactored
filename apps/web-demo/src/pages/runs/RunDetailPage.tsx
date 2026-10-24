import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router";
import {
  PlayCircle,
  ShieldCheck,
  GitFork,
  ListOrdered,
  Wrench,
  FileSearch,
  BarChart2,
  Code2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { StatusBadge, normalizeStatusKind, type StatusKind } from "@/components/StatusBadge";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { PanelEmptyState } from "@/components/PanelEmptyState";
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
import {
  createInitialRunViewState,
  reduceRunAll,
  getEventKind,
  getEventPayload,
  type RunEventEnvelope,
} from "@/domain/reduceRun.ts";

type TabKey = "contract" | "graph" | "timeline" | "tools" | "review" | "metrics" | "raw";

export function RunDetailPage() {
  const { runId } = useParams();
  const activeRunId = runId ?? "";
  const [activeTab, setActiveTab] = useState<TabKey>("contract");
  const [events, setEvents] = useState<RunEventEnvelope[]>([]);
  const [replay, setReplay] = useState<ApiResult<ReplayPayload> | null>(null);
  const [runRecord, setRunRecord] = useState<ApiResult<RunSummaryItem> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setReplay(null);
    setRunRecord(null);
    if (!activeRunId) {
      return () => {
        alive = false;
      };
    }
    fetchReplay(activeRunId).then((res) => {
      if (!alive) return;
      setReplay(res);
      setEvents(res.ok ? res.data.events : []);
    });
    fetchRun(activeRunId).then((res) => {
      if (alive) setRunRecord(res);
    });
    return () => {
      alive = false;
    };
  }, [activeRunId, reloadKey]);

  const state = useMemo(() => {
    return reduceRunAll(createInitialRunViewState(activeRunId || "unknown-run"), events);
  }, [activeRunId, events]);

  const runMeta = runRecord && runRecord.ok ? runRecord.data : null;

  // 数据级别：优先后端权威 detail_level（取不到才回退 l2_path/l3_path），与 RunReplayPage 共用同一函数。
  // 不能因「无 L2 回放」就把级别判成 UNKNOWN —— 运行存在时它有自身真实级别（通常 L1）。
  const traceLevel: TraceLevel = runMeta
    ? resolveTraceLevel(runMeta)
    : replay?.ok
      ? "L2"
      : "UNKNOWN";
  const replayAvailable = replay?.ok === true;

  // 保真终态字段（来自 GET /api/runs/{id} 的 summary）；缺失保持 null，不推测。
  const facts = readTerminalFacts(runMeta);
  const notExecuted = facts.executed === false;

  const recordedStop =
    typeof runMeta?.summary?.["stopReason"] === "string"
      ? (runMeta.summary["stopReason"] as string)
      : null;
  const stopInfo = describeStopReason(state.stopReason ?? recordedStop);
  const displayStatus: StatusKind = runMeta ? normalizeStatusKind(runMeta.status) : state.status;

  const tabs: { key: TabKey; label: string; icon: typeof ShieldCheck }[] = [
    { key: "contract", label: "2.1 目标契约 (M1)", icon: ShieldCheck },
    { key: "graph", label: "2.2 任务图 (M3)", icon: GitFork },
    { key: "timeline", label: "2.3 事件时间线", icon: ListOrdered },
    { key: "tools", label: "2.4 工具与方法卡", icon: Wrench },
    { key: "review", label: "2.5 评审与修复", icon: FileSearch },
    { key: "metrics", label: "2.6 预算与指标", icon: BarChart2 },
    { key: "raw", label: "2.7 原始数据", icon: Code2 },
  ];

  if (!activeRunId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <PanelEmptyState
          variant="missing"
          title="URL 缺少 run_id 参数"
          description="请从「求解运行历史」列表进入详情页。"
          hint="未回落演示数据。"
        />
      </div>
    );
  }

  if (runRecord === null || replay === null) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-ink-soft)" }}>
        正在载入运行详情与审计链条...
      </div>
    );
  }

  // 存在性判据是「运行记录是否存在」，而不是「回放是否存在」：
  // 运行真实存在但没有 L2 存档时 /api/replays 返回 404，此时仍必须展示真实终态与级别。
  if (!runMeta && !replay.ok) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <PanelEmptyState
          variant="missing"
          title={runId ? "运行记录不存在或详情存档不可读（真实错误态）" : "URL 缺少 run_id 参数"}
          description={
            runId
              ? `${replay.error.message}（接口：${replay.error.url}）`
              : "请从「求解运行历史」列表进入详情页。"
          }
          hint="未回落演示数据；缺失记录的数据级别记为 UNKNOWN，不标注 L3。"
          action={
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
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
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              <span>重新加载</span>
            </button>
          }
        />
      </div>
    );
  }

  const taskList = Object.values(state.tasks);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* 顶部常驻摘要条 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderRadius: "var(--radius-card)",
          border: "1px solid var(--color-line)",
          backgroundColor: "#ffffff",
          padding: "16px 24px",
          boxShadow: "0 1px 3px rgba(15,38,92,0.04)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
              <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-brand-deep)", fontFamily: "var(--font-mono)" }}>
                {state.runId}
              </span>
              <StatusBadge status={displayStatus} size="sm" />
              <DataSourceBadge level={traceLevel} size="sm" />
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
事件总数: <strong>{state.events.length}</strong> 帧（存档 events：{replay.ok ? (replay.data.hasEventsField ? "存在" : "缺失，未伪造") : "回放存档不可用"}）· 终止原因: <code>{stopInfo.code}</code>（{stopInfo.title}）
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ textAlign: "right", fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            <div>工作单元: <strong>{taskList.length}</strong> 个 · 工具调用: <strong>{state.toolCalls.length}</strong> 次</div>
            <div style={{ color: "#16a34a", fontSize: "11px" }}>● 候选确认状态: candidate_verified = false（候选恒未经形式化确认，需人工复核）</div>
          </div>

          <Link
            to={`/runs/${activeRunId}/replay`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              borderRadius: "8px",
              backgroundColor: "var(--color-brand)",
              color: "#ffffff",
              padding: "9px 16px",
              fontSize: "13px",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            <PlayCircle size={16} />
            <span>进入回放演示模式</span>
          </Link>
        </div>
      </div>

      {!replayAvailable ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            borderRadius: "8px",
            border: "1px solid #fde68a",
            backgroundColor: "#fffbeb",
            color: "#92400e",
            padding: "12px 16px",
            fontSize: "12px",
            lineHeight: 1.7,
          }}
        >
          <AlertTriangle size={16} style={{ marginTop: "2px", flexShrink: 0 }} />
          <span>
            回放存档不可用（该运行没有 L2 存档）：{replay.ok ? "未知原因" : replay.error.message}。
            运行记录本身存在，下方展示其真实终态与级别 <strong>{traceLevel}</strong>；
            事件派生视图为空，不做任何推测，也不回落演示数据。
          </span>
        </div>
      ) : null}

      {notExecuted ? (
        <div
          style={{
            borderRadius: "var(--radius-card)",
            border: "1px solid #fecaca",
            backgroundColor: "#fef2f2",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#b91c1c" }}>
            本运行未执行（executed = false）
          </div>
          <div style={{ fontSize: "12px", color: "#7f1d1d", lineHeight: 1.8 }}>
            status: <code>{facts.status ?? "未知"}</code> · stopReason: <code>{facts.stopReason ?? "未知"}</code> ·
            terminalKind: <code>{facts.terminalKind ?? "未知"}</code> · code: <code>{facts.code ?? "未知"}</code>
            <br />
            final_response: <code>{facts.finalResponse ?? "未提供"}</code>
            （官方契约的未执行占位文本，不是候选答案）· 数据级别: <strong>{traceLevel}</strong>
          </div>
        </div>
      ) : null}

      {/* 7 标签页切换栏 */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--color-line)", gap: "4px" }}>
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              border: "none",
              borderBottom: activeTab === key ? "2px solid var(--color-brand)" : "2px solid transparent",
              backgroundColor: "transparent",
              padding: "10px 16px",
              fontSize: "13px",
              fontWeight: activeTab === key ? 600 : 500,
              color: activeTab === key ? "var(--color-brand)" : "var(--color-ink-soft)",
              cursor: "pointer",
            }}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* 标签页内容区 */}
      <div
        style={{
          borderRadius: "var(--radius-card)",
          border: "1px solid var(--color-line)",
          backgroundColor: "#ffffff",
          padding: "24px",
          minHeight: "420px",
        }}
      >
        {activeTab === "contract" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h4 style={{ margin: "0 0 10px", fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              M1 契约看板与任务认领
            </h4>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px", backgroundColor: "var(--color-surface-muted)" }}>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginBottom: "4px" }}>候选提案 (Candidate Proposal)</div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-ink)", fontFamily: "var(--font-mono)" }}>
                  {notExecuted
                    ? "（未执行：无候选产物）"
                    : state.candidateProposal ?? "（无候选产物 / final_response 缺失）"}
                </div>
              </div>
              <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px", backgroundColor: "var(--color-surface-muted)" }}>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginBottom: "4px" }}>安全红线免责声明</div>
                <div style={{ fontSize: "13px", color: "#92400e", fontWeight: 500 }}>
                  candidate_verified: false · 未经形式化数学内核确认，仅为待审候选
                </div>
                {facts.finalResponse !== null || facts.executed !== null ? (
                  <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", marginTop: "6px", lineHeight: 1.7 }}>
                    final_response: <code>{facts.finalResponse ?? "未提供"}</code> · executed:{" "}
                    <code>{facts.executed === null ? "未知" : String(facts.executed)}</code>
                    {notExecuted ? "（官方契约的未执行占位文本，不是候选答案）" : ""}
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ marginTop: "12px" }}>
              <h5 style={{ margin: "0 0 8px", fontSize: "13px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
                认领任务清单 ({taskList.length})
              </h5>
              <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", overflow: "hidden" }}>
                <div style={{ display: "flex", backgroundColor: "var(--color-surface-sunken)", padding: "10px 14px", fontSize: "12px", fontWeight: 600 }}>
                  <span style={{ width: "120px" }}>任务 ID</span>
                  <span style={{ width: "140px" }}>目标 (Goal)</span>
                  <span style={{ width: "100px" }}>状态</span>
                  <span style={{ flex: 1 }}>候选交付</span>
                </div>
                {taskList.length === 0 ? (
                  <div style={{ padding: "16px", fontSize: "12px", color: "var(--color-ink-mute)" }}>尚未生成任务</div>
                ) : (
                  taskList.map((t) => (
                    <div key={t.id} style={{ display: "flex", padding: "10px 14px", fontSize: "13px", borderTop: "1px solid var(--color-line)" }}>
                      <span style={{ width: "120px", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{t.id}</span>
                      <span style={{ width: "140px", color: "var(--color-ink-soft)" }}>{t.goalId || "-"}</span>
                      <span style={{ width: "100px", color: t.status === "COMPLETE" ? "#16a34a" : "#d97706", fontWeight: 600 }}>{t.status}</span>
                      <span style={{ flex: 1, fontFamily: "var(--font-mono)" }}>{t.proposal || "-"}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "graph" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
                M3 调度拓扑图（DAG 节点链）
              </h4>
              <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
                数据深度: {traceLevel === "UNKNOWN" ? "未知（接口未确证，不冒充 L3）" : `${traceLevel}（由运行记录 l2_path / l3_path 确证）`}
              </span>
            </div>
            <div
              style={{
                borderRadius: "8px",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface-muted)",
                padding: "24px",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ padding: "12px 18px", borderRadius: "8px", border: "1px solid var(--color-brand)", backgroundColor: "var(--color-brand-tint)", textAlign: "center" }}>
                  <div style={{ fontSize: "11px", color: "var(--color-brand-deep)", fontWeight: 600 }}>会话起点</div>
                  <div style={{ fontSize: "13px", fontWeight: 500 }}>SESSION_INIT</div>
                </div>
                <span>→</span>
                {taskList.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                    <div style={{ padding: "12px 18px", borderRadius: "8px", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", textAlign: "center" }}>
                      <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontWeight: 600 }}>任务: {t.id}</div>
                      <div style={{ fontSize: "13px", fontWeight: 500 }}>{t.status}</div>
                    </div>
                    <span>→</span>
                  </div>
                ))}
                <div style={{ padding: "12px 18px", borderRadius: "8px", border: "1px solid #bbf7d0", backgroundColor: "#f0fdf4", textAlign: "center" }}>
                  <div style={{ fontSize: "11px", color: "#15803d", fontWeight: 600 }}>终态产物（待审候选）</div>
                  <div style={{ fontSize: "13px", fontWeight: 500 }}>{state.candidateProposal ?? "无候选产物"}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "timeline" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              事件序列流水表 (Trace Timeline · {state.events.length} 帧)
            </h4>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", overflow: "hidden" }}>
              <div style={{ display: "flex", backgroundColor: "var(--color-surface-sunken)", padding: "10px 14px", fontSize: "12px", fontWeight: 600 }}>
                <span style={{ width: "60px" }}>Seq</span>
                <span style={{ width: "160px" }}>Kind / 事件类型</span>
                <span style={{ width: "120px" }}>来源标号</span>
                <span style={{ flex: 1 }}>Payload 摘要</span>
              </div>
              {state.events.map((ev) => (
                <div key={ev.seq} style={{ display: "flex", padding: "10px 14px", fontSize: "13px", borderTop: "1px solid var(--color-line)" }}>
                  <span style={{ width: "60px", fontFamily: "var(--font-mono)" }}>#{ev.seq}</span>
                  <span style={{ width: "160px", fontWeight: 600, color: "var(--color-brand)" }}>{getEventKind(ev)}</span>
                  <span style={{ width: "120px", color: "var(--color-ink-mute)", fontSize: "12px" }}>{ev.sourceKind || "session_log"}</span>
                  <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--color-ink-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {JSON.stringify(getEventPayload(ev))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "tools" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              工具与方法调用卡 ({state.toolCalls.length})
            </h4>
            {state.toolCalls.length === 0 ? (
              <PanelEmptyState
                variant="empty"
                title="本会话未记录工具或外部求解器调用"
                description="纯代数逻辑推理，无需调用外置 Python WASI 或 CAS。"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {state.toolCalls.map((tc, idx) => (
                  <div key={idx} style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px" }}>
                    <div style={{ fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "8px" }}>
                      #{idx + 1} 工具: {tc.name} · 状态: {tc.status}
                    </div>
                    {Boolean(tc.output) && (
                      <pre style={{ backgroundColor: "var(--color-surface-sunken)", padding: "12px", borderRadius: "6px", fontSize: "12px", margin: 0 }}>
                        {JSON.stringify(tc.output, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "review" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              M4 / M5 评审审计与门禁裁决
            </h4>
            <div style={{ border: "1px solid #bfdbfe", borderRadius: "8px", padding: "16px", backgroundColor: "#eff6ff" }}>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#1d4ed8", marginBottom: "4px" }}>
                CERT1 门控审计记录（模型结构化自检，非形式化数学认证）
              </div>
              <div style={{ fontSize: "12px", color: "#1e40af", lineHeight: 1.6 }}>
                <div>终止状态码: <code>{stopInfo.code}</code>（{stopInfo.title} / {stopInfo.categoryTitle}）</div>
                <div>
                  真实终态: <code>{facts.status ?? displayStatus}</code> · terminalKind: <code>{facts.terminalKind ?? "未知"}</code> · executed: <code>{facts.executed === null ? "未知" : String(facts.executed)}</code> · final_response: <code>{facts.finalResponse ?? (state.finalResponseMissing ? "缺失（未伪造）" : "未提供")}</code>
                </div>
                <div>
                  {facts.status === "candidate" || state.status === "candidate"
                    ? "终态为候选交付；candidate_verified 严格保留为 false，仍需人工复核。"
                    : `非候选终态（${stopInfo.categoryTitle}），未产出可交付候选，页面不显示为 candidate。`}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "metrics" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px", textAlign: "center" }}>
              <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>事件总流水</div>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-brand)", marginTop: "4px" }}>{state.events.length}</div>
            </div>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px", textAlign: "center" }}>
              <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>认领工作单元</div>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-brand)", marginTop: "4px" }}>{taskList.length}</div>
            </div>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px", textAlign: "center" }}>
              <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>外部工具调用</div>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-brand)", marginTop: "4px" }}>{state.toolCalls.length}</div>
            </div>
          </div>
        )}

        {activeTab === "raw" && (
          <div>
            <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginBottom: "8px" }}>
              前端未执行 JSON Schema 校验：<span style={{ color: "#b45309", fontWeight: 600 }}>UNVERIFIED（校验状态未知）</span> —— 下方为接口原始载荷，未做任何改写。
            </div>
            <pre style={{ backgroundColor: "var(--color-surface-sunken)", padding: "16px", borderRadius: "8px", fontSize: "12px", fontFamily: "var(--font-mono)", overflowX: "auto" }}>
{JSON.stringify({
  runId: state.runId,
  recordedStatus: facts.status,
  recordedStopReason: facts.stopReason,
  terminalKind: facts.terminalKind,
  finalResponse: facts.finalResponse,
  executed: facts.executed,
  code: facts.code,
  detailLevel: traceLevel,
  replayAvailable,
  reducedStatus: state.status,
  candidateProposal: state.candidateProposal,
  candidate_verified: false,
  totalEvents: state.events.length,
  conflicts: state.conflicts,
  degraded: state.degraded,
}, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
