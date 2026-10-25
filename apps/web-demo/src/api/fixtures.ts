/**
 * 内置答辩演示样本（离线兜底与单测样本）。
 * 保证在离线演示或无 BFF 运行时仍可 100% 独立离线交互。
 */

import sampleData from "../../fixtures/session-sample.json";
import type { RunEventEnvelope } from "../domain/reduceRun.ts";

export const DEMO_SAMPLE_LOG = sampleData as {
  schemaVersion: string;
  version: number;
  events: RunEventEnvelope[];
};

export const DEMO_RUN_ID = "demo-session";
