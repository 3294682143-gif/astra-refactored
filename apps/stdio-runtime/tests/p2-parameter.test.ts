import test from "node:test";
import assert from "node:assert/strict";
import { compileP2Contract, isParameterProblem } from "@astra/math-contract";
import { p2IsAnswerObligationKindForGoal } from "@astra/protocol";

const PARAMETER_PROBLEM = "Classify the parameter a in the equation a*x=1";

test("a parameter-classification problem compiles to PARAMETER with a BOUNDARY_EXCEPTIONS duty", () => {
  const contract = compileP2Contract(PARAMETER_PROBLEM, "parameter");
  const goal = contract.goals.find((g) => g.kind === "PARAMETER");
  assert.ok(goal, "expected a PARAMETER goal");
  const boundaryTasks = contract.tasks.filter((task) =>
    task.obligationId.endsWith(":BOUNDARY_EXCEPTIONS"),
  );
  assert.equal(boundaryTasks.length, 1);
  assert.equal(boundaryTasks[0]!.goalId, goal!.goalId);
  assert.equal(p2IsAnswerObligationKindForGoal("PARAMETER", "OUTPUT_COVERAGE"), true);
});

test("only genuine parameter-classification problems are PARAMETER", () => {
  assert.equal(isParameterProblem(PARAMETER_PROBLEM), true);
  assert.equal(isParameterProblem("Compute 2+2"), false);
  assert.equal(isParameterProblem("How many integer solutions does x+y=3 have"), false);
  assert.equal(isParameterProblem("Solve both parts: (a) compute 2+2 and (b) compute 3+3"), false);
  // Naming a parameter without asking to classify it is not enough.
  assert.equal(isParameterProblem("Compute the value of x when parameter a=2"), false);
});
