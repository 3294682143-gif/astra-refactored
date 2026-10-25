/**
 * @astra/protocol — Unified Math Assets DTO and types.
 *
 * Single normative source of truth is `mathagent/resources/math-assets.json`.
 * Static views are generated into `generated/math-assets.ts`.
 */

import type { EvidenceCeiling, MathAssetDefinition } from "./generated/math-assets.js";

export * from "./generated/math-assets.js";

export const MATH_ASSET_STATUS = Object.freeze([
  "COMPLETE",
  "NEEDS_INPUT",
  "OUT_OF_SCOPE",
  "UNAVAILABLE",
  "ERROR",
  "UNKNOWN",
] as const);

export type MathAssetStatus = (typeof MATH_ASSET_STATUS)[number];

export interface MathAssetBinding {
  readonly taskId: string;
  readonly goalId: string;
  readonly scopeId: string;
  readonly contractVersion: number;
  readonly sourceRequestId?: string;
}

export interface MathAssetAction {
  readonly action: "math_asset";
  readonly assetId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly scope?: string;
}

export interface MathAssetObservation {
  readonly quantity: string;
  readonly value: unknown;
  readonly domain: string;
  readonly exactness: EvidenceCeiling;
  readonly coverage: string;
  readonly sourceInputHash: string;
  readonly taskId: string;
  readonly contractVersion: number;
}

export interface MathAssetCheck {
  readonly checkerId: string;
  readonly version: string;
  readonly scope: string;
  readonly inputHash: string;
  readonly resultHash: string;
  readonly status: string;
}

export interface MathAssetUsage {
  readonly durationMs: number;
  readonly computationType: string;
}

export interface MathAssetResult {
  readonly schemaVersion: "math-assets-v1";
  readonly assetId: string;
  readonly assetVersion: string;
  readonly catalogDigest: string;
  readonly requestId: string;
  readonly binding: MathAssetBinding;
  readonly normalizedInput: Readonly<Record<string, unknown>>;
  readonly inputHash: string;
  readonly status: MathAssetStatus;
  readonly guidance: readonly string[];
  readonly observations: readonly MathAssetObservation[];
  readonly checks: readonly MathAssetCheck[];
  readonly usage: MathAssetUsage;
  readonly limitations: readonly string[];
  readonly resultHash: string;
}

export interface MathAssetPortRequest {
  readonly action: "math_asset";
  readonly assetId: string;
  readonly target?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly binding: MathAssetBinding;
}

export interface MathAssetPort {
  execute(request: MathAssetPortRequest): Promise<MathAssetResult>;
}
