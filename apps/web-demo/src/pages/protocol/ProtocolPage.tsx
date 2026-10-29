import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchProtocolSessionEvents,
  fetchProtocolSessions,
  type ApiResult,
  type ProtocolLogRecord,
  type ProtocolSessionItem,
  type ProtocolSessionsResponse,
} from "@/api/client.ts";

/**
 * InkStone 协议观测台：渲染 atria-bridge-runner 落盘的网关事件日志。
 * 每帧事件的 validationStatus 来自服务端 parseGatewayEvent 精确键校验，
 * 缺失数据时显示空态，绝不合成事件流。
 */

const EVENT_ORDER = [
  "message_start",
  "thinking_delta",
  "tool_use_start",
  "tool_input_delta",
  "tool_use_end",
  "content_delta",
  "usage",
  "message_end",
  "error",
] as const;

function eventColor(type: string | undefined): string {
  switch (type) {
    case "message_start":
    case "message_end":
      return "var(--color-brand)";
    case "thinking_delta":
      return "var(--color-ink-mute)";
    case "content_delta":
      return "var(--color-ink)";
    case "usage":
      return "var(--color-brand-deep)";
    case "error":
      return "var(--color-danger, #b00)";
    default:
      return "var(--color-ink-soft)";
  }
}

function ValidationBadge({ status, error }: { status?: string; error?: string | null }) {
  if (status === "pass") {
    return (
      <span title="parseGatewayEvent 校验通过" style={{ color: "var(--color-brand)", display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px" }}>
        <CheckCircle2 size={12} /> pass
      </span>
    );
  }
  return (
    <span title={error ?? "校验失败"} style={{ color: "var(--color-danger, #b00)", display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px" }}>
      <XCircle size={12} /> {status ?? "unknown"}
    </span>
  );
}

function UsagePanel({ usage }: { usage: Record<string, unknown> | null | undefined }) {
  if (!usage) return null;
  const keys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: "12px", color: "var(--color-ink-soft)" }}>
      {keys.map((k) => (
        <span key={k}>
          {k}=<strong>{typeof usage[k] === "number" ? String(usage[k]) : "null"}</strong>
        </span>
      ))}
    </div>
  );
}

function GatewayEventRow({ record }: { record: ProtocolLogRecord }) {
  if (record.kind === "CANCEL_DECISION") {
    return (
      <div style={{ borderRadius: "8px", border: "1px solid var(--color-line-strong)", backgroundColor: "var(--color-surface-muted)", padding: "8px 12px", fontSize: "12px" }}>
        <strong>CANCEL_DECISION</strong>：{JSON.stringify(record.decision)}
      </div>
    );
  }
  if (record.kind === "RECOVERY_409_CHECK") {
    return (
      <div style={{ borderRadius: "8px", border: "1px solid var(--color-line-strong)", backgroundColor: "var(--color-surface-muted)", padding: "8px 12px", fontSize: "12px" }}>
        <strong>RECOVERY_409_CHECK</strong>：attempt={String(record.attempt)} conflictCode={String(record.conflictCode)} recoverable={String(record.recoverable)} shouldRetry={String(record.shouldRetry)}
      </div>
    );
  }
  const ev = record.event;
  const type = ev?.type;
  const preview =
    typeof ev?.text === "string"
      ? ev.text.length > 80
        ? `${ev.text.slice(0, 80)}…`
        : ev.text
      : type === "usage"
        ? "USAGE_KEYS 四字段"
        : type === "message_end"
          ? `stop_reason=${ev?.stop_reason ?? "?"}`
          : "";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "10px", borderBottom: "1px dashed var(--color-line)", padding: "6px 2px", fontSize: "13px" }}>
      <span style={{ minWidth: "130px", fontFamily: "monospace", fontSize: "12px", color: eventColor(type) }}>{type ?? "unknown"}</span>
      <span style={{ flex: 1, color: "var(--color-ink-soft)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{preview}</span>
      <ValidationBadge status={record.validationStatus} error={record.validationError} />
    </div>
  );
}

export function ProtocolPage() {
  const [sessions, setSessions] = useState<ApiResult<ProtocolSessionsResponse> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<ApiResult<{ session_id: string; events: ProtocolLogRecord[] }> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchProtocolSessions().then((res) => {
      if (alive) setSessions(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setEvents(null);
    fetchProtocolSessionEvents(selected).then((res) => {
      if (alive) setEvents(res);
    });
    return () => {
      alive = false;
    };
  }, [selected]);

  const items: readonly ProtocolSessionItem[] = sessions && sessions.ok ? sessions.data.sessions : [];
  const records: readonly ProtocolLogRecord[] = events && events.ok ? events.data.events : [];
  const lastUsage = [...records].reverse().find((r) => r.event?.type === "usage")?.event?.usage ?? null;

  return (
    <div style={{ display: "flex", gap: "16px", height: "calc(100vh - 140px)" }}>
      <aside
        style={{
          width: "280px",
          flexShrink: 0,
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "14px",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}>桥接会话</h2>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-ink-mute)" }}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {sessions === null && <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>加载中…</div>}
        {sessions && !sessions.ok && (
          <div style={{ fontSize: "12px", color: "var(--color-danger, #b00)" }}>{sessions.error.message}</div>
        )}
        {sessions && sessions.ok && items.length === 0 && (
          <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", lineHeight: 1.7 }}>
            暂无桥接会话日志。经 InkstoneDesktopBridgeClient 发起推理后，事件流会落盘到
            ASTRA_DATA_ROOT/protocol/*.jsonl。
          </div>
        )}
        {items.map((s) => (
          <button
            key={s.session_id}
            type="button"
            onClick={() => setSelected(s.session_id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              borderRadius: "8px",
              border: selected === s.session_id ? "1px solid var(--color-brand)" : "1px solid var(--color-line)",
              backgroundColor: selected === s.session_id ? "var(--color-brand-tint)" : "transparent",
              padding: "8px 10px",
              marginBottom: "6px",
              cursor: "pointer",
              fontSize: "12px",
              color: "var(--color-ink)",
            }}
          >
            <div style={{ fontFamily: "monospace" }}>{s.session_id}</div>
            <div style={{ color: "var(--color-ink-mute)", marginTop: "2px" }}>
              {new Date(s.updated_at * 1000).toLocaleString()} · {s.size_bytes} B
            </div>
          </button>
        ))}
      </aside>

      <section
        style={{
          flex: 1,
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "18px 20px",
          overflowY: "auto",
        }}
      >
        <h2 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          网关事件泳道
        </h2>
        <div style={{ fontSize: "12px", color: "var(--color-ink-mute)", marginBottom: "12px" }}>
          事件序列：{EVENT_ORDER.join(" → ")} · 校验器：parseGatewayEvent（精确键集合）
        </div>
        {!selected && (
          <PanelEmptyState
            title="选择一个桥接会话"
            description="左侧列表来自服务端 ASTRA_DATA_ROOT/protocol/ 的真实落盘日志；空列表即无实时数据，不以合成流顶替。"
          />
        )}
        {selected && events === null && <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>加载事件…</div>}
        {selected && events && !events.ok && (
          <div style={{ fontSize: "12px", color: "var(--color-danger, #b00)" }}>{events.error.message}</div>
        )}
        {selected && events && events.ok && records.length === 0 && (
          <PanelEmptyState title="该会话暂无事件" variant="missing" />
        )}
        {records.length > 0 && (
          <>
            <div style={{ borderRadius: "8px", border: "1px solid var(--color-line)", padding: "10px 12px", marginBottom: "10px", backgroundColor: "var(--color-surface-muted)" }}>
              <UsagePanel usage={lastUsage} />
            </div>
            {records.map((r, i) => (
              <GatewayEventRow key={`${r.timestamp ?? "t"}-${i}`} record={r} />
            ))}
          </>
        )}
      </section>
    </div>
  );
}
