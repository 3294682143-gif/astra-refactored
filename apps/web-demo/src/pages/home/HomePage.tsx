import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ArrowRight,
  FileCheck2,
  Gauge,
  MessageSquareText,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { PanelEmptyState } from "@/components/PanelEmptyState";
import {
  fetchCapabilities,
  fetchReplayList,
  type ApiResult,
  type CapabilitiesResponse,
  type ProviderInfo,
  type ReplayListItem,
} from "@/api/client.ts";

interface InnovationCard {
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly to: string;
  readonly cta: string;
  readonly icon: typeof ShieldCheck;
}

function pickGoldenRunId(items: readonly ReplayListItem[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  const withL2 = items.filter((it) => it.has_l2 !== false);
  const first = (withL2.length > 0 ? withL2 : items)[0];
  return typeof first?.run_id === "string" ? first.run_id : null;
}

function providerLabel(info: ProviderInfo | undefined): string {
  if (!info) return "未探测";
  const provider = info.provider ?? "unknown";
  if (provider === "unconfigured") return "未配置（SOLVER_NOT_CONFIGURED）";
  const model = info.model ? ` · ${info.model}` : "";
  return `${provider}${model}`;
}

export function HomePage() {
  const [caps, setCaps] = useState<ApiResult<CapabilitiesResponse> | null>(null);
  const [replays, setReplays] = useState<ApiResult<{ items?: ReplayListItem[] }> | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCapabilities().then((res) => {
      if (alive) setCaps(res);
    });
    fetchReplayList().then((res) => {
      if (alive) setReplays(res);
    });
    return () => {
      alive = false;
    };
  }, []);

  const capsData = caps && caps.ok ? caps.data : null;
  const providerInfo = capsData?.provider_info;
  const protocolSource = providerInfo?.protocol_source ?? "live";
  const goldenRunId = pickGoldenRunId(replays && replays.ok ? replays.data.items : undefined);

  const cards: InnovationCard[] = [
    {
      title: "创新点 1 · 可验证科学计算（算）",
      subtitle: "M1–M5 运行时 / 拒止早退 / 强制取证 / 多数票锚定",
      description:
        "每道科学计算题拉满完整架构：unsolved 先拒一次、弃权强制取证、独立选票多数决收口，全部结论锚定确定性计算资产证据。这是可复制推广到其它科学场景的「算」内核。",
      to: goldenRunId ? `/runs/${encodeURIComponent(goldenRunId)}` : "/runs",
      cta: goldenRunId ? "查看黄金审计运行" : "查看运行列表",
      icon: ShieldCheck,
    },
    {
      title: "创新点 2 · 工具编排与执行韧性（做）",
      subtitle: "gateway-events 精确键校验 / cancelInferenceDecision / 409 恢复链",
      description:
        "工具自主调用的鲁棒底座：SSE 事件逐帧过 parseGatewayEvent 校验；取消只报告已确认语义（本地 abort ≠ 服务端停止）；409 冲突按 5s 证明窗单次重试。",
      to: "/protocol/resilience",
      cta: "演示韧性三场景",
      icon: Waypoints,
    },
    {
      title: "创新点 3 · 可复现验证与审计回放（验证·迭代）",
      subtitle: "7 审计子标签 / 确定性回放 / 协议观测台",
      description:
        "科学结论可复现可审计：事件时间线、资产观测、评审修复、预算指标全程可观测；L2 存档一键离线回放——支撑「假设—实验—验证—迭代」闭环与场景复制。",
      to: goldenRunId ? `/runs/${encodeURIComponent(goldenRunId)}/replay` : "/protocol",
      cta: goldenRunId ? "回放时间胶囊" : "进入协议观测台",
      icon: FileCheck2,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <section
        style={{
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "24px 28px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
          <Gauge size={20} color="var(--color-brand)" />
          <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            书生 AI4S 科学智能体 · 可验证计算驾驶舱
          </h1>
        </div>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
          兴智杯 Track160 · 方向1 AI4S 科学智能体：以书生 Intern（Atria-Dawn / Intern-S2）大模型与工具链为主，围绕「算—做—验证—迭代」构建可验证的科学计算闭环。
          数学推理智能体是本平台可复制推广的科学场景之一——同一「算—做—验证—迭代」底座可迁移到物理、化学、生命科学等场景，仅替换领域计算资产与评测题集。
          本页为答辩动线起点，三张创新点卡片对应可验证计算、执行韧性、可复现审计三层能力。
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "10px",
            marginTop: "16px",
            fontSize: "12px",
          }}
        >
          <span
            style={{
              borderRadius: "9999px",
              border: "1px solid var(--color-line)",
              padding: "4px 12px",
              color: "var(--color-ink-soft)",
              backgroundColor: "var(--color-surface-muted)",
            }}
          >
            推理提供方（服务端环境决定，浏览器只读）：{providerLabel(providerInfo)}
          </span>
          <span
            style={{
              borderRadius: "9999px",
              border: "1px solid var(--color-line)",
              padding: "4px 12px",
              color: "var(--color-ink-soft)",
              backgroundColor: "var(--color-surface-muted)",
            }}
          >
            协议数据源：{protocolSource === "mock" ? "mock 合成（synthetic）" : protocolSource}
          </span>
          <span
            style={{
              borderRadius: "9999px",
              border: "1px solid var(--color-line)",
              padding: "4px 12px",
              color: "var(--color-ink-soft)",
              backgroundColor: "var(--color-surface-muted)",
            }}
          >
            参赛方向：方向1 · AI4S（数学为可复制推广场景）
          </span>
          {caps && !caps.ok && (
            <span
              style={{
                borderRadius: "9999px",
                border: "1px solid var(--color-line-strong)",
                padding: "4px 12px",
                color: "var(--color-danger, #b00)",
                backgroundColor: "var(--color-surface-muted)",
              }}
            >
              /api/capabilities 不可达：{caps.error.message}
            </span>
          )}
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
        {cards.map(({ title, subtitle, description, to, cta, icon: Icon }) => (
          <article
            key={title}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              borderRadius: "12px",
              border: "1px solid var(--color-line)",
              backgroundColor: "var(--color-surface)",
              padding: "20px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Icon size={18} color="var(--color-brand)" />
              <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>{title}</h2>
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>{subtitle}</div>
            <p style={{ margin: 0, flex: 1, fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
              {description}
            </p>
            <Link
              to={to}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                alignSelf: "flex-start",
                borderRadius: "8px",
                backgroundColor: "var(--color-brand)",
                color: "#fff",
                padding: "7px 14px",
                fontSize: "13px",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              {cta}
              <ArrowRight size={14} />
            </Link>
          </article>
        ))}
      </section>

      <section
        style={{
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "20px 24px",
        }}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
          <MessageSquareText size={16} style={{ verticalAlign: "-3px", marginRight: "6px" }} />
          答辩动线（3 分钟）
        </h2>
        <ol style={{ margin: 0, paddingLeft: "20px", fontSize: "13px", color: "var(--color-ink-soft)", lineHeight: 2 }}>
          <li><Link to="/chat">产品对话页</Link>：切换思考开关（快速/深度），观察 reasoning_dispatched 尾注与停止生成的诚实语义</li>
          <li><Link to="/protocol/resilience">韧性演示</Link>：取消 / 409 恢复 / 429 节流三场景的判定链实证（工具编排鲁棒性）</li>
          <li><Link to={goldenRunId ? `/runs/${encodeURIComponent(goldenRunId)}` : "/runs"}>黄金运行 7 子标签审计</Link> → <Link to={goldenRunId ? `/runs/${encodeURIComponent(goldenRunId)}/replay` : "/runs"}>时间胶囊回放</Link>（可复现验证）</li>
          <li>可复制推广：同一「算—做—验证—迭代」底座由数学迁移到物理 / 化学 / 生信等科学场景，仅替换领域计算资产与评测题集</li>
          <li><Link to="/batch/compare">Atria-Dawn vs Intern-S2 同域 A/B 对照</Link>：同题集、同预算下的稳定性与口径对照</li>
        </ol>
        {replays && replays.ok && goldenRunId === null && (
          <div style={{ marginTop: "12px" }}>
            <PanelEmptyState
              title="暂无可回放的时间胶囊"
              description="完成一次真实求解后，L2 存档会出现在 /api/replays 列表，本页将自动给出黄金运行深链。"
            />
          </div>
        )}
      </section>
    </div>
  );
}
