import { CircleHelp, Database, History, ScanSearch } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * 数据可观测级别徽章。
 * UNKNOWN 用于「接口未确证级别」的情形：绝不冒充 L2 / L3（记录缺失时不得标 L3）。
 */
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
    bg: "#e0e7ff",
    text: "#3730a3",
    border: "#c7d2fe",
  },
  UNKNOWN: {
    level: "UNKNOWN",
    name: "级别未确证",
    caption: "当前请求失败或接口未返回存档路径，无法确证数据可观测级别（不冒充 L2 / L3）",
    icon: CircleHelp,
    bg: "var(--color-state-stale-bg)",
    text: "var(--color-state-stale)",
    border: "#d1d5db",
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
          gap: "6px",
          borderRadius: "6px",
          fontWeight: 500,
          backgroundColor: cfg.bg,
          color: cfg.text,
          border: `1px solid ${cfg.border}`,
          padding: size === "sm" ? "2px 6px" : "4px 8px",
          fontSize: size === "sm" ? "11px" : "12px",
          lineHeight: 1.4,
        }}
      >
        <Icon size={size === "sm" ? 12 : 14} />
        <span>{cfg.level === "UNKNOWN" ? "未知级别" : `${cfg.level} · ${cfg.name}`}</span>
      </span>
      {withCaption ? (
        <span style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>{cfg.caption}</span>
      ) : null}
    </span>
  );
}