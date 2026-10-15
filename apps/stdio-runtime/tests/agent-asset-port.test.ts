import test from "node:test";
import assert from "node:assert/strict";
import { captureAgentPorts } from "../src/agent-loop-io.js";

test("G7/PR7 7e: the optional asset port is captured, frozen and bounded", () => {
  const ports = captureAgentPorts({
    model: { generate: async () => ({}) },
    effect: null,
    catalog: null,
    asset: {
      call: async () => ({ group: "skills", assetId: "x", scopeId: "a".repeat(64), contractVersion: 1, sha256: "0".repeat(64) }),
    },
  } as never);
  assert.equal(typeof ports.asset?.call, "function");
  assert.ok(Object.isFrozen(ports.asset));
  assert.ok(Object.isFrozen(ports));
});

test("G7/PR7 7e: an unknown port key is still refused (fail-closed)", () => {
  assert.throws(() =>
    captureAgentPorts({
      model: { generate: async () => ({}) },
      effect: null,
      catalog: null,
      bogus: 1,
    } as never),
  );
});
