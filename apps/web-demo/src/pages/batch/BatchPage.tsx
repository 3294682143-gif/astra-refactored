import { useEffect, useState } from "react";
import { Layers, RefreshCw, Upload } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import { StatusBadge, normalizeStatusKind } from "@/components/StatusBadge";
import { fetchRuns, type ApiResult, type RunSummaryItem, type RunsResponse } from "@/api/client.ts";
import { describeStopReason } from "@/domain/stopReasonView.ts";

const UNKNOWN = "未知";

interface StatCard {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
}

function countBy(items: readonly RunSummaryItem[], kinds: readonly string[]): number {
  return items.filter((run) => kinds.includes(normalizeStatusKind(run.status))).length;
}

export function BatchPage() {
  const [result, setResult] = useState<ApiResult<RunsResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setResult(null);
    fetchRuns(200, 0).then((res) => {
      if (alive) setResult(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const items = result && result.ok ? result.data.items : [];

  const stats: StatCard[] =
    result && result.ok
      ? [
          {
            label: "本地运行索引记录数",
            value: String(items.length),
            caption: "口径：GET /api/runs 返回条数（非基准评测题集）",
          },
          {
            label: "候选交付数（未验证）",
            value: String(countBy(items, ["candidate"])),
            caption: "口径：stopReason 属于正常交付类；候选恒为未经形式化验证",
          },
          {
            label: "未解数",
            value: String(countBy(items, ["unsolved"])),
            caption: "口径：无候选 / 修复未过门控 / 预算与迭代上限",
          },
          {
            label: "失败或取消数",
            value: String(countBy(items, ["error", "timeout", "failed", "cancelled", "aborted"])),
            caption: "口径：超时 / 启动或子进程失败 / 取消 / 传输错误，与候选严格区分",
          },
        ]
      : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "16px" }}>
        <div>
          <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            批量评测与盲跑看板
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
            本页仅呈现 BFF 真实接口可取到的数据；接口未提供的基准评测指标一律显示「未知」。
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="未实现：BFF 当前未提供评测批次导入接口（无 POST /api/batches）"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              borderRadius: "8px",
              border: "1px dashed var(--color-line-strong)",
              backgroundColor: "var(--color-surface-sunken)",
              color: "var(--color-ink-mute)",
              padding: "8px 16px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "not-allowed",
            }}
          >
            <Upload size={14} />
            <span>导入评测批次 (JSONL)</span>
          </button>
          <span style={{ fontSize: "11px", color: "#b45309" }}>
            未实现：无对应接口（已显式禁用，不做假导入）
          </span>
        </div>
      </div>

      {result === null ? (
        <div style={{ padding: "30px", textAlign: "center", color: "var(--color-ink-soft)" }}>
          正在加载运行索引...
        </div>
      ) : !result.ok ? (
        <PanelEmptyState
          variant="missing"
          title="运行索引加载失败（真实错误态）"
          description={`${result.error.message}（接口：${result.error.url}）`}
          hint="未以演示数据顶替。请确认 Python BFF 已启动后重试。"
          action={
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "8px",
                border: "1px solid var(--color-brand)",
                backgroundColor: "var(--color-brand-tint)",
                color: "var(--color-brand-deep)",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              <span>重新加载</span>
            </button>
          }
        />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
            {stats.map((card) => (
              <div key={card.label} style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>{card.label}</div>
                <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-brand-deep)", marginTop: "4px" }}>{card.value}</div>
                <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", marginTop: "4px" }}>{card.caption}</div>
              </div>
            ))}
          </div>

          <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "6px" }}>
              接口未提供的评测指标（显式未知）
            </div>
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
              <li>
                导入评测题目数 / 子领域覆盖：{UNKNOWN} —— BFF 无评测题集接口（无 <code>/api/benchmarks</code>）。
              </li>
              <li>
                候选答案形成率、盲跑稳定性极差、子进程零悬挂率：{UNKNOWN} —— 无可信接口，禁止以历史静态数字冒充当前成绩。
              </li>
              <li>判分器版本与评测协议：{UNKNOWN} —— 无接口提供。</li>
            </ul>
          </div>

          <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", overflow: "hidden" }}>
            <div style={{ display: "flex", backgroundColor: "var(--color-surface-sunken)", padding: "12px 18px", fontSize: "13px", fontWeight: 600 }}>
              <span style={{ width: "200px" }}>运行 ID</span>
              <span style={{ width: "170px" }}>状态</span>
              <span style={{ flex: 1 }}>场景</span>
              <span style={{ width: "220px" }}>终止原因</span>
            </div>
            {items.length === 0 ? (
              <div style={{ padding: "16px 18px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                接口返回 0 条运行记录（真实响应，非加载失败）。
              </div>
            ) : (
              items.map((run) => {
                const stopInfo = describeStopReason(
                  typeof run.summary?.["stopReason"] === "string"
                    ? (run.summary["stopReason"] as string)
                    : null,
                );
                return (
                  <div key={run.run_id} style={{ display: "flex", padding: "12px 18px", fontSize: "13px", borderTop: "1px solid var(--color-line)", alignItems: "center" }}>
                    <span style={{ width: "200px", fontFamily: "var(--font-mono)" }}>{run.run_id}</span>
                    <span style={{ width: "170px" }}>
                      <StatusBadge status={normalizeStatusKind(run.status)} size="sm" />
                    </span>
                    <span style={{ flex: 1, fontWeight: 500 }}>{run.scenario || "（场景未记录）"}</span>
                    <span style={{ width: "220px", fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                      {stopInfo.code}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
        <Layers size={12} />
        <span>本页所有数字均来自 GET /api/runs 实时响应；无接口支撑的指标不会显示为具体数值。</span>
      </div>
    </div>
  );
}