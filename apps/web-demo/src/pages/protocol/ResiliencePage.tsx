import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CircleStop, OctagonAlert, TimerReset } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchProtocolSessions,
  type ApiResult,
  type ProtocolSessionsResponse,
} from "@/api/client.ts";

/**
 * 取消 / 恢复韧性演示页。
 *
 * 诚实边界：
 *  - 三场景的「判定链实证」来自真实协议日志（CANCEL_DECISION / RECOVERY_409_CHECK），
 *    无日志时明示「尚未产生实证记录」，不编造判定结果；
 *  - 场景 A 的即时交互走 /api/atria/chat 产品通道，停止语义为「本地中止 + 远端未知」；
 *  - 场景 B/C 的故障注入需要服务端 ASTRA_PROTOCOL_SOURCE=mock 与桥接子进程配合，
 *    本页只呈现已产生的判定链证据并给出操作指引。
 */

interface ScenarioCard {
  readonly key: string;
  readonly title: string;
  readonly icon: typeof CircleStop;
  readonly principle: string;
  readonly evidenceKind: "CANCEL_DECISION" | "RECOVERY_409_CHECK" | "RPM_GUARD";
  readonly howto: string;
}

const SCENARIOS: readonly ScenarioCard[] = [
  {
    key: "cancel",
    title: "场景 A · 中途取消",
    icon: CircleStop,
    principle:
      "cancelInferenceDecision 只落实已确认语义：身份不符抛 CancelProtocolError；活跃流未 drain 返回 drain_unconfirmed；本地 AbortController 中止返回 aborted_or_closed——本地 abort ≠ 服务端停止。",
    evidenceKind: "CANCEL_DECISION",
    howto: "在「产品对话」页发送并点击「停止生成」，或在桥接通道对运行中的子进程发 SIGTERM。",
  },
  {
    key: "conflict",
    title: "场景 B · 409 冲突恢复",
    icon: OctagonAlert,
    principle:
      "inferenceConflictCode 识别 409001/TURN_CONFLICT 与 409005/INFERENCE_ALREADY_RUNNING(retryable)；canRecoverInferenceConflict 要求 5s 证明窗内的 drain proof 且 requestId 不同；shouldRetryInferenceConflict 仅允许 attempt 0 重试一次。",
    evidenceKind: "RECOVERY_409_CHECK",
    howto: "对 mock-gateway 发起 POST /api/orbit/v1/local-agent/messages?fault=409001（或 409005），经桥接器观察判定链落盘。",
  },
  {
    key: "ratelimit",
    title: "场景 C · 429 节流与预算守卫",
    icon: TimerReset,
    principle:
      "AtriaDawnClient._dispatch_with_rpm_guard 读取 Retry-After，等待时间耗尽剩余预算时拒绝重试而非挂死；取消句柄在等待期内仍可打断。",
    evidenceKind: "RPM_GUARD",
    howto: "对 mock-gateway 发起 ?fault=429 请求，或在直连通道触发账户 60 RPM 上限观察 Retry-After 等待。",
  },
];

export function ResiliencePage() {
  const [sessions, setSessions] = useState<ApiResult<ProtocolSessionsResponse> | null>(null);

  useEffect(() => {
    let alive = true;
    fetchProtocolSessions().then((res) => {
      if (alive) setSessions(res);
    });
    return () => {
      alive = false;
    };
  }, []);

  const hasSessions = sessions !== null && sessions.ok && sessions.data.sessions.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <section
        style={{
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "18px 22px",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          取消 / 恢复韧性演示
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
          全部判定链来自 inkstone-re-lab 的 cancel.mjs / recovery.mjs 纯函数与 atria_client.py 的 429 守卫，
          证据落盘为协议日志（ASTRA_DATA_ROOT/protocol/*.jsonl）。本页只呈现真实产生的记录。
        </p>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "16px" }}>
        {SCENARIOS.map(({ key, title, icon: Icon, principle, evidenceKind, howto }) => (
          <article
            key={key}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              borderRadius: "12px",
              border: "1px solid var(--color-line)",
              backgroundColor: "var(--color-surface)",
              padding: "18px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Icon size={18} color="var(--color-brand)" />
              <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>{title}</h2>
            </div>
            <p style={{ margin: 0, flex: 1, fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.8 }}>
              {principle}
            </p>
            <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
              <strong>操作指引</strong>：{howto}
            </div>
            <div
              style={{
                borderRadius: "8px",
                border: "1px dashed var(--color-line-strong)",
                padding: "8px 12px",
                fontSize: "12px",
                color: "var(--color-ink-mute)",
              }}
            >
              证据标记：{evidenceKind} →{" "}
              <Link to="/protocol" style={{ color: "var(--color-brand)" }}>
                到协议观测台查看
              </Link>
            </div>
          </article>
        ))}
      </section>

      {!hasSessions && (
        <PanelEmptyState
          title="尚无判定链实证记录"
          description={
            sessions === null
              ? "正在探测协议会话…"
              : sessions.ok
                ? "按场景卡片指引产生 CANCEL_DECISION / RECOVERY_409_CHECK 记录后，可在协议观测台逐帧审计。"
                : `协议会话接口不可达：${sessions.error.message}`
          }
        />
      )}
    </div>
  );
}
