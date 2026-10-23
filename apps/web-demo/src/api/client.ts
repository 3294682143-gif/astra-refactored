/**
 * BFF API 客户端（带自动离线降级兜底）。
 *
 * 保证：
 *   1. 优先尝试本地 Starlette BFF 接口（/api/*）
 *   2. 网络异常或服务未启动时，透明降级至预置高质量 fixture 演示数据
 *   3. 永不泄露任何模型 API Key 或越权访问宿主环境
 */

import { DEMO_SAMPLE_LOG } from "./fixtures.ts";
import type { RunEventEnvelope } from "../domain/reduceRun.ts";

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  model_invoked: boolean;
  data_root?: string;
}

export interface CapabilitiesResponse {
  service: string;
  version: string;
  read_only: boolean;
  model_invoked: boolean;
  schema_version: number;
  routes: string[];
}

export interface RunSummaryItem {
  run_id: string;
  created_at: number;
  source: string;
  status: string;
  scenario?: string;
  model?: string;
  seed?: number;
  duration_s?: number;
  summary: Record<string, unknown>;
  l2_path?: string;
  l3_path?: string;
  tags: string[];
  checksum?: string;
}

export interface RunsResponse {
  items: RunSummaryItem[];
  count: number;
  limit: number;
  offset: number;
}

export interface ReplayResponse {
  run_id: string;
  source: string;
  created_at: number;
  details: {
    events?: RunEventEnvelope[];
    [key: string]: unknown;
  };
}

async function safeFetch<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export async function fetchHealth(): Promise<HealthResponse> {
  return safeFetch<HealthResponse>("/api/health", {
    status: "ok",
    service: "astra-web-bff (offline fallback)",
    version: "0.1.0",
    model_invoked: false,
  });
}

export async function fetchCapabilities(): Promise<CapabilitiesResponse> {
  return safeFetch<CapabilitiesResponse>("/api/capabilities", {
    service: "astra-web-bff (offline fallback)",
    version: "0.1.0",
    read_only: true,
    model_invoked: false,
    schema_version: 1,
    routes: ["/api/health", "/api/capabilities", "/api/runs", "/api/replays", "/api/assets"],
  });
}

export async function fetchRuns(limit = 50, offset = 0): Promise<RunsResponse> {
  const fallback: RunsResponse = {
    items: [
      {
        run_id: "demo-session",
        created_at: Date.now() / 1000 - 3600,
        source: "demo_fixture",
        status: "candidate",
        scenario: "algebra-imo-p1",
        model: "deepseek-v4.1",
        duration_s: 2.45,
        summary: {
          answer: "4",
          candidate_verified: false,
          stopReason: "REVIEWS_COMPLETE",
        },
        l2_path: "runs/demo-session/details.json",
        tags: ["demo", "verified-structure"],
      },
    ],
    count: 1,
    limit,
    offset,
  };
  return safeFetch<RunsResponse>(`/api/runs?limit=${limit}&offset=${offset}`, fallback);
}

export async function fetchReplay(runId: string): Promise<RunEventEnvelope[]> {
  try {
    const res = await fetch(`/api/replays/${encodeURIComponent(runId)}`);
    if (res.ok) {
      const data = (await res.json()) as ReplayResponse;
      if (Array.isArray(data.details?.events)) {
        return data.details.events;
      }
    }
  } catch {
    // 降级使用内置真实 fixture
  }

  // 默认降级返回 DEMO_SAMPLE_LOG 中的 11 条真实事件
  return DEMO_SAMPLE_LOG.events;
}
