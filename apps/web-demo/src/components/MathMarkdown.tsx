import { Fragment } from "react";
import katex from "@/vendor/katex/katex.mjs";

interface MathMarkdownProps {
  content: string;
  className?: string;
}

function renderKatex(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr.trim(), {
      displayMode,
      throwOnError: false,
      output: "htmlAndMathml",
    });
  } catch {
    return `<span class="katex-fallback">${expr}</span>`;
  }
}

/**
 * 专业的数学公式排版与 Markdown 渲染组件。
 *
 * 特性：
 *   1. 原生 KaTeX 排版：真正解析 LaTeX 数学公式（\frac, \sum, \sqrt, 上下标等），支持行内 $...$ 与块级 $$...$$。
 *   2. Alert 强调块：支持 GitHub 风格的 > [!NOTE]、> [!WARNING]、> [!IMPORTANT]。
 *   3. 格式化代码块与表格：清晰呈现 JSON 回执与数学参数。
 *   4. 安全第一：非公式文本禁止注入原始 HTML。
 */
export function MathMarkdown({ content, className = "" }: MathMarkdownProps) {
  if (!content) return null;

  // 将正文按双换行切分为段落/块级元素
  const rawBlocks = content.split(/\n{2,}/);

  return (
    <div
      className={className}
      style={{
        lineHeight: 1.7,
        fontSize: "14px",
        color: "var(--color-ink)",
        wordBreak: "break-word",
      }}
    >
      {rawBlocks.map((block, idx) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        // 1. 标题 (###, ##, #)
        if (trimmed.startsWith("#")) {
          const match = trimmed.match(/^(#{1,4})\s+(.+)$/);
          if (match) {
            const level = match[1].length;
            const titleText = match[2];
            const size = level === 1 ? "20px" : level === 2 ? "17px" : "15px";
            return (
              <div
                key={idx}
                style={{
                  fontSize: size,
                  fontWeight: 700,
                  color: "var(--color-brand-deep)",
                  margin: "18px 0 10px 0",
                  borderBottom: level <= 2 ? "1px solid var(--color-line)" : "none",
                  paddingBottom: level <= 2 ? "6px" : 0,
                }}
              >
                {titleText}
              </div>
            );
          }
        }

        // 2. Alert 强调块 (> [!NOTE], > [!WARNING], > [!IMPORTANT])
        if (trimmed.startsWith(">")) {
          const lines = trimmed.split("\n").map((l) => l.replace(/^>\s?/, ""));
          const firstLine = lines[0] || "";
          let alertType: "note" | "warning" | "important" = "note";
          let alertTitle = "说明";

          if (firstLine.includes("[!WARNING]") || firstLine.includes("[!CAUTION]")) {
            alertType = "warning";
            alertTitle = "注意";
            lines.shift();
          } else if (firstLine.includes("[!NOTE]")) {
            alertType = "note";
            alertTitle = "说明";
            lines.shift();
          } else if (firstLine.includes("[!IMPORTANT]")) {
            alertType = "important";
            alertTitle = "重点";
            lines.shift();
          }

          const borderColors = {
            note: "var(--color-brand-mid)",
            warning: "var(--color-state-candidate)",
            important: "#e11d48",
          };
          const bgColors = {
            note: "var(--color-brand-tint)",
            warning: "var(--color-state-candidate-bg)",
            important: "#ffe4e6",
          };

          return (
            <div
              key={idx}
              style={{
                margin: "14px 0",
                padding: "12px 16px",
                borderLeft: `4px solid ${borderColors[alertType]}`,
                backgroundColor: bgColors[alertType],
                borderRadius: "4px",
                fontSize: "13px",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "4px" }}>{alertTitle}</div>
              <div>{lines.join("\n")}</div>
            </div>
          );
        }

        // 3. 代码块 (```json ... ```)
        if (trimmed.startsWith("```")) {
          const lines = trimmed.split("\n");
          const codeContent = lines.slice(1, -1).join("\n");
          return (
            <pre
              key={idx}
              style={{
                margin: "12px 0",
                padding: "12px 14px",
                backgroundColor: "#f4f6fa",
                border: "1px solid var(--color-line)",
                borderRadius: "8px",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                lineHeight: 1.5,
                overflowX: "auto",
                color: "#1e293b",
              }}
            >
              <code>{codeContent}</code>
            </pre>
          );
        }

        // 4. 无序列表 (* or -)
        if (trimmed.split("\n").every((l) => /^\s*[*+-]\s+/.test(l))) {
          const items = trimmed.split("\n").map((l) => l.replace(/^\s*[*+-]\s+/, ""));
          return (
            <ul key={idx} style={{ margin: "10px 0", paddingLeft: "20px" }}>
              {items.map((it, itemIdx) => (
                <li key={itemIdx} style={{ margin: "4px 0" }}>
                  <InlineMathText text={it} />
                </li>
              ))}
            </ul>
          );
        }

        // 5. 独立数学公式块 ($$ ... $$) -> 真正调用 KaTeX displayMode
        if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
          const mathExpr = trimmed.slice(2, -2).trim();
          const renderedHtml = renderKatex(mathExpr, true);
          return (
            <div
              key={idx}
              style={{
                margin: "16px 0",
                padding: "14px",
                textAlign: "center",
                backgroundColor: "#f8fafc",
                border: "1px solid var(--color-line-strong)",
                borderRadius: "8px",
                overflowX: "auto",
              }}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          );
        }

        // 6. 常规段落
        return (
          <p key={idx} style={{ margin: "10px 0" }}>
            <InlineMathText text={trimmed} />
          </p>
        );
      })}
    </div>
  );
}

/** 渲染内联行内公式与行内代码 */
function InlineMathText({ text }: { text: string }) {
  // 分词处理 `code` 与 $formula$ 与 **bold**
  const parts = text.split(/(`[^`]+`|\$[^$]+\$|\*\*[^*]+\*\*)/g);

  return (
    <>
      {parts.map((part, pIdx) => {
        if (!part) return null;

        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={pIdx}
              style={{
                backgroundColor: "rgba(15, 38, 92, 0.06)",
                padding: "2px 6px",
                borderRadius: "4px",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                color: "var(--color-brand-deep)",
              }}
            >
              {part.slice(1, -1)}
            </code>
          );
        }

        // 行内公式：真正调用 KaTeX 行内渲染
        if (part.startsWith("$") && part.endsWith("$")) {
          const formula = part.slice(1, -1);
          const renderedHtml = renderKatex(formula, false);
          return (
            <span
              key={pIdx}
              style={{ padding: "0 2px" }}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          );
        }

        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={pIdx} style={{ fontWeight: 600, color: "var(--color-brand-deep)" }}>
              {part.slice(2, -2)}
            </strong>
          );
        }

        return <Fragment key={pIdx}>{part}</Fragment>;
      })}
    </>
  );
}
