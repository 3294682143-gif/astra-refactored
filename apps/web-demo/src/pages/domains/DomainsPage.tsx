import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Boxes, RefreshCw, FlaskConical } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchRuns,
  type ApiResult,
  type RunSummaryItem,
  type RunsResponse,
} from "@/api/client.ts";

/**
 * 四域场景页：/api/v2/domains 真实注册域 × /api/runs 真实运行聚合。
 * 诚实红线：无真实 run 的域显示空态，不以样例冒充；run 归属只按
 * summary.metadata.domainId / problem 的 [RunSpec:xxx] 前缀匹配，不推测。
 */

interface V2Domain {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly tools: readonly string[];
}

interface V2DomainsResponse {
  readonly domains: V2Domain[];
  readonly count: number;
}

async function fetchV2Domains(): Promise<ApiResult<V2DomainsResponse>> {
  try {
    const res = await fetch("/api/v2/domains", { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return {
        ok: false,
        error: { kind: "http", status: res.status, message: `HTTP ${res.status}`, url: "/api/v2/domains" },
      };
    }
    return { ok: true, data: (await res.json()) as V2DomainsResponse, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: err instanceof Error ? err.message : String(err),
        url: "/api/v2/domains",
      },
    };
  }
}

function domainOfRun(run: RunSummaryItem): string | null {
  const meta = run.summary?.["metadata"];
  if (meta && typeof meta === "object") {
    const did = (meta as Record<string, unknown>)["domainId"];
    if (typeof did === "string" && did) return did;
  }
  const problem = run.summary?.["problem"];
  if (typeof problem === "string") {
    const m = problem.match(/^\[RunSpec:([^\]]+)\]/);
    if (m) return m[1];
  }
  return null;
}

export function DomainsPage() {
  const [domains, setDomains] = useState<ApiResult<V2DomainsResponse> | null>(null);
  const [runs, setRuns] = useState<ApiResult<RunsResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchV2Domains().then((res) => {
      if (alive) setDomains(res);
    });
    fetchRuns(200, 0).then((res) => {
      if (alive) setRuns(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const runsByDomain = useMemo(() => {
    const map = new Map<string, RunSummaryItem[]>();
    if (runs && runs.ok) {
      for (const run of runs.data.items) {
        const d = domainOfRun(run);
        if (!d) continue;
        const list = map.get(d) ?? [];
        list.push(run);
        map.set(d, list);
      }
    }
    return map;
  }, [runs]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <section
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "18px 22px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            <Boxes size={16} style={{ verticalAlign: "-3px", marginRight: "6px" }} />
            领域注册表（四域共用同一内核）
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--color-ink-mute)" }}>
            数据来自 GET /api/v2/domains（真实注册表）与 /api/runs（真实运行记录）；无真实运行的域显示空态。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            borderRadius: "8px",
            border: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface-muted)",
            padding: "7px 14px",
            fontSize: "13px",
            cursor: "pointer",
            color: "var(--color-ink-soft)",
          }}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </section>

      {domains === null && <div style={{ fontSize: "13px", color: "var(--color-ink-mute)" }}>加载领域注册表…</div>}
      {domains && !domains.ok && (
        <PanelEmptyState variant="missing" title="领域注册表不可达" description={domains.error.message} />
      )}

      {domains && domains.ok && (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "16px",
          }}
        >
          {domains.data.domains.map((d) => {
            const domainRuns = runsByDomain.get(d.id) ?? [];
            const latest = domainRuns.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
            return (
              <article
                key={d.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  borderRadius: "12px",
                  border: "1px solid var(--color-line)",
                  backgroundColor: "var(--color-surface)",
                  padding: "18px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <FlaskConical size={16} color="var(--color-brand)" />
                  <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                    {d.id}
                  </h2>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "11px",
                      fontFamily: "monospace",
                      color: "var(--color-ink-mute)",
                      border: "1px solid var(--color-line)",
                      borderRadius: "9999px",
                      padding: "2px 8px",
                    }}
                  >
                    v{d.version}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
                  {d.description}
                </p>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
                  <strong>工具</strong>：{d.tools.join(" · ")}
                </div>
                <div
                  style={{
                    borderTop: "1px dashed var(--color-line)",
                    paddingTop: "10px",
                    fontSize: "12px",
                    color: "var(--color-ink-soft)",
                  }}
                >
                  <strong>真实运行</strong>：{domainRuns.length} 次
                  {latest ? (
                    <div style={{ marginTop: "6px" }}>
                      最近：
                      <Link
                        to={`/runs/${encodeURIComponent(latest.run_id)}`}
                        style={{ color: "var(--color-brand)", fontFamily: "monospace" }}
                      >
                        {latest.run_id}
                      </Link>
                      <span style={{ color: "var(--color-ink-mute)" }}>
                        {" "}（{latest.status}
                        {typeof latest.summary?.["stopReason"] === "string"
                          ? ` / ${String(latest.summary["stopReason"])}`
                          : ""}）
                      </span>
                      {" · "}
                      <Link
                        to={`/runs/${encodeURIComponent(latest.run_id)}/replay`}
                        style={{ color: "var(--color-brand)" }}
                      >
                        时间胶囊回放
                      </Link>
                    </div>
                  ) : (
                    <div style={{ marginTop: "6px", color: "var(--color-ink-mute)" }}>
                      暂无真实运行记录（不以样例冒充）。
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
