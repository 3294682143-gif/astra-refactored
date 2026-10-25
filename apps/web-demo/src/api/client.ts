/**
 * BFF API 客户端（诚实模式 / honesty-first）。
 *
 * 设计红线（对应 t2 验收项 [3]）：
 *   1. 任何请求失败都返回显式错误态（ApiResult.ok === false），
 *      绝不以演示 / 样例数据顶替真实结果（旧版 safeFetch 的静默兜底已移除）。
 *   2. 接口未提供或字段缺失时返回 undefined / null，由页面渲染「未知态」，不编造默认值。
 *   3. 永不泄露任何模型 API Key，也不越权访问宿主环境。
 */

import type { RunEventEnvelope } from "../domain/reduceRun.ts";

/** 数据可观测级别；UNKNOWN 表示无法从接口确证级别（不得冒充 L2 / L3）。 */
export type TraceLevel = "L1" | "L2" | "L3" | "UNKNOWN";

export interface ApiError {
  readonly kind: "network" | "http" | "malformed";
  readonly status?: number;
  readonly message: string;
  readonly url: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly httpStatus: number }
  | { readonly ok: false; readonly error: ApiError };

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
  read_only?: boolean;
  execution_queue?: boolean;
  sse_streaming?: boolean;
  model_invoked?: boolean;
  schema_version?: number | string;
  routes?: string[];
  max_concurrent_runs?: number;
  supports_cancellation?: boolean;
  cancellation_supported?: boolean;
  supported_engines?: string[];
  default_budget?: Record<string, unknown>;
  protocol_version?: string | null;
  catalog_version?: string | null;
  catalog_digest?: string | null;
  limits?: Record<string, unknown>;
  execution?: {
    max_concurrent_runs?: number;
    running?: number;
    queued?: number;
    active_run_id?: string | null;
  };
}

export interface RunSummaryItem {
  run_id: string;
  created_at: number;
  source: string;
  status: string;
  scenario?: string | null;
  model?: string | null;
  seed?: number | null;
  duration_s?: number | null;
  summary?: Record<string, unknown>;
  l2_path?: string | null;
  l3_path?: string | null;
  /** 后端权威数据可观测级别（按真实存档文件推导：L1 | L2 | L3）。 */
  detail_level?: string | null;
  tags?: string[];
  checksum?: string | null;
}

export interface RunsResponse {
  items: RunSummaryItem[];
  count?: number;
  limit?: number;
  offset?: number;
}

export interface AssetItem {
  asset_id: string;
  run_id: string;
  kind: string;
  rel_path: string;
  mime: string;
  bytes: number;
  created_at: number;
}

export interface AssetsResponse {
  items: AssetItem[];
  count?: number;
}

export interface ReplayPayload {
  run_id: string;
  source: string;
  created_at: number;
  events: RunEventEnvelope[];
  /** 存档中是否真的存在 events 字段（缺失时为空数组，不伪造）。 */
  hasEventsField: boolean;
  details: Record<string, unknown>;
}

export interface MathAssetSummaryItem {
  readonly assetId: string;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly behaviorCount: number;
  readonly targets: readonly string[];
  readonly guidanceOnly: boolean;
}

export interface MathAssetsResponse {
  readonly schemaVersion: string;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly assetCount: number;
  readonly computationBehaviorCount: number;
  readonly guidanceOnlyCount: number;
  readonly assets: readonly MathAssetSummaryItem[];
}

export interface MathAssetBehavior {
  readonly target: string;
  readonly declaredScope: string;
  readonly requiredParams: readonly string[];
  readonly optionalParams: readonly string[];
  readonly resultType: string;
  readonly evidenceCeiling: string;
}

export interface MathAssetDetail extends MathAssetSummaryItem {
  readonly instructions: {
    readonly conditions: readonly string[];
    readonly procedure: readonly string[];
    readonly misuse: readonly string[];
    readonly verificationBoundary: string;
  };
  readonly behaviors: readonly MathAssetBehavior[];
  readonly examples?: Record<string, unknown>;
  readonly inputSchema?: Record<string, unknown> | null;
}

export interface RuntimeInfoResponse {
  readonly service: string;
  readonly protocolVersion: string;
  readonly catalogAvailable: boolean;
  readonly catalogError: string | null;
  readonly catalogVersion: string | null;
  readonly catalogDigest: string | null;
  readonly assetCount: number | null;
  readonly computationBehaviorCount: number | null;
  readonly solverConfigured: boolean;
}

export interface CreateRunResponse {
  run_id: string;
  status: string;
  /** 是否新启动了执行（幂等键重放时为 false）。 */
  started?: boolean;
  /** 是否命中幂等键重放（HTTP 200 + true）；与首次执行严格区分。 */
  idempotent_replay?: boolean;
  /** 响应时该运行是否已处于终态。 */
  terminal?: boolean;
}

/** 运行记录中的保真终态字段（来自 summary，未提供者为 null，绝不推测）。 */
export interface RunTerminalFacts {
  readonly status: string | null;
  readonly stopReason: string | null;
  readonly terminalKind: string | null;
  readonly finalResponse: string | null;
  readonly executed: boolean | null;
  readonly code: string | null;
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asBoolean = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/**
 * 从真实的 run 记录（GET /api/runs/{id}）读取保真终态字段。
 * 只做字段搬运：缺失一律返回 null，不填充默认值。
 */
export function readTerminalFacts(
  run: Pick<RunSummaryItem, "status" | "summary"> | null | undefined,
): RunTerminalFacts {
  const summary = run?.summary ?? {};
  return {
    status: asString(summary["status"]) ?? asString(run?.status),
    stopReason: asString(summary["stopReason"]),
    terminalKind: asString(summary["terminalKind"]),
    finalResponse: asString(summary["final_response"] ?? summary["finalResponse"]),
    executed: asBoolean(summary["executed"]),
    code: asString(summary["code"]),
  };
}

export interface BuildManifestSummary {
  manifestVersion?: string;
  profileId?: string;
  engine?: string;
  schemaVersion?: string;
  commit?: string;
  jsCount: number;
  assetEntryCount: number;
  mathFamilyFileCount: number;
  /** 浏览器本地对该清单原始字节计算的 SHA-256；环境不支持时为 null。 */
  manifestSha256: string | null;
}

interface JsonRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function requestJson<T>(url: string, init?: JsonRequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: err instanceof Error ? err.message : String(err),
        url,
      },
    };
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") detail = ` - ${body.detail}`;
    } catch {
      // 错误体不是 JSON：保留 HTTP 状态码本身，不做推测
    }
    return {
      ok: false,
      error: {
        kind: "http",
        status: res.status,
        message: `HTTP ${res.status}${detail || (res.statusText ? ` ${res.statusText}` : "")}`,
        url,
      },
    };
  }

  try {
    return { ok: true, data: (await res.json()) as T, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        status: res.status,
        message: `响应不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        url,
      },
    };
  }
}

export function fetchHealth(): Promise<ApiResult<HealthResponse>> {
  return requestJson<HealthResponse>("/api/health");
}

export function fetchCapabilities(): Promise<ApiResult<CapabilitiesResponse>> {
  return requestJson<CapabilitiesResponse>("/api/capabilities");
}

export function fetchRuns(limit = 50, offset = 0): Promise<ApiResult<RunsResponse>> {
  return requestJson<RunsResponse>(`/api/runs?limit=${limit}&offset=${offset}`);
}

export function fetchRun(runId: string): Promise<ApiResult<RunSummaryItem>> {
  return requestJson<RunSummaryItem>(`/api/runs/${encodeURIComponent(runId)}`);
}

export function fetchMathAssets(): Promise<ApiResult<MathAssetsResponse>> {
  return requestJson<MathAssetsResponse>("/api/math-assets");
}

export function fetchMathAsset(assetId: string): Promise<ApiResult<MathAssetDetail>> {
  return requestJson<MathAssetDetail>(`/api/math-assets/${encodeURIComponent(assetId)}`);
}

export function fetchRuntimeInfo(): Promise<ApiResult<RuntimeInfoResponse>> {
  return requestJson<RuntimeInfoResponse>("/api/runtime-info");
}

export function fetchAssets(runId?: string): Promise<ApiResult<AssetsResponse>> {
  const qs = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  return requestJson<AssetsResponse>(`/api/assets${qs}`);
}

/**
 * 发起求解请求。
 * 可选 Idempotency-Key：同键重放由后端返回 HTTP 200 + idempotent_replay=true（不新起执行），
 * 调用方必须据此与首次执行（HTTP 201）区分呈现。
 */
export function createRun(
  body: {
    problem: string;
    max_model_calls?: number;
    max_work_units?: number;
    max_effects?: number;
    max_reviews?: number;
    max_method_loads?: 0;
    max_repairs?: number;
    max_consensus?: number;
    max_r0?: 0 | 1;
    problem_seconds?: number;
    policy?: "BEST_EFFORT" | "STRICT";
    metadata?: Record<string, unknown>;
    engine?: "ts";
  },
  idempotencyKey?: string,
): Promise<ApiResult<CreateRunResponse>> {
  return requestJson<CreateRunResponse>("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function fetchReplay(runId: string): Promise<ApiResult<ReplayPayload>> {
  const res = await requestJson<{
    run_id?: unknown;
    source?: unknown;
    created_at?: unknown;
    details?: unknown;
  }>(`/api/replays/${encodeURIComponent(runId)}`);
  if (!res.ok) return res;

  const body = res.data;
  const details =
    body.details && typeof body.details === "object" && !Array.isArray(body.details)
      ? (body.details as Record<string, unknown>)
      : {};
  const rawEvents = details["events"];
  const hasEventsField = Array.isArray(rawEvents);

  return {
    ok: true,
    httpStatus: res.httpStatus,
    data: {
      run_id: typeof body.run_id === "string" ? body.run_id : runId,
      source: typeof body.source === "string" ? body.source : "unknown",
      created_at: typeof body.created_at === "number" ? body.created_at : Number.NaN,
      events: hasEventsField ? (rawEvents as RunEventEnvelope[]) : [],
      hasEventsField,
      details,
    },
  };
}

const DECLARED_LEVELS: readonly TraceLevel[] = ["L1", "L2", "L3"];

/**
 * 由真实运行记录推导数据可观测级别（RunDetailPage 与 RunReplayPage 共用，保证同一记录级别一致）。
 *
 *   1. 优先采用后端权威字段 detail_level（大小写归一后必须是 L1/L2/L3 之一）；
 *   2. 取不到才回退到真实存档路径推导（l3_path → L3，l2_path → L2）；
 *   3. 两者皆无 → L1（仅摘要）；记录本身不存在 → UNKNOWN。
 * 任何情况下都不冒充 L2 / L3。
 */
export function resolveTraceLevel(
  run: Pick<RunSummaryItem, "l2_path" | "l3_path" | "detail_level"> | null | undefined,
): TraceLevel {
  if (!run) return "UNKNOWN";
  const declared =
    typeof run.detail_level === "string" ? run.detail_level.trim().toUpperCase() : "";
  const authoritative = DECLARED_LEVELS.find((level) => level === declared);
  if (authoritative) return authoritative;
  if (typeof run.l3_path === "string" && run.l3_path.trim()) return "L3";
  if (typeof run.l2_path === "string" && run.l2_path.trim()) return "L2";
  return "L1";
}

/**
 * 读取发布清单快照（public/BUILD_MANIFEST.json，构建期自 release/BUILD_MANIFEST.json 拷贝）。
 * 只陈述清单中真实存在的事实，不输出「校验通过」一类断言。
 */
export async function fetchBuildManifest(): Promise<ApiResult<BuildManifestSummary>> {
  const url = "/BUILD_MANIFEST.json";
  let bytes: ArrayBuffer;
  let httpStatus = 0;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, message: `HTTP ${res.status}`, url } };
    }
    httpStatus = res.status;
    bytes = await res.arrayBuffer();
  } catch (err) {
    return {
      ok: false,
      error: { kind: "network", message: err instanceof Error ? err.message : String(err), url },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        message: `清单不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        url,
      },
    };
  }

  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const countArray = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

  const source = obj(parsed["source"]);
  const assets = obj(parsed["assets"]);

  return {
    ok: true,
    httpStatus,
    data: {
      manifestVersion: str(parsed["manifestVersion"]),
      profileId: str(parsed["profileId"]),
      engine: str(parsed["engine"]),
      schemaVersion: str(parsed["schemaVersion"]),
      commit: str(source["commit"]),
      jsCount: countArray(parsed["js"]),
      assetEntryCount: Object.keys(assets).length,
      mathFamilyFileCount: Object.keys(obj(parsed["mathFamilyFiles"])).length,
      manifestSha256: await sha256Hex(bytes),
    },
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}