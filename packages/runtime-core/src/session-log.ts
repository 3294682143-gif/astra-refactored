/**
 * @astra/runtime-core — DSH-inspired immutable SessionLog + Pi-inspired
 * ContextProjector and a read-only deterministic ReplayRunner (G4/PR5 Slice 4a).
 *
 * One ordered, immutable, schema-versioned event log is the single source of
 * truth for what the model actually saw. Every model request's visible context
 * and `requestHash` is a deterministic projection of the log prefix; a cache is
 * only ever a view derived from an event version and can never become the
 * source itself. The ReplayRunner re-derives every projected request and the
 * final view from a log snapshot with no model/effect port and no clock; the
 * public trace is strictly separated from the private raw text.
 *
 * Pure module: no I/O, no network, no clock, no model/effect call.
 */

import { detectLoneSurrogates, p2Snapshot, p4Hash } from "@astra/protocol";

export const SESSION_LOG_SCHEMA_VERSION = "session-log-v1" as const;
export type SessionLogSchemaVersion = typeof SESSION_LOG_SCHEMA_VERSION;

/** Fixed event kinds; no free-form kind is accepted. */
export const SESSION_LOG_KIND = [
  "SESSION_INIT",
  "CONTRACT",
  "CONTRACT_REVISED",
  "MODEL_REQUEST",
  "TASK_STARTED",
  "WORKUNIT",
  "TOOL_OBSERVATION",
  "METHOD_LOAD",
  "REVIEW_CHALLENGE",
  "REPAIR",
  "FINAL",
] as const;
export type SessionLogKind = (typeof SESSION_LOG_KIND)[number];

/** One ordered immutable event. `seq` is assigned by the log, never a caller. */
export interface SessionLogEvent {
  readonly seq: number;
  readonly schemaVersion: SessionLogSchemaVersion;
  readonly kind: SessionLogKind;
  /** Structured payload; bounded and frozen. Never carries a provider secret. */
  readonly data: Readonly<Record<string, unknown>>;
}

const MAX_EVENTS = 1024;
const MAX_DATA_BYTES = 262144;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * An append-only, immutable, schema-versioned session event log. `append`
 * refuses an unknown kind, a non-object payload, an oversized payload, a lone
 * surrogate or a duplicate sequence; the returned snapshot is deep-frozen so a
 * caller can never mutate the source of truth.
 */
export class SessionLog {
  private readonly records: SessionLogEvent[] = [];

  get length(): number {
    return this.records.length;
  }

  append(kind: SessionLogKind, data: Record<string, unknown>): SessionLogEvent {
    if (!(SESSION_LOG_KIND as readonly string[]).includes(kind)) {
      throw new Error("SESSION_LOG_KIND");
    }
    if (!isPlainObject(data) || !detectLoneSurrogates(data).ok) {
      throw new Error("SESSION_LOG_DATA");
    }
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (bytes > MAX_DATA_BYTES) {
      throw new Error("SESSION_LOG_BOUND");
    }
    if (this.records.length >= MAX_EVENTS) {
      throw new Error("SESSION_LOG_BOUND");
    }
    const event: SessionLogEvent = Object.freeze({
      seq: this.records.length + 1,
      schemaVersion: SESSION_LOG_SCHEMA_VERSION,
      kind,
      data: p2Snapshot(data) as Readonly<Record<string, unknown>>,
    });
    this.records.push(event);
    return event;
  }

  events(): readonly SessionLogEvent[] {
    return Object.freeze([...this.records]);
  }

  /** Deterministic frozen view: exactly the ordered events and a version. */
  snapshot(): { readonly schemaVersion: SessionLogSchemaVersion; readonly version: number; readonly events: readonly SessionLogEvent[] } {
    return p2Snapshot({
      schemaVersion: SESSION_LOG_SCHEMA_VERSION,
      version: this.records.length,
      events: this.records,
    }) as {
      readonly schemaVersion: SessionLogSchemaVersion;
      readonly version: number;
      readonly events: readonly SessionLogEvent[];
    };
  }
}

export interface SessionLogSnapshot {
  readonly schemaVersion: SessionLogSchemaVersion;
  readonly version: number;
  readonly events: readonly SessionLogEvent[];
}

export interface ProjectedRequest {
  readonly seq: number;
  readonly phase: string;
  readonly requestId: string;
  readonly contextHash: string;
  readonly contextBytes: number;
  /** The public, safe projection: never the raw visible text. */
  readonly visibleRoles: readonly string[];
}

function hashOfMessages(messages: unknown): { readonly contextHash: string; readonly contextBytes: number } {
  const serialized = JSON.stringify(messages);
  return {
    contextHash: p4Hash(serialized),
    contextBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/**
 * Pi-inspired `prepareRequest` boundary: the model-visible context is projected
 * from the log, not stored authoritatively anywhere else. The projection is a
 * pure function of one recorded request event; the hash is recomputed from the
 * recorded messages so a drift between the log and any request is impossible.
 */
export class ContextProjector {
  /** Project one MODEL_REQUEST event into its request identity. */
  prepareRequest(event: SessionLogEvent): ProjectedRequest {
    if (event.kind !== "MODEL_REQUEST") {
      throw new Error("SESSION_LOG_KIND");
    }
    const data = event.data;
    const phase = data.phase;
    const requestId = data.requestId;
    const messages = data.messages;
    if (typeof phase !== "string" || typeof requestId !== "string" || !Array.isArray(messages)) {
      throw new Error("SESSION_LOG_DATA");
    }
    const { contextHash, contextBytes } = hashOfMessages(messages);
    const declared = data.contextHash;
    if (typeof declared !== "string" || declared !== contextHash) {
      throw new Error("SESSION_LOG_HASH_MISMATCH");
    }
    const visibleRoles = messages.map((row) =>
      isPlainObject(row) && typeof row.role === "string" ? row.role : "",
    );
    return Object.freeze({
      seq: event.seq,
      phase,
      requestId,
      contextHash,
      contextBytes,
      visibleRoles: Object.freeze(visibleRoles),
    });
  }

  /** Project every request in order; the whole-request projection of one log. */
  projectAll(snapshot: SessionLogSnapshot): readonly ProjectedRequest[] {
    const out: ProjectedRequest[] = [];
    for (const event of snapshot.events) {
      if (event.kind === "MODEL_REQUEST") {
        out.push(this.prepareRequest(event));
      }
    }
    return Object.freeze(out);
  }
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly schemaVersion: SessionLogSchemaVersion;
  readonly requests: readonly ProjectedRequest[];
  readonly mismatches: readonly number[];
  /** The final view recorded by the FINAL event, or null when absent. */
  readonly final: Readonly<Record<string, unknown>> | null;
}

/**
 * In-process read-only replay. It re-projects every MODEL_REQUEST from the log
 * and re-reads the FINAL view; it calls no model/effect port, reads no clock and
 * performs no I/O. `ok` is true iff every projected request hash matches the
 * recorded one and the model-visible projection is byte-stable.
 */
export class ReplayRunner {
  private readonly projector = new ContextProjector();

  replay(snapshot: SessionLogSnapshot): ReplayResult {
    const mismatches: number[] = [];
    const requests: ProjectedRequest[] = [];
    let final: Readonly<Record<string, unknown>> | null = null;
    let expectedSeq = 1;
    for (const event of snapshot.events) {
      if (event.seq !== expectedSeq) {
        mismatches.push(event.seq);
      }
      expectedSeq = event.seq + 1;
      if (event.kind === "MODEL_REQUEST") {
        const projected = this.projector.prepareRequest(event);
        requests.push(projected);
      } else if (event.kind === "FINAL") {
        final = event.data;
      }
    }
    return Object.freeze({
      ok: mismatches.length === 0,
      schemaVersion: snapshot.schemaVersion,
      requests: Object.freeze(requests),
      mismatches: Object.freeze(mismatches),
      final,
    });
  }

  /** Public safe trace: only request identities, never the raw private text. */
  publicTrace(snapshot: SessionLogSnapshot): readonly ProjectedRequest[] {
    return this.projector.projectAll(snapshot);
  }
}
