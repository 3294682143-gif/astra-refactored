import { RotateCcw, ShieldAlert } from "lucide-react";
import type { RecoveryEligibility } from "../../../domain/research/types";

interface RecoveryBannerProps {
  recovery: RecoveryEligibility;
  isResuming: boolean;
  onResume: () => void;
}

export function RecoveryBanner({ recovery, isResuming, onResume }: RecoveryBannerProps) {
  if (!recovery.eligible) return null;

  return (
    <div
      style={{
        backgroundColor: "#fefce8",
        border: "1px solid #fef08a",
        borderRadius: "10px",
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
        <ShieldAlert size={20} color="#ca8a04" style={{ flexShrink: 0, marginTop: "2px" }} />
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#854d0e" }}>
            同题受约束恢复可用（检查点 #{recovery.checkpointSeq ?? "N/A"}）
          </div>
          <div style={{ fontSize: "12px", color: "#a16207", marginTop: "2px", lineHeight: 1.5 }}>
            本研究可在原题上下文受控续推。剩余继承预算：
            <strong>{recovery.remainingBudget?.maxModelCalls ?? "若干"}</strong> 次模型调用。
            恢复将建立关联执行片段，不覆写历史终态，原时限与预算严格继承。
          </div>
        </div>
      </div>

      <button
        type="button"
        disabled={isResuming}
        onClick={onResume}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 18px",
          borderRadius: "6px",
          backgroundColor: "#ca8a04",
          color: "#ffffff",
          fontSize: "13px",
          fontWeight: 600,
          border: "none",
          cursor: isResuming ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
          boxShadow: "0 2px 4px rgba(202, 138, 4, 0.2)",
        }}
      >
        <RotateCcw size={14} />
        {isResuming ? "正在启动恢复片段..." : "恢复此题研究"}
      </button>
    </div>
  );
}
