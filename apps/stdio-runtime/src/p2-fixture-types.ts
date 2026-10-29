/**
 * @astra/stdio-runtime — P2-A offline fixture composition types and guards.
 *
 * Types plus configuration/unit validation only. The runner that composes
 * M1/M3/runtime-core lives in a separate module. Nothing here performs I/O,
 * reads the environment or calls a method port.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P2_TRANSPORT_STATUS,
  detectLoneSurrogates,
  p2Snapshot,
  type P2Artifact,
  type P2ArtifactRef,
  type P2Contract,
  type P2ErrorCode,
  type P2MethodPort,
  type P2MethodUse,
  type P2PacketDelivery,
  type P2TransportStatus,
} from "@astra/protocol";
import type { P2ArtifactEntry, P2PreparedContext, P2RouteInput } from "@astra/math-workunit";

const MAX_SHORT = 256;
const MAX_ID = 64;
const MAX_TEXT_BYTES = 65536;
const MAX_UNITS = 3;
const MAX_ROUTES = 2;
const MAX_METHODS = 2;
const MAX_METHOD_CHARS = 24000;
const MAX_REMAINING_MS = 5000;

/** One synthetic fixture work unit. `text` is a raw receipt, never a path. */
export interface P2FixtureUnit {
  readonly taskId: string;
  readonly routeId: string;
  readonly methodIds: readonly string[];
  readonly transportStatus: P2TransportStatus;
  readonly text: string;
}

/** Trusted fixture configuration. `methodPort`/`now` are host-injected. */
export interface P2FixtureOptions {
  readonly routes: readonly P2RouteInput[];
  readonly maxWorkUnits: number;
  readonly remainingMs: number;
  readonly maxMethods: number;
  readonly maxMethodChars: number;
  readonly methodPort?: P2MethodPort | null;
  readonly now?: () => number;
}

/** One prepared request plus its private fixture-side bookkeeping. */
export interface P2FixtureRequest extends P2PreparedContext {
  readonly requestId: string;
  readonly taskId: string;
  readonly methodUses: readonly P2MethodUse[];
  readonly transportStatus: P2TransportStatus;
  readonly rawResponseText: string;
  readonly artifactRef: P2ArtifactRef | null;
  readonly errorCode: P2ErrorCode | null;
}

export type P2FixtureStop =
  | "BUDGET_EXHAUSTED"
  | "FIXTURE_EXHAUSTED"
  | "DEADLINE_EXCEEDED"
  | "TASK_NOT_READY"
  | "PACKET_REJECTED"
  | "TRANSPORT_STOP"
  | "CONTEXT_TOO_LARGE";

export interface P2FixtureTrace {
  readonly unit: number;
  readonly requestId: string;
  readonly deliveryStatus: P2PacketDelivery | "REJECTED";
  readonly code: P2ErrorCode | null;
}

/** Public summary carries no problem text, method body, raw error or path. */
export interface P2FixtureSummary {
  readonly mode: "MOCK_ONLY";
  readonly targetEnvironment: "TARGET_UNVERIFIED";
  readonly status: "candidate" | "unsolved";
  readonly candidateProposal: string | null;
  readonly candidateVerified: false;
  readonly strictAcceptance: "NOT_PERFORMED";
  readonly stopReason: P2FixtureStop;
  readonly fixtureReceiptsConsumed: number;
  readonly methodLoadAttempts: number;
  readonly trace: readonly P2FixtureTrace[];
}

export interface P2FixturePrivateState {
  readonly contract: P2Contract;
  readonly artifacts: readonly P2ArtifactEntry[];
  readonly requests: readonly P2FixtureRequest[];
}

export interface P2FixtureResult {
  readonly summary: P2FixtureSummary;
  readonly privateState: P2FixturePrivateState;
}

function shape(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const own = Object.keys(value);
  if (own.length !== expected.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  for (const name of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
}

function boundedInt(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function shortText(value: unknown): string {
  if (typeof value !== "string" || !detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (value.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...value].length > MAX_SHORT) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function methodId(value: unknown): string {
  if (typeof value !== "string" || !detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const chars = [...value].length;
  if (chars < 1 || chars > MAX_ID) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function transportStatus(value: unknown): P2TransportStatus {
  if (typeof value !== "string" || !(P2_TRANSPORT_STATUS as readonly string[]).includes(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return value as P2TransportStatus;
}

function readUnit(raw: unknown): P2FixtureUnit {
  const node = shape(raw);
  exactKeys(node, ["taskId", "routeId", "methodIds", "transportStatus", "text"]);
  const taskId = shortText(node.taskId);
  const routeId = shortText(node.routeId);
  if (!Array.isArray(node.methodIds) || node.methodIds.length > MAX_METHODS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const methodIds = node.methodIds.map((entry) => methodId(entry));
  const status = transportStatus(node.transportStatus);
  if (typeof node.text !== "string" || !detectLoneSurrogates(node.text).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (Buffer.byteLength(node.text, "utf8") > MAX_TEXT_BYTES) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return { taskId, routeId, methodIds, transportStatus: status, text: node.text };
}

function readOptions(raw: unknown): P2FixtureOptions {
  const node = shape(raw);
  if (!Array.isArray(node.routes) || node.routes.length < 1 || node.routes.length > MAX_ROUTES) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const maxWorkUnits = boundedInt(node.maxWorkUnits, 0, MAX_UNITS);
  const remainingMs = boundedInt(node.remainingMs, 1, MAX_REMAINING_MS);
  const maxMethods = boundedInt(node.maxMethods, 0, MAX_METHODS);
  const maxMethodChars = boundedInt(node.maxMethodChars, 1, MAX_METHOD_CHARS);
  const now = node.now;
  if (now !== undefined && typeof now !== "function") {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const port = node.methodPort;
  if (port !== undefined && port !== null) {
    if (typeof port !== "object" || Array.isArray(port)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const candidate = port as Record<string, unknown>;
    if (typeof candidate.catalog !== "function" || typeof candidate.load !== "function") {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  return {
    routes: node.routes as readonly P2RouteInput[],
    maxWorkUnits,
    remainingMs,
    maxMethods,
    maxMethodChars,
    methodPort: (port ?? null) as P2MethodPort | null,
    ...(now === undefined ? {} : { now: now as () => number }),
  };
}

/**
 * Validate the fixture configuration and the unit list. The port is never
 * called and no environment is read; route contents are left to the runner's
 * strict `registerRoute`. The returned list is a frozen snapshot.
 */
export function validateP2FixtureUnits(
  units: readonly P2FixtureUnit[],
  options: P2FixtureOptions,
): readonly P2FixtureUnit[] {
  const config = readOptions(options);
  const raw = p2Snapshot(units);
  if (!Array.isArray(raw) || raw.length > MAX_UNITS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  void config;
  const list = raw.map((entry) => readUnit(entry));
  return p2Snapshot(list) as readonly P2FixtureUnit[];
}

export type { P2Artifact, P2ArtifactEntry, P2ArtifactRef, P2Contract, P2MethodPort, P2MethodUse };
