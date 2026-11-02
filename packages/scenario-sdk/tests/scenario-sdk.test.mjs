import assert from "node:assert/strict";
import test from "node:test";

import {
  defineScenario,
  ScenarioRegistry,
  createScenarioTemplate,
} from "../src/index.ts";

test("E03.1: defineScenario 校验合法性与冻结不可变性", () => {
  const template = createScenarioTemplate({
    scenarioId: "test.materials_science",
    name: "材料科学测试场景",
    description: "晶体结构预测与热力学稳定性实验",
  });

  const defined = defineScenario(template);
  assert.equal(defined.manifest.scenarioId, "test.materials_science");
  assert.ok(Object.isFrozen(defined));
  assert.ok(Object.isFrozen(defined.manifest));
  assert.ok(Object.isFrozen(defined.team));
  assert.ok(Object.isFrozen(defined.inputs));

  // Invalid scenario ID rejection
  assert.throws(() => {
    defineScenario({
      ...template,
      manifest: { ...template.manifest, scenarioId: "INVALID SCENARIO ID!" },
    });
  }, /lower-case alphanumerics/);
});

test("E03.2: ScenarioRegistry 登记、检索与防重入机制", () => {
  const registry = new ScenarioRegistry();
  const template = createScenarioTemplate({
    scenarioId: "custom.quantum_chem",
    name: "量子化学场景",
    description: "密度泛函理论与分子轨道能级计算",
  });

  registry.register(template);
  assert.equal(registry.has("custom.quantum_chem"), true);
  assert.equal(registry.has("non_existent"), false);

  const fetched = registry.get("custom.quantum_chem");
  assert.ok(fetched);
  assert.equal(fetched.manifest.name, "量子化学场景");

  // Duplicate registration must throw
  assert.throws(() => {
    registry.register(template);
  }, /already registered/);

  // List manifests
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].scenarioId, "custom.quantum_chem");
});

test("E03.3: checkReadiness 严格识别就绪与未就绪状态，杜绝伪装已完成", () => {
  const registry = new ScenarioRegistry();

  const isolateScenario = createScenarioTemplate({
    scenarioId: "test.molecular_dynamics",
    name: "分子动力学仿真场景",
    description: "受控代码模拟",
    requiresIsolation: true,
  });
  registry.register(isolateScenario);

  // 1. Missing model capability
  const status1 = registry.checkReadiness("test.molecular_dynamics", ["text_generation"], true);
  assert.equal(status1.isReady, false);
  assert.equal(status1.status, "NOT_READY");
  assert.ok(status1.missingCapabilities.includes("scientific_reasoning"));

  // 2. Missing code isolation runtime
  const status2 = registry.checkReadiness("test.molecular_dynamics", ["scientific_reasoning"], false);
  assert.equal(status2.isReady, false);
  assert.equal(status2.status, "NOT_READY");
  assert.ok(status2.missingCapabilities.includes("sandboxed_execution_worker"));

  // 3. All capabilities present
  const status3 = registry.checkReadiness("test.molecular_dynamics", ["scientific_reasoning"], true);
  assert.equal(status3.isReady, true);
  assert.equal(status3.status, "READY");
  assert.equal(status3.missingCapabilities.length, 0);
});

test("E03.4: createSnapshot 生成不可变运行快照", () => {
  const registry = new ScenarioRegistry();
  const template = createScenarioTemplate({
    scenarioId: "test.snapshot_demo",
    name: "快照验证场景",
    description: "验证快照时间戳与不可变性",
  });
  registry.register(template);

  const snapshot = registry.createSnapshot("test.snapshot_demo");
  assert.equal(snapshot.scenarioId, "test.snapshot_demo");
  assert.equal(snapshot.version, "1.0.0");
  assert.ok(snapshot.snapshotTimestamp.length > 0);
  assert.ok(Object.isFrozen(snapshot));
});
