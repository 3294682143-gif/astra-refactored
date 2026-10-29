/**
 * @astra/protocol — a2 short-path offline surface (types only).
 *
 * Declarations only: no I/O, no environment access, no network, no client,
 * no method dispatch and no tool execution. A hash here is data integrity,
 * not authentication and not a mathematical proof.
 */

import type { P2MethodAsset } from "./p2-methods.js";

export interface A2Message {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface A2Request {
  readonly messages: readonly A2Message[];
  /** Decimal string, never a float: JSON integer protocols reject floats. */
  readonly temperature: string;
  readonly maxTokens: number;
}

export interface A2Receipt {
  readonly transport: "COMPLETE" | "TRUNCATED";
  readonly text: string;
}

export interface A2Profile {
  readonly schemaVersion: "a2-shortpath-profile-v1";
  readonly baselineVersion: "0.10.0a2";
  readonly sources: Readonly<Record<string, string>>;
  readonly maxSteps: 1 | 3;
  readonly maxMethods: 2;
  readonly maxMethodChars: 12000;
  readonly maxInputChars: 60000;
  readonly temperature: "0.2";
  readonly maxTokens: 8192;
  readonly systemPrompt: string;
  readonly catalogBlock: string;
  readonly turnNotes: readonly string[];
  readonly closeoutNotes: readonly string[];
  readonly forceCloseoutNote: string;
  readonly methodAsset: P2MethodAsset;
  readonly loadedFeedback: string;
  readonly repeatedFeedback: string;
}

export interface A2Bundle {
  readonly schemaVersion: "a2-shortpath-bundle-v1";
  readonly scenario: "direct" | "method" | "repeat" | "truncated" | "final-turn-method";
  readonly problem: string;
  readonly profile: A2Profile;
  readonly profileHash: string;
  readonly requests: readonly A2Request[];
  readonly requestHashes: readonly string[];
  readonly receipts: readonly A2Receipt[];
  readonly result: {
    readonly status: "candidate" | "unsolved";
    readonly candidateVerified: false;
    readonly closeout: string;
  };
  readonly methodLoads: number;
  readonly toolExecutions: 0;
}
