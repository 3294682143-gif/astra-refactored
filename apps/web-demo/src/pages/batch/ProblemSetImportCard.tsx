import { useState, type ChangeEvent, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Upload, X } from "lucide-react";
import {
  importProblemSet,
  type ProblemSetImportMode,
  type ProblemSetImportResponse,
} from "@/api/client.ts";

export interface ProblemSetImportCardProps {
  onClose: () => void;
  onImported: (result: ProblemSetImportResponse) => void;
}

export function ProblemSetImportCard({ onClose, onImported }: ProblemSetImportCardProps) {
  const [name, setName] = useState("");
  const [jsonlText, setJsonlText] = useState("");
  const [mode, setMode] = useState<ProblemSetImportMode>("catalog");
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResultMsg(null);
    try {
      const text = await file.text();
      setJsonlText(text);
      if (!name.trim()) {
        setName(file.name.replace(/\.(jsonl|txt|ndjson)$/i, ""));
      }
    } catch (err) {
      setError(`文件读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!jsonlText.trim()) {
      setError("请先选择 .jsonl 文件或粘贴 JSONL 内容");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResultMsg(null);

    const res = await importProblemSet({
      name: name.trim() || undefined,
      jsonl_text: jsonlText,
      mode,
      overwrite: mode === "replays" ? overwrite : undefined,
    });
    setSubmitting(false);

    if (!res.ok) {
      setError(res.error.message);
      return;
    }

    const data = res.data;
    if (data.mode === "replays") {
      setResultMsg(`已导入 ${data.imported_count ?? 0} 条 SolveResult 运行日志到本地研究日志。`);
    } else if (data.mode === "enqueue") {
      const warn =
        data.solver_configured === false
          ? "（提示：当前未配置可用求解器，队列将按 SOLVER_NOT_CONFIGURED 如实收口）"
          : "";
      setResultMsg(
        `已保存题集「${data.problem_set?.name ?? ""}」（${data.problem_set?.count ?? 0} 题）并提交 ${data.enqueued_count ?? 0} 条单题入队${warn}。`,
      );
    } else {
      setResultMsg(
        `已校验并保存题集「${data.problem_set?.name ?? ""}」（共 ${data.problem_set?.count ?? 0} 题），可在「已导入 JSONL 题集」标签页逐题查看或启动求解。`,
      );
    }
    onImported(data);
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="zygos-glass"
      style={{
        borderRadius: "16px",
        padding: "18px 22px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        border: "1px solid var(--color-brand-mid)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <FileSpreadsheet size={16} color="var(--color-brand-mid)" />
          <span style={{ fontSize: "14.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            导入 JSONL 题目集 / 历史归档
          </span>
          <span style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>
            POST /api/problem-sets/import
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭导入面板"
          className="zygos-btn-ghost"
          style={{ padding: "4px 8px", fontSize: "12px" }}
        >
          <X size={14} />
          <span>收起</span>
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px", color: "var(--color-ink-soft)" }}>
          <span>题集名称（可选）</span>
          <input
            type="text"
            placeholder="例如：eval200-自定义子集"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              padding: "7px 10px",
              borderRadius: "8px",
              border: "1px solid var(--color-line)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-ink)",
              fontSize: "12.5px",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px", color: "var(--color-ink-soft)" }}>
          <span>选择本地 `.jsonl` 文件</span>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "5px 10px",
              borderRadius: "8px",
              border: "1px dashed var(--color-line-strong)",
              backgroundColor: "var(--color-surface-sunken)",
            }}
          >
            <Upload size={13} color="var(--color-brand-mid)" />
            <input
              type="file"
              accept=".jsonl,.txt,.ndjson,application/x-ndjson"
              onChange={(e) => void handleFileChange(e)}
              style={{ fontSize: "12px", color: "var(--color-ink)" }}
            />
          </div>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px", color: "var(--color-ink-soft)" }}>
          <span>导入方式</span>
          <select
            aria-label="JSONL 导入方式"
            value={mode}
            onChange={(e) => setMode(e.target.value as ProblemSetImportMode)}
            style={{
              padding: "7px 10px",
              borderRadius: "8px",
              border: "1px solid var(--color-line)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-ink)",
              fontSize: "12.5px",
            }}
          >
            <option value="catalog">仅解析入库题集目录（支持逐题发起求解）</option>
            <option value="enqueue">解析并逐题入队求解（单并发队列，≤50 题）</option>
            <option value="replays">导入历史 SolveResult 运行档案 JSONL</option>
          </select>
        </label>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px", color: "var(--color-ink-soft)" }}>
        <span>JSONL 内容（每行一个 JSON 对象，题集行需包含 `problem` / `question` / `prompt` 字段）</span>
        <textarea
          aria-label="JSONL 内容"
          rows={5}
          value={jsonlText}
          onChange={(e) => setJsonlText(e.target.value)}
          placeholder={'{"id": "Q-001", "stratum": "A", "problem": "Prove that $x^3 - 9$ is irreducible in $\\\\mathbb{F}_{31}$."}\n{"id": "Q-002", "stratum": "B", "problem": "Find all integers $n \\\\ge 1$ such that $n$ divides $2^n - 1$."}'}
          style={{
            padding: "10px 12px",
            borderRadius: "10px",
            border: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface)",
            color: "var(--color-ink)",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            resize: "vertical",
          }}
        />
      </label>

      {mode === "replays" ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-ink-soft)" }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>允许覆盖同 `run_id` 的既有归档</span>
        </label>
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "9px 12px",
            borderRadius: "10px",
            backgroundColor: "var(--color-state-unsolved-bg)",
            color: "var(--color-state-unsolved)",
            fontSize: "12.5px",
          }}
        >
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {resultMsg ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "9px 12px",
            borderRadius: "10px",
            backgroundColor: "var(--color-surface-sunken)",
            border: "1px solid var(--color-line)",
            color: "var(--color-state-solved, #22c55e)",
            fontSize: "12.5px",
            fontWeight: 600,
          }}
        >
          <CheckCircle2 size={15} />
          <span>{resultMsg}</span>
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" }}>
        <button
          type="submit"
          disabled={submitting}
          className="zygos-btn-primary"
          style={{ padding: "8px 16px", fontSize: "12.5px" }}
        >
          <FileSpreadsheet size={14} />
          <span>{submitting ? "导入校验中…" : "确认导入 JSONL"}</span>
        </button>
      </div>
    </form>
  );
}
