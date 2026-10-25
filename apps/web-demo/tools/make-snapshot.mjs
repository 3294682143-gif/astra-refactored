/**
 * G1 data pipeline — produce a REAL SessionLogSnapshot for the demo frontend.
 *
 * The snapshot is produced by the repository's own `runAgentLoop`, driven by the
 * repository's own scripted (offline, no-network) model/effect ports. Nothing in
 * the output is hand-written or hand-patched: if this script is re-run with the
 * same options it must reproduce the same record.
 *
 * Offline guarantees: no provider endpoint, no credentials, no network, no tool
 * execution on the host. The model port returns fixed scripted receipts.
 *
 * Usage (from anywhere):
 *   node apps/web-demo/tools/make-snapshot.mjs
 *
 * Outputs (all under apps/web-demo/fixtures/):
 *   session-sample.json       the real snapshot (demo data source)
 *   session-tampered.json     the same snapshot with TWO fields altered, used by
 *                             the audit demo to show ReplayRunner detects it
 *   session-sample.meta.json  census + replay verdict (reproducibility evidence)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReplayRunner, SESSION_LOG_KIND } from "@astra/runtime-core";
import { runAgentLoop } from "../../stdio-runtime/dist/src/agent-loop.js";
import { reactivePorts } from "../../stdio-runtime/dist/tests/agent-loop-test-support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "..", "fixtures");

/** The problem text is a generic arithmetic prompt; no question card, no answer table. */
const PROBLEM = "Compute 2+2";

/**
 * Budgets are deliberately modest and fully offline. maxReviews/maxR0 are raised
 * above the zero defaults so the log also covers review-class events rather than
 * only the happy path.
 */
const OPTIONS = Object.freeze({
  remainingMs: 20000,
  maxModelCalls: 8,
  maxWorkUnits: 3,
  maxEffects: 1,
  maxReviews: 1,
  maxR0: 1,
});

function census(events) {
  const seen = new Map();
  for (const event of events) {
    seen.set(event.kind, (seen.get(event.kind) ?? 0) + 1);
  }
  return Object.freeze({
    distinctKinds: seen.size,
    perKind: Object.fromEntries([...seen.entries()].sort()),
    missingKinds: SESSION_LOG_KIND.filter((kind) => !seen.has(kind)),
  });
}

/** Rebuild a plain snapshot object (frozen objects do not survive JSON round-trip). */
function plain(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function tamper(snapshot) {
  const out = plain(snapshot);
  for (const event of out.events) {
    if (event.kind === "FINAL") {
      event.data.finalResponse = "{999}";
    }
    if (event.kind === "MODEL_REQUEST" && typeof event.data.contextHash === "string") {
      // Replace a valid 64-hex hash with another valid 64-hex value: only the
      // chained integrity digest can catch this.
      event.data.contextHash = "a".repeat(64);
    }
  }
  return out;
}

async function main() {
  const ports = reactivePorts();
  const result = await runAgentLoop(PROBLEM, "demo-session", OPTIONS, {
    model: ports.model,
    effect: ports.effect,
  });

  const snapshot = result.privateState.sessionLog;
  if (snapshot === undefined || snapshot === null) {
    throw new Error("runAgentLoop returned no sessionLog snapshot");
  }

  const runner = new ReplayRunner();
  const replay = runner.replay(snapshot);

  const sample = plain(snapshot);
  const tampered = tamper(snapshot);
  const replayTampered = runner.replay(tampered);

  const meta = Object.freeze({
    generatedBy: "apps/web-demo/tools/make-snapshot.mjs",
    producedByRepoCode: true,
    problemText: PROBLEM,
    options: OPTIONS,
    schemaVersion: sample.schemaVersion,
    version: sample.version,
    eventCount: sample.events.length,
    census: census(sample.events),
    replay: {
      ok: replay.ok,
      mismatches: replay.mismatches,
      requestCount: replay.requests.length,
      finalStatus: replay.final === null ? null : replay.final["status"],
      finalCandidateVerified:
        replay.final === null ? null : replay.final["candidateVerified"],
    },
    tamperCheck: {
      ok: replayTampered.ok,
      mismatches: replayTampered.mismatches,
    },
    runSummary: {
      status: result.summary.status,
      finalResponse: result.summary.finalResponse,
      stopReason: result.summary.stopReason ?? null,
    },
  });

  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(resolve(FIXTURE_DIR, "session-sample.json"), JSON.stringify(sample, null, 2) + "\n", "utf8");
  writeFileSync(resolve(FIXTURE_DIR, "session-tampered.json"), JSON.stringify(tampered, null, 2) + "\n", "utf8");
  writeFileSync(resolve(FIXTURE_DIR, "session-sample.meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({ eventCount: meta.eventCount, census: meta.census, replay: meta.replay, tamperCheck: meta.tamperCheck }, null, 2));
}

await main();
