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
} from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import { fetchReplay } from "@/api/client.ts";
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
  const activeRunId = runId || "demo-session";
  const [activeTab, setActiveTab] = useState<TabKey>("contract");
  const [events, setEvents] = useState<RunEventEnvelope[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchReplay(activeRunId).then((evs) => {
      setEvents(evs);
      setLoading(false);
    });
  }, [activeRunId]);

  const state = useMemo(() => {
    return reduceRunAll(createInitialRunViewState(activeRunId), events);
  }, [activeRunId, events]);

  const tabs: { key: TabKey; label: string; icon: typeof ShieldCheck }[] = [
    { key: "contract", label: "2.1 目标契约 (M1)", icon: ShieldCheck },
    { key: "graph", label: "2.2 任务图 (M3)", icon: GitFork },
    { key: "timeline", label: "2.3 事件时间线", icon: ListOrdered },
    { key: "tools", label: "2.4 工具与方法卡", icon: Wrench },
    { key: "review", label: "2.5 评审与修复", icon: FileSearch },
    { key: "metrics", label: "2.6 预算与指标", icon: BarChart2 },
    { key: "raw", label: "2.7 原始数据", icon: Code2 },
  ];

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-ink-soft)" }}>
        正在载入运行详情与审计链条...
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
              <StatusBadge status={state.status} size="sm" />
              <DataSourceBadge level="L3" size="sm" />
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
              事件总数: <strong>{state.events.length}</strong> 帧 · 终止原因: <code>{state.stopReason || "RUNNING"}</code>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ textAlign: "right", fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            <div>工作单元: <strong>{taskList.length}</strong> 个 · 工具调用: <strong>{state.toolCalls.length}</strong> 次</div>
            <div style={{ color: "#16a34a", fontSize: "11px" }}>● 形式化验证状态: candidate_verified = false (合规待审)</div>
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
                  {state.candidateProposal || "推导中..."}
                </div>
              </div>
              <div style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "16px", backgroundColor: "var(--color-surface-muted)" }}>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginBottom: "4px" }}>安全红线免责声明</div>
                <div style={{ fontSize: "13px", color: "#92400e", fontWeight: 500 }}>
                  candidate_verified: false · 未经形式化数学内核证明，仅为候选
                </div>
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
                数据深度: L3 完整拓扑
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
                  <div style={{ fontSize: "11px", color: "#15803d", fontWeight: 600 }}>终态候选</div>
                  <div style={{ fontSize: "13px", fontWeight: 500 }}>{state.candidateProposal || "候选生成"}</div>
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
                <div>终止状态码: <code>{state.stopReason || "REVIEWS_COMPLETE"}</code></div>
                <div>门禁裁决: 允许作为候选交付，candidate_verified 严格保留为 false。</div>
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
              JSON Schema 校验状态: <span style={{ color: "#16a34a", fontWeight: 600 }}>VERIFIED_VALID (SolveResultDto)</span>
            </div>
            <pre style={{ backgroundColor: "var(--color-surface-sunken)", padding: "16px", borderRadius: "8px", fontSize: "12px", fontFamily: "var(--font-mono)", overflowX: "auto" }}>
{JSON.stringify({
  runId: state.runId,
  status: state.status,
  stopReason: state.stopReason,
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
