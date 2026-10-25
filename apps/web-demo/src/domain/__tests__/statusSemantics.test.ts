/**
 * 回归护栏：终态语义与 final_response 诚实性。
 *
 * 断言（对应 t2 验收项 [3][4][5]）：
 *   - timeout / 启动失败 / cancelled / error 与 candidate 必须彼此可区分；
 *   - 记录未声明终态时不得伪造 candidate；
 *   - final_response 缺失时必须显式标记，不得填充结论文本；
 *   - candidateVerified 恒为 false。
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  reduceRun,
  createInitialRunViewState,
  classifyRunStatus,
  type RunEventEnvelope,
} from "../reduceRun.ts";

function fold(events: readonly RunEventEnvelope[]) {
  return events.reduce(reduceRun, createInitialRunViewState("guard-run"));
}

describe("终态语义分类（与 candidate 严格可区分）", () => {
  it("REVIEWS_COMPLETE 才归为 candidate 交付", () => {
    assert.strictEqual(classifyRunStatus("REVIEWS_COMPLETE"), "candidate");
  });

  it("超时类终止码归为 timeout", () => {
    assert.strictEqual(classifyRunStatus("TIMEOUT"), "timeout");
    assert.strictEqual(classifyRunStatus("DEADLINE_EXCEEDED"), "timeout");
  });

  it("运行时启动 / 子进程失败归为 failed", () => {
    assert.strictEqual(classifyRunStatus("SPAWN_FAILED"), "failed");
    assert.strictEqual(classifyRunStatus("CHILD_FAILED"), "failed");
  });

  it("取消归为 cancelled", () => {
    assert.strictEqual(classifyRunStatus("CANCELLED"), "cancelled");
  });

  it("传输与字段校验故障归为 error", () => {
    assert.strictEqual(classifyRunStatus("TRANSPORT_STOP"), "error");
    assert.strictEqual(classifyRunStatus("FIELD_VALUE"), "error");
    assert.strictEqual(classifyRunStatus("ERROR"), "error");
  });

  it("数学未解与预算耗尽归为 unsolved（不得显示为 candidate）", () => {
    assert.strictEqual(classifyRunStatus("NO_CANDIDATE"), "unsolved");
    assert.strictEqual(classifyRunStatus("REVISE_REJECTED"), "unsolved");
    assert.strictEqual(classifyRunStatus("BUDGET_EXHAUSTED"), "unsolved");
  });

  it("未注册终止码与缺失终止码归为 unknown（不回落 candidate）", () => {
    assert.strictEqual(classifyRunStatus("SOMETHING_NEW"), "unknown");
    assert.strictEqual(classifyRunStatus(null), "unknown");
    assert.strictEqual(classifyRunStatus(""), "unknown");
  });

  it("FINAL 事件携带 TIMEOUT 时不产生 candidate 终态", () => {
    const s = fold([
      { seq: 1, kind: "SESSION_INIT", payload: { sessionId: "s-1" } },
      { seq: 2, kind: "FINAL", payload: { stopReason: "TIMEOUT", final_response: "" } },
    ]);
    assert.strictEqual(s.status, "timeout");
    assert.notStrictEqual(s.status, "candidate");
    assert.strictEqual(s.resultSeen, true);
    assert.strictEqual(s.candidateVerified, false);
  });

  it("run.finished 不冲淡已判定的失败 / 超时终态", () => {
    const s = fold([
      { seq: 1, kind: "FINAL", payload: { stopReason: "SPAWN_FAILED" } },
      { seq: 2, kind: "run.finished", payload: {} },
    ]);
    assert.strictEqual(s.status, "failed");
    assert.strictEqual(s.candidateVerified, false);
  });
});

describe("final_response 诚实性", () => {
  it("携带 final_response 时如实记录，且不声称形式化确认", () => {
    const s = fold([
      { seq: 1, kind: "FINAL", payload: { stopReason: "REVIEWS_COMPLETE", final_response: "x = 3" } },
    ]);
    assert.strictEqual(s.finalResponseMissing, false);
    assert.strictEqual(s.candidateProposal, "x = 3");
    assert.strictEqual(s.candidateVerified, false);
  });

  it("缺失 final_response 时标记缺失，不填充结论文本", () => {
    const s = fold([
      { seq: 1, kind: "FINAL", payload: { stopReason: "REVIEWS_COMPLETE" } },
    ]);
    assert.strictEqual(s.finalResponseMissing, true);
    assert.strictEqual(s.candidateProposal, null);
  });

  it("空白 final_response 视为缺失（不把空格当结论）", () => {
    const s = fold([
      { seq: 1, kind: "FINAL", payload: { stopReason: "REVIEWS_COMPLETE", final_response: "   " } },
    ]);
    assert.strictEqual(s.finalResponseMissing, true);
  });

  it("无 stopReason 且无声明 status 的 FINAL：终态为 unknown 而非 candidate", () => {
    const s = fold([{ seq: 1, kind: "FINAL", payload: { final_response: "4" } }]);
    assert.strictEqual(s.status, "unknown");
    assert.strictEqual(s.stopReason, null);
    assert.strictEqual(s.candidateVerified, false);
  });

  it("真实 Astra 信封（只有 status 字段）按其声明还原为候选终态", () => {
    const s = fold([
      {
        seq: 1,
        kind: "FINAL",
        payload: { status: "candidate", reason: "BEST_EFFORT_CANDIDATE", finalResponse: "4", candidateVerified: false },
      },
    ]);
    assert.strictEqual(s.status, "candidate");
    assert.strictEqual(s.finalResponseMissing, false);
    assert.strictEqual(s.candidateProposal, "4");
    assert.strictEqual(s.candidateVerified, false);
  });
});