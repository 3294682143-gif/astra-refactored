/**
 * @astra/runtime-core — a2 short-path offline replay (pure memory only).
 *
 * No I/O, no filesystem, no network, no client, no method dispatch, no tool
 * execution and no background loop. A hash is data integrity, not
 * authentication and not a mathematical proof.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2Snapshot,
  type A2Bundle,
  type A2Receipt,
  type A2Request,
} from "@astra/protocol";

import { a2Hash, a2Profile, a2Request } from "./p2-a2-data.js";

export { a2Hash, a2Profile, a2Request } from "./p2-a2-data.js";

const MAX_BYTES = 262144;
const MAX_PROBLEM_CHARS = 8192;
const MAX_RECEIPT_CHARS = 65536;
const MAX_REQUESTS = 3;
const SCENARIOS = ["direct", "method", "repeat", "truncated", "final-turn-method"] as const;
const TRANSPORTS = ["COMPLETE", "TRUNCATED"] as const;
const STATUSES = ["candidate", "unsolved"] as const;
const CLOSEOUTS = ["final_complete", "incomplete_transport", "method_budget_exhausted"] as const;
const BUNDLE_KEYS = [
  "schemaVersion",
  "scenario",
  "problem",
  "profile",
  "profileHash",
  "requests",
  "requestHashes",
  "receipts",
  "result",
  "methodLoads",
  "toolExecutions",
] as const;
const RECEIPT_KEYS = ["transport", "text"] as const;
const RESULT_KEYS = ["status", "candidateVerified", "closeout"] as const;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(code: keyof typeof P2_ERROR_CODES): never {
  throw new P2Error(P2_ERROR_CODES[code]);
}

function codePointLength(value: string): number | null {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return null;
      }
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    }
    count += 1;
  }
  return count;
}

function exactKeys(node: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    fail("PACKET_SCHEMA");
  }
  const record = node as Record<string, unknown>;
  const own = Object.keys(record);
  if (own.length !== keys.length) {
    fail("PACKET_SCHEMA");
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      fail("PACKET_SCHEMA");
    }
  }
  return record;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("PACKET_SCHEMA");
  }
  const length = codePointLength(value);
  if (length === null || length > max) {
    fail("PACKET_SCHEMA");
  }
  return value;
}

function a2Receipt(value: unknown): A2Receipt {
  const record = exactKeys(p2Snapshot(value), RECEIPT_KEYS);
  const transport = record["transport"];
  if (typeof transport !== "string" || !(TRANSPORTS as readonly string[]).includes(transport)) {
    fail("PACKET_SCHEMA");
  }
  const text = boundedString(record["text"], MAX_RECEIPT_CHARS);
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_CHARS) {
    fail("BOUND_EXCEEDED");
  }
  return p2Snapshot({ transport: transport as A2Receipt["transport"], text });
}

/** Strict a2 bundle bound to a trusted source lock. */
export function validateA2Bundle(
  value: unknown,
  trustedSources: Readonly<Record<string, string>>,
): A2Bundle {
  const snapshot = p2Snapshot(value);
  const record = exactKeys(snapshot, BUNDLE_KEYS);
  if (record["schemaVersion"] !== "a2-shortpath-bundle-v1") {
    fail("PACKET_SCHEMA");
  }
  const scenario = record["scenario"];
  if (typeof scenario !== "string" || !(SCENARIOS as readonly string[]).includes(scenario)) {
    fail("PACKET_SCHEMA");
  }
  const problem = boundedString(record["problem"], MAX_PROBLEM_CHARS);
  const profile = a2Profile(record["profile"], trustedSources);
  const profileHash = record["profileHash"];
  if (typeof profileHash !== "string" || !HEX64.test(profileHash)) {
    fail("PACKET_SCHEMA");
  }
  if (profileHash !== a2Hash(profile)) {
    fail("PACKET_BINDING");
  }
  const expectedSteps = scenario === "final-turn-method" ? 1 : 3;
  if (profile.maxSteps !== expectedSteps) {
    fail("PACKET_BINDING");
  }
  const rawRequests = record["requests"];
  const rawHashes = record["requestHashes"];
  const rawReceipts = record["receipts"];
  if (!Array.isArray(rawRequests) || !Array.isArray(rawHashes) || !Array.isArray(rawReceipts)) {
    fail("PACKET_SCHEMA");
  }
  const count = rawRequests.length;
  if (count < 1 || count > MAX_REQUESTS || count > profile.maxSteps) {
    fail("BOUND_EXCEEDED");
  }
  if (rawHashes.length !== count || rawReceipts.length !== count) {
    fail("PACKET_BINDING");
  }
  const requests: A2Request[] = [];
  const requestHashes: string[] = [];
  const receipts: A2Receipt[] = [];
  let truncated = false;
  for (let index = 0; index < count; index += 1) {
    const request = a2Request(rawRequests[index]);
    if (request.temperature !== profile.temperature || request.maxTokens !== profile.maxTokens) {
      fail("PACKET_BINDING");
    }
    const first = request.messages[0];
    const second = request.messages[1];
    if (
      request.messages.length < 2 ||
      first?.role !== "system" ||
      first.content !== profile.systemPrompt ||
      second?.role !== "user" ||
      second.content !== problem
    ) {
      fail("PACKET_BINDING");
    }
    const digest = rawHashes[index];
    if (typeof digest !== "string" || !HEX64.test(digest)) {
      fail("PACKET_SCHEMA");
    }
    if (digest !== a2Hash(request)) {
      fail("PACKET_BINDING");
    }
    const receipt = a2Receipt(rawReceipts[index]);
    if (receipt.transport === "TRUNCATED") {
      truncated = true;
    }
    requests.push(request);
    requestHashes.push(digest);
    receipts.push(receipt);
  }
  const result = exactKeys(record["result"], RESULT_KEYS);
  const status = result["status"];
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
    fail("PACKET_SCHEMA");
  }
  if (result["candidateVerified"] !== false) {
    fail("PACKET_SCHEMA");
  }
  const closeout = result["closeout"];
  if (typeof closeout !== "string" || !(CLOSEOUTS as readonly string[]).includes(closeout)) {
    fail("PACKET_SCHEMA");
  }
  if (status === "candidate" && truncated) {
    fail("PACKET_BINDING");
  }
  const methodLoads = record["methodLoads"];
  if (
    typeof methodLoads !== "number" ||
    !Number.isSafeInteger(methodLoads) ||
    methodLoads < 0 ||
    methodLoads > 2
  ) {
    fail("PACKET_SCHEMA");
  }
  if (record["toolExecutions"] !== 0) {
    fail("PACKET_SCHEMA");
  }
  const bundle: A2Bundle = {
    schemaVersion: "a2-shortpath-bundle-v1",
    scenario: scenario as A2Bundle["scenario"],
    problem,
    profile,
    profileHash,
    requests,
    requestHashes,
    receipts,
    result: {
      status: status as A2Bundle["result"]["status"],
      candidateVerified: false,
      closeout,
    },
    methodLoads,
    toolExecutions: 0,
  };
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > MAX_BYTES) {
    fail("BOUND_EXCEEDED");
  }
  return p2Snapshot(bundle);
}

export interface A2RequestDifference {
  readonly index: number;
  readonly code: "REQUEST_COUNT" | "MESSAGES" | "TEMPERATURE" | "MAX_TOKENS";
}

export interface A2RequestComparison {
  readonly status: "REQUEST_IDENTICAL" | "DIFFERENT";
  readonly expectedCount: number;
  readonly actualCount: number;
  readonly differences: readonly A2RequestDifference[];
}

/** Compare two request lists without echoing any message text or hash. */
export function compareA2Requests(
  expected: readonly A2Request[],
  actual: readonly A2Request[],
): A2RequestComparison {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    fail("PACKET_SCHEMA");
  }
  if (expected.length > MAX_REQUESTS || actual.length > MAX_REQUESTS) {
    fail("BOUND_EXCEEDED");
  }
  const left = expected.map((item) => a2Request(item));
  const right = actual.map((item) => a2Request(item));
  const differences: A2RequestDifference[] = [];
  if (left.length !== right.length) {
    differences.push({ index: -1, code: "REQUEST_COUNT" });
  }
  const overlap = Math.min(left.length, right.length);
  for (let index = 0; index < overlap; index += 1) {
    const a = left[index] as A2Request;
    const b = right[index] as A2Request;
    if (a2Hash(a.messages) !== a2Hash(b.messages)) {
      differences.push({ index, code: "MESSAGES" });
    }
    if (a.temperature !== b.temperature) {
      differences.push({ index, code: "TEMPERATURE" });
    }
    if (a.maxTokens !== b.maxTokens) {
      differences.push({ index, code: "MAX_TOKENS" });
    }
  }
  return p2Snapshot({
    status: differences.length === 0 ? "REQUEST_IDENTICAL" : "DIFFERENT",
    expectedCount: left.length,
    actualCount: right.length,
    differences,
  });
}

/** Read-only replay cursor over one validated bundle. */
export class A2ReplaySession {
  readonly #bundle: A2Bundle;
  #cursor = 0;

  constructor(bundle: A2Bundle, trustedSources: Readonly<Record<string, string>>) {
    this.#bundle = validateA2Bundle(bundle, trustedSources);
  }

  next(request: A2Request): A2Receipt {
    const expected = this.#bundle.requests[this.#cursor];
    if (expected === undefined) {
      fail("FIXTURE_EXHAUSTED");
    }
    const candidate = a2Request(request);
    if (a2Hash(candidate) !== a2Hash(expected)) {
      fail("PACKET_BINDING");
    }
    const receipt = this.#bundle.receipts[this.#cursor] as A2Receipt;
    this.#cursor += 1;
    return p2Snapshot(receipt);
  }

  snapshot(): { consumed: number; remaining: number } {
    return p2Snapshot({
      consumed: this.#cursor,
      remaining: this.#bundle.requests.length - this.#cursor,
    });
  }
}
