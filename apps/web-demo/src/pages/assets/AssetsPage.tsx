import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Boxes, Calculator, CircleHelp, RefreshCw, Search, ShieldQuestion } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchMathAsset,
  fetchMathAssets,
  type ApiResult,
  type MathAssetDetail,
  type MathAssetsResponse,
} from "@/api/client.ts";

export function AssetsPage() {
  const [catalog, setCatalog] = useState<ApiResult<MathAssetsResponse> | null>(null);
  const [selected, setSelected] = useState<MathAssetDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setSelected(null);
    setDetailError(null);
    fetchMathAssets().then((res) => {
      if (!alive) return;
      setCatalog(res);
      if (res.ok && res.data.assets.length > 0) {
        const first = res.data.assets[0]!;
        fetchMathAsset(first.assetId).then((detail) => {
          if (!alive) return;
          if (detail.ok) setSelected(detail.data);
          else setDetailError(detail.error.message);
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const data = catalog && catalog.ok ? catalog.data : null;
  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return data.assets;
    return data.assets.filter(
      (asset) =>
        asset.name.toLowerCase().includes(needle) ||
        asset.assetId.toLowerCase().includes(needle) ||
        asset.summary.toLowerCase().includes(needle) ||
        asset.targets.some((target) => target.toLowerCase().includes(needle)),
    );
  }, [data, query]);

  const choose = async (assetId: string) => {
    setDetailError(null);
    const detail = await fetchMathAsset(assetId);
    if (detail.ok) setSelected(detail.data);
    else setDetailError(detail.error.message);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          数学资产
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          唯一规范目录驱动的资产发现页。资产以稳定 assetId 标识，计算行为以 target 区分；页面不维护第二份方法卡、数学族或工具目录。
        </p>
      </div>

      {catalog === null ? (
        <div style={{ padding: "18px", fontSize: "12px", color: "var(--color-ink-soft)" }}>正在读取规范目录…</div>
      ) : !catalog.ok ? (
        <PanelEmptyState
          variant="missing"
          title="数学资产目录不可用（真实错误态）"
          description={`${catalog.error.message}（资源：${catalog.error.url}）`}
          hint="目录不可用时不会回退到方法卡、数学族或旧工具表。"
          action={
            <button type="button" onClick={() => setReloadKey((k) => k + 1)}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", borderRadius: "8px", border: "1px solid var(--color-brand)", backgroundColor: "var(--color-brand-tint)", color: "var(--color-brand-deep)", padding: "8px 16px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              <RefreshCw size={14} />重新加载
            </button>
          }
        />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
            <SummaryCard icon={<Boxes size={18} />} label="数学资产" value={`${data?.assetCount ?? "未知"} 项`} note={`catalogVersion ${data?.catalogVersion ?? "未知"}`} />
            <SummaryCard icon={<Calculator size={18} />} label="计算行为" value={`${data?.computationBehaviorCount ?? "未知"} 项`} note="按 (assetId, target) 唯一计数" />
            <SummaryCard icon={<ShieldQuestion size={18} />} label="仅指导资产" value={`${data?.guidanceOnlyCount ?? "未知"} 项`} note="零计算行为不是缺失" />
          </div>

          <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", padding: "12px 16px", fontSize: "11px", color: "var(--color-ink-soft)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
            catalogDigest: {data?.catalogDigest ?? "未知"}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: "20px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", border: "1px solid var(--color-line-strong)", borderRadius: "8px", padding: "8px 12px", backgroundColor: "#ffffff" }}>
                <Search size={15} color="var(--color-ink-mute)" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按名称、assetId 或 target 搜索"
                  style={{ border: "none", outline: "none", width: "100%", fontSize: "13px", color: "var(--color-ink)" }} />
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "620px", overflowY: "auto" }}>
                {filtered.map((asset) => (
                  <button key={asset.assetId} type="button" onClick={() => choose(asset.assetId)}
                    style={{ textAlign: "left", borderRadius: "10px", border: `1px solid ${selected?.assetId === asset.assetId ? "var(--color-brand)" : "var(--color-line)"}`, backgroundColor: selected?.assetId === asset.assetId ? "var(--color-brand-tint)" : "#ffffff", padding: "12px 14px", cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
                      <strong style={{ fontSize: "13px", color: "var(--color-brand-deep)" }}>{asset.name}</strong>
                      <span style={{ fontSize: "10px", color: asset.guidanceOnly ? "var(--color-ink-mute)" : "var(--color-brand)" }}>{asset.guidanceOnly ? "仅指导" : `${asset.behaviorCount} 行为`}</span>
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontFamily: "var(--font-mono)", marginTop: "4px" }}>{asset.assetId}</div>
                    <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", marginTop: "6px", lineHeight: 1.5 }}>{asset.summary}</div>
                  </button>
                ))}
                {filtered.length === 0 ? <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>没有匹配的数学资产。</div> : null}
              </div>
            </div>

            <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
              {detailError ? <div style={{ color: "var(--color-state-error)", fontSize: "12px" }}>资产详情读取失败：{detailError}</div> : null}
              {!selected ? <div style={{ color: "var(--color-ink-mute)", fontSize: "12px" }}>选择左侧资产查看适用条件、步骤、输入参数与证据边界。</div> : (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "18px", color: "var(--color-brand-deep)" }}>{selected.name}</h3>
                    <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", fontFamily: "var(--font-mono)", marginTop: "4px" }}>{selected.assetId} · v{selected.version}</div>
                    <p style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>{selected.summary}</p>
                  </div>
                  <DetailBlock title="适用条件" rows={selected.instructions.conditions} />
                  <DetailBlock title="步骤" rows={selected.instructions.procedure} />
                  <DetailBlock title="不适用情况" rows={selected.instructions.misuse} />
                  <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
                    <strong style={{ color: "var(--color-brand-deep)" }}>证据边界：</strong>{selected.instructions.verificationBoundary}
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "8px" }}>计算行为</div>
                    {selected.behaviors.length === 0 ? <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>该资产仅提供指导，不包含计算行为。</div> : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {selected.behaviors.map((behavior) => (
                          <div key={behavior.target} style={{ border: "1px solid var(--color-line)", borderRadius: "8px", padding: "10px 12px", fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.55 }}>
                            <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-brand)", fontWeight: 600 }}>{behavior.target}</div>
                            <div>{behavior.declaredScope}</div>
                            <div>参数：{behavior.requiredParams.join(", ") || "无"}；结果：{behavior.resultType}；证据上限：{behavior.evidenceCeiling}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "11px", color: "var(--color-ink-mute)" }}>
            <CircleHelp size={12} />
            <span>目录来自 GET /api/math-assets；运行产物仍由 GET /api/assets 单独表示，不计入数学资产数量。</span>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard(props: { icon: ReactNode; label: string; value: string; note: string }) {
  return (
    <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", fontSize: "13px", fontWeight: 600 }}>{props.icon}{props.label}</div>
      <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginTop: "8px" }}>{props.value}</div>
      <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", marginTop: "4px" }}>{props.note}</div>
    </div>
  );
}

function DetailBlock(props: { title: string; rows: readonly string[] }) {
  return (
    <div>
      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "6px" }}>{props.title}</div>
      <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.65 }}>
        {props.rows.map((row, index) => <li key={`${props.title}-${index}`}>{row}</li>)}
      </ul>
    </div>
  );
}
