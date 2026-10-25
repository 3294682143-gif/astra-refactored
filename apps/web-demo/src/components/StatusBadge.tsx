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
    border: "#fde68a",
    dot: "#b45309",
  },
  unsolved: {
    label: "未解",
    icon: CircleHelp,
    bg: "var(--color-state-unsolved-bg)",
    text: "var(--color-state-unsolved)",
    border: "#cbd5e1",
    dot: "#475569",
  },
  error: {
    label: "运行错误",
    icon: AlertOctagon,
    bg: "var(--color-state-error-bg)",
    text: "var(--color-state-error)",
    border: "#fecaca",
    dot: "#b91c1c",
  },
  timeout: {
    label: "超时终止",
    icon: Timer,
    bg: "#fff7ed",
    text: "#c2410c",
    border: "#fed7aa",
    dot: "#ea580c",
  },
  failed: {
    label: "运行时失败",
    icon: Wrench,
    bg: "#fef2f2",
    text: "#b91c1c",
    border: "#fca5a5",
    dot: "#991b1b",
  },
  cancelled: {
    label: "已取消",
    icon: Ban,
    bg: "#f8fafc",
    text: "#475569",
    border: "#cbd5e1",
    dot: "#94a3b8",
  },
  unknown: {
    label: "状态未知",
    icon: ShieldQuestion,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-state-stale)",
    border: "#d1d5db",
    dot: "#9ca3af",
  },
  stale: {
    label: "已失效",
    icon: History,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-state-stale)",
    border: "#e5e7eb",
    dot: "#6b7280",
  },
  running: {
    label: "推导中",
    icon: PlayCircle,
    bg: "var(--color-brand-tint)",
    text: "var(--color-brand-deep)",
    border: "#93c5fd",
    dot: "#2563eb",
  },
  idle: {
    label: "待运行",
    icon: Clock,
    bg: "var(--color-surface-muted)",
    text: "var(--color-ink-soft)",
    border: "var(--color-line)",
    dot: "var(--color-ink-mute)",
  },
  finished: {
    label: "已结束",
    icon: CheckCircle2,
    bg: "#f0fdf4",
    text: "#15803d",
    border: "#bbf7d0",
    dot: "#16a34a",
  },
  aborted: {
    label: "已中止",
    icon: AlertOctagon,
    bg: "#fef2f2",
    text: "#b91c1c",
    border: "#fecaca",
    dot: "#dc2626",
  },
  solved: {
    label: "引擎自报已解 · 未经形式化验证",
    icon: CheckCircle2,
    bg: "#f0fdf4",
    text: "#15803d",
    border: "#bbf7d0",
    dot: "#16a34a",
  },
};

/**
 * 把接口返回的原始 status 字符串映射为受控状态。
 * 未注册值一律落到 unknown —— 绝不回落为 candidate（旧版曾回落 candidate，属于伪造终态）。
 */
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
        fontWeight: 500,
        backgroundColor: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
        padding: size === "sm" ? "2px 8px" : "4px 10px",
        fontSize: size === "sm" ? "11px" : "12px",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {showDot ? (
        <span
          style={{
            borderRadius: "50%",
            width: size === "sm" ? "6px" : "8px",
            height: size === "sm" ? "6px" : "8px",
            backgroundColor: cfg.dot,
          }}
        />
      ) : null}
      <span>{text}</span>
    </span>
  );
}