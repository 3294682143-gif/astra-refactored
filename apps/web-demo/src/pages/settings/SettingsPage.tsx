import { Server, Key } from "lucide-react";

export function SettingsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          系统状态与运行环境设置
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          查看 BFF 服务、Node 运行时状态与端点安全配置。
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* 服务健康卡片 */}
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
            <Server size={18} color="var(--color-brand)" />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-ink)" }}>
              本地服务运行状态
            </h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", fontSize: "13px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>Web Demo 版本</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)" }}>v0.1.0-preview</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>Node.js 运行时环境</span>
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)" }}>v24.17.0 (锁定兼容)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>执行引擎模式</span>
              <span style={{ fontWeight: 600, color: "var(--color-brand)" }}>TypeScript AgentLoop (默认)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", backgroundColor: "var(--color-surface-muted)", borderRadius: "6px" }}>
              <span style={{ color: "var(--color-ink-mute)" }}>并发求解队列限制</span>
              <span style={{ fontWeight: 600 }}>1 (严格顺序调度)</span>
            </div>
          </div>
        </div>

        {/* 凭据安全说明卡片 */}
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-brand-ring)", backgroundColor: "var(--color-brand-tint)", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
            <Key size={18} color="var(--color-brand-deep)" />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              凭据隔离与安全设计
            </h3>
          </div>
          <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--color-ink)", lineHeight: 1.6 }}>
            根据项目安全纪律：<strong>前端浏览器绝对不接触任何 API Key</strong>。
            Intern-S1 模型调用仅由后端宿主（Python Host）通过官方注入 client 代理，前端仅展示「端点已就绪」状态指示，禁止在界面输入或回显任何凭据。
          </p>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", backgroundColor: "#ffffff", padding: "4px 10px", borderRadius: "6px", fontSize: "12px", color: "#16a34a", fontWeight: 500, border: "1px solid #bbf7d0" }}>
            <span>● 服务端求解端点状态：已配置就绪 (Intern-S1 MaaS API)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
