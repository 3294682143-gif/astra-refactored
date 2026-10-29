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
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-card)",
        border: `1px dashed ${isMissing ? "var(--color-state-candidate)" : "var(--color-line-strong)"}`,
        backgroundColor: isMissing ? "var(--color-state-candidate-bg)" : "rgba(255,255,255,0.7)",
        padding: "48px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          width: "48px",
          height: "48px",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          backgroundColor: isMissing ? "#fef3c7" : "var(--color-brand-tint)",
          color: isMissing ? "#b45309" : "var(--color-brand)",
        }}
      >
        <Icon size={24} />
      </div>

      <h3 style={{ margin: "0 0 8px", fontSize: "15px", fontWeight: 600, color: "var(--color-ink)" }}>
        {title}
      </h3>

      {description?.trim() ? (
        <p style={{ margin: "0 0 8px", maxWidth: "420px", fontSize: "13px", lineHeight: 1.5, color: "var(--color-ink-soft)" }}>
          {description}
        </p>
      ) : null}

      {hint?.trim() ? (
        <p style={{ margin: 0, maxWidth: "420px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
          {hint}
        </p>
      ) : null}

      {action ? <div style={{ marginTop: "20px" }}>{action}</div> : null}
    </div>
  );
}
