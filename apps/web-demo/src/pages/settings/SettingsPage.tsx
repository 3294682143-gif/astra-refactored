import { useEffect, useState } from "react";
import { Key, RefreshCw, Server } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import {
  fetchCapabilities,
  fetchHealth,
  type ApiResult,
  type CapabilitiesResponse,
  type HealthResponse,
} from "@/api/client.ts";

const UNKNOWN = "未知";

interface Row {
  readonly label: string;
  readonly value: string;
}

export function SettingsPage() {
  const [health, setHealth] = useState<ApiResult<HealthResponse> | null>(null);
  const [caps, setCaps] = useState<ApiResult<CapabilitiesResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setHealth(null);
    setCaps(null);
    fetchHealth().then((res) => {
      if (alive) setHealth(res);
    });
    fetchCapabilities().then((res) => {
      if (alive) setCaps(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const healthData = health && health.ok ? health.data : null;
  const capsData = caps && caps.ok ? caps.data : null;

  const rows: Row[] = [
    {
      label: "BFF /api/health 可达性",
      value: health === null ? "探测中..." : health.ok ? `可达（status=${healthData?.status ?? UNKNOWN}）` : `不可达（${health.error.message}）`,
    },
    {
      label: "BFF 服务标识 / 版本",
      value: healthData ? `${healthData.service} / ${healthData.version}` : UNKNOWN,
    },
    {
      label: "健康检查是否调用模型",
      value: healthData ? String(healthData.model_invoked) : UNKNOWN,
    },
    {
      label: "数据根目录 (data_root)",
      value: healthData?.data_root ?? UNKNOWN,
    },
    {
      label: "Schema 版本",
      value: capsData?.schema_version !== undefined ? String(capsData.schema_version) : UNKNOWN,
    },
    {
      label: "执行队列 / SSE 流式",
      value:
        capsData && (capsData.execution_queue !== undefined || capsData.sse_streaming !== undefined)
          ? `execution_queue=${String(capsData.execution_queue ?? UNKNOWN)}, sse_streaming=${String(capsData.sse_streaming ?? UNKNOWN)}`
          : UNKNOWN,
    },
    {
      label: "并发求解队列上限",
      value:
        typeof capsData?.execution?.max_concurrent_runs === "number"
          ? String(capsData.execution.max_concurrent_runs)
          : typeof capsData?.max_concurrent_runs === "number"
            ? String(capsData.max_concurrent_runs)
            : `${UNKNOWN}（接口未返回该字段）`,
    },
    {
      label: "当前运行中 / 排队",
      value:
        capsData?.execution &&
        (typeof capsData.execution.running === "number" || typeof capsData.execution.queued === "number")
          ? `running=${String(capsData.execution.running ?? UNKNOWN)}, queued=${String(capsData.execution.queued ?? UNKNOWN)}`
          : `${UNKNOWN}（接口未返回该字段）`,
    },
    {
      label: "支持主动取消运行",
      value:
        typeof capsData?.cancellation_supported === "boolean"
          ? String(capsData.cancellation_supported)
          : typeof capsData?.supports_cancellation === "boolean"
            ? String(capsData.supports_cancellation)
            : `${UNKNOWN}（接口未返回该字段）`,
    },
    {
      label: "推理提供方（服务端环境决定，浏览器只读）",
      value: capsData?.provider_info?.provider ?? `${UNKNOWN}（接口未返回 provider_info）`,
    },
    {
      label: "当前模型 / 端点主机（脱敏）",
      value: capsData?.provider_info
        ? `${capsData.provider_info.model ?? UNKNOWN} @ ${capsData.provider_info.endpoint_host ?? UNKNOWN}`
        : UNKNOWN,
    },
    {
      label: "reasoning_mode / wire_max_tokens",
      value: capsData?.provider_info
        ? `${capsData.provider_info.reasoning_mode ?? UNKNOWN} / ${String(capsData.provider_info.wire_max_tokens ?? UNKNOWN)}`
        : UNKNOWN,
    },
    {
      label: "协议数据源（live / mock 合成）",
      value: capsData?.provider_info?.protocol_source ?? UNKNOWN,
    },
    {
      label: "Node.js 运行时版本",
      value: `${UNKNOWN}（浏览器端无法读取宿主 Node 版本）`,
    },
    {
      label: "Web Demo 前端版本",
      value: `${UNKNOWN}（前端未注入构建版本号）`,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          系统状态与运行环境设置
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          本页状态全部来自 <code>/api/health</code> 与 <code>/api/capabilities</code> 实时响应；接口未返回的字段显示「未知」。
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Server size={18} color="var(--color-brand)" />
              <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-ink)" }}>
                本地服务运行状态
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "6px",
                border: "1px solid var(--color-line-strong)",
                backgroundColor: "#ffffff",
                color: "var(--color-ink-soft)",
                padding: "6px 12px",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <RefreshCw size={13} />
              <span>重新探测</span>
            </button>
          </div>

          {health !== null && !health.ok && caps !== null && !caps.ok ? (
            <PanelEmptyState
              variant="missing"
              title="BFF 探测失败（真实错误态）"
              description={`/api/health：${health.error.message}；/api/capabilities：${caps.error.message}`}
              hint="未以演示数据顶替，也不显示为「已就绪」。"
            />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", fontSize: "13px" }}>
              {rows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "12px",
                    padding: "8px 12px",
                    backgroundColor: "var(--color-surface-muted)",
                    borderRadius: "6px",
                  }}
                >
                  <span style={{ color: "var(--color-ink-mute)" }}>{row.label}</span>
                  <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-brand-ring)", backgroundColor: "var(--color-brand-tint)", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
            <Key size={18} color="var(--color-brand-deep)" />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              凭据隔离与安全设计
            </h3>
          </div>
          <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--color-ink)", lineHeight: 1.6 }}>
            根据项目安全纪律：<strong>前端浏览器绝对不接触任何 API Key</strong>。
            模型调用仅由后端宿主（Python Host）通过官方注入的 public client 代理，
            前端不输入、不回显、也无法查询任何凭据。
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: "#ffffff",
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                color: health?.ok ? "#15803d" : health === null ? "var(--color-ink-soft)" : "#b45309",
                fontWeight: 500,
                border: `1px solid ${health?.ok ? "#bbf7d0" : "#fde68a"}`,
              }}
            >
              <span>
                ● BFF 健康检查：
                {health === null ? "探测中..." : health.ok ? `status=${healthData?.status ?? UNKNOWN}` : `不可达（${health.error.message}）`}
              </span>
            </div>
            <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
              模型凭据是否已配置：{UNKNOWN} —— 前端不可见（后端宿主持有），本台不做任何「已配置 / 已就绪」断言。
              健康检查响应中的 <code>model_invoked</code> 仅表示本次检查未触发模型调用。
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
          <DataSourceBadge level={health === null ? "UNKNOWN" : health.ok ? "L1" : "UNKNOWN"} size="sm" />
          <span>健康与能力信息属于轻量只读摘要（L1）；探测失败时级别记为未知。</span>
        </div>
      </div>
    </div>
  );
}