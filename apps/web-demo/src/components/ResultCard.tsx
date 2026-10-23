import type { ReactNode } from "react";
import { Clock3, Info, TriangleAlert } from "lucide-react";
import { StatusBadge, type StatusKind } from "./StatusBadge";
import { DataSourceBadge, type DataSourceLevel } from "./DataSourceBadge";

export interface ResultCardProps {
  title: string;
  status: StatusKind;
  source: DataSourceLevel;
  answer?: string;
  unsolvedReason?: string;
  errorMessage?: string;
  note?: string;
  updatedAt?: string;
  actions?: ReactNode;
  footer?: ReactNode;
}

export function ResultCard({
  title,
  status,
  source,
  answer,
  unsolvedReason,
  errorMessage,
  note,
  updatedAt,
  actions,
  footer,
}: ResultCardProps) {
  const showAnswer = status === "candidate" && Boolean(answer?.trim());
  const showUnsolved = status === "unsolved";
  const showError = status === "error";

  return (
    <article
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-line)",
        backgroundColor: "var(--color-surface)",
        boxShadow: "0 1px 3px rgba(15,38,92,0.05)",
      }}
    >
      <div className="astra-brand-rule" style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px" }} />

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 20px 10px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: "15px", fontWeight: 600, color: "var(--color-ink)" }}>
            {title}
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
            <StatusBadge status={status} size="sm" />
            <DataSourceBadge level={source} size="sm" />
            {updatedAt ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
                <Clock3 size={12} />
                <span>{updatedAt}</span>
              </span>
            ) : null}
          </div>
        </div>
        {actions ? <div>{actions}</div> : null}
      </header>

      <div style={{ padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {showAnswer ? (
          <section
            style={{
              borderRadius: "8px",
              border: "1px solid var(--color-brand-ring)",
              backgroundColor: "var(--color-brand-tint)",
              padding: "12px 14px",
            }}
          >
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "4px" }}>
              🛡️ 候选答案（未经形式化验证）
            </div>
            <div style={{ fontSize: "14px", lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--color-ink)" }}>
              {answer}
            </div>
          </section>
        ) : null}

        {showUnsolved ? (
          <section
            style={{
              display: "flex",
              gap: "10px",
              borderRadius: "8px",
              border: "1px solid var(--color-line)",
              backgroundColor: "var(--color-surface-muted)",
              padding: "12px 14px",
            }}
          >
            <Info size={16} color="var(--color-state-unsolved)" style={{ marginTop: "2px", flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-ink-soft)", marginBottom: "2px" }}>
                未解归因说明
              </div>
              <div style={{ fontSize: "13px", lineHeight: 1.5, color: "var(--color-ink-soft)" }}>
                {unsolvedReason?.trim() || "未形成符合约束的候选答案，有界求解受控收口。"}
              </div>
            </div>
          </section>
        ) : null}

        {showError ? (
          <section
            style={{
              display: "flex",
              gap: "10px",
              borderRadius: "8px",
              border: "1px solid var(--color-state-error)",
              backgroundColor: "var(--color-state-error-bg)",
              padding: "12px 14px",
            }}
          >
            <TriangleAlert size={16} color="var(--color-state-error)" style={{ marginTop: "2px", flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-state-error)", marginBottom: "2px" }}>
                运行异常
              </div>
              <div style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--color-state-error)" }}>
                {errorMessage?.trim() || "未知系统异常"}
              </div>
            </div>
          </section>
        ) : null}

        {note?.trim() ? (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--color-ink-mute)", lineHeight: 1.5 }}>
            {note}
          </p>
        ) : null}
      </div>

      {footer ? (
        <footer style={{ borderTop: "1px solid var(--color-line)", backgroundColor: "var(--color-surface-muted)", padding: "10px 20px" }}>
          {footer}
        </footer>
      ) : null}
    </article>
  );
}
