import test from "node:test";
import assert from "node:assert/strict";

import { prepareP4R0Recheck } from "@astra/math-contract";
import { validateP4R0RecheckInput } from "@astra/math-review";
import {
  P2Error,
  canonicalScope,
  p4Hash,
  type P4R0RecheckPreparation,
} from "@astra/protocol";

import {
  makeNonDefaultSeqR0,
  makeRecheck,
  makeRecheckMultipart,
  type Mutable,
} from "./p4-r0-recheck-fixtures.js";

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

/**
 * Re-hash one tampered preparation so the shape checks are actually reached.
 * The child contract, the child binding, the lineage child and the plan text
 * are re-synchronized to the tampered target; the parent hash is untouched.
 */
function sync(prep: Mutable<P4R0RecheckPreparation>): Mutable<P4R0RecheckPreparation> {
  const contract = clone(prep.target.contract);
  const planText = JSON.stringify({
    goals: contract.goals,
    obligations: contract.obligations,
    tasks: contract.tasks,
    riskHints: contract.riskHints,
  });
  prep.target.planText = planText;
  prep.target.binding.planHash = p4Hash(JSON.stringify(contract));
  prep.revision.revisedContract = contract;
  prep.revision.record!.lineage!.child = clone(prep.target.binding);
  prep.revisionHash = p4Hash(JSON.stringify(prep.revision));
  return prep;
}

test("group 1: valid preparation passes and multipart/non-default seq are true positives", () => {
  const { preparation } = makeRecheck();
  assert.equal(validateP4R0RecheckInput(preparation).revisionHash, preparation.revisionHash);
  const multipart = makeRecheckMultipart().preparation;
  assert.equal(validateP4R0RecheckInput(multipart).target.binding.contractVersion, multipart.parent.contractVersion + 1);
  const nonDefault = makeRecheck({}, makeNonDefaultSeqR0()).preparation;
  assert.equal(validateP4R0RecheckInput(nonDefault).target.contract.envelope.eventSeq, 8);
});

test("group 2: tampered child shape is rejected after re-hashing", () => {
  const { original, trigger, revision, preparation } = makeRecheck();
  const base = { planningModelCalls: 1, remainingRootCalls: 2, remainingMs: 700 } as const;
  const mutations: readonly ((value: Mutable<P4R0RecheckPreparation>) => void)[] = [
    (value) => {
      value.target.contract.obligations[0]!.status = "OPEN";
    },
    (value) => {
      for (const item of value.target.contract.obligations) {
        item.status = "SATISFIED";
      }
    },
    (value) => {
      value.target.contract.obligations[0]!.acceptance = {} as never;
    },
    (value) => {
      value.target.contract.tasks[0]!.delivery = "RUNNING";
    },
    (value) => {
      value.target.contract.tasks[0]!.inputArtifactRefs = [{ artifactId: "a", artifactVersion: 1 }];
    },
    (value) => {
      value.target.contract.tasks[0]!.obligationId = "ghost";
    },
    (value) => {
      value.target.contract.goals[0]!.scope.scopeId = "0".repeat(64);
    },
    (value) => {
      value.target.contract.tasks[0]!.dependencyTaskIds = [value.target.contract.tasks[0]!.taskId];
    },
    (value) => {
      value.target.contract.tasks = value.target.contract.tasks.slice(1);
    },
  ];
  for (const mutate of mutations) {
    const tampered = clone(preparation);
    mutate(tampered);
    sync(tampered);
    assert.throws(() => validateP4R0RecheckInput(tampered as never), P2Error);
  }
  assert.equal(prepareP4R0Recheck(original, trigger, revision, base).action, "REQUEST_REVIEW");
});

test("group 2b: a new scope assumption with a refreshed scope hash is still rejected", () => {
  const { preparation } = makeRecheck();
  const tampered = clone(preparation);
  const goal = tampered.target.contract.goals[0]!;
  goal.scope.localAssumptions = [...goal.scope.localAssumptions, "fixture assumption"];
  goal.scope.scopeId = p4Hash(canonicalScope(goal.scope));
  assert.equal(goal.scope.scopeId, p4Hash(canonicalScope(goal.scope)));
  for (const item of tampered.target.contract.obligations) {
    item.envelope.scopeId = goal.scope.scopeId;
  }
  for (const item of tampered.target.contract.tasks) {
    item.scopeId = goal.scope.scopeId;
    item.envelope.scopeId = goal.scope.scopeId;
  }
  sync(tampered);
  assert.throws(() => validateP4R0RecheckInput(tampered as never), P2Error);
});

test("group 3: tampered revision source is rejected after re-hashing", () => {
  const { original, trigger, revision, preparation } = makeRecheck();
  const base = { planningModelCalls: 1, remainingRootCalls: 2, remainingMs: 700 } as const;
  const mutations: readonly ((value: Mutable<P4R0RecheckPreparation>) => void)[] = [
    (value) => {
      value.revision.availability = "STALE";
    },
    (value) => {
      value.revision.record!.lineage!.canActivate = true as never;
    },
    (value) => {
      value.revision.record!.lineage!.changedGoalIds = [];
    },
    (value) => {
      value.revision.events[1]!.eventSeq = 99;
    },
    (value) => {
      value.revision.record!.rawResponseText = "not json";
    },
    (value) => {
      value.revision.record!.context.contextHash = "0".repeat(64);
    },
    (value) => {
      value.revision.parent.contractVersion = 99;
    },
    (value) => {
      value.revision.record!.lineage!.parent.planHash = "0".repeat(64);
    },
    (value) => {
      value.revision.record!.code = "INVALID_REVISION";
    },
    (value) => {
      value.revision.record!.state = "OUTCOME_UNKNOWN";
    },
    (value) => {
      value.revision.delta!.changedGoalIds = [];
    },
    (value) => {
      value.revision.events = [];
    },
    (value) => {
      value.revision.record!.context.contextBytes = 1;
    },
  ];
  for (const mutate of mutations) {
    const tampered = clone(preparation);
    mutate(tampered);
    sync(tampered);
    assert.throws(() => validateP4R0RecheckInput(tampered as never), P2Error);
    assert.throws(
      () => prepareP4R0Recheck(original, trigger, tampered.revision as never, base),
      P2Error,
    );
  }
  const wrongHash = clone(preparation);
  wrongHash.revisionHash = "0".repeat(64);
  assert.throws(() => validateP4R0RecheckInput(wrongHash as never), P2Error);
  assert.equal(prepareP4R0Recheck(original, trigger, revision, base).action, "REQUEST_REVIEW");
});

test("group 4: extra fields and budget drift are rejected", () => {
  const { preparation } = makeRecheck();
  const extra = clone(preparation) as Mutable<P4R0RecheckPreparation> & { extra?: number };
  extra.extra = 1;
  assert.throws(() => validateP4R0RecheckInput(extra as never), P2Error);
  const forgedAction = clone(preparation);
  forgedAction.action = "INSUFFICIENT_BUDGET";
  assert.throws(() => validateP4R0RecheckInput(forgedAction as never), P2Error);
  const forgedRoot = clone(preparation);
  forgedRoot.remainingRootCalls = 1;
  assert.throws(() => validateP4R0RecheckInput(forgedRoot as never), P2Error);
  const forgedPlanning = clone(preparation);
  forgedPlanning.planningModelCalls = 0;
  assert.throws(() => validateP4R0RecheckInput(forgedPlanning as never), P2Error);
  const forgedMs = clone(preparation);
  forgedMs.remainingMs = 25;
  assert.throws(() => validateP4R0RecheckInput(forgedMs as never), P2Error);
  const forgedFlag = clone(preparation);
  forgedFlag.canSupportObligation = true as never;
  assert.throws(() => validateP4R0RecheckInput(forgedFlag as never), P2Error);
  const forgedSemantic = clone(preparation);
  forgedSemantic.semanticResult = "PASS" as never;
  assert.throws(() => validateP4R0RecheckInput(forgedSemantic as never), P2Error);
});
