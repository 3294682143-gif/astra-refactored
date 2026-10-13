/**
 * @astra/stdio-runtime — real TS registration evidence for declared scope
 * coverage. The store is the real `P2WorkunitStore`; the proposal is the exact
 * four-list shape `p2ScopeCoverage` accepts. A declared row is data only: it
 * never closes an obligation, never changes the ready set and is never a
 * coverage proof.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { P2Error, p2Snapshot, type P2Task } from "@astra/protocol";
import { compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";

const HEX64 = /^[0-9a-f]{64}$/u;

function fixture(): { store: P2WorkunitStore; task: P2Task } {
  const contract = compileP2Contract("Compute 2+2", "scope-coverage-unit");
  const store = new P2WorkunitStore(contract);
  const task = p2Snapshot({
    ...(contract.tasks[0] as P2Task),
    delivery: "RUNNING" as const,
  }) as P2Task;
  return { store, task };
}

function legalProposal(): Record<string, unknown> {
  return {
    quantifiers: [],
    branchConditions: [],
    boundaryCases: ["the declared boundary case is restated"],
    goalExhaustion: ["the declared goal exhaustion is restated"],
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof P2Error);
    return (error as P2Error).code;
  }
  throw new Error("expected a fixed rejection");
}

test("a legal four-list proposal is registered as declared data", () => {
  const { store, task } = fixture();
  const before = store.snapshot();
  const coverage = store.declareScopeCoverage(task, legalProposal());
  assert.match(coverage.coverageHash, HEX64);
  const rows = store.scopeCoverageSnapshot();
  assert.equal(rows.length, 1);
  const row = rows[0] as (typeof rows)[number];
  assert.equal(row.taskId, task.taskId);
  assert.equal(row.scopeId, task.scopeId);
  assert.equal(row.coverage.coverageHash, coverage.coverageHash);
  const stored = store.scopeCoverageOf(task.taskId);
  assert.notEqual(stored, null);
  assert.equal((stored as { coverageHash: string }).coverageHash, coverage.coverageHash);
  // Registration never touches artifacts, versions or the ready set.
  assert.deepEqual(store.snapshot(), before);
});

test("a shape-legal but out-of-scope quantifier is a fixed SCOPE_MISMATCH", () => {
  const { store, task } = fixture();
  const proposal = legalProposal();
  proposal.quantifiers = ["for every integer outside declared scope"];
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "SCOPE_MISMATCH",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
  assert.equal(store.scopeCoverageOf(task.taskId), null);
});

test("an out-of-scope branch condition is a fixed SCOPE_MISMATCH", () => {
  const { store, task } = fixture();
  const proposal = legalProposal();
  proposal.branchConditions = ["a branch that was never declared"];
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "SCOPE_MISMATCH",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});

test("an extra key is a fixed PACKET_BINDING and registers nothing", () => {
  const { store, task } = fixture();
  const proposal = legalProposal();
  proposal.kind = "SCOPE_REFINEMENT";
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "PACKET_BINDING",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});

test("a missing key is a fixed PACKET_BINDING and registers nothing", () => {
  const { store, task } = fixture();
  const proposal = legalProposal();
  delete proposal.goalExhaustion;
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "PACKET_BINDING",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});

test("a non-list field is a fixed rejection and registers nothing", () => {
  const { store, task } = fixture();
  const proposal = legalProposal();
  proposal.boundaryCases = "not a list";
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "BOUND_EXCEEDED",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});

test("a whitespace-only item is a fixed PACKET_BINDING and registers nothing", () => {
  const { store, task } = fixture();
  const proposal = legalProposal();
  proposal.goalExhaustion = ["   "];
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "PACKET_BINDING",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});

test("a declared row never closes an obligation or creates a candidate", () => {
  const { store, task } = fixture();
  const obligationsBefore = store.snapshot().length;
  store.declareScopeCoverage(task, legalProposal());
  assert.equal(store.snapshot().length, obligationsBefore);
  const rows = store.scopeCoverageSnapshot();
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as { taskId: string }).taskId, task.taskId);
});

function multipartFixture(): { store: P2WorkunitStore; task: P2Task; childIds: string[] } {
  const contract = compileP2Contract(
    "Solve both parts: (a) compute 2+2 and (b) compute 3+3",
    "scope-coverage-multipart",
  );
  const store = new P2WorkunitStore(contract);
  const root = contract.goals.find((goal) => goal.kind === "MULTIPART");
  assert.ok(root, "expected a MULTIPART root goal");
  const rootTask = contract.tasks.find((task) => task.goalId === root!.goalId);
  assert.ok(rootTask, "expected a task of the MULTIPART root goal");
  const task = p2Snapshot({
    ...(rootTask as P2Task),
    delivery: "RUNNING" as const,
  }) as P2Task;
  return { store, task, childIds: root!.subgoals.map((child) => child.goalId) };
}

test("a MULTIPART root must name exactly its trusted child goals to claim exhaustion", () => {
  const { store, task, childIds } = multipartFixture();
  assert.deepEqual([...childIds].sort(), ["goal-1-a", "goal-1-b"]);
  const proposal = legalProposal();
  proposal.goalExhaustion = [...childIds];
  const coverage = store.declareScopeCoverage(task, proposal);
  assert.match(coverage.coverageHash, HEX64);
  assert.equal(store.scopeCoverageSnapshot().length, 1);
});

test("a MULTIPART exhaustion claim that misses a child is a fixed SCOPE_MISMATCH", () => {
  const { store, task, childIds } = multipartFixture();
  const proposal = legalProposal();
  proposal.goalExhaustion = childIds.slice(0, 1);
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "SCOPE_MISMATCH",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});

test("a MULTIPART exhaustion claim with a foreign extra child is a fixed SCOPE_MISMATCH", () => {
  const { store, task, childIds } = multipartFixture();
  const proposal = legalProposal();
  proposal.goalExhaustion = [...childIds, "goal-1-c"];
  assert.equal(
    codeOf(() => store.declareScopeCoverage(task, proposal)),
    "SCOPE_MISMATCH",
  );
  assert.equal(store.scopeCoverageSnapshot().length, 0);
});
