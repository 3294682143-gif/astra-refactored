import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_SCENARIO_CONTRACTS,
  MATH_SCENARIO_CONTRACT,
  CONTROL_SCENARIO_CONTRACT,
  SCI_COMPUTING_SCENARIO_CONTRACT,
  DATA_ANALYSIS_SCENARIO_CONTRACT,
  ROLE_SOURCE_MAPPINGS,
} from "../dist/src/index.js";

test("E02.1: 四个核心科研场景契约均已完整定义并登记", () => {
  const keys = Object.keys(ALL_SCENARIO_CONTRACTS);
  assert.equal(keys.length, 4);
  assert.ok(keys.includes("math.research"));
  assert.ok(keys.includes("control.identification"));
  assert.ok(keys.includes("scientific_computing.heat_transfer"));
  assert.ok(keys.includes("data_analysis.statistical_inference"));

  for (const [id, contract] of Object.entries(ALL_SCENARIO_CONTRACTS)) {
    assert.equal(contract.manifest.scenarioId, id);
    assert.ok(contract.manifest.name.length > 0);
    assert.ok(contract.manifest.goals.length > 0);
    assert.ok(contract.inputs.requiredFields.length > 0);
    assert.ok(contract.results.exportedFileNames.length > 0);
  }
});

test("E02.2: 每个场景内部具备完整的多 Agent 角色团队结构 (4 roles per scenario)", () => {
  const contracts = [
    MATH_SCENARIO_CONTRACT,
    CONTROL_SCENARIO_CONTRACT,
    SCI_COMPUTING_SCENARIO_CONTRACT,
    DATA_ANALYSIS_SCENARIO_CONTRACT,
  ];

  for (const c of contracts) {
    const team = c.team;
    assert.ok(team.roles.length >= 4, `Scenario ${c.manifest.scenarioId} must have at least 4 roles`);

    const roleIds = new Set();
    const categories = new Set();

    for (const r of team.roles) {
      assert.ok(!roleIds.has(r.roleId), `Duplicate roleId: ${r.roleId}`);
      roleIds.add(r.roleId);
      categories.add(r.roleCategory);
      assert.ok(r.triggerCondition.length > 0);
      assert.ok(r.maxModelCallsPerTask > 0);
    }

    // Must at least have PLANNER, WORKER, REVIEWER
    assert.ok(categories.has("PLANNER"), `${c.manifest.scenarioId} missing PLANNER`);
    assert.ok(categories.has("WORKER"), `${c.manifest.scenarioId} missing WORKER`);
    assert.ok(categories.has("REVIEWER"), `${c.manifest.scenarioId} missing REVIEWER`);
  }
});

test("E02.3: 引擎到角色来源映射表完整覆盖四场景，无死锁或歧义", () => {
  assert.ok(ROLE_SOURCE_MAPPINGS.length >= 16);

  const scenarioMapped = new Set(ROLE_SOURCE_MAPPINGS.map((m) => m.targetScenarioId));
  assert.equal(scenarioMapped.size, 4);

  for (const entry of ROLE_SOURCE_MAPPINGS) {
    assert.ok(["ts", "legacy", "lite"].includes(entry.sourceEngine));
    assert.ok(entry.legacyRoleOrStage.length > 0);
    assert.ok(entry.targetAgentId.startsWith("agent_"));
    assert.ok(entry.budgetCapCalls > 0);
  }
});
