import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  P2Error,
  type P3EffectPort,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import {
  P3EffectGate,
  parseP3Action,
  p3EffectFailure,
  p3EffectKey,
  p3EffectReceipt,
} from "@astra/math-gateway";
import { prepareP3Context } from "@astra/math-workunit";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { runP3Fixture, type P3FixtureReceipt } from "../src/p3-fixture.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const PROBLEM = "Solve the linear system x+y=3, x-y=1 and expand (x+1)**2.";
const SESSION = "sess-p3-fixture";
const TOOL = "polynomial_expand_coefficients";
const LINEAR = "linear_system_solution_set";

let calls = 0;

function realPyPort(): P3EffectPort {
  return {
    execute(request: P3EffectRequest): P3EffectReceipt {
      calls += 1;
      const proc = spawnSync(
        "python",
        ["-m", "python.astra_bridge.p3_effects"],
        {
          cwd: ROOT,
          input: JSON.stringify(request),
          timeout: Math.min(request.remainingMs, 5000),
          maxBuffer: 65536,
          env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
        },
      );
      assert.equal(proc.status, 0, String(proc.stderr));
      return JSON.parse(proc.stdout.toString("utf8")) as P3EffectReceipt;
    },
  };
}

function toolAction(name: string, args: Record<string, unknown>, scope = "s") {
  return { action: "tool", name, args, scope };
}
function finalAction(answer: string, complete = true, unresolved: string[] = []) {
  return { action: "final", answer, complete, unresolved };
}
function receipt(text: unknown, transportStatus = "COMPLETE"): P3FixtureReceipt {
  return { transportStatus: transportStatus as P3FixtureReceipt["transportStatus"], text: JSON.stringify(text) };
}
function run(receipts: readonly P3FixtureReceipt[], over: Partial<Parameters<typeof runP3Fixture>[3]> = {}) {
  return runP3Fixture(PROBLEM, SESSION, receipts, {
    maxTurns: 3,
    maxEffects: 2,
    remainingMs: 5000,
    effectPort: null,
    ...over,
  });
}
function baseGate(maxEffects = 2) {
  const contract = compileP2Contract(PROBLEM, SESSION);
  const ledger = new ContractLedger(contract);
  const task = ledger.startTask(ledger.readyTasks()[0]!.taskId);
  const gate = new P3EffectGate(
    {
      sessionId: SESSION,
      problemHash: contract.problemHash,
      contractVersion: contract.contractVersion,
      taskId: task.taskId,
      scopeId: task.scopeId,
    },
    maxEffects,
  );
  const binding = (sourceRequestId: string) => ({
    sessionId: SESSION,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: task.taskId,
    scopeId: task.scopeId,
    sourceRequestId,
  });
  return { contract, task, gate, binding };
}
function admit(gate: P3EffectGate, binding: unknown, action: unknown, turns = 3, ms = 1000) {
  return gate.admit(action, binding, turns, ms);
}
function okReceipt(request: P3EffectRequest, observation = "obs"): P3EffectReceipt {
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: request.action.action === "tool" ? "PROGRAM_OBSERVATION" : "METHOD_REFERENCE",
    observation,
    observationHash: sha(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  };
}
function settleOk(gate: P3EffectGate, binding: unknown, action: unknown, observation = "obs") {
  const admitted = admit(gate, binding, action);
  assert.equal(admitted.status, "ADMITTED");
  const request = (admitted as { request: P3EffectRequest }).request;
  gate.markDispatched(request.effectId);
  return gate.settle(okReceipt(request, observation));
}

test("strict parser accepts four shapes and freezes nested data", () => {
  const tool = parseP3Action(JSON.stringify(toolAction(TOOL, { expression: "(x+1)**2", variables: ["x"], parameters: [] })));
  assert.equal(tool.action, "tool");
  assert.ok(Object.isFrozen(tool));
  if (tool.action === "tool") {
    assert.ok(Object.isFrozen(tool.args));
    assert.ok(Object.isFrozen(tool.args.variables));
  }
  assert.equal(parseP3Action(JSON.stringify({ action: "method", id: "linearization-spectral" })).action, "method");
  assert.equal(parseP3Action(JSON.stringify(finalAction("x=1"))).action, "final");
  assert.equal(parseP3Action(JSON.stringify({ action: "unsolved", reason: "no" })).action, "unsolved");
});

test("strict parser rejects malformed, unsafe and out-of-scope actions", () => {
  const bad = [
    JSON.stringify({ action: "tool", name: TOOL, args: {}, scope: "s", extra: 1 }),
    '{"action":"method","id":"a","id":"b"}',
    '{"action":"method","id":"a","x":NaN}',
    '{"action":"method","id":"a","x":1.5}',
    '{"action":"method","id":"a","x":9007199254740993}',
    '{"action":"method","id":"a\\ud800"}',
    JSON.stringify({ action: "tool", name: "unknown_tool", args: {}, scope: "s" }),
    JSON.stringify({ action: "method", id: "../etc/passwd" }),
    JSON.stringify({ action: "method", id: "A" }),
    JSON.stringify({ action: "final", answer: "a", complete: true, unresolved: [], extra: 1 }),
    JSON.stringify({ action: "unsolved", reason: "" }),
  ];
  for (const text of bad) {
    assert.throws(() => parseP3Action(text), P2Error, text);
  }
  let deep = "1";
  for (let i = 0; i < 40; i += 1) deep = `[${deep}]`;
  assert.throws(() => parseP3Action(`{"action":"method","id":"a","x":${deep}}`), P2Error);
  assert.throws(() => parseP3Action(`{"action":"method","id":"a","x":"${"y".repeat(30000)}"}`), P2Error);
});

test("gate caches canonical args, ignores scope wording, keeps array order", () => {
  const { gate, binding } = baseGate();
  const first = admit(gate, binding("model-1"), toolAction(TOOL, { expression: "(x+1)**2", variables: ["x"], parameters: [] }, "expand it"));
  assert.equal(first.status, "ADMITTED");
  const request = (first as { request: P3EffectRequest }).request;
  gate.markDispatched(request.effectId);
  const settled = gate.settle(okReceipt(request, "obs-1"));
  assert.equal(settled.state, "OBSERVED");
  const again = admit(gate, binding("model-2"), toolAction(TOOL, { parameters: [], variables: ["x"], expression: "(x+1)**2" }, "different wording"));
  assert.equal(again.status, "CACHED");
  if (again.status === "CACHED") {
    assert.equal(again.receipt.observation, "obs-1");
    assert.equal(again.receipt.observationHash, sha("obs-1"));
  }
  assert.equal(gate.snapshot().length, 1);
  const reordered = p3EffectKey(toolAction(TOOL, { variables: ["x", "y"], expression: "e", parameters: [] }) as never);
  const swapped = p3EffectKey(toolAction(TOOL, { variables: ["y", "x"], expression: "e", parameters: [] }) as never);
  assert.notEqual(reordered, swapped);
});

test("gate rejects last turn, low time, foreign binding and repeated source without mutation", () => {
  const { gate, binding } = baseGate();
  const before = gate.snapshot().length;
  assert.throws(() => admit(gate, binding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }), 1), P2Error);
  assert.throws(() => admit(gate, binding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }), 3, 25), P2Error);
  assert.throws(() => admit(gate, { ...binding("model-1"), taskId: "other" }, toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] })), P2Error);
  assert.equal(gate.snapshot().length, before);
  const admitted = admit(gate, binding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }));
  assert.equal(admitted.status, "ADMITTED");
  assert.throws(() => admit(gate, binding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] })), P2Error);
  assert.equal(gate.snapshot().length, before + 1);
});

test("gate rejects wrong identity/hash/level/source and caches ERROR, blocks UNKNOWN", () => {
  const { gate, binding } = baseGate();
  const admitted = admit(gate, binding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }));
  const request = (admitted as { request: P3EffectRequest }).request;
  gate.markDispatched(request.effectId);
  const good = okReceipt(request);
  const variants: unknown[] = [
    { ...good, effectId: "effect-2" },
    { ...good, binding: { ...good.binding, taskId: "other" } },
    { ...good, observationHash: sha("other") },
    { ...good, level: "REVIEWED" },
    { ...good, source: "METHOD_REFERENCE" },
  ];
  for (const variant of variants) {
    assert.throws(() => p3EffectReceipt(variant, request), P2Error);
  }
  assert.equal(gate.snapshot()[0]!.state, "DISPATCHED");
  const errored = gate.settle({ ...good, status: "ERROR", observation: "bad", observationHash: sha("bad") });
  assert.equal(errored.state, "OBSERVED");
  const cached = admit(gate, binding("model-2"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }));
  assert.equal(cached.status, "CACHED");
  const unknownGate = baseGate().gate;
  const unknownBinding = baseGate().binding;
  const admitted2 = admit(unknownGate, unknownBinding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }));
  const request2 = (admitted2 as { request: P3EffectRequest }).request;
  unknownGate.markDispatched(request2.effectId);
  assert.equal(unknownGate.settle(p3EffectFailure(request2, "UNKNOWN")).state, "OUTCOME_UNKNOWN");
  assert.throws(() => admit(unknownGate, unknownBinding("model-2"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] })), P2Error);
  assert.ok(Object.isFrozen(gate.snapshot()));
});

test("real python adapter integration: tool, linear and method effects", () => {
  const cases: readonly { action: unknown; check: (r: P3EffectReceipt) => void }[] = [
    {
      action: toolAction(TOOL, { expression: "(x+1)**2", variables: ["x"], parameters: [] }),
      check: (r) => {
        const obs = JSON.parse(r.observation) as {
          result: {
            terms: readonly { coefficient: readonly { coefficient: string }[]; powers: readonly number[] }[];
          };
        };
        assert.deepEqual(obs.result.terms.map((t) => t.coefficient.map((c) => c.coefficient)), [["1"], ["2"], ["1"]]);
        assert.deepEqual(obs.result.terms.map((t) => t.powers), [[0], [1], [2]]);
      },
    },
    {
      action: toolAction(LINEAR, { matrix: [["1", "1"], ["1", "-1"]], rhs: ["3", "1"], variables: ["x", "y"], domain: "RATIONAL" }),
      check: (r) => {
        const obs = JSON.parse(r.observation) as { result: { particular: readonly string[] } };
        assert.deepEqual(obs.result.particular, ["2", "1"]);
      },
    },
    {
      action: { action: "method", id: "linearization-spectral" },
      check: (r) => {
        const obs = JSON.parse(r.observation) as { asset: { body: string; bodySha256: string } };
        assert.ok(obs.asset.body.length > 0);
        assert.equal(sha(obs.asset.body), obs.asset.bodySha256);
      },
    },
  ];
  for (const item of cases) {
    calls = 0;
    const port = realPyPort();
    const first = run([receipt(item.action), receipt(item.action), receipt(finalAction("x=1"))], { effectPort: port });
    assert.equal(calls, 1);
    assert.equal(first.public.counts.cached, 1);
    assert.equal(first.public.counts.turns, 3);
    assert.equal(first.public.counts.effects, 1);
    assert.equal(first.public.candidateVerified, false);
    assert.equal(first.public.status, "candidate");
    assert.equal(first.public.candidate, "x=1");
    assert.equal(first.private.receipts.length, 1);
    item.check(first.private.receipts[0]!);
    for (const index of [1, 2]) {
      const slot = first.private.requests[index]!;
      const payload = JSON.parse(slot.messages[1]!.content) as { effects: readonly P3EffectReceipt[] };
      assert.equal(payload.effects.length, 1);
      assert.equal(payload.effects[0]!.observation, first.private.receipts[0]!.observation);
      assert.equal(slot.contextHash, sha(JSON.stringify(slot.messages)));
      assert.equal(slot.contextBytes, Buffer.byteLength(JSON.stringify(slot.messages), "utf8"));
    }
    for (const obligation of first.private.contract.obligations) {
      assert.equal(obligation.status, obligation.obligationId === first.private.task.obligationId ? "IN_PROGRESS" : "OPEN");
      assert.equal(obligation.acceptance, null);
    }
    assert.equal(first.private.task.delivery, "RUNNING");
    const visible = JSON.stringify(first.public);
    assert.ok(!visible.includes(PROBLEM));
    assert.ok(!visible.includes(first.private.receipts[0]!.observation));
  }
});

test("no dispatch and no candidate on transport, budget and terminal failures", () => {
  const effect = toolAction(TOOL, { expression: "(x+1)**2", variables: ["x"], parameters: [] });
  const cases: readonly { receipts: readonly P3FixtureReceipt[]; over?: Partial<Parameters<typeof runP3Fixture>[3]> }[] = [
    { receipts: [] },
    { receipts: [receipt(effect, "TRUNCATED")] },
    { receipts: [receipt(effect, "ERROR")] },
    { receipts: [receipt(effect, "UNKNOWN")] },
    { receipts: [{ transportStatus: "COMPLETE", text: "{not json" }] },
    { receipts: [receipt(effect)], over: { maxTurns: 1 } },
    { receipts: [receipt(effect), receipt(finalAction("x=1"))], over: { maxEffects: 0 } },
    { receipts: [receipt(finalAction("x=1", false, ["gap"]))] },
    { receipts: [receipt({ action: "unsolved", reason: "no" })] },
  ];
  for (const item of cases) {
    calls = 0;
    const result = run(item.receipts, { effectPort: realPyPort(), ...item.over });
    assert.equal(calls, 0);
    assert.equal(result.public.candidate, null);
    assert.equal(result.public.status, "unsolved");
    assert.equal(result.public.candidateVerified, false);
    assert.equal(result.private.receipts.length, 0);
    assert.equal(result.private.modelGate.length, Math.min(1, item.receipts.length));
  }
});

test("root port faults, forged receipts and late clocks never retry or verify", () => {
  const effect = toolAction(TOOL, { expression: "(x+1)**2", variables: ["x"], parameters: [] });
  let clockVal = 0;
  const now = () => clockVal;
  let count = 0;
  const port: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      count += 1;
      clockVal = 5000;
      return okReceipt(request, "obs");
    },
  };
  const throwing: P3EffectPort = {
    execute(): P3EffectReceipt {
      count += 1;
      throw new Error("PRIVATE");
    },
  };
  const forged: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      count += 1;
      return { ...okReceipt(request, "obs"), observationHash: sha("other") };
    },
  };
  const foreign: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      count += 1;
      return { ...okReceipt(request, "obs"), binding: { ...request.binding, taskId: "other" } };
    },
  };
  const errored: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      count += 1;
      return { ...okReceipt(request, "obs"), status: "ERROR", observation: "bad", observationHash: sha("bad") };
    },
  };
  const unknown: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      count += 1;
      clockVal = 5000;
      return p3EffectFailure(request, "UNKNOWN");
    },
  };
  const cases: readonly {
    port: P3EffectPort;
    receipts: readonly P3FixtureReceipt[];
    over?: Partial<Parameters<typeof runP3Fixture>[3]>;
    unknown?: number;
    candidate?: string | null;
    codes?: readonly string[];
  }[] = [
    { port: throwing, receipts: [receipt(effect), receipt(finalAction("x=1"))], unknown: 1 },
    { port: forged, receipts: [receipt(effect), receipt(finalAction("x=1"))], unknown: 1 },
    { port: foreign, receipts: [receipt(effect), receipt(finalAction("x=1"))], unknown: 1 },
    { port: errored, receipts: [receipt(effect), receipt(effect), receipt(finalAction("x=1"))], candidate: "x=1" },
    { port: port, receipts: [receipt(effect), receipt(finalAction("x=1"))], over: { remainingMs: 5000 }, codes: ["DEADLINE_EXCEEDED"] },
    { port: unknown, receipts: [receipt(effect), receipt(finalAction("x=1"))], unknown: 1 },
  ];
  for (const item of cases) {
    count = 0;
    clockVal = 0;
    const result = run(item.receipts, { effectPort: item.port, now, ...item.over });
    assert.equal(result.public.candidateVerified, false);
    assert.equal(result.public.candidate, item.candidate ?? null);
    assert.equal(result.public.counts.unknown, item.unknown ?? 0);
    assert.ok(!JSON.stringify(result.public).includes("PRIVATE"));
    if (item.codes !== undefined) {
      assert.deepEqual(result.public.codes, item.codes);
      assert.equal(result.private.receipts.length, 0);
    }
  }
  count = 0;
  clockVal = 5000;
  const earlyTicks = [0, 5000];
  const late = run([receipt(effect), receipt(finalAction("x=1"))], { effectPort: port, now: () => earlyTicks.shift() ?? 5000 });
  assert.equal(count, 0);
  assert.equal(late.public.candidate, null);
  assert.equal(late.private.receipts.length, 0);
  assert.deepEqual(late.public.codes, ["DEADLINE_EXCEEDED"]);
  const ticks = [0, 10, 5];
  let index = 0;
  count = 0;
  const back = run([receipt(effect), receipt(finalAction("x=1"))], { effectPort: port, now: () => ticks[index++]! });
  assert.equal(count, 0);
  assert.equal(back.public.candidate, null);
  assert.equal(back.private.receipts.length, 0);
});

test("M3 context rejects wrong history, foreign effects and oversized payloads", () => {
  const { contract, task, gate, binding } = baseGate();
  const settled = settleOk(gate, binding("model-1"), toolAction(TOOL, { expression: "e", variables: ["x"], parameters: [] }), "obs-1");
  const effect = settled.receipt!;
  const history = [{ requestId: "model-1", transportStatus: "COMPLETE" as const, text: "history" }];
  const allowed = ["PROPOSE_FINAL", "MARK_UNSOLVED", "CALL_REGISTERED_TOOL", "LOAD_METHOD"];
  const good = prepareP3Context(contract, task, "model-2", allowed, [effect], history);
  assert.equal(good.messages.length, 2);
  const bad: readonly unknown[][] = [
    [[effect], []],
    [[effect], [{ requestId: "model-2", transportStatus: "COMPLETE", text: "history" }]],
    [[effect], [{ requestId: "model-1", transportStatus: "TRUNCATED", text: "history" }]],
    [[{ ...effect, binding: { ...effect.binding, scopeId: "c".repeat(64) } }], history],
    [[{ ...effect, observationHash: sha("other") }], history],
    [[{ ...effect, status: "UNKNOWN" }], history],
    [[effect, effect], history],
  ];
  for (const args of bad) {
    assert.throws(() => prepareP3Context(contract, task, "model-2", allowed, args[0] as never, args[1] as never), P2Error);
  }
  assert.throws(() => prepareP3Context(contract, task, "model-1", allowed, [effect], []), P2Error);
  const bigHistory = [{ requestId: "model-1", transportStatus: "COMPLETE" as const, text: "😀".repeat(15000) }];
  const bigObservation = "x".repeat(15000);
  const bigEffect = { ...effect, observation: bigObservation, observationHash: sha(bigObservation) };
  assert.throws(() => prepareP3Context(contract, task, "model-2", allowed, [bigEffect], bigHistory), P2Error);
});
