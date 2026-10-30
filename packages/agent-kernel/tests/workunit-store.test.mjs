import assert from "node:assert/strict";
import test from "node:test";
import { WorkUnitStore } from "../dist/src/workunit-store.js";

test("I03: 请求、任务、产物绑定同一运行与版本，禁止版本倒退或同版本静默覆盖", () => {
  const store = new WorkUnitStore("run_control_exp_001");
  assert.equal(store.runId, "run_control_exp_001");

  // Register initial artifact version 1
  store.registerArtifact({
    artifactId: "art_excitation_signal",
    version: 1,
    kind: "dataset",
    payloadRef: "ref_payload_v1",
    dependencyRefs: [],
    digest: "sha256_v1_aaa",
    isStale: false,
  });

  const art = store.getArtifact("art_excitation_signal");
  assert.ok(art);
  assert.equal(art.artifactId, "art_excitation_signal");
  assert.equal(art.version, 1);

  // Attempting to overwrite version 1 with version 1 must throw
  assert.throws(
    () => {
      store.registerArtifact({
        artifactId: "art_excitation_signal",
        version: 1,
        kind: "dataset",
        payloadRef: "ref_payload_v1_tampered",
        dependencyRefs: [],
        digest: "sha256_v1_tampered",
        isStale: false,
      });
    },
    { message: /Cannot overwrite artifact art_excitation_signal version 1 with version 1/ }
  );

  // Attempting to overwrite with a lower version must throw
  assert.throws(
    () => {
      store.registerArtifact({
        artifactId: "art_excitation_signal",
        version: 0,
        kind: "dataset",
        payloadRef: "ref_payload_v0",
        dependencyRefs: [],
        digest: "sha256_v0",
        isStale: false,
      });
    },
    { message: /Cannot overwrite artifact art_excitation_signal version 1 with version 0/ }
  );
});

test("I09: 上游产物版本更新时，依赖 DAG 沿拓扑关系级联标记 STALE", () => {
  const store = new WorkUnitStore("run_dag_pipeline_002");

  // Dependency chain:
  // raw_sensor_data (v1) -> filtered_data (v1) -> parameter_estimate (v1) -> stability_report (v1)
  store.registerArtifact({
    artifactId: "raw_sensor_data",
    version: 1,
    kind: "data",
    payloadRef: "payload_raw_1",
    dependencyRefs: [],
    digest: "digest_raw_1",
    isStale: false,
  });

  store.registerArtifact({
    artifactId: "filtered_data",
    version: 1,
    kind: "preprocessed_data",
    payloadRef: "payload_filtered_1",
    dependencyRefs: ["raw_sensor_data"],
    digest: "digest_filtered_1",
    isStale: false,
  });

  store.registerArtifact({
    artifactId: "parameter_estimate",
    version: 1,
    kind: "parameters",
    payloadRef: "payload_params_1",
    dependencyRefs: ["filtered_data"],
    digest: "digest_params_1",
    isStale: false,
  });

  store.registerArtifact({
    artifactId: "stability_report",
    version: 1,
    kind: "report",
    payloadRef: "payload_report_1",
    dependencyRefs: ["parameter_estimate"],
    digest: "digest_report_1",
    isStale: false,
  });

  // Independent artifact not in this dependency path
  store.registerArtifact({
    artifactId: "reference_benchmark_catalog",
    version: 1,
    kind: "catalog",
    payloadRef: "payload_cat_1",
    dependencyRefs: [],
    digest: "digest_cat_1",
    isStale: false,
  });

  // Verify initial state: none are stale
  assert.equal(store.isArtifactStale("filtered_data"), false);
  assert.equal(store.isArtifactStale("parameter_estimate"), false);
  assert.equal(store.isArtifactStale("stability_report"), false);
  assert.equal(store.isArtifactStale("reference_benchmark_catalog"), false);

  // Invariant I09: Update upstream raw_sensor_data to version 2
  store.registerArtifact({
    artifactId: "raw_sensor_data",
    version: 2,
    kind: "data",
    payloadRef: "payload_raw_2",
    dependencyRefs: [],
    digest: "digest_raw_2",
    isStale: false,
  });

  // Cascade invalidation verification:
  // Downstream dependents MUST all be marked STALE
  assert.equal(store.isArtifactStale("filtered_data"), true);
  assert.equal(store.isArtifactStale("parameter_estimate"), true);
  assert.equal(store.isArtifactStale("stability_report"), true);

  // Independent artifact must NOT be affected
  assert.equal(store.isArtifactStale("reference_benchmark_catalog"), false);
});

test("T06: 循环依赖与自依赖任务提案被严格拦截", () => {
  const store = new WorkUnitStore("run_cycle_guard_003");

  // Self-dependency rejected
  assert.throws(
    () => {
      store.addTask({
        taskId: "task_self_recursive",
        goalRefs: ["g1"],
        dependencies: ["task_self_recursive"],
        routeId: "route_direct",
        state: "PENDING",
      });
    },
    { message: /Circular dependency detected: task task_self_recursive cannot depend on itself/ }
  );

  // Duplicate task ID rejected
  store.addTask({
    taskId: "task_valid_step_1",
    goalRefs: ["g1"],
    dependencies: [],
    routeId: "route_direct",
    state: "PENDING",
  });

  assert.throws(
    () => {
      store.addTask({
        taskId: "task_valid_step_1",
        goalRefs: ["g1"],
        dependencies: [],
        routeId: "route_direct",
        state: "PENDING",
      });
    },
    { message: /Task already registered: task_valid_step_1/ }
  );
});
