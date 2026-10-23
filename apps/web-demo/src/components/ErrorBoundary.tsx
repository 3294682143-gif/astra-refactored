import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  scope?: string;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[web-demo][ErrorBoundary:${this.props.scope || "root"}]`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, fallback, scope } = this.props;

    if (error === null) return children;
    if (fallback) return fallback(error, this.reset);

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--radius-card)",
          border: "1px solid #fecaca",
          backgroundColor: "#fef2f2",
          padding: "36px 20px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            marginBottom: "12px",
            display: "flex",
            width: "44px",
            height: "44px",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            backgroundColor: "#fee2e2",
            color: "#b91c1c",
          }}
        >
          <ShieldAlert size={22} />
        </div>

        <h3 style={{ margin: "0 0 6px", fontSize: "15px", fontWeight: 600, color: "var(--color-ink)" }}>
          {scope ? `${scope} 局部渲染异常` : "模块渲染失败"}
        </h3>

        <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--color-ink-soft)" }}>
          该错误已被局部隔离保护，页面其余面板仍可正常交互。
        </p>

        <pre
          style={{
            margin: "0 0 16px",
            maxWidth: "100%",
            overflowX: "auto",
            borderRadius: "6px",
            backgroundColor: "#ffffff",
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            color: "#b91c1c",
            border: "1px solid #fecaca",
          }}
        >
          {error.message}
        </pre>

        <button
          type="button"
          onClick={this.reset}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            borderRadius: "8px",
            backgroundColor: "var(--color-brand)",
            color: "#ffffff",
            border: "none",
            padding: "8px 16px",
            fontSize: "13px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={14} />
          重试模块
        </button>
      </div>
    );
  }
}
