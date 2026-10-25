import { useEffect, useState } from "react";
import { Boxes, CircleHelp, FileCode2, Layers, RefreshCw, ShieldQuestion } from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchAssets,
  fetchBuildManifest,
  type ApiResult,
  type AssetsResponse,
  type BuildManifestSummary,
} from "@/api/client.ts";

const UNKNOWN = "未知";

export function AssetsPage() {
  const [manifest, setManifest] = useState<ApiResult<BuildManifestSummary> | null>(null);
  const [assets, setAssets] = useState<ApiResult<AssetsResponse> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setManifest(null);
    setAssets(null);
    fetchBuildManifest().then((res) => {
      if (alive) setManifest(res);
    });
    fetchAssets().then((res) => {
      if (alive) setAssets(res);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const manifestData = manifest && manifest.ok ? manifest.data : null;
  const assetCount = assets && assets.ok ? assets.data.items.length : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          能力资产与方法基准浏览器
        </h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)" }}>
          所有数字均取自 BFF 接口与发布清单快照；接口未提供的计数显示「未知」，不以静态文案冒充已发布事实。
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", marginBottom: "8px" }}>
            <FileCode2 size={18} />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>发布清单登记 JS 产物</h3>
          </div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginBottom: "4px" }}>
            {manifestData ? `${manifestData.jsCount} 项` : UNKNOWN}
          </div>
          <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            来源：<code>/BUILD_MANIFEST.json</code> 的 <code>js[]</code> 条目数
            {manifestData ? `（profileId=${manifestData.profileId ?? UNKNOWN}，engine=${manifestData.engine ?? UNKNOWN}）` : "（清单不可用）"}。
          </div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", marginBottom: "8px" }}>
            <Layers size={18} />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>发布清单登记的数学族文件</h3>
          </div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginBottom: "4px" }}>
            {manifestData ? `${manifestData.mathFamilyFileCount} 个文件` : UNKNOWN}
          </div>
          <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            来源：清单 <code>mathFamilyFiles</code> 键数。此为文件计数，不等于数学族能力数量。
          </div>
        </div>

        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "#ffffff", padding: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-brand)", marginBottom: "8px" }}>
            <Boxes size={18} />
            <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>已注册运行资产</h3>
          </div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)", marginBottom: "4px" }}>
            {assetCount === null ? UNKNOWN : `${assetCount} 项`}
          </div>
          <div style={{ fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.5 }}>
            来源：<code>GET /api/assets</code> 实时响应
            {assets && !assets.ok ? `（接口失败：${assets.error.message}）` : "。"}
          </div>
        </div>
      </div>

      <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-line)", backgroundColor: "var(--color-surface-muted)", padding: "18px 20px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-brand-deep)", marginBottom: "6px" }}>
          接口未提供的能力资产计数（显式未知）
        </div>
        <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
          <li>方法卡总数（例如 general_v11 方法卡）：{UNKNOWN} —— BFF 未暴露方法卡目录接口。</li>
          <li>数学族分类数量：{UNKNOWN} —— 仅有文件计数，无分类接口。</li>
          <li>已注册计算工具数量：{UNKNOWN} —— 无 <code>/api/tools</code> 接口。</li>
        </ul>
      </div>

      {manifest === null ? (
        <div style={{ padding: "18px", fontSize: "12px", color: "var(--color-ink-soft)" }}>
          正在读取发布清单快照...
        </div>
      ) : !manifest.ok ? (
        <PanelEmptyState
          variant="missing"
          title="发布清单快照不可用（真实错误态）"
          description={`${manifest.error.message}（资源：${manifest.error.url}）`}
          hint="校验状态记为 UNKNOWN，不显示为「通过」。"
          action={
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "8px",
                border: "1px solid var(--color-brand)",
                backgroundColor: "var(--color-brand-tint)",
                color: "var(--color-brand-deep)",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              <span>重新加载</span>
            </button>
          }
        />
      ) : (
        <div style={{ borderRadius: "var(--radius-card)", border: "1px solid var(--color-brand-ring)", backgroundColor: "var(--color-brand-tint)", padding: "16px 20px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
            <ShieldQuestion size={20} color="var(--color-brand-deep)" style={{ marginTop: "2px", flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
                发布清单已加载 · 校验状态：UNVERIFIED（本台未逐文件复核哈希）
              </div>
              <div style={{ fontSize: "11px", color: "var(--color-ink-soft)", lineHeight: 1.6, marginTop: "4px" }}>
                本机对该清单原始字节计算的 SHA-256：
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  {manifest.data.manifestSha256 ?? "不可用（当前环境无 WebCrypto）"}
                </code>
                <br />
                清单自述 schemaVersion={manifest.data.schemaVersion ?? UNKNOWN}，source.commit=
                {manifest.data.commit ?? UNKNOWN}。上述仅为清单内容与本地摘要，不构成对运行时代码完整性或数学能力的核对结论。
              </div>
            </div>
          </div>
          <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--color-brand-deep)", whiteSpace: "nowrap" }}>
            /BUILD_MANIFEST.json
          </span>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
        <CircleHelp size={12} />
        <span>说明：清单快照由构建期从 release/BUILD_MANIFEST.json 拷贝至 public/，属静态事实记录；逐文件哈希复核需在仓库侧执行。</span>
      </div>
    </div>
  );
}