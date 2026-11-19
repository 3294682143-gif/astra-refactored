import type { ResearchViewModel } from "./types";

export interface NumericObservation {
  readonly quantity: string;
  readonly value: string;
  readonly exactness?: string;
}

export interface FinalAnswerPresentation {
  readonly hasAnswer: boolean;
  readonly headline: string | null;
  readonly items: readonly string[];
  readonly fullPlainText: string;
  readonly rawSourceText: string;
  readonly numericObservations: readonly NumericObservation[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 将 LaTeX 单参数命令如 \cmd{content} 展平为 content（支持嵌套花括号） */
function unwrapCommand(input: string, cmdName: string): string {
  const token = `\\${cmdName}`;
  let out = input;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const idx = out.indexOf(token);
    if (idx === -1) break;
    // 确保不是更长命令的前缀
    const afterCmd = out[idx + token.length];
    if (afterCmd && /[a-zA-Z]/.test(afterCmd)) {
      break;
    }
    let pos = idx + token.length;
    while (pos < out.length && /\s/.test(out[pos])) pos += 1;
    if (out[pos] !== "{") {
      out = out.slice(0, idx) + out.slice(idx + token.length);
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = pos; i < out.length; i++) {
      if (out[i] === "{") depth += 1;
      else if (out[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const inner = out.slice(pos + 1, end);
    out = out.slice(0, idx) + inner + out.slice(end + 1);
  }
  return out;
}

/** 将双参数 LaTeX 命令如 \frac{a}{b} 转为 a/b（含必要括号保护） */
function unwrapFrac(input: string): string {
  const commands = ["\\dfrac", "\\tfrac", "\\frac", "\\binom"];
  let out = input;
  let guard = 0;

  const readBraced = (s: string, start: number): { content: string; next: number } | null => {
    let p = start;
    while (p < s.length && /\s/.test(s[p])) p += 1;
    if (s[p] !== "{") return null;
    let depth = 0;
    for (let i = p; i < s.length; i++) {
      if (s[i] === "{") depth += 1;
      else if (s[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          return { content: s.slice(p + 1, i), next: i + 1 };
        }
      }
    }
    return null;
  };

  while (guard < 40) {
    guard += 1;
    let foundIdx = -1;
    let foundCmd = "";
    for (const cmd of commands) {
      const i = out.indexOf(cmd);
      if (i !== -1 && (foundIdx === -1 || i < foundIdx)) {
        foundIdx = i;
        foundCmd = cmd;
      }
    }
    if (foundIdx === -1) break;

    const first = readBraced(out, foundIdx + foundCmd.length);
    if (!first) {
      out = out.slice(0, foundIdx) + out.slice(foundIdx + foundCmd.length);
      continue;
    }
    const second = readBraced(out, first.next);
    if (!second) {
      out = out.slice(0, foundIdx) + first.content + out.slice(first.next);
      continue;
    }

    const a = first.content.trim();
    const b = second.content.trim();
    const replacement =
      foundCmd === "\\binom"
        ? `C(${a}, ${b})`
        : `${/[+\-\s]/.test(a) ? `(${a})` : a}/${/[+\-\s]/.test(b) ? `(${b})` : b}`;
    out = out.slice(0, foundIdx) + replacement + out.slice(second.next);
  }
  return out;
}

/** 提取所有 \boxed{...} 内容 */
function extractBoxedAnswers(raw: string): string[] {
  const results: string[] = [];
  const token = "\\boxed";
  let cursor = 0;
  while (cursor < raw.length) {
    const idx = raw.indexOf(token, cursor);
    if (idx === -1) break;
    let pos = idx + token.length;
    while (pos < raw.length && /\s/.test(raw[pos])) pos += 1;
    if (raw[pos] !== "{") {
      cursor = pos;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = pos; i < raw.length; i++) {
      if (raw[i] === "{") depth += 1;
      else if (raw[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    results.push(raw.slice(pos + 1, end));
    cursor = end + 1;
  }
  return results;
}

/**
 * 将原始输出清洗为“无符号化”的纯文本与直接数字表达：
 *   - 去除所有 $...$ / $$...$$ / \(...\) / \[...\] 定界符与 Markdown 标记；
 *   - 展开 \frac、\boxed、\text、\mathbb 等 LaTeX 指令；
 *   - 将常见希腊/代数 Unicode 符号转为直白文本或标准数字描述，保留数学含义不失真。
 */
export function toPlainAnswerText(
  raw: string,
  options?: { singleLine?: boolean },
): string {
  if (!raw || !raw.trim()) return "";

  let s = raw.replace(/\r\n/g, "\n");

  // 1. 剥离 Markdown 代码围栏标记与引用、加粗、标题符号
  s = s.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^>\s?/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");

  // 2. 去掉 LaTeX 公式定界符与版式修饰命令
  s = s
    .replace(/\$\$/g, "")
    .replace(/\$/g, "")
    .replace(/\\\[|\\\]|\\\(|\\\)/g, "")
    .replace(/\\(?:displaystyle|textstyle|scriptstyle|left|right|big|Big|bigg|Bigg|limits|nolimits|quad|qquad|,|;|:|!)\b/g, " ")
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\!/g, "");

  // 3. 展开 \frac / \binom 与单参数包装命令
  s = unwrapFrac(s);
  for (const cmd of [
    "boxed",
    "text",
    "textbf",
    "textit",
    "textrm",
    "mathrm",
    "mathbf",
    "mathit",
    "mathcal",
    "mathfrak",
    "mathscr",
    "mathbb",
    "boldsymbol",
    "operatorname",
    "overline",
    "underline",
    "hat",
    "bar",
    "tilde",
    "vec",
  ]) {
    s = unwrapCommand(s, cmd);
  }
  s = unwrapCommand(s, "sqrt"); // 前面可再补前缀提示，这里保持干净纯文本根号展开在下面处理

  // 4. 将 LaTeX 符号命令转为纯文本
  const cmdReplacements: Array<[RegExp, string]> = [
    [/\\cong\b/g, " 同构于 "],
    [/\\simeq\b/g, " 同构于 "],
    [/\\equiv\b/g, " 同余于 "],
    [/\\approx\b/g, " 约等于 "],
    [/\\neq\b|\\ne\b/g, " != "],
    [/\\geq\b|\\ge\b/g, " >= "],
    [/\\leq\b|\\le\b/g, " <= "],
    [/\\times\b/g, " x "],
    [/\\cdot\b/g, " * "],
    [/\\div\b/g, " / "],
    [/\\pm\b/g, "+/-"],
    [/\\oplus\b/g, " 直和 "],
    [/\\otimes\b/g, " 张量积 "],
    [/\\cup\b/g, " 并 "],
    [/\\cap\b/g, " 交 "],
    [/\\subseteq\b|\\subset\b/g, " 包含于 "],
    [/\\in\b/g, " 属于 "],
    [/\\notin\b/g, " 不属于 "],
    [/\\emptyset\b|\\varnothing\b/g, "空集"],
    [/\\infty\b/g, "无穷大"],
    [/\\forall\b/g, "对任意 "],
    [/\\exists\b/g, "存在 "],
    [/\\Rightarrow\b|\\implies\b/g, " => "],
    [/\\Leftrightarrow\b|\\iff\b/g, " 等价于 "],
    [/\\to\b|\\rightarrow\b|\\mapsto\b/g, " -> "],
    [/\\partial\b/g, "d"],
    [/\\gcd\b/g, "gcd"],
    [/\\lcm\b/g, "lcm"],
    [/\\ker\b/g, "ker"],
    [/\\operatorname\b/g, ""],
    [/\\dim\b/g, "dim"],
    [/\\det\b/g, "det"],
    [/\\rank\b/g, "rank"],
    [/\\sin\b/g, "sin"],
    [/\\cos\b/g, "cos"],
    [/\\tan\b/g, "tan"],
    [/\\log\b/g, "log"],
    [/\\ln\b/g, "ln"],
    [/\\exp\b/g, "exp"],
    [/\\sum\b/g, "求和 "],
    [/\\prod\b/g, "连乘 "],
    [/\\int\b/g, "积分 "],
    [/\\alpha\b/g, "alpha"],
    [/\\beta\b/g, "beta"],
    [/\\gamma\b/g, "gamma"],
    [/\\delta\b/g, "delta"],
    [/\\varepsilon\b|\\epsilon\b/g, "epsilon"],
    [/\\theta\b/g, "theta"],
    [/\\lambda\b/g, "lambda"],
    [/\\Lambda\b/g, "Lambda"],
    [/\\mu\b/g, "mu"],
    [/\\pi\b/g, "pi"],
    [/\\sigma\b/g, "sigma"],
    [/\\Sigma\b/g, "Sigma"],
    [/\\phi\b|\\varphi\b/g, "phi"],
    [/\\chi\b/g, "chi"],
    [/\\omega\b/g, "omega"],
    [/\\Omega\b/g, "Omega"],
    [/\\Delta\b/g, "Delta"],
  ];

  for (const [pattern, rep] of cmdReplacements) {
    s = s.replace(pattern, rep);
  }

  // 5. 将孤立 Unicode 数学符号转为直白文本（不再呈现“符号化”外观）
  const unicodeReplacements: Array<[RegExp, string]> = [
    [/≅/g, " 同构于 "],
    [/⊕/g, " 直和 "],
    [/⊗/g, " 张量积 "],
    [/≥/g, " >= "],
    [/≤/g, " <= "],
    [/≠/g, " != "],
    [/≈/g, " 约等于 "],
    [/≡/g, " 同余于 "],
    [/∈/g, " 属于 "],
    [/∉/g, " 不属于 "],
    [/⊆|⊂/g, " 包含于 "],
    [/∪/g, " 并 "],
    [/∩/g, " 交 "],
    [/∅/g, "空集"],
    [/∞/g, "无穷大"],
    [/∀/g, "对任意 "],
    [/∃/g, "存在 "],
    [/⇒/g, " => "],
    [/⇔/g, " 等价于 "],
    [/→|↦/g, " -> "],
    [/×/g, " x "],
    [/÷/g, " / "],
    [/±/g, "+/-"],
    [/∂/g, "d"],
    [/χ/g, "chi"],
    [/Λ/g, "Lambda"],
    [/λ/g, "lambda"],
    [/ε/g, "epsilon"],
    [/α/g, "alpha"],
    [/β/g, "beta"],
    [/γ/g, "gamma"],
    [/δ/g, "delta"],
    [/θ/g, "theta"],
    [/π/g, "pi"],
    [/σ/g, "sigma"],
    [/φ/g, "phi"],
    [/ω/g, "omega"],
    [/Δ/g, "Delta"],
    [/Σ/g, "Sigma"],
    [/Ω/g, "Omega"],
  ];

  for (const [pattern, rep] of unicodeReplacements) {
    s = s.replace(pattern, rep);
  }

  // 6. 清理剩余反斜杠与纯包装花括号
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  s = s.replace(/\\\\/g, "\n");
  s = s.replace(/[{}]/g, "");

  // 7. 规范空白
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();

  if (options?.singleLine) {
    return s.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
  }
  return s;
}

/** 将多段答案按编号或分号拆分为清晰易读的纯文本条目 */
function splitPlainItems(plainText: string): string[] {
  if (!plainText) return [];
  // 在内联编号如 " (2) " 或 "（2）" 前适度断行，提升多问答案可读性
  const normalized = plainText
    .replace(/\s+(?=\(\d+\)\s)/g, "\n")
    .replace(/\s+(?=（\d+）)/g, "\n")
    .replace(/;\s*/g, "\n")
    .replace(/；\s*/g, "\n");

  const lines = normalized
    .split("\n")
    .map((l) => l.trim().replace(/^[-•]\s+/, ""))
    .filter(Boolean);

  return lines.length > 0 ? lines : [plainText];
}

/** 提取实测工具观测中的精确数值回执（如有） */
function extractNumericObservations(viewModel: ResearchViewModel): NumericObservation[] {
  const out: NumericObservation[] = [];
  const seen = new Set<string>();

  for (const node of viewModel.nodes) {
    const raw = asRecord(node.technical?.raw);
    if (!raw) continue;
    const obsList =
      raw["TOOL_OBSERVATION"] && typeof raw["TOOL_OBSERVATION"] === "object"
        ? (asRecord(raw["TOOL_OBSERVATION"])?.["observation"] as unknown)
        : undefined;
    const candidates = Array.isArray(obsList) ? obsList : [];

    for (const item of candidates) {
      const rec = asRecord(item);
      if (!rec) continue;
      const quantity = asString(rec["quantity"]) ?? node.relations?.assetName ?? "计算观测";
      const val = rec["value"];
      if (val === undefined || val === null) continue;
      const valueStr =
        typeof val === "number" || typeof val === "boolean" || typeof val === "string"
          ? String(val)
          : JSON.stringify(val);
      const exactness = asString(rec["exactness"]) ?? undefined;
      const key = `${quantity}:${valueStr}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ quantity, value: valueStr, exactness });
      }
    }
  }

  return out;
}

export function extractFinalAnswerPresentation(
  viewModel: ResearchViewModel,
): FinalAnswerPresentation {
  const deliveryNode =
    viewModel.nodes.find((n) => n.id === "node-delivery-final") ?? null;
  const deliveryEvidence = deliveryNode?.evidenceId
    ? viewModel.evidences[deliveryNode.evidenceId] ?? null
    : null;
  const deliveryRaw = asRecord(deliveryNode?.technical?.raw);
  const deliveryPayload = asRecord(deliveryRaw?.["payload"]) ?? deliveryRaw;

  const rawSourceText =
    asString(viewModel.finalAnswer) ??
    asString(deliveryEvidence?.markdownContent) ??
    asString(deliveryPayload?.["final_response"]) ??
    asString(deliveryPayload?.["answer"]) ??
    asString(deliveryNode?.outputSummary) ??
    "";

  const boxed = rawSourceText ? extractBoxedAnswers(rawSourceText) : [];
  const fullPlainText = toPlainAnswerText(rawSourceText);
  const items = splitPlainItems(fullPlainText);
  const numericObservations = extractNumericObservations(viewModel);

  let headline: string | null = null;
  if (boxed.length > 0) {
    const cleaned = toPlainAnswerText(boxed[boxed.length - 1], { singleLine: true });
    if (cleaned) headline = cleaned;
  } else if (fullPlainText && fullPlainText.length <= 72 && items.length === 1) {
    headline = fullPlainText;
  } else if (numericObservations.length === 1 && numericObservations[0].value.length <= 24) {
    headline = `${numericObservations[0].quantity} = ${numericObservations[0].value}`;
  }

  return {
    hasAnswer: Boolean(fullPlainText),
    headline,
    items,
    fullPlainText,
    rawSourceText,
    numericObservations,
  };
}
