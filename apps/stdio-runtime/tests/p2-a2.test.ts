import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  type A2Bundle,
  type A2Request,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import {
  a2Hash,
  a2Request,
  compareA2Requests,
  validateA2Bundle,
  A2ReplaySession,
} from "@astra/runtime-core";
import {
  P2RouteRegistry,
  prepareP2Context,
  rebuildA2Requests,
} from "@astra/math-workunit";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const repoRoot = path.resolve(root);
const lock = JSON.parse(
  readFileSync(path.join(repoRoot, "packages/protocol/schema/a2-source-lock.json"), "utf8"),
) as Record<string, string>;

const SCENARIOS = ["direct", "method", "repeat", "truncated", "final-turn-method"] as const;
const EXPECTED_COUNTS: Record<string, number> = {
  direct: 1,
  method: 2,
  repeat: 3,
  truncated: 1,
  "final-turn-method": 1,
};
const EXPECTED_LOADS: Record<string, number> = {
  direct: 0,
  method: 1,
  repeat: 1,
  truncated: 0,
  "final-turn-method": 0,
};

function captured(scenario: string): A2Bundle {
  const run = spawnSync(
    "python",
    ["-m", "python.astra_bridge.a2_capture", "--scenario", scenario],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 262145,
      env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  return validateA2Bundle(JSON.parse(run.stdout), lock);
}

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

test("rebuilt requests match captured requests", () => {
  for (const scenario of SCENARIOS) {
    const bundle = captured(scenario);
    const rebuilt = rebuildA2Requests(bundle.profile, bundle.problem, bundle.receipts);
    assert.equal(rebuilt.length, EXPECTED_COUNTS[scenario]);
    assert.equal(bundle.requests.length, EXPECTED_COUNTS[scenario]);
    assert.deepEqual(rebuilt, bundle.requests);
    assert.equal(compareA2Requests(bundle.requests, rebuilt).status, "REQUEST_IDENTICAL");
    for (let index = 0; index < rebuilt.length; index += 1) {
      assert.equal(a2Hash(rebuilt[index]), bundle.requestHashes[index]);
    }
    assert.equal(bundle.methodLoads, EXPECTED_LOADS[scenario]);
    assert.equal(bundle.toolExecutions, 0);
    assert.equal(bundle.result.candidateVerified, false);
    if (scenario === "truncated" || scenario === "final-turn-method") {
      assert.equal(bundle.result.status, "unsolved");
    } else {
      assert.equal(bundle.result.status, "candidate");
    }
  }
});

test("replay is read-only and rejects a changed request", () => {
  const bundle = captured("repeat");
  const rebuilt = rebuildA2Requests(bundle.profile, bundle.problem, bundle.receipts);
  const session = new A2ReplaySession(bundle, lock);
  const changed = clone(rebuilt[0]!);
  changed.messages[0] = {
    ...changed.messages[0]!,
    content: `${changed.messages[0]!.content}PRIVATE_CHANGE`,
  };
  assert.throws(() => session.next(changed), { code: "PACKET_BINDING" });
  assert.deepEqual(session.snapshot(), { consumed: 0, remaining: 3 });
  for (let index = 0; index < rebuilt.length; index += 1) {
    assert.deepEqual(session.next(rebuilt[index]!), bundle.receipts[index]);
  }
  assert.deepEqual(session.snapshot(), { consumed: 3, remaining: 0 });
  assert.throws(() => session.next(rebuilt[0]!), { code: "FIXTURE_EXHAUSTED" });
  const external = clone(bundle);
  const isolated = new A2ReplaySession(external, lock);
  external.receipts[0] = { transport: "COMPLETE", text: "PRIVATE_CHANGE" };
  const receipt = isolated.next(rebuilt[0]!);
  assert.equal(receipt.text, bundle.receipts[0]!.text);
  assert.equal(Object.isFrozen(receipt), true);
});

test("difference reports carry fixed codes only", () => {
  const bundle = captured("direct");
  const expected = bundle.requests;
  const actual = clone(expected);
  actual[0]!.messages.push({ role: "user", content: "PRIVATE_DIFF" });
  actual[0] = { ...actual[0]!, temperature: "1", maxTokens: 1 };
  const report = compareA2Requests(expected, actual);
  assert.equal(report.status, "DIFFERENT");
  assert.deepEqual(
    report.differences.map((entry) => entry.code).sort(),
    ["MAX_TOKENS", "MESSAGES", "TEMPERATURE"],
  );
  const text = JSON.stringify(report);
  assert.equal(text.includes("PRIVATE_DIFF"), false);
  assert.equal(text.includes(bundle.problem), false);
  assert.equal(text.includes(bundle.receipts[0]!.text), false);
  const short = compareA2Requests(expected, []);
  assert.deepEqual(short.differences, [{ index: -1, code: "REQUEST_COUNT" }]);
  const frozen = a2Request(expected[0]!);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.messages), true);
  assert.equal(a2Hash({ b: 1, a: 2 }), a2Hash({ a: 2, b: 1 }));
  assert.equal(a2Hash({ text: "A2 offline alignment \u03b1\u{1f600}" }), a2Hash({ text: bundle.problem }));
});

test("P2 work-packet context is not the a2 request", () => {
  const bundle = captured("direct");
  const contract = compileP2Contract(bundle.problem, "p2-difference");
  const ledger = new ContractLedger(contract);
  const task = ledger.startTask(contract.tasks[0]!.taskId);
  const registry = new P2RouteRegistry();
  const registered = registry.register({
    routeId: "r",
    representation: "rep",
    operation: "op",
    lemmas: [],
    construction: "split",
  });
  const prepared = prepareP2Context(
    ledger.snapshot(),
    task,
    registered,
    "r1",
    [],
    [],
    [],
  );
  const candidate = { ...bundle.requests[0]!, messages: prepared.messages };
  const report = compareA2Requests(bundle.requests, [candidate]);
  assert.equal(report.status, "DIFFERENT");
  assert.deepEqual(report.differences, [{ index: 0, code: "MESSAGES" }]);
});

test("canonical hash matches Python canonical_hash", () => {
  const value = JSON.parse(
    '{"\\ue000":1,"\\ud83d\\ude00":2,"\\u4e2d\\u6587":3,"ascii":4,"__proto__":5,"z":6,"a":7}',
  ) as Record<string, unknown>;
  const run = spawnSync(
    "python",
    [
      "-c",
      "import json,sys;from python.astra_bridge.a2_capture import canonical_hash;print(canonical_hash(json.loads(sys.stdin.read())))",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
      input: JSON.stringify(value),
      env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.equal(a2Hash(value), run.stdout.trim());
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.throws(() => a2Hash({ bad: "\ud800" }), { code: "PACKET_SCHEMA" });
  assert.throws(() => a2Hash({ number: 0.5 }), { code: "PACKET_SCHEMA" });
});

test("bundle negative controls reject tampering", () => {
  const bundle = captured("direct");
  const bad = (mutate: (copy: Mutable<A2Bundle>) => void, code: string) => {
    const copy = clone(bundle);
    mutate(copy);
    assert.throws(() => validateA2Bundle(copy, lock), { code });
  };
  const extra = clone(bundle) as Mutable<A2Bundle> & { extra?: number };
  extra.extra = 1;
  assert.throws(() => validateA2Bundle(extra, lock), { code: "PACKET_SCHEMA" });
  const sourceName = Object.keys(lock)[0] as string;
  bad((copy) => {
    const sources = { ...copy.profile.sources, [sourceName]: "0".repeat(64) };
    const profile = { ...copy.profile, sources };
    copy.profile = profile;
    copy.profileHash = a2Hash(profile);
  }, "VERSION_MISMATCH");
  bad((copy) => {
    copy.profileHash = "0".repeat(64);
  }, "PACKET_BINDING");
  bad((copy) => {
    const requests: Mutable<A2Request>[] = copy.requests.map((row) => ({
      ...row,
      messages: [...row.messages],
    }));
    requests[0] = {
      ...requests[0]!,
      messages: [
        requests[0]!.messages[0]!,
        { role: "user", content: "PRIVATE_CHANGE" },
      ],
    };
    copy.requests = requests;
    copy.requestHashes = requests.map((row) => a2Hash(row));
  }, "PACKET_BINDING");
  bad((copy) => {
    const requests: Mutable<A2Request>[] = copy.requests.map((row) => ({
      ...row,
      messages: [...row.messages],
    }));
    const messages = [...requests[0]!.messages].reverse();
    requests[0] = { ...requests[0]!, messages };
    copy.requests = requests;
    copy.requestHashes = requests.map((row) => a2Hash(row));
  }, "PACKET_BINDING");
  bad((copy) => {
    const requests: Mutable<A2Request>[] = copy.requests.map((row) => ({ ...row, maxTokens: 0 }));
    copy.requests = requests;
    copy.requestHashes = requests.map((row) => a2Hash(row));
  }, "PACKET_SCHEMA");
  bad((copy) => {
    const requests: Mutable<A2Request>[] = copy.requests.map((row) => ({
      ...row,
      temperature: "0.5",
    }));
    copy.requests = requests;
    copy.requestHashes = requests.map((row) => a2Hash(row));
  }, "PACKET_SCHEMA");
  bad((copy) => {
    copy.result = { ...copy.result, candidateVerified: true as unknown as false };
  }, "PACKET_SCHEMA");
  bad((copy) => {
    copy.receipts = [{ transport: "COMPLETE", text: "\ud800" }];
  }, "PACKET_SCHEMA");
  bad((copy) => {
    copy.receipts = [{ transport: "TRUNCATED", text: copy.receipts[0]!.text }];
  }, "PACKET_BINDING");
  const rebuilt = rebuildA2Requests(bundle.profile, bundle.problem, bundle.receipts);
  const session = new A2ReplaySession(bundle, lock);
  assert.deepEqual(session.next(rebuilt[0]!), bundle.receipts[0]);
});

test("builder negative controls reject illegal receipts", () => {
  const bundle = captured("direct");
  const profile = bundle.profile;
  const problem = bundle.problem;
  const finalText = bundle.receipts[0]!.text;
  const badReceipt = (text: unknown, code: string) => {
    assert.throws(
      () => rebuildA2Requests(profile, problem, [{ transport: "COMPLETE", text } as never]),
      { code },
    );
  };
  badReceipt(null, "PACKET_SCHEMA");
  badReceipt([], "PACKET_SCHEMA");
  badReceipt("null", "PACKET_SCHEMA");
  badReceipt("[]", "PACKET_SCHEMA");
  badReceipt('{"action":"final","action":"final"}', "PACKET_SCHEMA");
  badReceipt('{"action":"tool","id":"x"}', "NOT_REUSABLE");
  badReceipt('{"action":"method","id":"other"}', "NOT_REUSABLE");
  badReceipt('{"action":"final","answer":"","complete":true,"unresolved":[]}', "NOT_REUSABLE");
  badReceipt('{"action":"final","answer":"   ","complete":true,"unresolved":[]}', "NOT_REUSABLE");
  badReceipt('{"action":"final","answer":"x","complete":false,"unresolved":[]}', "NOT_REUSABLE");
  assert.throws(
    () =>
      rebuildA2Requests(profile, problem, [
        { transport: "COMPLETE", text: finalText },
        { transport: "COMPLETE", text: finalText },
      ]),
    { code: "ILLEGAL_TRANSITION" },
  );
  const methodText = '{"action":"method","id":"linearization-spectral"}';
  const bigProfile = {
    ...profile,
    loadedFeedback: `${profile.loadedFeedback}${"x".repeat(60000)}`,
  };
  assert.throws(
    () =>
      rebuildA2Requests(bigProfile, problem, [
        { transport: "COMPLETE", text: methodText },
        { transport: "COMPLETE", text: methodText },
      ]),
    { code: "BOUND_EXCEEDED" },
  );
});
