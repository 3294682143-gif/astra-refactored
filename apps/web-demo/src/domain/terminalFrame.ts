/**
 * SSE 关闭帧终态解析（纯函数，可离线单测）。
 *
 * 背景：当前 BFF 在运行终态时只发一帧 `event: close`，其 data 即该运行的真实终态事实
 * （如 {"status":"error","stopReason":"ERROR","terminalKind":"system_failure",
 *      "final_response":"Unsolved.","executed":false,"code":"SOLVER_NOT_CONFIGURED"}）。
 * 前端必须据此呈现显式未执行态，而不是回落成中性占位或「结果未知」。
 */

import type { RunEventEnvelope } from "./reduceRun.ts";

/** 后端关闭帧携带的终态事实；未提供的字段一律为 null，绝不推测。 */
export interface TerminalFrame {
  readonly status: string | null;
  readonly stopReason: string | null;
  readonly terminalKind: string | null;
  readonly finalResponse: string | null;
  readonly executed: boolean | null;
  readonly code: string | null;
}

/** 终态信封使用的固定序号基址：避开真实事件 seq，避免与业务事件冲突。 */
export const TERMINAL_FRAME_SEQ_BASE = 10_000_000;

/**
 * 解析 SSE close 帧的 data。非对象、非法 JSON、空对象或全无终态字段时返回 null
 * （宁可显示「未知」也不凭空造出一个终态）。
 */
export function parseTerminalFrame(raw: unknown): TerminalFrame | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const o = value as Record<string, unknown>;
  const frame: TerminalFrame = {
    status: typeof o["status"] === "string" ? o["status"] : null,
    stopReason: typeof o["stopReason"] === "string" ? o["stopReason"] : null,
    terminalKind: typeof o["terminalKind"] === "string" ? o["terminalKind"] : null,
    finalResponse:
      typeof o["final_response"] === "string"
        ? o["final_response"]
        : typeof o["finalResponse"] === "string"
          ? o["finalResponse"]
          : null,
    executed: typeof o["executed"] === "boolean" ? o["executed"] : null,
    code: typeof o["code"] === "string" ? o["code"] : null,
  };

  const hasAnyFact =
    frame.status !== null ||
    frame.stopReason !== null ||
    frame.terminalKind !== null ||
    frame.finalResponse !== null ||
    frame.executed !== null ||
    frame.code !== null;
  return hasAnyFact ? frame : null;
}

/**
 * 把关闭帧的终态事实映射为一条 FINAL 信封交给纯归约器。
 * 承载的是后端自述的真实终态（字段改名 + 时间线登记），不新增任何未声明的结论。
 */
export function toTerminalEnvelope(frame: TerminalFrame, runId?: string): RunEventEnvelope {
  const payload: Record<string, unknown> = {};
  if (frame.stopReason !== null) payload["stopReason"] = frame.stopReason;
  if (frame.status !== null) payload["status"] = frame.status;
  if (frame.finalResponse !== null) payload["final_response"] = frame.finalResponse;
  if (frame.executed !== null) payload["executed"] = frame.executed;
  if (frame.code !== null) payload["code"] = frame.code;
  if (frame.terminalKind !== null) payload["terminalKind"] = frame.terminalKind;
  return {
    seq: TERMINAL_FRAME_SEQ_BASE,
    kind: "FINAL",
    payload,
    ...(runId ? { runId } : {}),
  };
}

/** 该终态是否明确「未执行任何求解」（executed === false）。 */
export function isNotExecuted(frame: TerminalFrame | null): boolean {
  return frame?.executed === false;
}

/**
 * 由「题目 + 预算配置」生成稳定的幂等键（FNV-1a 双通道，ASCII 头安全）。
 * 同题同配置重复提交 → 后端 HTTP 200 + idempotent_replay=true，不新起执行。
 */
export function stableIdempotencyKey(
  problem: string,
  maxModelCalls: number,
  maxMethodLoads: 0 | 1,
): string {
  const bytes = new TextEncoder().encode(`${problem}\u0000${maxModelCalls}\u0000${maxMethodLoads}`);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + b, 0x85ebca6b) >>> 0;
  }
  return `solve-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}