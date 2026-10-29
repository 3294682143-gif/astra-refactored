import { test } from "node:test";
import assert from "node:assert/strict";
import { P2Error, p2Snapshot, p4Hash, p4JsonEqual } from "@astra/protocol";
import { P4RecheckSession, validateP4RecheckInput } from "@astra/math-review";
import {
  acceptedChild,
  buildRecheck,
  makeRecheck,
  type RecheckMaterial,
} from "./p4-recheck-fixtures.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

function clone<T>(value: T): T {
  return structuredClone(value) as T;
}

function validate(material: RecheckMaterial, patch: Record<string, unknown> = {}): unknown {
  const parent = clone(material.parent);
  const child = clone(material.child);
  const parentReview = clone(material.parentReview);
  const repair = clone(material.repair);
  const target = { parent, child, parentReview, repair } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value;
  }
  return validateP4RecheckInput(
    material.contract,
    target.parent as typeof parent,
    target.child as typeof child,
    target.parentReview as typeof parentReview,
    target.repair as typeof repair,
  );
}

function recordOf(repair: RecheckMaterial["repair"]): Record<string, unknown> {
  return clone(repair.record) as unknown as Record<string, unknown>;
}

test("S2 re-review input rejects binding, state and replay tampering", () => {
  const material = buildRecheck();
  const before = JSON.stringify([
    material.parent,
    material.child,
    material.parentReview,
    material.repair,
  ]);
  const record = recordOf(material.repair);
  const reviewRecord = clone(material.parentReview.records[0]) as unknown as Record<string, unknown>;
  const cases: readonly (() => unknown)[] = [
    () => validate(material, { parent: { ...clone(material.parent), availability: "STALE" } }),
    () => validate(material, { child: { ...clone(material.child), availability: "STALE" } }),
    () => validate(material, { parent: { ...clone(material.parent), binding: { ...material.parent.binding, contractVersion: 2 } } }),
    () => validate(material, { parent: { ...clone(material.parent), targetHash: "0".repeat(64) } }),
    () => validate(material, { child: { ...clone(material.child), binding: { ...material.child.binding, sourceRequestId: "model-1" } } }),
    () => validate(material, { child: { ...clone(material.child), binding: { ...material.child.binding, artifactVersion: 2 } } }),
    () => validate(material, { child: { ...clone(material.child), targetHash: "0".repeat(64) } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), availability: "STALE" } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), targetHash: "0".repeat(64) } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), records: [] } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), records: [reviewRecord, reviewRecord] } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), records: [{ ...reviewRecord, rawResponseText: "{}" }] } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), records: [{ ...reviewRecord, report: null }] } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), records: [{ ...reviewRecord, context: { ...(reviewRecord.context as Record<string, unknown>), contextBytes: 1 } }] } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), challenges: [] } }),
    () => validate(material, { parentReview: { ...clone(material.parentReview), evidence: [] } }),
    () => validate(material, { repair: { ...clone(material.repair), repairAttempts: 0 } }),
    () => validate(material, { repair: { ...clone(material.repair), availability: "STALE" } }),
    () => validate(material, { repair: { ...clone(material.repair), parentHash: "0".repeat(64) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: null } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, state: "DISPATCHED" } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, code: "INVALID_REPAIR" } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, transportStatus: "TRUNCATED" } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, rawResponseText: "{}" } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, context: { ...(record.context as Record<string, unknown>), contextBytes: 1 } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, lineage: null } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, lineage: { ...(record.lineage as Record<string, unknown>), requiresRecheck: false } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, lineage: { ...(record.lineage as Record<string, unknown>), canReplaceProtected: true } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, lineage: { ...(record.lineage as Record<string, unknown>), checkResult: "PASS" } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, lineage: { ...(record.lineage as Record<string, unknown>), changedFields: ["claim"] } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, lineage: { ...(record.lineage as Record<string, unknown>), challengeId: "challenge-2" } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, challenge: { ...(record.challenge as Record<string, unknown>), challengeId: "challenge-2" } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, challenge: { ...(record.challenge as Record<string, unknown>), issue: { ...material.challenge.issue, stepLocator: { start: 0, end: 1, quote: "😀" } } } } } }),
  ];
  for (const fn of cases) {
    assert.throws(fn, (error: unknown) => error instanceof P2Error);
  }
  assert.equal(
    JSON.stringify([material.parent, material.child, material.parentReview, material.repair]),
    before,
  );
  assert.equal(material.challenge.status, "CHALLENGED");
  assert.equal(material.repair.record?.lineage?.requiresRecheck, true);
});

test("S2 re-review input rejects a re-hashed but altered repair context payload", () => {
  const material = buildRecheck();
  const record = recordOf(material.repair);
  const context = record.context as Record<string, unknown>;
  const messages = clone(context.messages) as readonly { role: string; content: string }[];
  const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  const rebuild = (next: Record<string, unknown>, raw?: string): Record<string, unknown> => {
    const content = raw ?? JSON.stringify(next);
    const nextMessages = [
      { role: "system", content: messages[0]!.content },
      { role: "user", content },
    ];
    const serialized = JSON.stringify(nextMessages);
    return {
      ...record,
      context: {
        messages: nextMessages,
        contextHash: p4Hash(serialized),
        contextBytes: Buffer.byteLength(serialized, "utf8"),
      },
    };
  };
  const cases: readonly (() => unknown)[] = [
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild({ ...payload, problemFullText: "other problem" }) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild({ ...payload, parentClaim: "x=0 or x=1" }) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild({ ...payload, parentAssumptions: ["x>=0"] }) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild({ ...payload, challenge: { ...material.challenge, challengeId: "challenge-2" } }) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild({ ...payload, obligations: [] }) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild(payload, messages[1]!.content.replace('"requestId":"model-3"', '"requestId":"model-3","requestId":"model-3"')) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild(payload, messages[1]!.content.replace('"parentHash":"', '"parentHash":1.5,"parentHash":"')) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: rebuild(payload, messages[1]!.content.replace('"routeId":"route-1"', '"routeId":"route-1\\ud800"')) } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, context: { ...context, contextHash: "0".repeat(64) } } } }),
    () => validate(material, { repair: { ...clone(material.repair), record: { ...record, context: { ...context, contextBytes: (context.contextBytes as number) + 1 } } } }),
  ];
  for (const fn of cases) {
    assert.throws(fn, (error: unknown) => error instanceof P2Error);
  }
  const good = validate(material) as { readonly repairHash: string };
  assert.equal(good.repairHash, p4Hash(JSON.stringify(material.repair)));
  assert.equal(p4JsonEqual(material.repair, buildRecheck().repair), true);
});

test("S2 re-review input rejects a genuine M3 no-op child and a foreign repair record", () => {
  const material = buildRecheck();
  const noop = acceptedChild(material, {
    claim: "x=1 only",
    derivation: material.parent.artifact.packet!.derivation,
    candidateProposal: "x=1",
  });
  assert.equal(noop.child.binding.artifactId, "repair-1");
  assert.equal(noop.child.binding.sourceRequestId, "model-3");
  assert.equal(noop.child.artifact.rawResponseText, noop.raw);
  expectCode(() => validate(material, { child: noop.child }), "PACKET_BINDING");
  expectCode(
    () => validate(material, { child: noop.child, repair: { ...clone(material.repair), record: { ...recordOf(material.repair), rawResponseText: noop.raw } } }),
    "PACKET_BINDING",
  );

  const declared = buildRecheck(["x>=0"]);
  assert.deepEqual([...declared.contract.goals[0]!.scope.localAssumptions], ["x>=0"]);
  assert.deepEqual([...declared.parent.artifact.packet!.assumptions], []);
  assert.equal(validate(declared) !== null, true);
  const reused = acceptedChild(declared, { assumptions: ["x>=0"] });
  assert.deepEqual([...reused.child.artifact.packet!.assumptions], ["x>=0"]);
  expectCode(() => validate(declared, { child: reused.child }), "PACKET_SCOPE_VIOLATION");
  assert.equal(declared.challenge.status, "CHALLENGED");
  assert.equal(declared.challenge.availability, "ACTIVE");
});

test("S2 re-review session snapshots its caller material and never widens the root budget", () => {
  const material = buildRecheck();
  const beforeMaterial = JSON.stringify([
    material.parent,
    material.child,
    material.parentReview,
    material.repair,
  ]);
  const parent = clone(material.parent) as unknown as Record<string, unknown>;
  const child = clone(material.child) as unknown as Record<string, unknown>;
  const parentReview = clone(material.parentReview) as unknown as Record<string, unknown>;
  const repair = clone(material.repair) as unknown as Record<string, unknown>;
  const session = new P4RecheckSession(
    material.contract,
    parent as unknown as RecheckMaterial["parent"],
    child as unknown as RecheckMaterial["child"],
    parentReview as unknown as RecheckMaterial["parentReview"],
    repair as unknown as RecheckMaterial["repair"],
  );
  const capturedHash = session.snapshot().repairHash;
  const record = session.admit(1000, 1);
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.parentClaim, "x=1 only");
  assert.equal(payload.childDerivation, material.child.artifact.packet!.derivation);
  assert.equal(payload.repairHash, capturedHash);
  assert.equal(payload.repairHash, p4Hash(JSON.stringify(material.repair)));

  (parent.artifact as Record<string, unknown>).packet = {
    ...(material.parent.artifact.packet as unknown as Record<string, unknown>),
    claim: "tampered",
  };
  ((parentReview.records as Record<string, unknown>[])[0] as Record<string, unknown>).code =
    "INVALID_REPORT";
  (repair.record as Record<string, unknown>).rawResponseText = "{}";
  const after = session.snapshot();
  assert.equal(after.repairHash, capturedHash);
  assert.equal(after.record?.code, "NOT_DISPATCHED");
  assert.equal(after.record?.state, "ADMITTED");
  assert.equal(after.record?.context.contextHash, record.context.contextHash);
  assert.equal(
    JSON.stringify([
      material.parent,
      material.child,
      material.parentReview,
      material.repair,
    ]),
    beforeMaterial,
  );
  assert.equal(material.challenge.status, "CHALLENGED");
  assert.equal(material.challenge.availability, "ACTIVE");
  assert.equal(material.repair.record?.code, "PROPOSAL_RECORDED");
  assert.equal(material.repair.record?.lineage?.requiresRecheck, true);
  assert.equal(material.repair.record?.lineage?.canReplaceProtected, false);
  assert.equal(material.repair.record?.lineage?.checkResult, "UNKNOWN");
  assert.equal(p4JsonEqual(p2Snapshot(material.repair), buildRecheck().repair), true);

  const fresh = makeRecheck(material);
  const initial = JSON.stringify(fresh.snapshot());
  expectCode(() => fresh.admit(1000, 0), "BUDGET_EXHAUSTED");
  expectCode(() => fresh.admit(1000, 2), "BOUND_EXCEEDED");
  expectCode(() => fresh.admit(1000, Number.NaN), "BOUND_EXCEEDED");
  expectCode(() => fresh.admit(25, 1), "BOUND_EXCEEDED");
  assert.equal(JSON.stringify(fresh.snapshot()), initial);
  assert.equal(fresh.snapshot().record, null);
  assert.equal(fresh.snapshot().availability, "ACTIVE");
});

test("S2 re-review input reads the caller repair snapshot exactly once", () => {
  const material = buildRecheck();
  const record = material.repair.record;
  let reads = 0;
  const getterObject = {
    ...material.repair,
    get record() {
      reads += 1;
      return reads === 1 ? record : null;
    },
  };
  const validated = validateP4RecheckInput(
    material.contract,
    material.parent,
    material.child,
    material.parentReview,
    getterObject as unknown as RecheckMaterial["repair"],
  );
  assert.equal(reads, 1);
  assert.equal(validated.repairHash, p4Hash(JSON.stringify(material.repair)));
  assert.equal(validated.repair.record?.code, "PROPOSAL_RECORDED");
  assert.equal(validated.repair.record?.lineage?.requiresRecheck, true);
  assert.equal(validated.repair.record?.lineage?.canReplaceProtected, false);
  assert.equal(validated.repair.record?.lineage?.checkResult, "UNKNOWN");
  assert.equal(material.challenge.status, "CHALLENGED");
  assert.equal(material.challenge.availability, "ACTIVE");
});
