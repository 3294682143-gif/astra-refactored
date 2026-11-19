import { CircleHelp, Database, History, ScanSearch } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type DataSourceLevel = "L1" | "L2" | "L3" | "UNKNOWN";

interface SourceConfig {
  readonly level: DataSourceLevel;
  readonly name: string;
  readonly caption: string;
  readonly icon: LucideIcon;
  readonly bg: string;
  readonly text: string;
  readonly border: string;
}

const REGISTRY: Record<DataSourceLevel, SourceConfig> = {
  L1: {
    level: "L1",
    name: "公开摘要",
    caption: "基础摘要层：仅保留关键字段，无拓扑边与真实时间戳",
    icon: Database,
    bg: "var(--color-surface-sunken)",
    text: "var(--color-ink-soft)",
    border: "var(--color-line-strong)",
  },
  L2: {
    level: "L2",
    name: "历史日志",
    caption: "历史轨迹层：包含 SessionLog 会话序列与自检记录",
    icon: History,
    bg: "var(--color-brand-tint)",
    text: "var(--color-brand-deep)",
    border: "var(--color-brand-ring)",
  },
  L3: {
    level: "L3",
    name: "完整观察",
    caption: "完整观察层：保留原始依赖、推导与毫秒级时间戳",
    icon: ScanSearch,
    bg: "rgba(99, 102, 241, 0.16)",
    text: "var(--color-aurora-indigo)",
    border: "rgba(129, 140, 248, 0.35)",
  },
  UNKNOWN: {
    level: "UNKNOWN",
    name: "级别未确证",
    caption: "当前请求失败或接口未返回存档路径，无法确证数据可观测级别（不冒充 L2 / L3）",
    icon: CircleHelp,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-state-stale)",
    border: "var(--color-line)",
  },
};

export interface DataSourceBadgeProps {
  level: DataSourceLevel;
  withCaption?: boolean;
  size?: "sm" | "md";
}

export function DataSourceBadge({
  level,
  withCaption = false,
  size = "md",
}: DataSourceBadgeProps) {
  const cfg = REGISTRY[level] ?? REGISTRY.UNKNOWN;
  const Icon = cfg.icon;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }} title={cfg.caption}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          borderRadius: "9999px",
          fontWeight: 600,
          backgroundColor: cfg.bg,
          color: cfg.text,
          border: `1px solid ${cfg.border}`,
          padding: size === "sm" ? "2px 8px" : "4px 10px",
          fontSize: size === "sm" ? "11px" : "12px",
          lineHeight: 1.4,
        }}
      >
        <Icon size={size === "sm" ? 11 : 13} />
        <span>{cfg.level === "UNKNOWN" ? "未知级别" : `${cfg.level} · ${cfg.name}`}</span>
      </span>
      {withCaption ? (
        <span style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>{cfg.caption}</span>
      ) : null}
    </span>
  );
}
