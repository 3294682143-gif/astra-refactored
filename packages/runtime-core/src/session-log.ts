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
  "CONSENSUS",
  "TRUNCATION",
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

/**
 * Tamper-detection: every event carries an in-band chained digest (`data.__chain`)
 * over the persisted event form. `MODEL_REQUEST` is projected to
 * {phase,requestId,contextHash,contextBytes} (its messages are replaced by the
 * context hash on the wire), so the chain is identical in-process and after
 * transport; replacing `contextHash` with any other 64-hex value breaks it. The
 * digest lives inside the free-form `data`, so no schema/transport change is
 * needed and it survives the checkpoint/resume copy.
 */
function chainInput(kind: string, data: Readonly<Record<string, unknown>>): string {
  if (kind === "MODEL_REQUEST") {
    return JSON.stringify({ phase: data.phase, requestId: data.requestId, contextHash: data.contextHash, contextBytes: data.contextBytes });
  }
  const { __chain, ...rest } = data as Record<string, unknown>;
  void __chain;
  return JSON.stringify(rest);
}

function chainedEvent(kind: string, data: Readonly<Record<string, unknown>>, previous: string): string {
  return p4Hash(previous + "|" + kind + "|" + chainInput(kind, data));
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
    const frozen = p2Snapshot(data) as Readonly<Record<string, unknown>>;
    const previous =
      this.records.length === 0 ? "" : String((this.records[this.records.length - 1] as SessionLogEvent).data["__chain"] ?? "");
    const event: SessionLogEvent = Object.freeze({
      seq: this.records.length + 1,
      schemaVersion: SESSION_LOG_SCHEMA_VERSION,
      kind,
      data: p2Snapshot({ ...frozen, __chain: chainedEvent(kind, frozen, previous) }) as Readonly<Record<string, unknown>>,
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
    if (typeof phase !== "string" || typeof requestId !== "string") {
      throw new Error("SESSION_LOG_DATA");
    }
    // A transported/checkpointed log replaces the bulky `messages` with the
    // recorded context hash; identity is then the declared hash (which can no
    // longer be recomputed, so it is compared as declared, never silently).
    if (!Array.isArray(messages)) {
      const declaredOnly = data.contextHash;
      if (typeof declaredOnly !== "string" || !/^[0-9a-f]{64}$/u.test(declaredOnly)) {
        throw new Error("SESSION_LOG_DATA");
      }
      const declaredBytes = data.contextBytes;
      return Object.freeze({
        seq: event.seq,
        phase,
        requestId,
        contextHash: declaredOnly,
        contextBytes: typeof declaredBytes === "number" ? declaredBytes : 0,
        visibleRoles: Object.freeze([] as string[]),
      });
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
    let finalSeq = 0;
    let derivedAnswer: string | null = null;
    let chain = "";
    let expectedSeq = 1;
    for (const event of snapshot.events) {
      chain = chainedEvent(event.kind, event.data, chain);
      if (event.data["__chain"] !== chain) {
        mismatches.push(event.seq);
      }
      if (event.seq !== expectedSeq) {
        mismatches.push(event.seq);
      }
      expectedSeq = event.seq + 1;
      if (event.kind === "MODEL_REQUEST") {
        try {
          requests.push(this.projector.prepareRequest(event));
        } catch {
          // A tampered request hash/messages is a mismatch, never a throw.
          mismatches.push(event.seq);
        }
      } else if (event.kind === "WORKUNIT" || event.kind === "REPAIR") {
        const data = event.data;
        const proposal = data.candidateProposal;
        const delivered =
          event.kind === "WORKUNIT" ? data.deliveryStatus === "COMPLETE" : data.accepted === true;
        if (delivered && typeof proposal === "string" && proposal.trim().length > 0) {
          derivedAnswer = proposal;
        }
      } else if (event.kind === "FINAL") {
        final = event.data;
        finalSeq = event.seq;
      }
    }
    // Re-derive the final answer from the log and compare it byte-for-byte with
    // the FINAL event. Tampering the FINAL answer, an intermediate delivered
    // candidate, or any request hash is detected as a mismatch (ok=false).
    if (final !== null) {
      const declaredStatus = final["status"];
      const declaredResponse = final["finalResponse"];
      if (typeof declaredResponse !== "string") {
        mismatches.push(finalSeq);
      } else if (declaredStatus === "candidate") {
        if (derivedAnswer === null || declaredResponse !== derivedAnswer) {
          mismatches.push(finalSeq);
        }
      } else if (derivedAnswer !== null && declaredResponse === derivedAnswer) {
        // An UNSOLVED verdict must never restate a delivered candidate answer.
        mismatches.push(finalSeq);
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
