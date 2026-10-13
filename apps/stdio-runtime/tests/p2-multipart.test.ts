import test from "node:test";
import assert from "node:assert/strict";
import { compileP2Contract } from "@astra/math-contract";

// Two independently labelled sub-questions: the conservative compiler must
// classify MULTIPART and give each labelled part its own child goal.
const MULTIPART_PROBLEM = "Solve both parts: (a) compute 2+2 and (b) compute 3+3";

test("a real multi-part problem compiles to MULTIPART with one cover per child", () => {
  const contract = compileP2Contract(MULTIPART_PROBLEM, "multipart");
  const root = contract.goals.find((goal) => goal.kind === "MULTIPART");
  assert.ok(root, "expected a MULTIPART root goal");
  assert.deepEqual(
    root!.subgoals.map((child) => child.goalId),
    ["goal-1-a", "goal-1-b"],
  );
  for (const child of root!.subgoals) {
    assert.equal(child.kind, "VALUE");
  }
  const covers = contract.tasks.filter((task) => task.taskId.startsWith("goal-1:cover:"));
  assert.deepEqual(
    covers.map((cover) => cover.taskId).sort(),
    ["goal-1:cover:goal-1-a", "goal-1:cover:goal-1-b"],
  );
  const rootOutput = contract.tasks.find((task) => task.taskId === "goal-1:OUTPUT_COVERAGE");
  assert.ok(rootOutput, "expected the root OUTPUT_COVERAGE task");
  assert.deepEqual(
    [...rootOutput!.dependencyTaskIds].sort(),
    covers.map((cover) => cover.taskId).sort(),
  );
});

test("a single labelled part or a reordered label list is not MULTIPART", () => {
  const problems = [
    "Compute (a) 2+2",
    "Solve both parts: (b) compute 3+3 and (a) compute 2+2",
  ];
  for (const problem of problems) {
    const contract = compileP2Contract(problem, "single");
    assert.equal(
      contract.goals.some((goal) => goal.kind === "MULTIPART"),
      false,
    );
  }
});
