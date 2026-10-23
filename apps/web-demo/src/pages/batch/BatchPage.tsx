import { Upload } from "lucide-react";

export function BatchPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            批量评测与盲跑看板
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
            支持百题级评测日志 JSONL 导入与多批次极差对比，所有数据必须标明评测协议与判分器版本。
          </p>
        </div>

        <button
          type="button"
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
          <Upload size={14} />
          <span>导入评测批次 (JSONL)</span>
        </button>
      </div>

      {/* 统计指标卡片 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>导入评测题目数</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-brand-deep)", marginTop: "4px" }}>112 题</div>
          <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", marginTop: "4px" }}>涵盖 18 个经典数学子领域</div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>候选答案形成率</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "#16a34a", marginTop: "4px" }}>89.3%</div>
          <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", marginTop: "4px" }}>100 / 112 题收敛出候选</div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>3 次盲跑稳定性极差</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-brand)", marginTop: "4px" }}>≤ 2 题</div>
          <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", marginTop: "4px" }}>满足验收门槛 (≤ 3 题)</div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>子进程零悬挂率</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "#16a34a", marginTop: "4px" }}>100%</div>
          <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", marginTop: "4px" }}>无残留 Node 孤儿进程</div>
        </div>
      </div>

      {/* 逐题列表预演 */}
      <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", overflow: "hidden" }}>
        <div style={{ display: "flex", backgroundColor: "var(--color-surface-sunken)", padding: "12px 18px", fontSize: "13px", fontWeight: 600 }}>
          <span style={{ width: "80px" }}>题号</span>
          <span style={{ width: "140px" }}>子领域</span>
          <span style={{ flex: 1 }}>题目简述</span>
          <span style={{ width: "120px" }}>状态</span>
          <span style={{ width: "140px" }}>终止原因</span>
          <span style={{ width: "90px" }}>模型调用</span>
        </div>
        {[
          { id: "#001", domain: "代数多项式", text: "整系数多项式平方判定定理", status: "候选生成", reason: "REVIEWS_COMPLETE", calls: 6 },
          { id: "#002", domain: "解析数论", text: "二次剩余模分布与整点计数", status: "候选生成", reason: "REVIEWS_COMPLETE", calls: 8 },
          { id: "#003", domain: "组合极值", text: "完全图双色三角形数目极值", status: "候选生成", reason: "REVISE_REJECTED", calls: 14 },
          { id: "#004", domain: "偏微分方程", text: "弱解唯一性能量估计分析", status: "未解", reason: "BUDGET_EXHAUSTED", calls: 24 },
        ].map((item) => (
          <div key={item.id} style={{ display: "flex", padding: "12px 18px", fontSize: "13px", borderTop: "1px solid var(--color-line)", alignItems: "center" }}>
            <span style={{ width: "80px", fontFamily: "var(--font-mono)" }}>{item.id}</span>
            <span style={{ width: "140px", color: "var(--color-ink-soft)" }}>{item.domain}</span>
            <span style={{ flex: 1, fontWeight: 500 }}>{item.text}</span>
            <span style={{ width: "120px", color: item.status === "未解" ? "#b45309" : "#16a34a" }}>{item.status}</span>
            <span style={{ width: "140px", fontFamily: "var(--font-mono)", fontSize: "12px" }}>{item.reason}</span>
            <span style={{ width: "90px", fontFamily: "var(--font-mono)" }}>{item.calls} 次</span>
          </div>
        ))}
      </div>
    </div>
  );
}
