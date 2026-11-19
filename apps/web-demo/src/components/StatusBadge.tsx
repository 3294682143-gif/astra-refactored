import type { LucideIcon } from "lucide-react";
import {
  AlertOctagon,
  Ban,
  CircleHelp,
  FlaskConical,
  History,
  PlayCircle,
  CheckCircle2,
  Clock,
  ShieldQuestion,
  Timer,
  Wrench,
} from "lucide-react";

/**
 * 状态语义（红线）：
 *   - candidate 恒标「候选 · 未经形式化验证」；
 *   - timeout / failed / cancelled / error 与 candidate 在文案与配色上必须可区分；
 *   - unknown 用于无法从接口确证的状态，绝不回落为 candidate。
 */
export type StatusKind =
  | "candidate"
  | "unsolved"
  | "error"
  | "stale"
  | "running"
  | "idle"
  | "finished"
  | "aborted"
  | "solved"
  | "timeout"
  | "failed"
  | "cancelled"
  | "unknown";

interface StatusConfig {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly bg: string;
  readonly text: string;
  readonly border: string;
  readonly dot: string;
}

const REGISTRY: Record<StatusKind, StatusConfig> = {
  candidate: {
    label: "候选 · 未经形式化验证",
    icon: FlaskConical,
    bg: "var(--color-state-candidate-bg)",
    text: "var(--color-state-candidate)",
    border: "var(--color-state-candidate-border)",
    dot: "#f59e0b",
  },
  unsolved: {
    label: "未解",
    icon: CircleHelp,
    bg: "var(--color-state-unsolved-bg)",
    text: "var(--color-state-unsolved)",
    border: "var(--color-line-strong)",
    dot: "#64748b",
  },
  error: {
    label: "运行错误",
    icon: AlertOctagon,
    bg: "var(--color-state-error-bg)",
    text: "var(--color-state-error)",
    border: "var(--color-state-error-border)",
    dot: "#ef4444",
  },
  timeout: {
    label: "超时终止",
    icon: Timer,
    bg: "rgba(234, 88, 12, 0.14)",
    text: "#fb923c",
    border: "rgba(251, 146, 60, 0.35)",
    dot: "#f97316",
  },
  failed: {
    label: "运行时失败",
    icon: Wrench,
    bg: "var(--color-state-error-bg)",
    text: "var(--color-state-error)",
    border: "var(--color-state-error-border)",
    dot: "#ef4444",
  },
  cancelled: {
    label: "已取消",
    icon: Ban,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-ink-soft)",
    border: "var(--color-line-strong)",
    dot: "#94a3b8",
  },
  unknown: {
    label: "状态未知",
    icon: ShieldQuestion,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-state-stale)",
    border: "var(--color-line)",
    dot: "#94a3b8",
  },
  stale: {
    label: "已失效",
    icon: History,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-state-stale)",
    border: "var(--color-line)",
    dot: "#6b7280",
  },
  running: {
    label: "推导中",
    icon: PlayCircle,
    bg: "var(--color-brand-tint)",
    text: "var(--color-brand-mid)",
    border: "var(--color-brand-ring)",
    dot: "#3b82f6",
  },
  idle: {
    label: "待运行",
    icon: Clock,
    bg: "var(--color-surface-sunken)",
    text: "var(--color-ink-soft)",
    border: "var(--color-line)",
    dot: "var(--color-ink-mute)",
  },
  finished: {
    label: "已结束",
    icon: CheckCircle2,
    bg: "var(--color-state-success-bg)",
    text: "var(--color-state-success)",
    border: "var(--color-state-success-border)",
    dot: "#10b981",
  },
  aborted: {
    label: "已中止",
    icon: AlertOctagon,
    bg: "var(--color-state-error-bg)",
    text: "var(--color-state-error)",
    border: "var(--color-state-error-border)",
    dot: "#ef4444",
  },
  solved: {
    label: "引擎自报已解 · 未经形式化验证",
    icon: CheckCircle2,
    bg: "var(--color-state-success-bg)",
    text: "var(--color-state-success)",
    border: "var(--color-state-success-border)",
    dot: "#10b981",
  },
};

export function normalizeStatusKind(raw: unknown): StatusKind {
  if (typeof raw !== "string") return "unknown";
  const key = raw.trim().toLowerCase();
  return (Object.prototype.hasOwnProperty.call(REGISTRY, key) ? key : "unknown") as StatusKind;
}

export interface StatusBadgeProps {
  status: StatusKind;
  label?: string;
  size?: "sm" | "md";
  showDot?: boolean;
}

export function StatusBadge({
  status,
  label,
  size = "md",
  showDot = true,
}: StatusBadgeProps) {
  const cfg = REGISTRY[status] ?? REGISTRY.unknown;
  const text = label ?? cfg.label;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        borderRadius: "9999px",
        fontWeight: 600,
        backgroundColor: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
        padding: size === "sm" ? "2px 9px" : "4px 12px",
        fontSize: size === "sm" ? "11px" : "12px",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {showDot ? (
        <span
          style={{
            borderRadius: "50%",
            width: size === "sm" ? "6px" : "7px",
            height: size === "sm" ? "6px" : "7px",
            backgroundColor: cfg.dot,
            boxShadow: status === "running" ? `0 0 8px ${cfg.dot}` : "none",
            animation: status === "running" ? "pulse 1.5s infinite" : undefined,
          }}
        />
      ) : null}
      <span>{text}</span>
    </span>
  );
}
