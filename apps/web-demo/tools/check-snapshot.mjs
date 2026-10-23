/**
 * G1 judge — validate a SessionLogSnapshot for the demo frontend.
 *
 * This is the machine-checkable acceptance for the data pipeline: it must fail
 * loudly rather than pass on a fabricated or truncated snapshot.
 *
 * Usage:
 *   node apps/demo-web/tools/check-snapshot.mjs apps/demo-web/data/session-sample.json
 *
 * Exit 0 = PASS, exit 1 = FAIL. No network, no writes.
 */

import { readFileSync } from "node:fs";
import { ReplayRunner, SESSION_LOG_KIND, SESSION_LOG_SCHEMA_VERSION } from "@astra/runtime-core";

const REQUIRED_MIN_KINDS = 6;
const REQUIRED_MIN_EVENTS = 6;

const path = process.argv[2];
if (typeof path !== "string" || path.length === 0) {
  console.error("FAIL: usage: node check-snapshot.mjs <snapshot.json>");
  process.exit(1);
}

const failures = [];
const note = (message) => failures.push(message);

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`FAIL: cannot read/parse ${path}: ${error.message}`);
  process.exit(1);
}

// --- shape -----------------------------------------------------------------
if (snapshot.schemaVersion !== SESSION_LOG_SCHEMA_VERSION) {
  note(`schemaVersion ${JSON.stringify(snapshot.schemaVersion)} !== ${SESSION_LOG_SCHEMA_VERSION}`);
}
if (!Array.isArray(snapshot.events)) {
  note("events is not an array");
}

const events = Array.isArray(snapshot.events) ? snapshot.events : [];

// --- coverage --------------------------------------------------------------
if (events.length < REQUIRED_MIN_EVENTS) {
  note(`eventCount ${events.length} < required ${REQUIRED_MIN_EVENTS}`);
}

const kinds = new Set();
for (const event of events) {
  if (!SESSION_LOG_KIND.includes(event.kind)) {
    note(`unknown event kind ${JSON.stringify(event.kind)} at seq ${event.seq}`);
  }
  kinds.add(event.kind);
}
if (kinds.size < REQUIRED_MIN_KINDS) {
  note(`distinctKinds ${kinds.size} < required ${REQUIRED_MIN_KINDS}`);
}

// --- sequence integrity ----------------------------------------------------
const expected = events.map((_, index) => index + 1);
const actual = events.map((event) => event.seq);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  note(`seq is not a dense 1..N sequence: ${JSON.stringify(actual)}`);
}

// --- structural facts the demo relies on -----------------------------------
if (events.length > 0 && events[events.length - 1].kind !== "FINAL") {
  note(`last event kind ${JSON.stringify(events[events.length - 1].kind)} !== "FINAL"`);
}
if (!kinds.has("WORKUNIT")) {
  note('missing "WORKUNIT" event (candidate/artifact view would be empty)');
}
if (!kinds.has("MODEL_REQUEST")) {
  note('missing "MODEL_REQUEST" event (request-projection view would be empty)');
}

// --- replay verdict: the snapshot must be self-consistent ------------------
const runner = new ReplayRunner();
const replay = runner.replay(snapshot);
if (!replay.ok) {
  note(`ReplayRunner ok=false, mismatches=${JSON.stringify(replay.mismatches)}`);
}

// --- tamper detection: a forged answer/hash must be caught -----------------
const forged = JSON.parse(JSON.stringify(snapshot));
for (const event of forged.events) {
  if (event.kind === "FINAL") event.data.finalResponse = "{999}";
}
if (runner.replay(forged).ok) {
  note("ReplayRunner accepted a forged FINAL answer (tamper detection is not working)");
}

// --- report ----------------------------------------------------------------
console.log(
  JSON.stringify(
    {
      path,
      schemaVersion: snapshot.schemaVersion,
      eventCount: events.length,
      distinctKinds: kinds.size,
      perKind: Object.fromEntries([...kinds].sort().map((kind) => [kind, events.filter((e) => e.kind === kind).length])),
      replayOk: replay.ok,
      mismatches: replay.mismatches,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log("PASS: snapshot is a valid, replay-consistent session-log-v1 record");
