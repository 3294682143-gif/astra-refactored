import { RotateCcw, ShieldCheck, Loader2 } from "lucide-react";
import type { RecoveryEligibility } from "../../../domain/research/types";

export interface RecoveryBannerProps {
  recovery: RecoveryEligibility;
  isResuming: boolean;
  onResume: () => void;
}

export function RecoveryBanner({
  recovery,
  isResuming,
  onResume,
}: RecoveryBannerProps) {
  if (!recovery.eligible) return null;

  const reasonText =
    typeof (recovery as { reason?: unknown }).reason === "string"
      ? (recovery as { reason?: string }).reason
      : undefined;

  return (
    <div
      className="zygos-glass zygos-animate-in"
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: "16px",
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        flexWrap: "wrap",
        border: "1px solid var(--color-brand-ring)",
        backgroundColor: "var(--color-brand-tint)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", minWidth: 0, flex: "1 1 320px" }}>
        <div
          style={{
            width: "38px",
            height: "38px",
            borderRadius: "11px",
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-brand-ring)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-brand-mid)",
            flexShrink: 0,
            boxShadow: "0 4px 12px rgba(37, 99, 235, 0.16)",
          }}
        >
          <ShieldCheck size={19} />
        </div>

        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "14px",
              fontWeight: 700,
              color: "var(--color-brand-deep)",
            }}
          >
            <span>检测到可继承的有效研究检查点（受控同题续跑）</span>
          </div>
          <div
            style={{
              marginTop: "4px",
              fontSize: "12.5px",
              lineHeight: 1.55,
              color: "var(--color-ink-soft)",
            }}
          >
            {reasonText ||
              "系统已核验历史检查点一致性，可在不修改原题研究契约、不跳过审查门槛的前提下，继续推进未完结阶段。"}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onResume}
        disabled={isResuming}
        className="zygos-btn-primary"
        style={{
          padding: "9px 18px",
          fontSize: "13px",
          borderRadius: "10px",
          flexShrink: 0,
        }}
      >
        {isResuming ? (
          <>
            <Loader2 size={14} className="spin" />
            <span>正在恢复检查点...</span>
          </>
        ) : (
          <>
            <RotateCcw size={14} />
            <span>恢复同题研究</span>
          </>
        )}
      </button>
    </div>
  );
}
