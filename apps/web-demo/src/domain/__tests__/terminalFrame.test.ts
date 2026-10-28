/**
 * 回归护栏（t5）：SSE 关闭帧终态解析与数据级别判定。
 *
 * 断言：
 *   - 后端关闭帧（executed=false / SOLVER_NOT_CONFIGURED / Unsolved.）必须被解析为真实终态，
 *     经归约后落到 error，绝不落成 candidate，也不把 "Unsolved." 当成候选答案；
 *   - detail_level 权威优先，取不到才回退 l2_path/l3_path，记录缺失为 UNKNOWN；
 *   - 幂等键对同题同配置稳定、对不同输入不同。
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  parseTerminalFrame,
  toTerminalEnvelope,
  stableIdempotencyKey,
  TERMINAL_FRAME_SEQ_BASE,
} from "../terminalFrame.ts";
import { reduceRun, createInitialRunViewState } from "../reduceRun.ts";
import { resolveTraceLevel } from "../../api/client.ts";

const CLOSE_FRAME =
  '{"status": "error", "stopReason": "ERROR", "terminalKind": "system_failure", "final_response": "Unsolved.", "executed": false, "code": "SOLVER_NOT_CONFIGURED"}';

describe("SSE 关闭帧终态解析（V2 护栏）", () => {
  it("解析后端真实关闭帧的全部终态字段", () => {
    const frame = parseTerminalFrame(CLOSE_FRAME);
    assert.ok(frame, "应能解析关闭帧");
    assert.strictEqual(frame.status, "error");
    assert.strictEqual(frame.stopReason, "ERROR");
    assert.strictEqual(frame.terminalKind, "system_failure");
    assert.strictEqual(frame.finalResponse, "Unsolved.");
    assert.strictEqual(frame.executed, false);
    assert.strictEqual(frame.code, "SOLVER_NOT_CONFIGURED");
  });

  it("非法 JSON / 空对象 / 非对象一律返回 null（不凭空造终态）", () => {
    assert.strictEqual(parseTerminalFrame("not-json"), null);
    assert.strictEqual(parseTerminalFrame("{}"), null);
    assert.strictEqual(parseTerminalFrame(""), null);
    assert.strictEqual(parseTerminalFrame("null"), null);
    assert.strictEqual(parseTerminalFrame("[]"), null);
    assert.strictEqual(parseTerminalFrame(42), null);
  });

  it("关闭帧经归约后落到 error 终态，绝不显示为 candidate", () => {
    const frame = parseTerminalFrame(CLOSE_FRAME);
    assert.ok(frame);
    const s = reduceRun(
      createInitialRunViewState("run-x"),
      toTerminalEnvelope(frame, "run-x"),
    );
    assert.strictEqual(s.status, "error");
    assert.notStrictEqual(s.status, "candidate");
    assert.strictEqual(s.stopReason, "ERROR");
    assert.strictEqual(s.resultSeen, true);
    assert.strictEqual(s.finalResponseMissing, false);
    assert.strictEqual(s.candidateVerified, false);
  });

  it("终态信封使用固定序号基址并保留字段名映射", () => {
    const frame = parseTerminalFrame(CLOSE_FRAME);
    assert.ok(frame);
    const env = toTerminalEnvelope(frame, "run-x");
    assert.strictEqual(env.kind, "FINAL");
    assert.strictEqual(env.seq, TERMINAL_FRAME_SEQ_BASE);
    assert.strictEqual(env.runId, "run-x");
    const payload = env.payload as Record<string, unknown>;
    assert.strictEqual(payload["stopReason"], "ERROR");
    assert.strictEqual(payload["executed"], false);
    assert.strictEqual(payload["code"], "SOLVER_NOT_CONFIGURED");
  });

  it("未执行态（executed=false）的 final_response 仍可读但不构成候选", () => {
    const frame = parseTerminalFrame(CLOSE_FRAME);
    assert.ok(frame);
    const s = reduceRun(createInitialRunViewState("run-x"), toTerminalEnvelope(frame, "run-x"));
    assert.strictEqual(s.candidateProposal, "Unsolved.");
    assert.strictEqual(s.candidateVerified, false);
  });
});

describe("数据级别判定（detail_level 权威优先）", () => {
  it("detail_level 权威值优先于存档路径推导", () => {
    assert.strictEqual(resolveTraceLevel({ detail_level: "L1", l2_path: "runs/a.json", l3_path: "x" }), "L1");
    assert.strictEqual(resolveTraceLevel({ detail_level: "L2" }), "L2");
    assert.strictEqual(resolveTraceLevel({ detail_level: "l3" }), "L3");
  });

  it("detail_level 缺失或非法时才回退到真实存档路径", () => {
    assert.strictEqual(resolveTraceLevel({ l3_path: "runs/a/asset.bin" }), "L3");
    assert.strictEqual(resolveTraceLevel({ l2_path: "runs/a/details.json" }), "L2");
    assert.strictEqual(resolveTraceLevel({ detail_level: "L9", l2_path: "runs/a/details.json" }), "L2");
    assert.strictEqual(resolveTraceLevel({ detail_level: "L9" }), "L1");
    assert.strictEqual(resolveTraceLevel({}), "L1");
  });

  it("记录不存在时为 UNKNOWN，不冒充 L2 / L3", () => {
    assert.strictEqual(resolveTraceLevel(null), "UNKNOWN");
    assert.strictEqual(resolveTraceLevel(undefined), "UNKNOWN");
  });

  it("真实无存档的运行（detail_level=L1、无 l2/l3）判为 L1", () => {
    assert.strictEqual(resolveTraceLevel({ detail_level: "L1", l2_path: null, l3_path: null }), "L1");
  });
});

describe("幂等键稳定性（④ 护栏）", () => {
  it("同题同配置产生相同键（可触发后端 200 重放）", () => {
    assert.strictEqual(
      stableIdempotencyKey("p", 24, 1),
      stableIdempotencyKey("p", 24, 1),
    );
  });

  it("题目或配置不同则键不同", () => {
    assert.notStrictEqual(stableIdempotencyKey("p", 24, 1), stableIdempotencyKey("q", 24, 1));
    assert.notStrictEqual(stableIdempotencyKey("p", 24, 1), stableIdempotencyKey("p", 8, 1));
    assert.notStrictEqual(stableIdempotencyKey("p", 24, 1), stableIdempotencyKey("p", 24, 0));
    assert.notStrictEqual(
      stableIdempotencyKey("p", 24, 1, 0),
      stableIdempotencyKey("p", 24, 1, 1),
    );
    assert.notStrictEqual(
      stableIdempotencyKey("p", 256, 2, 1, "full"),
      stableIdempotencyKey("p", 256, 2, 1, "custom"),
    );
  });

  it("键为 ASCII 安全（可直接作为 HTTP 头值）", () => {
    const key = stableIdempotencyKey("设 P(x) 为整系数多项式 证明", 48, 0);
    assert.match(key, /^solve-[0-9a-f]{16}$/);
  });
});