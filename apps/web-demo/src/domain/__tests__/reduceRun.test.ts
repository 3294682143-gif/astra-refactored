import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reduceRun,
  reduceRunAll,
  createInitialRunViewState,
  type RunEventEnvelope,
} from "../reduceRun.ts";
import { PlaybackController } from "../playback.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("reduceRun 纯函数与核心契约", () => {
  it("初始状态满足红线约束：candidateVerified 恒为 false", () => {
    const state = createInitialRunViewState("test-run");
    assert.strictEqual(state.runId, "test-run");
    assert.strictEqual(state.status, "idle");
    assert.strictEqual(state.candidateVerified, false);
    assert.strictEqual(state.events.length, 0);
  });

  it("接收 FINAL/RESULT 事件后，candidateVerified 仍严格为 false", () => {
    const s0 = createInitialRunViewState("test-run");
    const ev1: RunEventEnvelope = {
      seq: 1,
      kind: "SESSION_INIT",
      payload: { sessionId: "sess-01" },
    };
    const ev2: RunEventEnvelope = {
      seq: 2,
      kind: "FINAL",
      payload: {
        stopReason: "REVIEWS_COMPLETE",
        answer: "x = 42",
      },
    };

    const s1 = reduceRun(s0, ev1);
    const s2 = reduceRun(s1, ev2);

    assert.strictEqual(s2.status, "candidate");
    assert.strictEqual(s2.stopReason, "REVIEWS_COMPLETE");
    assert.strictEqual(s2.candidateProposal, "x = 42");
    assert.strictEqual(s2.resultSeen, true);
    // 红线铁律断言：绝不允许标为已验证！
    assert.strictEqual(s2.candidateVerified, false);
  });

  it("幂等性：同 seq 同 payload 自动去重并返回相同引用", () => {
    const s0 = createInitialRunViewState("test-run");
    const ev: RunEventEnvelope = {
      seq: 1,
      kind: "TASK_STARTED",
      payload: { taskId: "T1", goalId: "G1" },
    };

    const s1 = reduceRun(s0, ev);
    const s2 = reduceRun(s1, ev);

    assert.strictEqual(s1, s2, "相同事件再次归约应返回相同对象引用（幂等）");
    assert.strictEqual(s1.events.length, 1);
  });

  it("冲突检测：同 seq 不同 payload 记录 conflict 且不破坏原事件", () => {
    const s0 = createInitialRunViewState("test-run");
    const evA: RunEventEnvelope = {
      seq: 5,
      kind: "WORKUNIT",
      payload: { taskId: "T1", deliveryStatus: "COMPLETE" },
    };
    const evB: RunEventEnvelope = {
      seq: 5,
      kind: "WORKUNIT",
      payload: { taskId: "T1", deliveryStatus: "INCOMPLETE" },
    };

    const s1 = reduceRun(s0, evA);
    const s2 = reduceRun(s1, evB);

    assert.strictEqual(s2.conflicts.length, 1);
    assert.strictEqual(s2.conflicts[0].seq, 5);
    assert.strictEqual(s2.conflicts[0].reason, "seq-conflict");
    assert.strictEqual(s2.events.length, 1);
    assert.strictEqual(s2.tasks["T1"]?.status, "COMPLETE");
  });

  it("乱序容错：乱序到达的事件按 seq 自动升序排列", () => {
    const s0 = createInitialRunViewState("test-run");
    const ev3: RunEventEnvelope = { seq: 3, kind: "log", payload: "step 3" };
    const ev1: RunEventEnvelope = { seq: 1, kind: "log", payload: "step 1" };
    const ev2: RunEventEnvelope = { seq: 2, kind: "log", payload: "step 2" };

    const s1 = reduceRun(s0, ev3);
    const s2 = reduceRun(s1, ev1);
    const s3 = reduceRun(s2, ev2);

    assert.strictEqual(s3.events.length, 3);
    assert.deepStrictEqual(
      s3.events.map((e) => e.seq),
      [1, 2, 3]
    );
  });

  it("未知事件安全隔离并标记 degraded 与 capabilityGaps", () => {
    const s0 = createInitialRunViewState("test-run");
    const unknownEv: RunEventEnvelope = {
      seq: 99,
      kind: "UNKNOWN_QUANTUM_GATE_FLIP",
      payload: { qbit: 4 },
    };

    const s1 = reduceRun(s0, unknownEv);
    assert.strictEqual(s1.degraded, true);
    assert.strictEqual(s1.unknownEvents.length, 1);
    assert.strictEqual(s1.unknownEvents[0].kind, "UNKNOWN_QUANTUM_GATE_FLIP");
    assert.ok(s1.capabilityGaps.includes("unknown-event:UNKNOWN_QUANTUM_GATE_FLIP"));
  });

  it("逐条归约结果严格等价于批量归约结果 (reduceRun vs reduceRunAll)", () => {
    const events: RunEventEnvelope[] = [
      { seq: 1, kind: "SESSION_INIT", payload: { sessionId: "batch-sess" } },
      { seq: 2, kind: "CONTRACT", payload: { contractVersion: 1, tasks: 2, obligations: 2 } },
      { seq: 3, kind: "TASK_STARTED", payload: { taskId: "T1", goalId: "Prove theorem" } },
      { seq: 4, kind: "WORKUNIT", payload: { taskId: "T1", deliveryStatus: "COMPLETE", candidateProposal: "n=4" } },
      { seq: 5, kind: "FINAL", payload: { stopReason: "REVIEWS_COMPLETE", answer: "n=4" } },
    ];

    const sInitial = createInitialRunViewState("test-run");
    const stepwise = events.reduce(reduceRun, sInitial);
    const batch = reduceRunAll(sInitial, events);

    assert.strictEqual(stepwise.status, batch.status);
    assert.strictEqual(stepwise.candidateProposal, batch.candidateProposal);
    assert.strictEqual(stepwise.candidateVerified, false);
    assert.strictEqual(batch.candidateVerified, false);
    assert.strictEqual(stepwise.events.length, batch.events.length);
  });
});

describe("PlaybackController 回放时钟与快照一致性", () => {
  it("支持加载事件流并自动就绪末帧", () => {
    const ctrl = new PlaybackController({ initialRunId: "ctrl-run", snapshotInterval: 5 });
    const events: RunEventEnvelope[] = Array.from({ length: 25 }, (_, i) => ({
      seq: i + 1,
      kind: "log",
      payload: `Message ${i + 1}`,
    }));

    ctrl.loadEvents(events);
    assert.strictEqual(ctrl.totalEvents, 25);
    assert.strictEqual(ctrl.currentIndex, 24);
    assert.strictEqual(ctrl.currentSeq, 25);
    assert.strictEqual(ctrl.state.candidateVerified, false);
  });

  it("单步后退、单步前进与任意游标跳转", () => {
    const ctrl = new PlaybackController({ initialRunId: "ctrl-run", snapshotInterval: 5 });
    const events: RunEventEnvelope[] = Array.from({ length: 10 }, (_, i) => ({
      seq: i + 1,
      kind: "log",
      payload: `Seq-${i + 1}`,
    }));
    ctrl.loadEvents(events);

    // 跳转到第 4 条 (index 3, seq 4)
    ctrl.jumpToIndex(3);
    assert.strictEqual(ctrl.currentIndex, 3);
    assert.strictEqual(ctrl.currentSeq, 4);

    // 单步前进
    ctrl.stepForward();
    assert.strictEqual(ctrl.currentIndex, 4);
    assert.strictEqual(ctrl.currentSeq, 5);

    // 单步后退
    ctrl.stepBackward();
    assert.strictEqual(ctrl.currentIndex, 3);
    assert.strictEqual(ctrl.currentSeq, 4);

    // 按 seq 跳转
    ctrl.jumpToSeq(8);
    assert.strictEqual(ctrl.currentIndex, 7);
    assert.strictEqual(ctrl.currentSeq, 8);
  });

  it("新事件到达时，历史游标保持不变（不强跳末帧）", () => {
    const ctrl = new PlaybackController({ initialRunId: "ctrl-run" });
    const initialEvents: RunEventEnvelope[] = Array.from({ length: 5 }, (_, i) => ({
      seq: i + 1,
      kind: "log",
      payload: `Init-${i + 1}`,
    }));
    ctrl.loadEvents(initialEvents);

    // 用户停留在第 2 帧 (index 1)
    ctrl.jumpToIndex(1);
    assert.strictEqual(ctrl.currentIndex, 1);

    // 此时后台收到第 6 条新事件
    ctrl.addEvent({ seq: 6, kind: "log", payload: "New event 6" });

    // 核心断言：当前游标保持在 1，不被强制推到 5！
    assert.strictEqual(ctrl.currentIndex, 1);
    assert.strictEqual(ctrl.totalEvents, 6);
  });

  it("快照恢复状态与从头完整归约状态完全等价", () => {
    const ctrl = new PlaybackController({ initialRunId: "snap-run", snapshotInterval: 4 });
    const events: RunEventEnvelope[] = Array.from({ length: 15 }, (_, i) => ({
      seq: i + 1,
      kind: "step.started",
      payload: { stepId: `s-${i + 1}`, name: `Step ${i + 1}` },
    }));
    ctrl.loadEvents(events);

    // 遍历每一个索引，断言快照增量计算结果与全量折叠结果一致
    for (let idx = 0; idx < events.length; idx++) {
      ctrl.jumpToIndex(idx);
      const stepwiseState = events.slice(0, idx + 1).reduce(reduceRun, createInitialRunViewState("snap-run"));
      assert.strictEqual(ctrl.state.lastSeq, stepwiseState.lastSeq);
      assert.strictEqual(ctrl.state.steps.length, stepwiseState.steps.length);
      assert.strictEqual(ctrl.state.candidateVerified, false);
    }
  });
});

describe("实测验证：Astra 真实 session-sample.json 回放", () => {
  it("回放 11 条真实 Astra 事件日志，达到 candidate 终态且验证标记为 false", () => {
    const samplePath = resolve(__dirname, "../../../fixtures/session-sample.json");
    const rawContent = readFileSync(samplePath, "utf-8");
    const sessionLog = JSON.parse(rawContent);

    assert.strictEqual(sessionLog.schemaVersion, "session-log-v1");
    assert.strictEqual(sessionLog.events.length, 11);

    const ctrl = new PlaybackController({ initialRunId: "demo-session" });
    ctrl.loadEvents(sessionLog.events);

    assert.strictEqual(ctrl.totalEvents, 11);
    const finalState = ctrl.state;

    // 终态验证
    assert.strictEqual(finalState.status, "candidate");
    assert.strictEqual(finalState.stopReason, "REVIEWS_COMPLETE");
    assert.strictEqual(finalState.candidateProposal, "4");
    assert.strictEqual(finalState.candidateVerified, false); // 严格红线
    assert.strictEqual(finalState.degraded, false);
    assert.strictEqual(finalState.conflicts.length, 0);
  });
});
