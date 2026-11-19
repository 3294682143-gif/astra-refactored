import { Fragment, useState } from "react";
import { Check, Copy } from "lucide-react";
import katex from "@/vendor/katex/katex.mjs";

interface MathMarkdownProps {
  content: string;
  className?: string;
  compact?: boolean;
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

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div
      style={{
        margin: "12px 0",
        borderRadius: "10px",
        border: "1px solid var(--color-line-strong)",
        backgroundColor: "var(--color-code-bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px",
          borderBottom: "1px solid var(--color-line)",
          fontSize: "11px",
          color: "var(--color-ink-mute)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{lang || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            border: "none",
            background: "transparent",
            color: copied ? "var(--color-state-success)" : "var(--color-ink-soft)",
            fontSize: "11px",
            cursor: "pointer",
            padding: "2px 6px",
            borderRadius: "4px",
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "12px 14px",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          lineHeight: 1.55,
          overflowX: "auto",
          color: "var(--color-ink)",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** 将原始文本按代码块、独立 $$...$$ 块及双换行段落安全切分 */
function splitBlocks(content: string): string[] {
  const blocks: string[] = [];
  const lines = content.split("\n");
  let i = 0;
  let buffer: string[] = [];

  const flushBuffer = () => {
    const joined = buffer.join("\n").trim();
    if (joined) {
      for (const part of joined.split(/\n{2,}/)) {
        const p = part.trim();
        if (p) blocks.push(p);
      }
    }
    buffer = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // 围栏代码块
    if (trimmed.startsWith("```")) {
      flushBuffer();
      const fenceLines = [line];
      i++;
      while (i < lines.length) {
        fenceLines.push(lines[i]!);
        if (lines[i]!.trim().startsWith("```")) {
          i++;
          break;
        }
        i++;
      }
      blocks.push(fenceLines.join("\n"));
      continue;
    }

    // 独立块级公式 $$ ... $$ (支持多行矩阵与单行 $$...$$)
    if (trimmed.startsWith("$$")) {
      flushBuffer();
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        blocks.push(trimmed);
        i++;
        continue;
      }
      const mathLines = [line];
      i++;
      while (i < lines.length) {
        mathLines.push(lines[i]!);
        if (lines[i]!.trim().endsWith("$$")) {
          i++;
          break;
        }
        i++;
      }
      blocks.push(mathLines.join("\n"));
      continue;
    }

    buffer.push(line);
    i++;
  }

  flushBuffer();
  return blocks;
}

/**
 * 专业的数学公式排版与 Markdown 渲染组件。
 *
 * 特性：
 *   1. 原生 KaTeX 排版：支持行内 $...$ 与块级 $$...$$（含多行矩阵），标题内公式同样完整解析。
 *   2. Alert 强调块：支持 > [!NOTE]、> [!WARNING]、> [!IMPORTANT]。
 *   3. 格式化代码块（带一键复制）、有序/无序列表与 Markdown 表格。
 *   4. 安全第一：非公式文本禁止注入原始 HTML。
 */
export function MathMarkdown({ content, className = "", compact = false }: MathMarkdownProps) {
  if (!content) return null;

  const rawBlocks = splitBlocks(content);

  return (
    <div
      className={className}
      style={{
        lineHeight: compact ? 1.65 : 1.75,
        fontSize: compact ? "13px" : "14px",
        color: "var(--color-ink)",
        wordBreak: "break-word",
      }}
    >
      {rawBlocks.map((trimmed, idx) => {
        // 1. 标题 (###, ##, #) —— 经由 InlineMathText 支持标题内公式
        if (trimmed.startsWith("#")) {
          const match = trimmed.match(/^(#{1,4})\s+(.+)$/);
          if (match) {
            const level = match[1]!.length;
            const titleText = match[2]!;
            const size = level === 1 ? "20px" : level === 2 ? "17px" : "15px";
            return (
              <div
                key={idx}
                style={{
                  fontSize: size,
                  fontWeight: 700,
                  color: "var(--color-brand-deep)",
                  margin: compact ? "10px 0 6px" : "18px 0 10px 0",
                  borderBottom: level <= 2 ? "1px solid var(--color-line)" : "none",
                  paddingBottom: level <= 2 ? "6px" : 0,
                }}
              >
                <InlineMathText text={titleText} />
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
            important: "var(--color-state-error)",
          };
          const bgColors = {
            note: "var(--color-brand-tint)",
            warning: "var(--color-state-candidate-bg)",
            important: "var(--color-state-error-bg)",
          };

          return (
            <div
              key={idx}
              style={{
                margin: compact ? "8px 0" : "14px 0",
                padding: "12px 16px",
                borderLeft: `3px solid ${borderColors[alertType]}`,
                backgroundColor: bgColors[alertType],
                borderRadius: "8px",
                fontSize: "13px",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: "4px", color: borderColors[alertType] }}>{alertTitle}</div>
              <div>
                <InlineMathText text={lines.join("\n")} />
              </div>
            </div>
          );
        }

        // 3. 代码块 (```json ... ```)
        if (trimmed.startsWith("```")) {
          const lines = trimmed.split("\n");
          const lang = lines[0]!.slice(3).trim();
          const hasClosing = lines.length > 1 && lines[lines.length - 1]!.trim().startsWith("```");
          const codeContent = (hasClosing ? lines.slice(1, -1) : lines.slice(1)).join("\n");
          return <CodeBlock key={idx} lang={lang} code={codeContent} />;
        }

        // 4. Markdown 表格
        const tableLines = trimmed.split("\n");
        if (
          tableLines.length >= 2 &&
          tableLines[0]!.includes("|") &&
          /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(tableLines[1]!)
        ) {
          const parseRow = (line: string) =>
            line
              .trim()
              .replace(/^\|/, "")
              .replace(/\|$/, "")
              .split("|")
              .map((cell) => cell.trim());
          const headers = parseRow(tableLines[0]!);
          const rows = tableLines.slice(2).map(parseRow);

          return (
            <div
              key={idx}
              style={{
                margin: compact ? "8px 0" : "14px 0",
                overflowX: "auto",
                borderRadius: "10px",
                border: "1px solid var(--color-line)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
                <thead>
                  <tr style={{ backgroundColor: "var(--color-surface-sunken)", borderBottom: "1px solid var(--color-line-strong)" }}>
                    {headers.map((h, hIdx) => (
                      <th key={hIdx} style={{ padding: "9px 12px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
                        <InlineMathText text={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, rIdx) => (
                    <tr key={rIdx} style={{ borderTop: "1px solid var(--color-line)" }}>
                      {headers.map((_, cIdx) => (
                        <td key={cIdx} style={{ padding: "8px 12px", color: "var(--color-ink-soft)" }}>
                          <InlineMathText text={r[cIdx] ?? ""} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        // 5. 无序列表 (* or -)
        if (tableLines.every((l) => /^\s*[*+-]\s+/.test(l))) {
          const items = tableLines.map((l) => l.replace(/^\s*[*+-]\s+/, ""));
          return (
            <ul key={idx} style={{ margin: compact ? "6px 0" : "10px 0", paddingLeft: "20px" }}>
              {items.map((it, itemIdx) => (
                <li key={itemIdx} style={{ margin: "4px 0" }}>
                  <InlineMathText text={it} />
                </li>
              ))}
            </ul>
          );
        }

        // 6. 有序列表 (1. ...)
        if (tableLines.every((l) => /^\s*\d+\.\s+/.test(l))) {
          const items = tableLines.map((l) => l.replace(/^\s*\d+\.\s+/, ""));
          return (
            <ol key={idx} style={{ margin: compact ? "6px 0" : "10px 0", paddingLeft: "22px" }}>
              {items.map((it, itemIdx) => (
                <li key={itemIdx} style={{ margin: "4px 0" }}>
                  <InlineMathText text={it} />
                </li>
              ))}
            </ol>
          );
        }

        // 7. 独立数学公式块 ($$ ... $$)
        if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
          const mathExpr = trimmed.slice(2, -2).trim();
          const renderedHtml = renderKatex(mathExpr, true);
          return (
            <div
              key={idx}
              style={{
                margin: compact ? "8px 0" : "14px 0",
                padding: compact ? "10px 12px" : "14px 18px",
                textAlign: "center",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
                borderLeft: "3px solid var(--color-brand)",
                borderRadius: "10px",
                overflowX: "auto",
              }}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          );
        }

        // 8. 常规段落（支持单换行保留语义折行）
        const paraLines = trimmed.split("\n");
        return (
          <p key={idx} style={{ margin: compact ? "6px 0" : "10px 0" }}>
            {paraLines.map((line, lIdx) => (
              <Fragment key={lIdx}>
                <InlineMathText text={line} />
                {lIdx < paraLines.length - 1 && <br />}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** 渲染内联行内公式、行内代码与加粗文本 */
export function InlineMathText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\$[^$\n]+\$|\*\*[^*]+\*\*)/g);

  return (
    <>
      {parts.map((part, pIdx) => {
        if (!part) return null;

        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={pIdx}
              style={{
                backgroundColor: "var(--color-code-inline-bg)",
                padding: "2px 6px",
                borderRadius: "5px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.9em",
                color: "var(--color-code-inline-ink)",
              }}
            >
              {part.slice(1, -1)}
            </code>
          );
        }

        if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
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
