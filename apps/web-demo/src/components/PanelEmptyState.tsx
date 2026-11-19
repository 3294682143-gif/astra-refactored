import type { ReactNode } from "react";
import { FileQuestion, Inbox } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type EmptyVariant = "empty" | "missing";

export interface PanelEmptyStateProps {
  variant?: EmptyVariant;
  icon?: LucideIcon;
  title: string;
  description?: string;
  hint?: string;
  action?: ReactNode;
}

export function PanelEmptyState({
  variant = "empty",
  icon,
  title,
  description,
  hint,
  action,
}: PanelEmptyStateProps) {
  const Icon = icon ?? (variant === "missing" ? FileQuestion : Inbox);
  const isMissing = variant === "missing";

  return (
    <div
      role="status"
      className="zygos-glass"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-card)",
        border: `1px dashed ${isMissing ? "var(--color-state-candidate-border)" : "var(--color-line-strong)"}`,
        backgroundColor: isMissing ? "var(--color-state-candidate-bg)" : "var(--color-surface)",
        padding: "48px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          width: "52px",
          height: "52px",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "14px",
          backgroundColor: isMissing ? "var(--color-state-candidate-bg)" : "var(--color-brand-tint)",
          border: `1px solid ${isMissing ? "var(--color-state-candidate-border)" : "var(--color-brand-ring)"}`,
          color: isMissing ? "var(--color-state-candidate)" : "var(--color-brand-mid)",
        }}
      >
        <Icon size={24} />
      </div>

      <h3 style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 700, color: "var(--color-ink)" }}>
        {title}
      </h3>

      {description?.trim() ? (
        <p style={{ margin: "0 0 8px", maxWidth: "480px", fontSize: "13px", lineHeight: 1.6, color: "var(--color-ink-soft)" }}>
          {description}
        </p>
      ) : null}

      {hint?.trim() ? (
        <p style={{ margin: 0, maxWidth: "480px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
          {hint}
        </p>
      ) : null}

      {action ? <div style={{ marginTop: "20px" }}>{action}</div> : null}
    </div>
  );
}
