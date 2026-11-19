import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  clearSolverConfig,
  fetchSolverConfig,
  fetchSolverModels,
  fetchSolverUsage,
  saveSolverConfig,
  type SolverConfigView,
  type SolverModelsView,
  type SolverUsageView,
} from "@/api/client.ts";

const UNKNOWN = "未知";

function tokens(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNKNOWN;
  return v.toLocaleString("zh-CN");
}

export function ModelAccessCard() {
  const [config, setConfig] = useState<SolverConfigView | null>(null);
  const [usage, setUsage] = useState<SolverUsageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);

  const [modelsResult, setModelsResult] = useState<SolverModelsView | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorNotice(null);
    const [cfgRes, usageRes] = await Promise.all([
      fetchSolverConfig(),
      fetchSolverUsage(),
    ]);

    if (!cfgRes.ok) {
      setErrorNotice(`读取模型配置失败：${cfgRes.error.message}`);
      setConfig(null);
    } else {
      setConfig(cfgRes.data);
      setEndpoint((prev) => prev || cfgRes.data.endpoint || cfgRes.data.endpoints?.[0]?.url || "");
      setModel((prev) => prev || cfgRes.data.model || cfgRes.data.endpoints?.[0]?.models?.[0] || "");
    }

    if (usageRes.ok) {
      setUsage(usageRes.data);
    } else {
      setUsage(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeEndpointOption = useMemo(() => {
    const opts = config?.endpoints ?? [];
    return opts.find((opt) => opt.url === endpoint) ?? null;
  }, [config?.endpoints, endpoint]);

  const modelChoices = useMemo(() => {
    const set = new Set<string>();
    if (modelsResult && modelsResult.endpoint === endpoint) {
      modelsResult.models.forEach((m) => set.add(m));
    }
    if (activeEndpointOption) {
      activeEndpointOption.models.forEach((m) => set.add(m));
    }
    if (model.trim()) {
      set.add(model.trim());
    }
    return Array.from(set);
  }, [modelsResult, endpoint, activeEndpointOption, model]);

  const handleSelectEndpointCard = (opt: { url: string; models: readonly string[] }) => {
    setEndpoint(opt.url);
    if (opt.models.length > 0 && !opt.models.includes(model)) {
      setModel(opt.models[0]);
    }
    setModelsResult(null);
  };

  const handleFetchModels = async () => {
    if (!endpoint.trim()) {
      setErrorNotice("请先填写或选择一个模型服务端点 URL。");
      return;
    }
    setFetchingModels(true);
    setErrorNotice(null);
    const res = await fetchSolverModels({
      endpoint: endpoint.trim(),
      credential: credential.trim() || undefined,
    });
    setFetchingModels(false);
    if (!res.ok) {
      setErrorNotice(`获取在线模型列表失败：${res.error.message}`);
      return;
    }
    setModelsResult(res.data);
    if (res.data.models.length > 0 && !res.data.models.includes(model)) {
      setModel(res.data.models[0]);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!endpoint.trim() || !model.trim() || !credential.trim()) {
      setErrorNotice("请完整填写服务端点、目标模型名称以及 API Credential（仅提交写入，提交后立即清空输入）。");
      return;
    }
    setSaving(true);
    setErrorNotice(null);
    setSuccessNotice(null);

    const res = await saveSolverConfig({
      endpoint: endpoint.trim(),
      model: model.trim(),
      credential: credential.trim(),
    });
    setSaving(false);

    if (!res.ok) {
      setErrorNotice(`保存模型接入配置失败：${res.error.message}`);
      return;
    }

    // 关键安全边界：提交成功后立即清空客户端输入态中的明文凭据
    setCredential("");
    setConfig(res.data);
    setSuccessNotice("模型接入凭据已提交至宿主机受控环境，本地输入框明文已清空。");
    const uRes = await fetchSolverUsage();
    if (uRes.ok) setUsage(uRes.data);
  };

  const handleClear = async () => {
    setSaving(true);
    setErrorNotice(null);
    setSuccessNotice(null);
    const res = await clearSolverConfig();
    setSaving(false);
    if (!res.ok) {
      setErrorNotice(`清除配置失败：${res.error.message}`);
      return;
    }
    setCredential("");
    setConfig(res.data);
    setSuccessNotice("已清除当前宿主机模型运行时配置。");
  };

  const endpointOptions = config?.endpoints ?? [];

  return (
    <section
      className="zygos-glass"
      style={{
        borderRadius: "20px",
        overflow: "hidden",
        border: "1px solid var(--color-line-strong)",
      }}
    >
      <div className="astra-brand-rule" style={{ height: "3px", width: "100%" }} />

      <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: "20px" }}>
        {/* Header Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "14px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "12px",
                backgroundColor: "var(--color-brand-tint)",
                border: "1px solid var(--color-brand-ring)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-brand-mid)",
              }}
            >
              <KeyRound size={19} />
            </div>
            <div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                研究求解模型接入与实时 Token 遥测
              </div>
              <div style={{ fontSize: "12.5px", color: "var(--color-ink-soft)" }}>
                支持官方书生 / OpenAI 兼容协议端点与动态模型探测
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "5px 12px",
                borderRadius: "999px",
                backgroundColor: config?.configured
                  ? "var(--color-state-success-bg)"
                  : "var(--color-state-candidate-bg)",
                border: `1px solid ${
                  config?.configured
                    ? "var(--color-state-success-border)"
                    : "var(--color-state-candidate-border)"
                }`,
                color: config?.configured
                  ? "var(--color-state-success)"
                  : "var(--color-state-candidate)",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              {config?.configured ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}
              <span>
                {loading
                  ? "读取配置中..."
                  : config?.configured
                  ? config.wired
                    ? "模型已接通宿主机"
                    : "已写入配置（待运行验证）"
                  : "尚未配置求解模型"}
              </span>
            </span>

            {config?.credential_fingerprint && (
              <code
                style={{
                  padding: "4px 10px",
                  borderRadius: "999px",
                  backgroundColor: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-line)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11.5px",
                  color: "var(--color-ink-soft)",
                }}
              >
                指纹: {config.credential_fingerprint}
              </code>
            )}

            <button
              type="button"
              onClick={() => void loadAll()}
              className="zygos-btn-ghost"
              style={{ padding: "6px 10px", fontSize: "12px" }}
              title="刷新配置与用量"
            >
              <RefreshCw size={13} />
              <span>刷新</span>
            </button>
          </div>
        </div>

        {/* Notices */}
        {errorNotice && (
          <div
            style={{
              padding: "11px 14px",
              borderRadius: "11px",
              backgroundColor: "var(--color-state-error-bg)",
              border: "1px solid var(--color-state-error-border)",
              color: "var(--color-state-error)",
              fontSize: "12.5px",
            }}
          >
            {errorNotice}
          </div>
        )}
        {successNotice && (
          <div
            style={{
              padding: "11px 14px",
              borderRadius: "11px",
              backgroundColor: "var(--color-state-success-bg)",
              border: "1px solid var(--color-state-success-border)",
              color: "var(--color-state-success)",
              fontSize: "12.5px",
            }}
          >
            {successNotice}
          </div>
        )}

        {/* Preset Endpoint Selector Cards (from BFF) */}
        {endpointOptions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-ink-mute)" }}>
              推荐预设端点快速切换（macOS 分组配置卡片）
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "10px",
              }}
            >
              {endpointOptions.map((opt) => {
                const selected = endpoint === opt.url;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => handleSelectEndpointCard(opt)}
                    className="zygos-node-card"
                    style={{
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: "12px",
                      border: selected
                        ? "1px solid var(--color-brand-mid)"
                        : "1px solid var(--color-line)",
                      backgroundColor: selected
                        ? "var(--color-brand-tint)"
                        : "var(--color-surface-sunken)",
                      boxShadow: selected ? "var(--shadow-glow-brand)" : "none",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                        {opt.label}
                      </span>
                      <Server size={13} color={selected ? "var(--color-brand-mid)" : "var(--color-ink-mute)"} />
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        color: "var(--color-ink-soft)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {opt.url}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Config Form */}
        <form onSubmit={(e) => void handleSave(e)} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
              <span>模型 API Base Endpoint</span>
              <input
                type="url"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://api.example.com/v1"
                required
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface-sunken)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12.5px",
                  outline: "none",
                }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>目标模型 ID</span>
                <button
                  type="button"
                  onClick={() => void handleFetchModels()}
                  disabled={fetchingModels}
                  style={{
                    border: "none",
                    background: "none",
                    color: "var(--color-brand-mid)",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: 0,
                  }}
                >
                  <Sparkles size={12} />
                  <span>{fetchingModels ? "探测中..." : "拉取在线模型"}</span>
                </button>
              </span>

              {modelChoices.length > 0 ? (
                <div style={{ display: "flex", gap: "8px" }}>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      borderRadius: "10px",
                      border: "1px solid var(--color-line-strong)",
                      backgroundColor: "var(--color-surface-sunken)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12.5px",
                      outline: "none",
                    }}
                  >
                    {modelChoices.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="internlm3-latest"
                  required
                  style={{
                    padding: "10px 12px",
                    borderRadius: "10px",
                    border: "1px solid var(--color-line-strong)",
                    backgroundColor: "var(--color-surface-sunken)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "12.5px",
                    outline: "none",
                  }}
                />
              )}
              {modelsResult && (
                <span style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontWeight: 400 }}>
                  模型列表来源：{modelsResult.source === "endpoint" ? "端点实时响应" : "本地回退清单"}
                  {modelsResult.detail ? ` (${modelsResult.detail})` : ""}
                </span>
              )}
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
              <span>API Credential（只写不回显）</span>
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={config?.configured ? "已配置凭据（如需更新请重新输入）" : "sk-..."}
                autoComplete="off"
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface-sunken)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12.5px",
                  outline: "none",
                }}
              />
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              {config?.key_management_url && (
                <a
                  href={config.key_management_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    fontSize: "12px",
                    color: "var(--color-brand-mid)",
                    textDecoration: "none",
                  }}
                >
                  <ExternalLink size={12} />
                  <span>密钥控制台</span>
                </a>
              )}
              {(usage?.balance.ledger_url || config?.balance_ledger_url) && (
                <a
                  href={usage?.balance.ledger_url ?? config?.balance_ledger_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    fontSize: "12px",
                    color: "var(--color-brand-mid)",
                    textDecoration: "none",
                  }}
                >
                  <ExternalLink size={12} />
                  <span>算力账单明细</span>
                </a>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {config?.configured && (
                <button
                  type="button"
                  onClick={() => void handleClear()}
                  disabled={saving}
                  className="zygos-btn-ghost"
                  style={{
                    padding: "8px 14px",
                    fontSize: "12.5px",
                    color: "var(--color-state-error)",
                    borderColor: "var(--color-state-error-border)",
                  }}
                >
                  <Trash2 size={13} />
                  <span>清除已存配置</span>
                </button>
              )}

              <button
                type="submit"
                disabled={saving}
                className="zygos-btn-primary"
                style={{ padding: "9px 18px", fontSize: "13px" }}
              >
                <Cpu size={14} />
                <span>{saving ? "提交写入中..." : "保存并接通求解引擎"}</span>
              </button>
            </div>
          </div>
        </form>

        {/* Token Telemetry Bento Tiles */}
        <div
          style={{
            borderTop: "1px solid var(--color-line)",
            paddingTop: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "13.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
              <Activity size={15} color="var(--color-brand-mid)" />
              <span>真实观测用量遥测（供应商未上报项显示“{UNKNOWN}”）</span>
            </span>
            {usage?.balance && !usage.balance.available && (
              <span style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>
                账户余额查询不可用：{usage.balance.reason}
              </span>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "10px",
            }}
          >
            {[
              {
                label: "调用次数 / 失败",
                val: usage ? `${usage.usage.calls} / ${usage.usage.failures}` : UNKNOWN,
              },
              {
                label: "Prompt Tokens",
                val: tokens(usage?.usage.prompt_tokens),
              },
              {
                label: "Completion Tokens",
                val: tokens(usage?.usage.completion_tokens),
              },
              {
                label: "Total Tokens",
                val: tokens(usage?.usage.total_tokens),
              },
              {
                label: "Cached Tokens",
                val: tokens(usage?.usage.cached_tokens),
              },
              {
                label: "未上报用量响应数",
                val: usage ? String(usage.usage.unknown_usage_responses) : UNKNOWN,
              },
            ].map((tile) => (
              <div
                key={tile.label}
                className="zygos-bento"
                style={{
                  padding: "12px 14px",
                  backgroundColor: "var(--color-surface-sunken)",
                }}
              >
                <div style={{ fontSize: "11.5px", color: "var(--color-ink-mute)", marginBottom: "4px" }}>
                  {tile.label}
                </div>
                <div
                  className="zygos-tabular"
                  style={{
                    fontSize: "19px",
                    fontWeight: 800,
                    color: tile.val === UNKNOWN ? "var(--color-ink-mute)" : "var(--color-brand-deep)",
                  }}
                >
                  {tile.val}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
