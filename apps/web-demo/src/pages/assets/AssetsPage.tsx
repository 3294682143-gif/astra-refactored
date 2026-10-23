import { Boxes, BookOpen, Layers, CheckCircle2 } from "lucide-react";

export function AssetsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          能力资产与方法基准浏览器
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          浏览系统内置的 20 张 general_v11 方法卡、22 个数学族及 73 项已注册计算工具。
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", marginBottom: "8px" }}>
            <BookOpen size={18} />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>方法卡资产 (Methods)</h3>
          </div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginBottom: "4px" }}>20 张</div>
          <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            包含 general_v11 决策表、必产出对象声明与结构标签，均受 SHA-256 哈希防篡改锁定。
          </div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", marginBottom: "8px" }}>
            <Layers size={18} />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>数学族目录 (Families)</h3>
          </div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginBottom: "4px" }}>22 个</div>
          <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            覆盖代数数论 (A)、组合离散 (B)、分析几何 (C)、概率统计拓扑 (D) 四大核心板块。
          </div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", marginBottom: "8px" }}>
            <Boxes size={18} />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>计算工具注册表 (Tools)</h3>
          </div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginBottom: "4px" }}>73 项</div>
          <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            提供形式参数 Schema 与安全准入白名单，所有执行结果在前端严格作为「观察」呈现。
          </div>
        </div>
      </div>

      {/* 构建清单状态卡 */}
      <div style={{ borderRadius: "var(--radius-card)", border: "1px solid #bbf7d0", backgroundColor: "#f0fdf4", padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <CheckCircle2 size={20} color="#15803d" />
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "#166534" }}>
              BUILD_MANIFEST.json 发布清单校验通过 (VERIFY_OK)
            </div>
            <div style={{ fontSize: "11px", color: "#15803d" }}>
              证明本地运行时代码与 bundle 文件哈希完整一致（不构成对真实数学能力的保证）。
            </div>
          </div>
        </div>
        <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "#166534" }}>
          release/BUILD_MANIFEST.json
        </span>
      </div>
    </div>
  );
}
