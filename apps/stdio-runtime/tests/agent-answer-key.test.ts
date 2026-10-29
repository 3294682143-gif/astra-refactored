import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalAnswerKey, sameAnswerKey } from "../src/agent-answer-key.js";

test("labels, one wrapper layer and insignificant whitespace are canonicalised", () => {
  assert.equal(sameAnswerKey("答案： 1 / 2", "1/2"), true);
  assert.equal(sameAnswerKey("最终答案：$1/2$", "1/2"), true);
  assert.equal(sameAnswerKey("\\(\\frac{1}{2}\\)", "1/2"), true);
  assert.equal(sameAnswerKey("\\boxed{\\frac12}", "1/2"), true);
  assert.equal(sameAnswerKey("Final answer: TRUE", " true "), true);
  assert.equal(sameAnswerKey("x + 1", "X+1"), true);
});

test("rationals, fractions and exact finite decimals share one key", () => {
  const oneHalf = canonicalAnswerKey("1/2");
  assert.equal(canonicalAnswerKey("\\frac{1}{2}"), oneHalf);
  assert.equal(canonicalAnswerKey("\\frac12"), oneHalf);
  assert.equal(canonicalAnswerKey("0.5"), oneHalf);
  assert.equal(canonicalAnswerKey("0.50"), oneHalf);
  assert.equal(sameAnswerKey("2/4", "0.5"), true);
  assert.equal(sameAnswerKey("-1/2", "-0.5"), true);
  assert.notEqual(canonicalAnswerKey("1/2"), canonicalAnswerKey("1/3"));
});

test("finite numeric sets are sorted and deduplicated", () => {
  assert.equal(sameAnswerKey("{1,0}", "{0,1}"), true);
  assert.equal(sameAnswerKey("{1.0,0.5,0}", "{0,1/2,1}"), true);
  assert.notEqual(canonicalAnswerKey("{1,0}"), canonicalAnswerKey("{1}"));
  assert.notEqual(canonicalAnswerKey("{1,0}"), canonicalAnswerKey("{1,0,2}"));
});

test("whole-answer option notation has a sorted canonical key", () => {
  assert.equal(sameAnswerKey("(A)", "A."), true);
  assert.equal(sameAnswerKey("A、C", "A, C"), true);
  assert.equal(sameAnswerKey("A、C", "AC"), true);
  assert.equal(sameAnswerKey("C,A", "A、C"), true);
  assert.equal(canonicalAnswerKey("A、B、C"), "options:A,B,C");
  assert.equal(sameAnswerKey("A", "(A)"), true);
  assert.equal(sameAnswerKey(" A ", "a."), true);
  assert.notEqual(canonicalAnswerKey("a"), canonicalAnswerKey("(A)"));
});

test("truth tokens are grouped without merging the two verdicts", () => {
  assert.equal(sameAnswerKey("正确", "TRUE"), true);
  assert.equal(sameAnswerKey("真", "yes"), true);
  assert.equal(sameAnswerKey("错误", "FALSE"), true);
  assert.equal(sameAnswerKey("假", "no"), true);
  assert.notEqual(canonicalAnswerKey("正确"), canonicalAnswerKey("错误"));
});

test("a whole polynomial is canonicalised by its coefficient map", () => {
  assert.equal(sameAnswerKey("x^2 - x", "x(x-1)"), true);
  assert.equal(sameAnswerKey("1 - x + x^2", "x^2-x+1"), true);
  assert.notEqual(canonicalAnswerKey("x^2-x"), canonicalAnswerKey("x^2+x"));
  // A relation is not a polynomial answer and stays as stripped text.
  assert.equal(sameAnswerKey("x+1=0", "x + 1 = 0"), true);
  assert.notEqual(canonicalAnswerKey("x+1=0"), canonicalAnswerKey("x+1"));
});

test("a sentence containing option letters is never collapsed to an option set", () => {
  const sentence = canonicalAnswerKey("A、B、C 正确，D 错误");
  assert.notEqual(sentence, canonicalAnswerKey("A、B、C"));
  assert.match(sentence, /^text:/u);
  assert.equal(sameAnswerKey("A、B、C 正确，D 错误", "a、b、c正确，d错误"), true);

  const ordinaryChoice = canonicalAnswerKey("A、C");
  assert.notEqual(sentence, ordinaryChoice);
});

test("internal whitespace never turns adjacent literals into another number", () => {
  assert.notEqual(canonicalAnswerKey("1 2"), canonicalAnswerKey("12"));
  assert.notEqual(canonicalAnswerKey("1 1/2"), canonicalAnswerKey("11/2"));
  assert.match(canonicalAnswerKey("x+" + "9".repeat(420)), /^text:/u);
});
