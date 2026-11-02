import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Boxes, RefreshCw, FlaskConical, ArrowRight, Users, Shield } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchRuns,
  type ApiResult,
  type RunSummaryItem,
  type RunsResponse,
} from "@/api/client.ts";

/**
 * 场景与领域工作台页：/api/v2/scenarios 真实场景注册表 × /api/runs 真实运行聚合。
 * 诚实红线：无真实 run 的域显示空态，不以样例冒充；支持直接进入场景工作区。
 */

interface ScenarioItem {
  readonly scenarioId: string;
  readonly domainId: string;
  readonly version: string;
  readonly name: string;
  readonly domainType: string;
  readonly description: string;
  readonly goals: readonly string[];
  readonly teamRolesCount: number;
  readonly inputKind: string;
  readonly visualizerComponent: string;
  readonly readinessStatus: string;
}

interface ScenariosResponse {
  readonly scenarios: ScenarioItem[];
  readonly count: number;
}

async function fetchScenarios(): Promise<ApiResult<ScenariosResponse>> {
  try {
    const res = await fetch("/api/v2/scenarios", { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return {
        ok: false,
        error: { kind: "http", status: res.status, message: `HTTP ${res.status}`, url: "/api/v2/scenarios" },
      };
    }
    return { ok: true, data: (await res.json()) as ScenariosResponse, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: err instanceof Error ? err.message : String(err),
        url: "/api/v2/scenarios",
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
  const [scenarios, setScenarios] = useState<ApiResult<ScenariosResponse> | null>(null);
  const [runs, setRuns] = useState<ApiResult<RunsResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchScenarios().then((res) => {
      if (alive) setScenarios(res);
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
            科学智能体科研场景目录 (AI4S Multi-Agent Scenarios)
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "12px", color: "var(--color-ink-mute)" }}>
            基于统一场景合同动态装载 {scenarios?.ok ? scenarios.data.count : "…"} 个科研场景；运行时就绪状态以真实环境探测为准。
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
          刷新注册表
        </button>
      </section>

      {scenarios === null && <div style={{ fontSize: "13px", color: "var(--color-ink-mute)" }}>加载科研场景目录…</div>}
      {scenarios && !scenarios.ok && (
        <PanelEmptyState variant="missing" title="场景注册表不可达" description={scenarios.error.message} />
      )}

      {scenarios && scenarios.ok && (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
            gap: "18px",
          }}
        >
          {scenarios.data.scenarios.map((s) => {
            const domainRuns = runsByDomain.get(s.domainId) ?? [];
            const latest = domainRuns.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];

            return (
              <article
                key={s.scenarioId}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  borderRadius: "12px",
                  border: "1px solid var(--color-line)",
                  backgroundColor: "var(--color-surface)",
                  padding: "20px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                    <FlaskConical size={16} color="var(--color-brand)" />
                    <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                      {s.name}
                    </h2>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: "11px",
                        fontFamily: "monospace",
                        color: "#0958d9",
                        backgroundColor: "#e6f4ff",
                        borderRadius: "9999px",
                        padding: "2px 8px",
                        fontWeight: 600,
                      }}
                    >
                      {s.readinessStatus}
                    </span>
                  </div>

                  <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", marginBottom: "8px", fontFamily: "monospace" }}>
                    {s.scenarioId} · v{s.version}
                  </div>

                  <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
                    {s.description}
                  </p>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <Users size={13} /> {s.teamRolesCount} 个专属智能体角色
                    </span>
                    <span>·</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <Shield size={13} /> 输入: {s.inputKind}
                    </span>
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      borderTop: "1px dashed var(--color-line)",
                      paddingTop: "12px",
                      marginBottom: "14px",
                      fontSize: "12px",
                      color: "var(--color-ink-soft)",
                    }}
                  >
                    <strong>真实运行记录</strong>：{domainRuns.length} 次
                    {latest ? (
                      <div style={{ marginTop: "4px" }}>
                        最近: <Link to={`/runs/${encodeURIComponent(latest.run_id)}`} style={{ color: "var(--color-brand)", fontFamily: "monospace" }}>{latest.run_id}</Link> ({latest.status})
                      </div>
                    ) : (
                      <div style={{ marginTop: "4px", color: "var(--color-ink-mute)" }}>
                        暂无真实运行记录（不以固定样例假冒）。
                      </div>
                    )}
                  </div>

                  <Link
                    to={`/scenarios/${encodeURIComponent(s.scenarioId)}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                      backgroundColor: "var(--color-brand-deep)",
                      color: "#ffffff",
                      textDecoration: "none",
                      borderRadius: "6px",
                      padding: "8px 14px",
                      fontSize: "13px",
                      fontWeight: 600,
                    }}
                  >
                    进入科研场景工作台 <ArrowRight size={14} />
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
