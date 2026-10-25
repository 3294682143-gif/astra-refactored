/**
 * Independent verification probe (frontend reducer) for defects #3 and #4.
 * Usage: node tests/web_review/probe_reducer.mjs <treeRoot>
 * Read-only: imports the tree's pure reducer, folds synthetic events, prints JSON.
 */
import { pathToFileURL } from "node:url";

const tree = process.argv[2];
if (!tree) { console.error("usage: node probe_reducer.mjs <treeRoot>"); process.exit(2); }

const mod = await import(pathToFileURL(`${tree}/apps/web-demo/src/domain/reduceRun.ts`).href);
const { reduceRun, createInitialRunViewState } = mod;

function fold(events) {
  let s = createInitialRunViewState("probe-run");
  for (const e of events) s = reduceRun(s, e);
  return s;
}

const terminalCases = {
  TIMEOUT: { seq: 1, kind: "RESULT", payload: { stopReason: "TIMEOUT", final_response: "Unsolved." } },
  SPAWN_FAILED: { seq: 1, kind: "RESULT", payload: { stopReason: "SPAWN_FAILED", final_response: "Unsolved." } },
  CANCELLED: { seq: 1, kind: "RESULT", payload: { stopReason: "CANCELLED", final_response: "Unsolved." } },
  ERROR: { seq: 1, kind: "RESULT", payload: { stopReason: "ERROR", final_response: "Unsolved." } },
};
const terminalObserved = {};
for (const [name, ev] of Object.entries(terminalCases)) {
  const s = fold([ev]);
  terminalObserved[name] = { status: s.status, candidateVerified: s.candidateVerified };
}
const defect3_present = Object.values(terminalObserved).some((o) => o.status === "candidate");

const frOnly = fold([{ seq: 1, kind: "RESULT", payload: { status: "candidate", stopReason: "REVIEWS_COMPLETE", final_response: "x = 42" } }]);
const frFinalOnly = fold([{ seq: 1, kind: "FINAL", payload: { status: "candidate", final_response: "proof-ish text" } }]);
const defect4_present = !(
  frOnly.candidateProposal === "x = 42" &&
  frFinalOnly.candidateProposal === "proof-ish text" &&
  frOnly.finalResponseMissing === false &&
  frFinalOnly.finalResponseMissing === false
);

const redline_ok =
  Object.values(terminalObserved).every((o) => o.candidateVerified === false) &&
  frOnly.candidateVerified === false && frFinalOnly.candidateVerified === false;

console.log(JSON.stringify({
  tree,
  module_loaded: true,
  has_classifyRunStatus: typeof mod.classifyRunStatus === "function",
  defect3_terminal_statuses: terminalObserved,
  defect3_present,
  defect4_final_response: {
    result_only_candidateProposal: frOnly.candidateProposal,
    result_only_finalResponseMissing: frOnly.finalResponseMissing ?? "(field absent in this version)",
    final_only_candidateProposal: frFinalOnly.candidateProposal,
    final_only_finalResponseMissing: frFinalOnly.finalResponseMissing ?? "(field absent in this version)",
  },
  defect4_present,
  redline_candidateVerified_false: redline_ok,
}, null, 2));