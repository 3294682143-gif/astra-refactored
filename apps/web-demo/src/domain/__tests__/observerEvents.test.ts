/**
 * 真实 Host 观测事件 → 前端消费的回归测试。
 *
 * 复核缺陷：Host 发出 model_dispatched / model_returned / effect_returned，
 * 求解页监听的却是旧的 MODEL_REQUEST / TOOL_OBSERVATION，reducer 也不认识这三个
 * 名字，于是整条真实事件流进入 unknownEvents、状态停在 idle。
 *
 * 这里断言三件事：
 *   1. 三个真实事件名都是「已知事件」，不落 unknownEvents；
 *   2. 折叠真实序列后状态确实在推进（running → 终态），步骤与 toolCalls 有内容；
 *   3. 旧存档（只有 summary 终态、没有 RESULT 事件）也能收口回放。
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  createInitialRunViewState,
  reduceRun,
  type RunEventEnvelope,
  type RunViewState,
} from "../reduceRun.ts";
import { parseTerminalFrame, toTerminalEnvelope } from "../terminalFrame.ts";

function fold(events: readonly RunEventEnvelope[]): RunViewState {
  return events.reduce<RunViewState>(
    (state, ev) => reduceRun(state, ev),
    createInitialRunViewState("live-solve"),
  );
}

const LIVE_SEQUENCE: readonly RunEventEnvelope[] = [
  { seq: 1, kind: "model_dispatched", payload: { requestId: "model-1", phase: "WORK", modelCalls: 1, remainingMs: 9000 } },
  { seq: 2, kind: "effect_returned", payload: { effectId: "effect-1", action: "math_asset", name: "gf2_rank", status: "COMPUTED", source: "PROGRAM_OBSERVATION", checkResult: "UNKNOWN" } },
  { seq: 3, kind: "model_returned", payload: { requestId: "model-1", phase: "WORK", transportStatus: "COMPLETE", modelCalls: 1, remainingMs: 8000 } },
  { seq: 4, kind: "RESULT", payload: { status: "candidate", stopReason: "REVIEWS_COMPLETE", final_response: "rank = 2", candidate_verified: false } },
];

describe("真实 Host 观测事件接入", () => {
  it("三个真实事件名都是已知事件，不再落入 unknownEvents", () => {
    const state = fold(LIVE_SEQUENCE);
    assert.deepStrictEqual(state.unknownEvents, []);
    assert.strictEqual(state.degraded, false);
    assert.strictEqual(state.events.length, LIVE_SEQUENCE.length);
  });

  it("model_dispatched 把状态推进到 running 并登记步骤", () => {
    const state = fold([LIVE_SEQUENCE[0]!]);
    assert.strictEqual(state.status, "running");
    const step = state.steps.find((s) => s.stepId === "model:model-1");
    assert.ok(step, "each dispatched request must appear as a step");
    assert.strictEqual(step!.status, "running");
    assert.match(state.logs.at(-1)!.message, /Model dispatched model-1/);
  });

  it("model_returned 收口对应步骤并保留 transportStatus", () => {
    const state = fold([LIVE_SEQUENCE[0]!, LIVE_SEQUENCE[2]!]);
    const step = state.steps.find((s) => s.stepId === "model:model-1");
    assert.strictEqual(step!.status, "finished");
    assert.strictEqual(step!.detail, "transportStatus=COMPLETE");
    assert.strictEqual(state.status, "running");
  });

  it("非 COMPLETE 返回被记为错误，但仍由真实终态事件决定最终状态", () => {
    const state = fold([
      LIVE_SEQUENCE[0]!,
      { seq: 2, kind: "model_returned", payload: { requestId: "model-1", phase: "WORK", transportStatus: "UNKNOWN", modelCalls: 1, remainingMs: 10 } },
    ]);
    const step = state.steps.find((s) => s.stepId === "model:model-1");
    assert.strictEqual(step!.status, "error");
    assert.ok(state.logs.some((row) => row.level === "error"));
    // 传输未知不自行变成终态：终态只能由真实 RESULT/FINAL 事件给出。
    assert.strictEqual(state.resultSeen, false);
  });

  it("effect_returned 登记真实 effect 观测", () => {
    const state = fold([LIVE_SEQUENCE[1]!]);
    assert.strictEqual(state.toolCalls.length, 1);
    const call = state.toolCalls[0]!;
    assert.strictEqual(call.id, "effect-1");
    assert.strictEqual(call.name, "gf2_rank");
    assert.strictEqual(call.status, "done");
    assert.deepStrictEqual(call.output, {
      status: "COMPUTED",
      source: "PROGRAM_OBSERVATION",
      checkResult: "UNKNOWN",
    });
  });

  it("同一条 effect 重复返回只更新，不重复追加", () => {
    const state = fold([
      LIVE_SEQUENCE[1]!,
      { seq: 3, kind: "effect_returned", payload: { effectId: "effect-1", action: "math_asset", name: "gf2_rank", status: "COMPUTED", source: "PROGRAM_OBSERVATION", checkResult: "FAILED" } },
    ]);
    assert.strictEqual(state.toolCalls.length, 1);
    assert.strictEqual(state.toolCalls[0]!.status, "error");
  });

  it("完整真实序列给出候选与结论文本，且 candidateVerified 恒为 false", () => {
    const state = fold(LIVE_SEQUENCE);
    assert.strictEqual(state.status, "candidate");
    assert.strictEqual(state.resultSeen, true);
    assert.strictEqual(state.candidateProposal, "rank = 2");
    assert.strictEqual(state.finalResponseMissing, false);
    assert.strictEqual(state.candidateVerified, false);
  });

  it("旧存档只有 summary 终态时也能收口回放（复核缺陷 #3）", () => {
    // 复核现场：落盘 candidate + final_response="rank = 2"，事件里没有终态事件。
    const archive = [LIVE_SEQUENCE[0]!, LIVE_SEQUENCE[2]!];
    const before = fold(archive);
    assert.strictEqual(before.resultSeen, false);

    const frame = parseTerminalFrame({
      status: "candidate",
      stopReason: "REVIEWS_COMPLETE",
      terminalKind: "REVIEWS_COMPLETE",
      finalResponse: "rank = 2",
      executed: true,
      code: null,
    });
    assert.ok(frame, "the authoritative summary must be readable as a terminal frame");
    const state = fold([...archive, toTerminalEnvelope(frame!, "run-legacy")]);

    assert.strictEqual(state.status, "candidate");
    assert.strictEqual(state.resultSeen, true);
    assert.strictEqual(state.candidateProposal, "rank = 2");
    assert.strictEqual(state.candidateVerified, false);
  });
});
