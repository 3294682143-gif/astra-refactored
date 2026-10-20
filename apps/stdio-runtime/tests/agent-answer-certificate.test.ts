import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateChoiceLetters,
  certificateCorrection,
  isCertifiedPacket,
  summarizeCertificate,
} from "../src/agent-answer-certificate.js";

test("certificate summary reads final, checks, options and verdict rows", () => {
  const packet = {
    candidateProposal: "A、C",
    suggestedChecks: [
      "CERT1|CHECK|C1|SUBSTITUTE|x=1 => PASS",
      "CERT1|CHECK|C2|RECOMPUTE|sum=4 => PASS",
      "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE",
      "CERT1|VERDICT|FALSE",
      "CERT1|FINAL|A、C",
    ],
  };
  const summary = summarizeCertificate(packet);
  assert.equal(summary.certified, true);
  assert.equal(summary.checkCount, 2);
  assert.equal(summary.optionTruths.get("D"), true);
  assert.equal(summary.verdict, false);
  assert.equal(isCertifiedPacket(packet), true);
});

test("option certificate closes a missing true option", () => {
  const packet = {
    candidateProposal: "A、C",
    suggestedChecks: [
      "CERT1|CHECK|C1|EVALUATE|A true => PASS",
      "CERT1|CHECK|C2|EVALUATE|D true => PASS",
      "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE",
      "CERT1|FINAL|A、C",
    ],
  };
  assert.equal(certificateCorrection(packet), "A、C、D");
});

test("verdict certificate replaces a hedged affirmative answer", () => {
  const packet = {
    candidateProposal: "正确（√），但并非对所有配置成立",
    suggestedChecks: [
      "CERT1|CHECK|C1|COUNTEREXAMPLE|one counterexample => PASS",
      "CERT1|CHECK|C2|EVALUATE|universal statement false => PASS",
      "CERT1|VERDICT|FALSE",
      "CERT1|FINAL|错误",
    ],
  };
  assert.equal(certificateCorrection(packet), "错误");
});

test("no machine-visible contradiction returns null", () => {
  const packet = {
    candidateProposal: "A、C",
    suggestedChecks: [
      "CERT1|CHECK|C1|EVALUATE|A true => PASS",
      "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=FALSE",
      "CERT1|FINAL|A、C",
    ],
  };
  assert.equal(certificateCorrection(packet), null);
  assert.deepEqual(candidateChoiceLetters("(A)、C"), ["A", "C"]);
});
