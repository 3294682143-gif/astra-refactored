/**
 * G4/PR5 Slice 4b — DSH monotonic tool-guard pipeline (pre -> guards).
 * A refusal is irreversible and every refusal maps to the same control
 * rejection the loop already applies; the guard never executes anything.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { monotonicToolGuard } from "@astra/math-gateway";
import type { P3Action } from "@astra/protocol";

const TOOL = {
  action: "tool",
  name: "polynomial_expand_coefficients",
  args: { expression: "2+2", variables: ["x"], parameters: [] },
  scope: "check the polynomial",
} as unknown as P3Action;

const METHOD = { action: "method", id: "method-1", scope: "load" } as unknown as P3Action;

function guard(over: Partial<Parameters<typeof monotonicToolGuard>[0]>) {
  return monotonicToolGuard({
    action: TOOL,
    allowTools: true,
    allowMethods: false,
    methodId: null,
    catalogIds: [],
    callsLeft: 3,
    maxReviews: 1,
    ...over,
  });
}

test("Slice 4b: a legal tool action is admitted (monotonic)", () => {
  const d = guard({});
  assert.equal(d.admitted, true);
  assert.equal(d.code, "ADMITTED");
  assert.equal(d.monotonic, true);
});

test("Slice 4b: refusals are irreversible and fixed-code", () => {
  assert.equal(guard({ allowTools: false }).code, "ACTION_NOT_ALLOWED");
  assert.equal(guard({ callsLeft: 0, maxReviews: 1 }).code, "BUDGET_RESERVED");
  assert.equal(
    guard({ action: METHOD, allowMethods: true, methodId: "method-9", catalogIds: ["method-1"] }).code,
    "UNKNOWN_METHOD",
  );
  assert.equal(
    guard({ action: METHOD, allowMethods: false, methodId: "method-1", catalogIds: ["method-1"] }).code,
    "METHOD_UNAVAILABLE",
  );
  assert.equal(
    guard({ action: { action: "final" } as unknown as P3Action }).code,
    "NOT_AN_EFFECT_ACTION",
  );
  // There is no un-reject: repeating the same refused call is byte-identical.
  assert.deepEqual(guard({ allowTools: false }), guard({ allowTools: false }));
});
