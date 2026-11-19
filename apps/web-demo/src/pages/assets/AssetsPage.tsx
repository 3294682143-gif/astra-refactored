import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Boxes,
  Compass,
  Cpu,
  Hash,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import {
  fetchMathAsset,
  fetchMathAssets,
  type MathAssetDetail,
  type MathAssetsResponse,
} from "@/api/client.ts";
import { PanelEmptyState } from "@/components/PanelEmptyState.tsx";

export function AssetsPage() {
  const [catalog, setCatalog] = useState<MathAssetsResponse | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MathAssetDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    const res = await fetchMathAssets();
    if (!res.ok) {
      setListError(res.error.message);
      setCatalog(null);
      setLoadingList(false);
      return;
    }
    setCatalog(res.data);
    setLoadingList(false);
    if (res.data.assets.length > 0) {
      setSelectedAssetId((prev) => prev ?? res.data.assets[0].assetId);
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    if (!selectedAssetId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);

    void fetchMathAsset(selectedAssetId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setDetailError(res.error.message);
        setDetail(null);
      } else {
        setDetail(res.data);
      }
      setLoadingDetail(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedAssetId]);

  const filteredAssets = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    if (!q) return catalog.assets;
    return catalog.assets.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.assetId.toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q) ||
        item.targets.some((t) => t.toLowerCase().includes(q)),
    );
  }, [catalog, query]);

  return (
    <div className="zygos-page-container" style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-brand-mid)",
              marginBottom: "6px",
            }}
          >
            <Boxes size={13} />
            <span>MATH ASSET REGISTRY · 可信数学方法目录</span>
          </div>
          <h1
            className="zygos-keynote-title"
            style={{
              margin: 0,
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.025em",
            }}
          >
            数学方法资产库
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "13.5px", color: "var(--color-ink-soft)" }}>
            展示研究引擎阶段 1/2 受控挂载的符号与解析数学资产规范（含适用边界、误用警示与证据上限）。
          </p>
        </div>

        {catalog && (
          <div
            className="zygos-glass"
            style={{
              padding: "8px 14px",
              borderRadius: "12px",
              display: "inline-flex",
              alignItems: "center",
              gap: "10px",
              fontSize: "12px",
              color: "var(--color-ink-soft)",
            }}
          >
            <Hash size={14} color="var(--color-brand-mid)" />
            <span>目录版本 {catalog.catalogVersion}</span>
            <span style={{ color: "var(--color-line-strong)" }}>|</span>
            <code
              title={catalog.catalogDigest}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                color: "var(--color-code-inline-ink)",
              }}
            >
              digest: {catalog.catalogDigest.slice(0, 14)}…
            </code>
          </div>
        )}
      </div>

      {/* 3 KPI Summary Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "14px",
        }}
      >
        {[
          {
            label: "已注册数学资产",
            value: catalog?.assetCount ?? "—",
            hint: `Schema v${catalog?.schemaVersion ?? "—"}`,
            icon: Boxes,
            color: "#3b82f6",
          },
          {
            label: "计算行为原语数",
            value: catalog?.computationBehaviorCount ?? "—",
            hint: "具备可声明证据上限的计算接口",
            icon: Cpu,
            color: "#38bdf8",
          },
          {
            label: "纯方法指导资产",
            value: catalog?.guidanceOnlyCount ?? "—",
            hint: "仅作启发规约，不充当数值验证器",
            icon: Compass,
            color: "#818cf8",
          },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.label}
              className="zygos-bento"
              style={{
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
                  {kpi.label}
                </span>
                <Icon size={16} color={kpi.color} />
              </div>
              <div
                className="zygos-tabular"
                style={{
                  fontSize: "30px",
                  fontWeight: 800,
                  color: "var(--color-brand-deep)",
                  letterSpacing: "-0.03em",
                  lineHeight: 1.1,
                }}
              >
                {kpi.value}
              </div>
              <div style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>{kpi.hint}</div>
            </div>
          );
        })}
      </div>

      {/* Main Split-Pane Content */}
      {loadingList ? (
        <div
          className="zygos-glass"
          style={{
            borderRadius: "16px",
            padding: "48px 24px",
            textAlign: "center",
            fontSize: "13.5px",
            color: "var(--color-ink-soft)",
          }}
        >
          正在读取数学资产目录...
        </div>
      ) : listError ? (
        <PanelEmptyState
          variant="missing"
          title="数学资产目录加载失败"
          description={listError}
          action={
            <button
              type="button"
              onClick={() => void loadAssets()}
              className="zygos-btn-primary"
              style={{ padding: "8px 16px", fontSize: "13px" }}
            >
              重新加载
            </button>
          }
        />
      ) : !catalog || catalog.assets.length === 0 ? (
        <PanelEmptyState
          variant="empty"
          title="未注册数学资产"
          description="后端 /api/math-assets 未返回任何可用数学方法条目。"
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(290px, 370px) minmax(0, 1fr)",
            gap: "16px",
            alignItems: "start",
          }}
        >
          {/* Left Master List */}
          <div
            className="zygos-glass"
            style={{
              borderRadius: "16px",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <Search
                size={14}
                color="var(--color-ink-mute)"
                style={{ position: "absolute", left: "11px", pointerEvents: "none" }}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="筛选资产名称、ID 或 target..."
                style={{
                  width: "100%",
                  padding: "8px 10px 8px 32px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-line-strong)",
                  backgroundColor: "var(--color-surface-sunken)",
                  fontSize: "12.5px",
                  outline: "none",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                maxHeight: "640px",
                overflowY: "auto",
                paddingRight: "2px",
              }}
            >
              {filteredAssets.length === 0 ? (
                <div style={{ padding: "24px 12px", textAlign: "center", fontSize: "12.5px", color: "var(--color-ink-mute)" }}>
                  没有匹配 “{query}” 的数学资产
                </div>
              ) : (
                filteredAssets.map((item) => {
                  const selected = item.assetId === selectedAssetId;
                  return (
                    <button
                      key={item.assetId}
                      type="button"
                      onClick={() => setSelectedAssetId(item.assetId)}
                      className="zygos-node-card"
                      style={{
                        textAlign: "left",
                        padding: "12px 14px",
                        borderRadius: "12px",
                        border: selected
                          ? "1px solid var(--color-brand-mid)"
                          : "1px solid var(--color-line)",
                        backgroundColor: selected
                          ? "var(--color-brand-tint)"
                          : "var(--color-surface-sunken)",
                        boxShadow: selected ? "var(--shadow-glow-brand)" : "none",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
                          {item.name}
                        </span>
                        <span
                          style={{
                            padding: "2px 7px",
                            borderRadius: "999px",
                            fontSize: "10.5px",
                            fontWeight: 600,
                            backgroundColor: item.guidanceOnly
                              ? "rgba(129, 140, 248, 0.16)"
                              : "var(--color-state-success-bg)",
                            color: item.guidanceOnly
                              ? "var(--color-aurora-indigo)"
                              : "var(--color-state-success)",
                          }}
                        >
                          {item.guidanceOnly ? "启发指导" : `${item.behaviorCount} 行为`}
                        </span>
                      </div>

                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-ink-mute)" }}>
                        {item.assetId} · v{item.version}
                      </div>

                      <div
                        style={{
                          fontSize: "12px",
                          lineHeight: 1.5,
                          color: "var(--color-ink-soft)",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {item.summary}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Detail Inspector */}
          <div
            className="zygos-glass"
            style={{
              borderRadius: "16px",
              padding: "22px 24px",
              display: "flex",
              flexDirection: "column",
              gap: "18px",
            }}
          >
            {loadingDetail ? (
              <div style={{ padding: "40px 16px", textAlign: "center", fontSize: "13px", color: "var(--color-ink-soft)" }}>
                正在加载资产规范详情...
              </div>
            ) : detailError ? (
              <PanelEmptyState
                variant="missing"
                title="无法读取该资产详情"
                description={detailError}
              />
            ) : !detail ? (
              <div style={{ padding: "40px 16px", textAlign: "center", fontSize: "13px", color: "var(--color-ink-mute)" }}>
                请从左侧选择一项数学资产查看详细规约。
              </div>
            ) : (
              <>
                <div style={{ borderBottom: "1px solid var(--color-line)", paddingBottom: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 800, color: "var(--color-brand-deep)" }}>
                          {detail.name}
                        </h2>
                        <code
                          style={{
                            padding: "2px 8px",
                            borderRadius: "6px",
                            backgroundColor: "var(--color-code-inline-bg)",
                            color: "var(--color-code-inline-ink)",
                            fontSize: "11.5px",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {detail.assetId}@{detail.version}
                        </code>
                      </div>
                      <p style={{ margin: "8px 0 0", fontSize: "13.5px", lineHeight: 1.6, color: "var(--color-ink)" }}>
                        {detail.summary}
                      </p>
                    </div>
                  </div>

                  {(detail.targets ?? []).length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "12px" }}>
                      {(detail.targets ?? []).map((target) => (
                        <span
                          key={target}
                          style={{
                            padding: "3px 10px",
                            borderRadius: "999px",
                            backgroundColor: "var(--color-surface-sunken)",
                            border: "1px solid var(--color-line)",
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            color: "var(--color-brand-mid)",
                          }}
                        >
                          target: {target}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Instructions Sections */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px" }}>
                  <InstructionCard
                    title="前置适用条件 (Conditions)"
                    icon={<Sparkles size={14} color="#3b82f6" />}
                    items={detail.instructions?.conditions ?? []}
                  />
                  <InstructionCard
                    title="受控执行步骤 (Procedure)"
                    icon={<BookOpen size={14} color="#38bdf8" />}
                    items={detail.instructions?.procedure ?? []}
                  />
                </div>

                {(detail.instructions?.misuse ?? []).length > 0 && (
                  <div
                    style={{
                      padding: "13px 16px",
                      borderRadius: "12px",
                      backgroundColor: "var(--color-state-error-bg)",
                      border: "1px solid var(--color-state-error-border)",
                      color: "var(--color-state-error)",
                      fontSize: "12.5px",
                      lineHeight: 1.6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, marginBottom: "6px" }}>
                      <AlertTriangle size={14} />
                      <span>常见误用与反例警示 (Misuse Warnings)</span>
                    </div>
                    <ul style={{ margin: 0, paddingLeft: "18px" }}>
                      {(detail.instructions?.misuse ?? []).map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div
                  style={{
                    padding: "13px 16px",
                    borderRadius: "12px",
                    backgroundColor: "var(--color-state-candidate-bg)",
                    border: "1px solid var(--color-state-candidate-border)",
                    color: "var(--color-state-candidate)",
                    fontSize: "12.5px",
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, marginBottom: "4px" }}>
                    <ShieldAlert size={14} />
                    <span>可信验证边界 (Verification Boundary)</span>
                  </div>
                  <div>{detail.instructions?.verificationBoundary}</div>
                </div>

                {/* Behaviors Table */}
                {(detail.behaviors ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--color-brand-deep)", marginBottom: "10px" }}>
                      计算行为接口声明 ({(detail.behaviors ?? []).length})
                    </div>
                    <div
                      style={{
                        borderRadius: "12px",
                        border: "1px solid var(--color-line)",
                        overflowX: "auto",
                        backgroundColor: "var(--color-surface-sunken)",
                      }}
                    >
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--color-line)", textAlign: "left", color: "var(--color-ink-mute)" }}>
                            <th style={{ padding: "10px 12px" }}>Target</th>
                            <th style={{ padding: "10px 12px" }}>作用域</th>
                            <th style={{ padding: "10px 12px" }}>必选 / 可选参数</th>
                            <th style={{ padding: "10px 12px" }}>返回类型</th>
                            <th style={{ padding: "10px 12px" }}>证据上限 (Ceiling)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(detail.behaviors ?? []).map((beh, idx) => (
                            <tr key={`${beh.target}-${idx}`} style={{ borderBottom: "1px solid var(--color-line)" }}>
                              <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", color: "var(--color-brand-mid)", fontWeight: 600 }}>
                                {beh.target}
                              </td>
                              <td style={{ padding: "10px 12px", color: "var(--color-ink)" }}>{beh.declaredScope}</td>
                              <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", color: "var(--color-ink-soft)" }}>
                                {(beh.requiredParams ?? []).join(", ") || "—"}
                                {(beh.optionalParams ?? []).length > 0 && (
                                  <span style={{ color: "var(--color-ink-mute)" }}>
                                    {" "}
                                    [{(beh.optionalParams ?? []).join(", ")}]
                                  </span>
                                )}
                              </td>
                              <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", color: "var(--color-ink-soft)" }}>
                                {beh.resultType}
                              </td>
                              <td style={{ padding: "10px 12px", color: "var(--color-state-candidate)", fontWeight: 600 }}>
                                {beh.evidenceCeiling}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InstructionCard({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: readonly string[];
}) {
  return (
    <div
      style={{
        padding: "13px 15px",
        borderRadius: "12px",
        backgroundColor: "var(--color-surface-sunken)",
        border: "1px solid var(--color-line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", fontWeight: 700, color: "var(--color-brand-deep)", marginBottom: "8px" }}>
        {icon}
        <span>{title}</span>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>无额外声明</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px", lineHeight: 1.6, color: "var(--color-ink-soft)" }}>
          {items.map((text, idx) => (
            <li key={idx} style={{ marginBottom: "4px" }}>
              {text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
