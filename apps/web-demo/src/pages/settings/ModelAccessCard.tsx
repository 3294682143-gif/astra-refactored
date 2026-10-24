import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  clearSolverConfig,
  fetchSolverConfig,
  fetchSolverUsage,
  saveSolverConfig,
  type ApiResult,
  type SolverConfigView,
  type SolverUsageView,
} from "@/api/client.ts";

const UNKNOWN = "未知";

const cardStyle = {
  borderRadius: "var(--radius-card)",
  border: "1px solid var(--color-line)",
  backgroundColor: "#ffffff",
  padding: "20px",
} as const;

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: "6px",
  border: "1px solid var(--color-line-strong)",
  backgroundColor: "#ffffff",
  color: "var(--color-ink)",
  padding: "8px 10px",
  fontSize: "13px",
  fontFamily: "var(--font-mono)",
} as const;

const labelStyle = {
  display: "block",
  marginBottom: "6px",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--color-ink-mute)",
} as const;

const buttonStyle = {
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
} as const;

/** Never render a token count that was not observed. */
const tokens = (value: number | null | undefined): string =>
  typeof value === "number" ? value.toLocaleString("en-US") : UNKNOWN;

export function ModelAccessCard() {
  const [config, setConfig] = useState<ApiResult<SolverConfigView> | null>(null);
  const [usage, setUsage] = useState<ApiResult<SolverUsageView> | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextConfig, nextUsage] = await Promise.all([fetchSolverConfig(), fetchSolverUsage()]);
    setConfig(nextConfig);
    setUsage(nextUsage);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const view = config && config.ok ? config.data : null;
  const options = view?.endpoints ?? [];
  const activeEndpoint = options.find((option) => option.url === (endpoint || view?.endpoint));
  const models = activeEndpoint?.models ?? [];

  useEffect(() => {
    if (!endpoint && view?.endpoint) setEndpoint(view.endpoint);
  }, [endpoint, view?.endpoint]);

  useEffect(() => {
    if (models.length > 0 && !models.includes(model)) {
      setModel(models[0] ?? "");
    }
  }, [model, models]);

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const result = await saveSolverConfig({ endpoint, model, credential });
    setBusy(false);
    if (result.ok) {
      // The submitted credential is dropped from component state immediately; it is
      // never echoed back and never read from the server.
      setCredential("");
      setNotice("已提交并接线（凭据不回显，只保留指纹）");
    } else {
      setNotice(`${result.error.message}`);
    }
    await reload();
  };

  const clear = async () => {
    setBusy(true);
    setNotice(null);
    const result = await clearSolverConfig();
    setBusy(false);
    setCredential("");
    setNotice(result.ok ? "已清除配置并断线" : result.error.message);
    await reload();
  };

  const usageData = usage && usage.ok ? usage.data : null;
  const balance = usageData?.balance ?? null;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <KeyRound size={18} color="var(--color-brand)" />
          <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-ink)" }}>
            模型接入配置
          </h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "12px",
              fontWeight: 600,
              padding: "4px 10px",
              borderRadius: "6px",
              border: `1px solid ${view?.wired ? "#bbf7d0" : "var(--color-line-strong)"}`,
              backgroundColor: view?.wired ? "#f0fdf4" : "var(--color-surface-muted)",
              color: view?.wired ? "#15803d" : "var(--color-ink-soft)",
            }}
          >
            {config === null ? "探测中..." : view?.wired ? "已配置并接线" : "未配置"}
          </span>
          <button type="button" onClick={() => void reload()} style={buttonStyle}>
            <RefreshCw size={13} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {config !== null && !config.ok ? (
        <div style={{ fontSize: "13px", color: "#b45309", lineHeight: 1.6 }}>
          读取配置失败（真实错误态）：{config.error.message}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            <div>
              <label style={labelStyle} htmlFor="solver-endpoint">
                接入端点（两个书生官方端点）
              </label>
              <select
                id="solver-endpoint"
                style={fieldStyle}
                value={endpoint || view?.endpoint || ""}
                onChange={(event) => setEndpoint(event.target.value)}
              >
                {options.length === 0 ? <option value="">{UNKNOWN}（接口未返回端点目录）</option> : null}
                {options.map((option) => (
                  <option key={option.key} value={option.url}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle} htmlFor="solver-model">
                模型（随端点联动）
              </label>
              <select
                id="solver-model"
                style={fieldStyle}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.length === 0 ? <option value="">{UNKNOWN}</option> : null}
                {models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label style={labelStyle} htmlFor="solver-credential">
              API Key（只写不读：提交后不回显，服务端只保留 sha256 指纹）
            </label>
            <input
              id="solver-credential"
              type="password"
              autoComplete="off"
              style={fieldStyle}
              placeholder="粘贴你的 API Key"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || credential.trim().length === 0 || !endpoint || !model}
              style={{ ...buttonStyle, borderColor: "var(--color-brand-ring)", color: "var(--color-brand-deep)" }}
            >
              <Save size={13} />
              <span>{busy ? "提交中..." : "保存并接线"}</span>
            </button>
            <button type="button" onClick={() => void clear()} disabled={busy} style={buttonStyle}>
              <Trash2 size={13} />
              <span>清除配置</span>
            </button>
            {notice ? (
              <span style={{ fontSize: "12px", color: "var(--color-ink-soft)" }}>{notice}</span>
            ) : null}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", fontSize: "13px" }}>
            <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>当前端点</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>{view?.endpoint ?? UNKNOWN}</span>
            </div>
            <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>当前模型</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>{view?.model ?? UNKNOWN}</span>
            </div>
            <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>凭据指纹</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>{view?.credential_fingerprint ?? UNKNOWN}</span>
            </div>
            <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>求解器已接线</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>{view === null ? UNKNOWN : String(view.wired)}</span>
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--color-line)", paddingTop: "14px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "10px" }}>
              调用量与余额
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", fontSize: "13px" }}>
              <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
                <span style={{ color: "var(--color-ink-mute)" }}>调用次数 / 失败</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>
                  {usageData ? `${usageData.usage.calls} / ${usageData.usage.failures}` : UNKNOWN}
                </span>
              </div>
              <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
                <span style={{ color: "var(--color-ink-mute)" }}>总 token（观测值）</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>{tokens(usageData?.usage.total_tokens)}</span>
              </div>
              <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
                <span style={{ color: "var(--color-ink-mute)" }}>输入 / 输出 token</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>
                  {`${tokens(usageData?.usage.prompt_tokens)} / ${tokens(usageData?.usage.completion_tokens)}`}
                </span>
              </div>
              <div style={{ padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px", display: "flex", justifyContent: "space-between", gap: "12px" }}>
                <span style={{ color: "var(--color-ink-mute)" }}>未报告 usage 的响应</span>
                <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right" }}>{tokens(usageData?.usage.unknown_usage_responses)}</span>
              </div>
            </div>

            <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
              余额：{balance === null ? UNKNOWN : balance.available ? "见平台账本" : `本台读不到（${balance.reason}）`}
              {balance ? (
                <>
                  {" "}
                  <a href={balance.ledger_url} target="_blank" rel="noreferrer" style={{ color: "var(--color-brand-deep)" }}>
                    打开积分账本 <ExternalLink size={11} style={{ verticalAlign: "-1px" }} />
                  </a>
                </>
              ) : null}
              {view?.key_management_url ? (
                <>
                  {" · "}
                  <a href={view.key_management_url} target="_blank" rel="noreferrer" style={{ color: "var(--color-brand-deep)" }}>
                    密钥管理 <ExternalLink size={11} style={{ verticalAlign: "-1px" }} />
                  </a>
                </>
              ) : null}
            </div>
            <div style={{ marginTop: "8px", fontSize: "11px", color: "var(--color-ink-mute)", lineHeight: 1.7 }}>
              调用量来自模型响应的真实 <code>usage</code> 字段；供应商未报告时显示「{UNKNOWN}」，不按 0 计。
              余额页为登录态页面、未发现官方余额接口，故本台不做任何余额数字推断。
            </div>
          </div>

          <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
            职责边界：凭据由后端宿主持有（写入宿主端配置文件，随 BFF 进程生效），本页只提交、不读回、不显示明文；
            端点与模型限定为上面两个书生官方端点。模型回答恒为「候选 · 未经形式化验证」。
          </div>
        </div>
      )}
    </div>
  );
}
