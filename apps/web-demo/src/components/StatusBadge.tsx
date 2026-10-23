import type { LucideIcon } from "lucide-react";
import { AlertOctagon, CircleHelp, FlaskConical, History, PlayCircle, CheckCircle2, Clock } from "lucide-react";

export type StatusKind =
  | "candidate"
  | "unsolved"
  | "error"
  | "stale"
  | "running"
  | "idle"
  | "finished"
  | "aborted"
  | "solved";

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
    label: "候选答案",
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
    label: "错误",
    icon: AlertOctagon,
    bg: "var(--color-state-error-bg)",
    text: "var(--color-state-error)",
    border: "#fecaca",
    dot: "#b91c1c",
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
    label: "就绪",
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
    label: "形式化通过",
    icon: CheckCircle2,
    bg: "#f0fdf4",
    text: "#15803d",
    border: "#bbf7d0",
    dot: "#16a34a",
  },
};

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
  const cfg = REGISTRY[status] || REGISTRY.unsolved;
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
