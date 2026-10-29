/**
 * @astra/math-review — P4 R0 controller aggregation of the three role reviews
 * (pure, no I/O, no model call, no clock).
 *
 * The controller only summarises the fixed verdict vocabulary of the three
 * independent reviews. It never re-reads model text, never ranks severity and
 * never derives a mathematical claim: `NO_ISSUE` is not correctness, `ISSUES`
 * is not a refutation and `UNKNOWN` is not "almost fine". A role that never
 * settled is reported as `missing` instead of being silently dropped.
 *
 * Determination (first matching rule wins):
 *
 *   1. a role without a settled review        -> UNKNOWN (incomplete coverage)
 *   2. any role verdict is ISSUES             -> ISSUES
 *   3. any role verdict is UNKNOWN            -> UNKNOWN
 *   4. all three role verdicts are NO_ISSUE   -> NO_ISSUE
 *
 * `dissents` lists every role whose own verdict differs from the aggregate, in
 * the fixed MEANING, METHOD, TASK_TOOL order. `missing` roles are never
 * dissents: they carry no verdict at all.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P4_R0_ROLE,
  P4_R0_ROLE_DIMENSION,
  p2Snapshot,
  type P4R0Aggregate,
  type P4R0Dimension,
  type P4R0Dissent,
  type P4R0ReviewSnapshot,
  type P4R0Role,
  type P4R0Verdict,
} from "@astra/protocol";

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

/**
 * The single verdict one role recorded. A role with no record, an unusable
 * record (non-OK code) or a report without a check reads as `UNKNOWN`; a role
 * whose dimension does not match the record's own report is refused because
 * the two would otherwise be silently conflated.
 */
export function roleVerdictOf(snapshot: P4R0ReviewSnapshot): P4R0Verdict {
  const record = snapshot.record;
  if (record === null) {
    return "UNKNOWN";
  }
  if (record.role !== snapshot.role) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const report = record.report;
  if (record.code !== "OK" || report === null) {
    return "UNKNOWN";
  }
  if (report.role !== snapshot.role) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const expected = P4_R0_ROLE_DIMENSION[snapshot.role];
  const checks = report.checks;
  if (checks.length !== 1 || checks[0]?.dimension !== expected) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return checks[0].verdict;
}

/** True once a snapshot carries a settled (returned or unknown) record. */
function settledOf(snapshot: P4R0ReviewSnapshot): boolean {
  const state = snapshot.record?.state;
  return state === "RETURNED" || state === "OUTCOME_UNKNOWN";
}

/**
 * Aggregate the three settled role snapshots into one bounded conclusion.
 *
 * The snapshots may be supplied in any order and may contain duplicates; the
 * result is always ordered by the fixed role vocabulary. An empty or partial
 * list is never an error: every absent role is reported as `missing` and the
 * conclusion is `UNKNOWN`.
 */
export function aggregateP4R0Reviews(
  snapshots: readonly P4R0ReviewSnapshot[],
): P4R0Aggregate {
  if (!Array.isArray(snapshots)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const byRole = new Map<P4R0Role, P4R0ReviewSnapshot>();
  for (const snapshot of snapshots) {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const role = snapshot.role;
    if (!(P4_R0_ROLE as readonly string[]).includes(role)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (byRole.has(role)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    byRole.set(role, snapshot);
  }

  const present: P4R0Role[] = [];
  const missing: P4R0Role[] = [];
  const verdicts = new Map<P4R0Role, P4R0Verdict>();
  for (const role of P4_R0_ROLE) {
    const snapshot = byRole.get(role);
    if (snapshot === undefined || !settledOf(snapshot)) {
      missing.push(role);
      continue;
    }
    present.push(role);
    verdicts.set(role, roleVerdictOf(snapshot));
  }

  const dimensions: P4R0Dimension[] = present.map((role) => P4_R0_ROLE_DIMENSION[role]);
  const issueDimensions: P4R0Dimension[] = present
    .filter((role) => verdicts.get(role) === "ISSUES")
    .map((role) => P4_R0_ROLE_DIMENSION[role]);

  let conclusion: P4R0Aggregate["conclusion"];
  if (missing.length > 0) {
    conclusion = "UNKNOWN";
  } else if (issueDimensions.length > 0) {
    conclusion = "ISSUES";
  } else if (present.some((role) => verdicts.get(role) === "UNKNOWN")) {
    conclusion = "UNKNOWN";
  } else {
    conclusion = "NO_ISSUE";
  }

  const dissents: P4R0Dissent[] = [];
  for (const role of present) {
    const verdict = verdicts.get(role) ?? "UNKNOWN";
    if (verdict !== conclusion) {
      dissents.push(
        Object.freeze({
          role,
          dimension: P4_R0_ROLE_DIMENSION[role],
          verdict,
        }),
      );
    }
  }

  return p2Snapshot({
    conclusion,
    issueDimensions,
    dissents,
    coverage: {
      roles: present,
      missing,
      dimensions,
    },
  }) as P4R0Aggregate;
}
