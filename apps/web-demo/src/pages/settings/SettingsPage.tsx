import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Sliders,
} from "lucide-react";
import {
  fetchCapabilities,
  fetchHealth,
  type CapabilitiesResponse,
  type HealthResponse,
} from "@/api/client.ts";
import { DataSourceBadge } from "@/components/DataSourceBadge.tsx";
import { PanelEmptyState } from "@/components/PanelEmptyState.tsx";
import { ModelAccessCard } from "./ModelAccessCard.tsx";

const UNKNOWN = "未知";

function formatBool(v: boolean | null | undefined): string {
  if (typeof v !== "boolean") return UNKNOWN;
  return v ? "是 (true)" : "否 (false)";
}

export function SettingsPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [probeError, setProbeError] = useState<string | null>(null);

  const loadProbes = useCallback(async () => {
    setLoading(true);
    setProbeError(null);
    const [hRes, cRes] = await Promise.all([fetchHealth(), fetchCapabilities()]);
    setHealth(hRes.ok ? hRes.data : null);
    setCapabilities(cRes.ok ? cRes.data : null);

    const errs: string[] = [];
    if (!hRes.ok) errs.push(`/api/health: ${hRes.error.message}`);
    if (!cRes.ok) errs.push(`/api/capabilities: ${cRes.error.message}`);
    if (errs.length > 0) {
      setProbeError(
        hRes.ok || cRes.ok
          ? `部分探针响应异常（${errs.join("；")}）`
          : `后端探针全部失败（${errs.join("；")}）`,
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadProbes();
  }, [loadProbes]);

  const probeRows = [
    {
      key: "服务名称与版本",
      value:
        health?.service || capabilities?.service
          ? `${health?.service ?? capabilities?.service} (${health?.version ?? capabilities?.version ?? UNKNOWN})`
          : UNKNOWN,
    },
    {
      key: "BFF 健康状态 (/api/health)",
      value: health?.status ?? UNKNOWN,
    },
    {
      key: "协议 / Schema 版本",
      value: String(capabilities?.protocol_version ?? capabilities?.schema_version ?? UNKNOWN),
    },
    {
      key: "探针阶段是否触发模型调用",
      value: formatBool(health?.model_invoked ?? capabilities?.model_invoked),
    },
    {
      key: "只读保护模式 (read_only)",
      value: formatBool(capabilities?.read_only),
    },
    {
      key: "执行队列支持 (execution_queue)",
      value: formatBool(capabilities?.execution_queue),
    },
    {
      key: "SSE 实时流 (sse_streaming)",
      value: formatBool(capabilities?.sse_streaming),
    },
    {
      key: "最大并发任务数",
      value: String(
        capabilities?.execution?.max_concurrent_runs ??
          capabilities?.max_concurrent_runs ??
          UNKNOWN,
      ),
    },
    {
      key: "受控任务取消能力",
      value: formatBool(
        capabilities?.supports_cancellation ?? capabilities?.cancellation_supported,
      ),
    },
    {
      key: "数学资产目录版本",
      value: capabilities?.catalog_version ?? UNKNOWN,
    },
    {
      key: "运行档案数据根目录 (data_root)",
      value: health?.data_root ?? UNKNOWN,
    },
  ];

  return (
    <div className="zygos-page-container" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Keynote Page Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-brand-mid)",
              marginBottom: "6px",
            }}
          >
            <Sliders size={13} />
            <span>SYSTEM SETTINGS · 运行环境与模型凭据配置</span>
          </div>
          <h1
            className="zygos-keynote-title"
            style={{
              margin: 0,
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.025em",
            }}
          >
            系统设置与模型接入
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "13.5px", color: "var(--color-ink-soft)" }}>
            管理宿主机推演引擎端点、密钥只写隔离策略，并实时核验 BFF 后端健康度与能力声明。
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadProbes()}
          disabled={loading}
          className="zygos-btn-ghost"
          style={{ padding: "8px 14px", fontSize: "13px" }}
        >
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
          <span>重新探测后端能力</span>
        </button>
      </div>

      {/* Model Access Card */}
      <ModelAccessCard />

      {/* BFF Health & Capabilities Table */}
      <section
        className="zygos-glass"
        style={{
          borderRadius: "18px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-line)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "10px",
                backgroundColor: "var(--color-brand-tint)",
                border: "1px solid var(--color-brand-ring)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-brand-mid)",
              }}
            >
              <Server size={16} />
            </span>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                BFF 后端探针与能力矩阵
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
                实时查询 /api/health 与 /api/capabilities；未返回字段严格显示“{UNKNOWN}”
              </div>
            </div>
          </div>

          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 11px",
              borderRadius: "999px",
              backgroundColor:
                health?.status === "ok"
                  ? "var(--color-state-success-bg)"
                  : "var(--color-state-stale-bg)",
              border: `1px solid ${
                health?.status === "ok"
                  ? "var(--color-state-success-border)"
                  : "var(--color-line)"
              }`,
              color:
                health?.status === "ok"
                  ? "var(--color-state-success)"
                  : "var(--color-ink-soft)",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            <Activity size={13} />
            <span>{loading ? "探测中..." : health ? `状态: ${health.status}` : "状态未确认"}</span>
          </span>
        </div>

        {probeError && (
          <div style={{ padding: "16px 20px" }}>
            <PanelEmptyState
              variant="missing"
              title="后端探针存在异常"
              description={probeError}
              hint="请确认 python/astra_web BFF 服务已启动，且 Vite 代理或静态托管路径通畅。"
            />
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <tbody>
              {probeRows.map((row) => (
                <tr key={row.key} style={{ borderBottom: "1px solid var(--color-line)" }}>
                  <td
                    style={{
                      padding: "12px 20px",
                      width: "340px",
                      color: "var(--color-ink-soft)",
                      fontWeight: 600,
                    }}
                  >
                    {row.key}
                  </td>
                  <td
                    style={{
                      padding: "12px 20px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12.5px",
                      color:
                        row.value === UNKNOWN
                          ? "var(--color-ink-mute)"
                          : "var(--color-brand-deep)",
                    }}
                  >
                    {row.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Credential Isolation & Data Observability Notice */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "16px",
        }}
      >
        <section
          className="zygos-glass"
          style={{
            borderRadius: "16px",
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            <Lock size={16} color="var(--color-brand-mid)" />
            <span>凭据隔离与安全红线说明</span>
          </div>
          <p style={{ margin: 0, fontSize: "12.5px", lineHeight: 1.65, color: "var(--color-ink-soft)" }}>
            模型 API 凭据在提交后即刻由前端清空输入框状态，仅通过受控 <code style={{ fontFamily: "var(--font-mono)" }}>PUT /api/config/solver</code> 写入宿主机内存配置；
            任何读取接口（包括历史档案、回放流、工作台事件与前端持久化存储）均绝不回显或落盘明文密钥，仅展示后端派生的脱敏指纹（fingerprint）。
          </p>
        </section>

        <section
          className="zygos-glass"
          style={{
            borderRadius: "16px",
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            <ShieldCheck size={16} color="var(--color-brand-mid)" />
            <span>运行档案可观测级别分级</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <DataSourceBadge level="L1" withCaption />
            <DataSourceBadge level="L2" withCaption />
            <DataSourceBadge level="L3" withCaption />
            <DataSourceBadge level="UNKNOWN" withCaption />
          </div>
        </section>
      </div>
    </div>
  );
}
