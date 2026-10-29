/**
 * @astra/math-workunit — a2 short-path request rebuild (pure, offline).
 *
 * Rebuilds requests from a trusted frozen profile, the problem and recorded
 * receipts only. No I/O, no client, no method dispatch, no tool execution and
 * no access to captured requests. A hash is data integrity, not proof.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  type A2Message,
  type A2Profile,
  type A2Receipt,
  type A2Request,
} from "@astra/protocol";

const MAX_INPUT_CHARS = 60000;
const MAX_PROBLEM_CHARS = 8192;
const MAX_RECEIPT_CHARS = 65536;
const MAX_REQUESTS = 3;
const MAX_BYTES = 262144;
const TRANSPORTS = ["COMPLETE", "TRUNCATED"] as const;
const ACTION_KEYS = ["action", "id"] as const;
const FINAL_KEYS = ["action", "answer", "complete", "unresolved"] as const;

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

function chars(value: string): number {
  const length = codePointLength(value);
  if (length === null) {
    fail("PACKET_SCHEMA");
  }
  return length;
}

function exactKeys(node: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    fail("PACKET_SCHEMA");
  }
  const record = node as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length) {
    fail("PACKET_SCHEMA");
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      fail("PACKET_SCHEMA");
    }
  }
  return record;
}

function parseAction(text: string): Record<string, unknown> {
  if (!detectDuplicateKeys(text).ok || !detectNonFiniteTokens(text).ok || !detectUnsafeNumbers(text).ok) {
    fail("PACKET_SCHEMA");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("PACKET_SCHEMA");
  }
  if (!detectLoneSurrogates(raw).ok) {
    fail("PACKET_SCHEMA");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("PACKET_SCHEMA");
  }
  return p2Snapshot(raw) as Record<string, unknown>;
}

function receiptOf(value: unknown): A2Receipt {
  const record = exactKeys(p2Snapshot(value), ["transport", "text"]);
  const transport = record["transport"];
  if (typeof transport !== "string" || !(TRANSPORTS as readonly string[]).includes(transport)) {
    fail("PACKET_SCHEMA");
  }
  const text = record["text"];
  if (typeof text !== "string" || text.length === 0) {
    fail("PACKET_SCHEMA");
  }
  if (chars(text) > MAX_RECEIPT_CHARS || Buffer.byteLength(text, "utf8") > MAX_RECEIPT_CHARS) {
    fail("BOUND_EXCEEDED");
  }
  return p2Snapshot({ transport: transport as A2Receipt["transport"], text });
}

/** Rebuild the a2 short-path requests from profile, problem and receipts. */
export function rebuildA2Requests(
  profile: A2Profile,
  problem: string,
  receipts: readonly A2Receipt[],
): readonly A2Request[] {
  const trusted = p2Snapshot(profile);
  if (trusted.maxSteps !== 1 && trusted.maxSteps !== 3) {
    fail("PACKET_SCHEMA");
  }
  if (
    trusted.maxMethods !== 2 ||
    trusted.maxMethodChars !== 12000 ||
    trusted.maxInputChars !== MAX_INPUT_CHARS ||
    trusted.temperature !== "0.2" ||
    trusted.maxTokens !== 8192
  ) {
    fail("PACKET_SCHEMA");
  }
  if (trusted.turnNotes.length !== 3 || trusted.closeoutNotes.length !== 3) {
    fail("PACKET_SCHEMA");
  }
  if (typeof problem !== "string" || problem.trim().length === 0) {
    fail("PACKET_SCHEMA");
  }
  if (chars(problem) > MAX_PROBLEM_CHARS || !detectLoneSurrogates(problem).ok) {
    fail("PACKET_SCHEMA");
  }
  if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > MAX_REQUESTS) {
    fail("BOUND_EXCEEDED");
  }
  if (receipts.length > trusted.maxSteps) {
    fail("BOUND_EXCEEDED");
  }
  const recorded = receipts.map((item) => receiptOf(item));

  const messages: A2Message[] = [
    { role: "system", content: trusted.systemPrompt },
    { role: "user", content: problem },
  ];
  const usedChars = (): number =>
    messages.reduce((total, message) => total + (codePointLength(message.content) ?? 0), 0);
  const catalogChars = chars(trusted.catalogBlock);
  const lastNote = trusted.closeoutNotes[trusted.maxSteps - 1] as string;
  let catalogAvailable = false;
  if (usedChars() + catalogChars + chars(lastNote) <= MAX_INPUT_CHARS) {
    messages.push({ role: "user", content: trusted.catalogBlock });
    catalogAvailable = true;
  }

  const requests: A2Request[] = [];
  let loaded = false;
  let forceCloseout = false;
  let terminal = false;

  for (let index = 0; index < recorded.length; index += 1) {
    if (terminal) {
      fail("ILLEGAL_TRANSITION");
    }
    const receipt = recorded[index] as A2Receipt;
    const remaining = trusted.maxSteps - index;
    const finalTurn = remaining === 1 || forceCloseout;
    const note = finalTurn
      ? (trusted.closeoutNotes[remaining - 1] as string)
      : (trusted.turnNotes[remaining - 1] as string);
    if (usedChars() + chars(note) > MAX_INPUT_CHARS) {
      fail("BOUND_EXCEEDED");
    }
    messages.push({ role: "user", content: note });
    const request: A2Request = {
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: trusted.temperature,
      maxTokens: trusted.maxTokens,
    };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_BYTES) {
      fail("BOUND_EXCEEDED");
    }
    requests.push(p2Snapshot(request));
    if (requests.length > MAX_REQUESTS) {
      fail("BOUND_EXCEEDED");
    }
    if (receipt.transport === "TRUNCATED") {
      terminal = true;
      continue;
    }
    const action = parseAction(receipt.text);
    const kind = action["action"];
    if (kind === "method") {
      const record = exactKeys(action, ACTION_KEYS);
      if (record["id"] !== trusted.methodAsset.id) {
        fail("NOT_REUSABLE");
      }
      if (finalTurn) {
        terminal = true;
        continue;
      }
      if (!catalogAvailable) {
        fail("NOT_REUSABLE");
      }
      messages.push({ role: "assistant", content: receipt.text });
      if (!loaded) {
        messages.push({ role: "user", content: trusted.loadedFeedback });
        loaded = true;
      } else {
        messages.push({ role: "user", content: trusted.repeatedFeedback });
        messages.push({ role: "user", content: trusted.forceCloseoutNote });
        forceCloseout = true;
      }
      continue;
    }
    if (kind === "final") {
      const record = exactKeys(action, FINAL_KEYS);
      const answer = record["answer"];
      const unresolved = record["unresolved"];
      if (
        typeof answer !== "string" ||
        answer.trim().length === 0 ||
        record["complete"] !== true ||
        !Array.isArray(unresolved) ||
        unresolved.length !== 0
      ) {
        fail("NOT_REUSABLE");
      }
      terminal = true;
      continue;
    }
    fail("NOT_REUSABLE");
  }

  return p2Snapshot(requests);
}
