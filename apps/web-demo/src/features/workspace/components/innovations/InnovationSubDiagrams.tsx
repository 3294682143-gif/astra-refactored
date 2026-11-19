import React from "react";
import { AlertTriangle, CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import type {
  DerivedThreeInnovationsMetrics,
  InnovationId,
  InnovationPhaseStatus,
  InnovationSpec,
} from "./innovationSpecs";

interface SubCardProps {
  code: string;
  title: string;
  moduleTag: string;
  caption: string;
  status: InnovationPhaseStatus;
  accent: string;
  liveBadge?: string;
  children: React.ReactNode;
}

function statusPill(status: InnovationPhaseStatus) {
  if (status === "completed") {
    return {
      text: "已实证完成",
      bg: "var(--color-state-success-bg)",
      color: "var(--color-state-success)",
      border: "var(--color-state-success-border)",
    };
  }
  if (status === "active") {
    return {
      text: "动态演进中",
      bg: "var(--color-brand-tint)",
      color: "var(--color-brand-deep)",
      border: "var(--color-brand-ring)",
    };
  }
  if (status === "error") {
    return {
      text: "异常截断",
      bg: "var(--color-state-error-bg)",
      color: "var(--color-state-error)",
      border: "var(--color-state-error-border)",
    };
  }
  return {
    text: "机制图解",
    bg: "var(--color-surface-sunken)",
    color: "var(--color-ink-mute)",
    border: "var(--color-line)",
  };
}

function SubDiagramCard({
  code,
  title,
  moduleTag,
  caption,
  status,
  accent,
  liveBadge,
  children,
}: SubCardProps) {
  const pill = statusPill(status);
  const isActive = status === "active";

  return (
    <div
      style={{
        borderRadius: "14px",
        border: isActive
          ? `1.5px solid ${accent}`
          : "1px solid var(--color-line-strong)",
        backgroundColor: "var(--color-surface)",
        boxShadow: isActive ? `0 8px 24px -12px ${accent}` : "var(--shadow-card)",
        padding: "12px 13px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: 0,
      }}
    >
      {/* Card Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            minWidth: 0,
          }}
        >
          <span
            className="zygos-tabular"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "20px",
              height: "20px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 800,
              backgroundColor: `${accent}24`,
              color: accent,
              flexShrink: 0,
            }}
          >
            {code}
          </span>
          <span
            className="zygos-heading-balance"
            style={{
              fontSize: "12.5px",
              fontWeight: 700,
              color: "var(--color-ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
        </div>

        <div style={{ display: "inline-flex", alignItems: "center", gap: "5px", flexShrink: 0 }}>
          <span
            style={{
              padding: "1px 6px",
              borderRadius: "5px",
              fontSize: "9.5px",
              fontFamily: "var(--font-mono)",
              backgroundColor: "var(--color-surface-sunken)",
              border: "1px solid var(--color-line)",
              color: "var(--color-ink-mute)",
            }}
          >
            {moduleTag}
          </span>
          <span
            className="zygos-tabular"
            style={{
              padding: "1px 7px",
              borderRadius: "999px",
              fontSize: "10px",
              fontWeight: 700,
              backgroundColor: pill.bg,
              color: pill.color,
              border: `1px solid ${pill.border}`,
              whiteSpace: "nowrap",
            }}
          >
            {liveBadge || pill.text}
          </span>
        </div>
      </div>

      {/* Visual Diagram Canvas */}
      <div
        className="zygos-blueprint-canvas"
        style={{
          position: "relative",
          borderRadius: "10px",
          border: "1px solid var(--color-line)",
          overflow: "hidden",
          padding: "7px",
        }}
      >
        {children}
      </div>

      {/* Single Concise Signal Line */}
      <div
        style={{
          fontSize: "10.5px",
          color: "var(--color-ink-mute)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {caption}
      </div>
    </div>
  );
}

/* ============================================================================
 * 创新点一 · 3 块源码直观动图
 *   ① M1 契约编译与分层真实任务 DAG (p2-compiler.ts)
 *   ② R0 三角色物理互盲审查 (p4-r0.ts)
 *   ③ 8 维签名雷达 + chooseP2ReadyTask 优先级队列 (agent-semantics.ts / p2-gate.ts)
 * ========================================================================== */
function InnovationOneDiagrams({
  spec,
  metrics,
  animateAlways,
}: {
  spec: InnovationSpec;
  metrics: DerivedThreeInnovationsMetrics;
  animateAlways: boolean;
}) {
  const [s1, s2, s3] = metrics.inn1SubStatuses;
  const { taskDag, routing } = metrics.projection;
  const dagMotion = animateAlways || s1 !== "pending";
  const r0Motion = animateAlways || s2 !== "pending";
  const routeMotion = animateAlways || s3 !== "pending";

  // Pick actual tasks from compiled DAG cleanly into 3 layers
  const layer1 = taskDag.tasks.filter((t) => t.layer === 1).slice(0, 2);
  const layer2 = taskDag.tasks.filter((t) => t.layer === 2).slice(0, 2);
  const layer3 = taskDag.tasks.filter((t) => t.layer === 3).slice(0, 1);

  const l1Nodes = layer1.length > 0 ? layer1 : [{ taskId: "t1", title: "定义域合法性", status: s1 === "completed" ? "completed" : "pending" } as const];
  const l2Nodes = layer2.length > 0 ? layer2 : [{ taskId: "t2", title: "独立第二推导", status: s1 === "completed" ? "completed" : "pending" } as const];
  const l3Node = layer3[0] ?? { taskId: "t3", title: "输出覆盖汇总", status: s1 === "completed" ? "completed" : "pending" as const };

  const r0Roles = [
    { role: "MEANING", label: "题意对齐", sub: "GOAL + 边界" },
    { role: "METHOD", label: "方法与域", sub: "KIND_RISK 风险" },
    { role: "TASK_TOOL", label: "工具覆盖", sub: "TASK_COVERAGE" },
  ];

  const dimsLabels = routing.dimensions.slice(0, 8);

  return (
    <>
      {/* 1-① 真编译分层任务 DAG */}
      <SubDiagramCard
        code={spec.subSpecs[0].code}
        title={spec.subSpecs[0].title}
        moduleTag={spec.subSpecs[0].moduleTag}
        caption={`原题 SHA256 → Goal=${taskDag.goalMeta.kind} → ${taskDag.tasks.length} 义务 · ${taskDag.edges.length} 依赖边`}
        status={s1}
        accent={spec.accentColor}
        liveBadge={`${taskDag.tasks.length} 义务 · v${taskDag.contractVersion}`}
      >
        <svg viewBox="0 0 330 186" width="100%" height="184" role="img" aria-label="P2契约编译与真实分层任务DAG动图">
          <defs>
            <linearGradient id="sub1Grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#3b82f6" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>

          {/* Animated edges: Source -> L1 -> L2 -> L3 */}
          <path d="M 64 93 H 88 M 88 54 V 132 M 88 54 H 104 M 88 132 H 104" stroke="#3b82f6" strokeWidth="1.5" fill="none" className={dagMotion ? "zygos-svg-flow" : ""} />
          <path d="M 184 54 C 198 54, 198 72, 206 72 M 184 132 C 198 132, 198 114, 206 114" stroke="#38bdf8" strokeWidth="1.5" fill="none" className={dagMotion ? "zygos-svg-flow" : ""} />
          <path d="M 278 72 L 290 93 M 278 114 L 290 93" stroke="url(#sub1Grad)" strokeWidth="1.5" fill="none" className={dagMotion ? "zygos-svg-flow" : ""} />

          {dagMotion && (
            <>
              <circle r="2.8" fill="#60a5fa">
                <animateMotion dur="2.2s" repeatCount="indefinite" path="M 64 93 H 88 V 54 H 184 C 198 54, 198 72, 206 72 H 278 L 290 93" />
              </circle>
              <circle r="2.6" fill="#38bdf8">
                <animateMotion dur="2.4s" begin="0.7s" repeatCount="indefinite" path="M 64 93 H 88 V 132 H 184 C 198 132, 198 114, 206 114 H 278 L 290 93" />
              </circle>
            </>
          )}

          {/* Left: M1 Compiler Anchor */}
          <rect x="6" y="42" width="58" height="102" rx="8" fill="var(--color-brand-tint)" stroke="#3b82f6" strokeWidth="1.3" />
          <text x="35" y="66" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="9.5" fontWeight="800">M1 编译</text>
          <rect x="12" y="76" width="46" height="17" rx="4" fill="var(--color-surface-solid)" stroke="#3b82f6" />
          <text x="35" y="88" textAnchor="middle" fill="var(--color-ink)" fontSize="8" fontWeight="700">
            {taskDag.goalMeta.kind.slice(0, 8)}
          </text>
          <text x="35" y="110" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7.4">Scope 锁定</text>
          <text x="35" y="123" textAnchor="middle" fill="#f59e0b" fontSize="7" fontWeight="700">UNKNOWN</text>

          {/* Column Label headers */}
          <text x="144" y="18" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.5" fontWeight="700">L1 前置/合法</text>
          <text x="242" y="18" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.5" fontWeight="700">L2 核心推导</text>
          <text x="306" y="18" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.5" fontWeight="700">L3 汇</text>

          {/* Layer 1 Real Task Nodes */}
          {l1Nodes.map((t, i) => {
            const y = l1Nodes.length === 1 ? 74 : i === 0 ? 34 : 112;
            const done = t.status === "completed";
            return (
              <g key={t.taskId}>
                <rect x="104" y={y} width="80" height="40" rx="7" fill="var(--color-surface-solid)" stroke={done ? "#10b981" : "#3b82f6"} strokeWidth="1.2" />
                <text x="144" y={y + 17} textAnchor="middle" fill="var(--color-ink)" fontSize="8.4" fontWeight="700">
                  {t.title.slice(0, 8)}
                </text>
                <text x="144" y={y + 30} textAnchor="middle" fill={done ? "#10b981" : "var(--color-ink-mute)"} fontSize="7.2" fontWeight="600">
                  {done ? "✓ 已闭合" : "待调度"}
                </text>
              </g>
            );
          })}

          {/* Layer 2 Real Task Nodes */}
          {l2Nodes.map((t, i) => {
            const y = l2Nodes.length === 1 ? 74 : i === 0 ? 52 : 100;
            const done = t.status === "completed";
            return (
              <g key={t.taskId}>
                <rect x="206" y={y} width="72" height="36" rx="6.5" fill="var(--color-surface-solid)" stroke={done ? "#10b981" : "#38bdf8"} strokeWidth="1.2" />
                <text x="242" y={y + 15} textAnchor="middle" fill="var(--color-ink)" fontSize="8" fontWeight="700">
                  {t.title.slice(0, 7)}
                </text>
                <text x="242" y={y + 27} textAnchor="middle" fill={done ? "#10b981" : "#38bdf8"} fontSize="7" fontWeight="600">
                  {done ? "✓ 已复核" : "并行链"}
                </text>
              </g>
            );
          })}

          {/* Layer 3 Output Coverage Sink */}
          <rect
            x="288"
            y="54"
            width="36"
            height="78"
            rx="8"
            fill={l3Node.status === "completed" ? "var(--color-state-success-bg)" : "var(--color-surface-solid)"}
            stroke="#10b981"
            strokeWidth="1.4"
          />
          <text x="306" y="84" textAnchor="middle" fill="var(--color-state-success)" fontSize="8.5" fontWeight="800">终态</text>
          <text x="306" y="98" textAnchor="middle" fill="var(--color-state-success)" fontSize="8.5" fontWeight="800">覆盖</text>
          <text x="306" y="114" textAnchor="middle" fill="var(--color-ink)" fontSize="7.4" fontWeight="700">
            {l3Node.status === "completed" ? "✓" : `v${taskDag.contractVersion}`}
          </text>

          {/* Bottom live counter bar */}
          <rect x="6" y="160" width="318" height="20" rx="5" fill="var(--color-surface-sunken)" stroke="var(--color-line)" />
          <text x="165" y="173" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7.5" fontWeight="600">
            已生成 {taskDag.tasks.length} 项义务节点 · 实际完成 {taskDag.tasks.filter((t) => t.status === "completed").length}/{taskDag.tasks.length} · 依赖边 {taskDag.edges.length}
          </text>
        </svg>
      </SubDiagramCard>

      {/* 1-② R0 三方物理互盲审查 */}
      <SubDiagramCard
        code={spec.subSpecs[1].code}
        title={spec.subSpecs[1].title}
        moduleTag={spec.subSpecs[1].moduleTag}
        caption="prepareP4R0 (PLAN≤64KB) → 三角色互盲锚定原题打分 → aggregateP4R0 定版"
        status={s2}
        accent={spec.accentColor}
        liveBadge={`R0 ${metrics.r0DoneCount}/3`}
      >
        <svg viewBox="0 0 330 186" width="100%" height="184" role="img" aria-label="R0三角色互盲并行审查动图">
          {/* Fan-out lines */}
          <path d="M 66 93 C 82 93, 82 32, 100 32" stroke="#3b82f6" strokeWidth="1.5" fill="none" className={r0Motion ? "zygos-svg-flow" : ""} />
          <path d="M 66 93 H 100" stroke="#38bdf8" strokeWidth="1.5" fill="none" className={r0Motion ? "zygos-svg-flow" : ""} />
          <path d="M 66 93 C 82 93, 82 154, 100 154" stroke="#6366f1" strokeWidth="1.5" fill="none" className={r0Motion ? "zygos-svg-flow" : ""} />

          {/* Fan-in lines */}
          <path d="M 232 32 C 248 32, 248 93, 258 93" stroke="#10b981" strokeWidth="1.5" fill="none" className={r0Motion ? "zygos-svg-flow" : ""} />
          <path d="M 232 93 H 258" stroke="#10b981" strokeWidth="1.5" fill="none" className={r0Motion ? "zygos-svg-flow" : ""} />
          <path d="M 232 154 C 248 154, 248 93, 258 93" stroke="#10b981" strokeWidth="1.5" fill="none" className={r0Motion ? "zygos-svg-flow" : ""} />

          {r0Motion && (
            <>
              <circle r="2.7" fill="#3b82f6">
                <animateMotion dur="2.1s" repeatCount="indefinite" path="M 66 93 C 82 93, 82 32, 100 32 H 232 C 248 32, 248 93, 258 93" />
              </circle>
              <circle r="2.7" fill="#38bdf8">
                <animateMotion dur="2.1s" begin="0.35s" repeatCount="indefinite" path="M 66 93 H 258" />
              </circle>
              <circle r="2.7" fill="#818cf8">
                <animateMotion dur="2.1s" begin="0.7s" repeatCount="indefinite" path="M 66 93 C 82 93, 82 154, 100 154 H 232 C 248 154, 248 93, 258 93" />
              </circle>
            </>
          )}

          {/* Left: prepareP4R0 source snapshot */}
          <rect x="6" y="48" width="60" height="90" rx="8" fill="var(--color-surface-solid)" stroke="var(--color-line-strong)" />
          <text x="36" y="76" textAnchor="middle" fill="var(--color-ink)" fontSize="9" fontWeight="700">原题快照</text>
          <text x="36" y="92" textAnchor="middle" fill="#3b82f6" fontSize="7.4" fontWeight="700">PLAN≤64KB</text>
          <text x="36" y="106" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7">防篡改重build</text>
          <text x="36" y="122" textAnchor="middle" fill="#f59e0b" fontSize="7" fontWeight="700">仅读原题</text>

          {/* Horizontal amber blind isolation barriers */}
          <line x1="98" y1="62" x2="234" y2="62" stroke="#f59e0b" strokeDasharray="3 2.5" strokeWidth="1.2" />
          <rect x="122" y="55" width="88" height="13" rx="6.5" fill="var(--color-surface-solid)" stroke="#f59e0b" strokeWidth="0.9" />
          <text x="166" y="64" textAnchor="middle" fill="#f59e0b" fontSize="7" fontWeight="700">物理互盲 · 禁传草稿</text>

          <line x1="98" y1="123" x2="234" y2="123" stroke="#f59e0b" strokeDasharray="3 2.5" strokeWidth="1.2" />
          <rect x="122" y="116" width="88" height="13" rx="6.5" fill="var(--color-surface-solid)" stroke="#f59e0b" strokeWidth="0.9" />
          <text x="166" y="125" textAnchor="middle" fill="#f59e0b" fontSize="7" fontWeight="700">物理互盲 · 独立打分</text>

          {/* 3 Real R0 Reviewer Cards */}
          {r0Roles.map((r, idx) => {
            const y = idx === 0 ? 12 : idx === 1 ? 73 : 134;
            const liveAg = metrics.r0Agents.find((a) => a.role === r.role);
            const done = liveAg ? liveAg.status === "completed" : metrics.r0DoneCount > idx;
            const verdictText = liveAg?.verdict ?? (done ? "NO_ISSUE" : r.sub);
            return (
              <g key={r.role}>
                <rect
                  x="100"
                  y={y}
                  width="132"
                  height="39"
                  rx="7"
                  fill="var(--color-surface-solid)"
                  stroke={done ? "#10b981" : "#3b82f6"}
                  strokeWidth="1.25"
                />
                <text x="110" y={y + 16} fill="var(--color-ink)" fontSize="9" fontWeight="700">
                  {r.role} · {r.label}
                </text>
                <text x="110" y={y + 30} fill={done ? "#10b981" : "var(--color-ink-mute)"} fontSize="7.4" fontWeight="600">
                  {done ? `裁决: ${verdictText}` : r.sub}
                </text>
                <circle cx="220" cy={y + 19.5} r="4.5" fill={done ? "#10b981" : "#3b82f6"} opacity={done ? 1 : 0.45} />
              </g>
            );
          })}

          {/* Right: Aggregate Decision Gate */}
          <rect
            x="258"
            y="48"
            width="66"
            height="90"
            rx="9"
            fill={metrics.r0DoneCount >= 3 ? "var(--color-state-success-bg)" : "var(--color-surface-solid)"}
            stroke="#10b981"
            strokeWidth="1.4"
          />
          <text x="291" y="75" textAnchor="middle" fill="var(--color-state-success)" fontSize="9" fontWeight="800">汇总定版</text>
          <text x="291" y="92" textAnchor="middle" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">
            {metrics.r0Conclusion || (r0Motion ? "NO_ISSUE" : "待审")}
          </text>
          <text x="291" y="109" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7.2">
            实审 {metrics.r0DoneCount}/3
          </text>
          <text x="291" y="123" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.8">
            至多修订1次
          </text>
        </svg>
      </SubDiagramCard>

      {/* 1-③ 8 维签名路由 & chooseP2ReadyTask 优先级队列 */}
      <SubDiagramCard
        code={spec.subSpecs[2].code}
        title={spec.subSpecs[2].title}
        moduleTag={spec.subSpecs[2].moduleTag}
        caption="8 维特征签名扫描选资产(≤3) → chooseP2ReadyTask Rank0→3 定序 → ≤64KB 派发"
        status={s3}
        accent={spec.accentColor}
        liveBadge={`命中 ${routing.matchedCount}/8 维`}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", height: "184px", justifyContent: "space-between" }}>
          {/* Top: Live 8-dim structural scan grid */}
          <div style={{ position: "relative", padding: "6px 7px", borderRadius: "8px", backgroundColor: "var(--color-surface-solid)", border: "1px solid var(--color-line)", overflow: "hidden" }}>
            {routeMotion && (
              <div
                className="zygos-scan-beam"
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: "36px",
                  background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.26), transparent)",
                  pointerEvents: "none",
                }}
              />
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "9.5px", fontWeight: 700, color: "var(--color-ink-soft)", marginBottom: "5px" }}>
              <span>8 维结构签名探针</span>
              <span style={{ color: "#3b82f6", fontFamily: "var(--font-mono)" }}>
                {routing.methodRoutes[0] || "精选资产 ≤3 · 保守回退"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "4px" }}>
              {dimsLabels.map((dim) => (
                <div
                  key={dim.key}
                  style={{
                    padding: "3px 4px",
                    borderRadius: "5px",
                    fontSize: "9px",
                    fontWeight: dim.matched ? 700 : 500,
                    textAlign: "center",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    backgroundColor: dim.matched ? "var(--color-state-success-bg)" : "var(--color-surface-sunken)",
                    border: `1px solid ${dim.matched ? "var(--color-state-success-border)" : "var(--color-line)"}`,
                    color: dim.matched ? "var(--color-state-success)" : "var(--color-ink-mute)",
                  }}
                >
                  {dim.title}
                </div>
              ))}
            </div>
          </div>

          {/* Middle: Real chooseP2ReadyTask priority queue (from p2-gate.ts KIND_PRIORITY) */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "4px" }}>
            {[
              { rank: "Rank 0", name: "候选合法性", hot: true },
              { rank: "Rank 1", name: "边界例外", hot: true },
              { rank: "Rank 2", name: "已备前置", hot: false },
              { rank: "Rank 3", name: "其余就绪", hot: false },
            ].map((q) => (
              <div
                key={q.rank}
                style={{
                  padding: "3px 5px",
                  borderRadius: "6px",
                  backgroundColor: q.hot ? "var(--color-brand-tint)" : "var(--color-surface-solid)",
                  border: `1px solid ${q.hot ? "var(--color-brand-ring)" : "var(--color-line)"}`,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "8.5px", fontWeight: 800, color: q.hot ? "var(--color-brand-deep)" : "var(--color-ink-mute)" }}>
                  {q.rank}
                </div>
                <div style={{ fontSize: "9px", fontWeight: 600, color: "var(--color-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {q.name}
                </div>
              </div>
            ))}
          </div>

          {/* Bottom: 6-step bounded scheduler SVG */}
          <svg viewBox="0 0 330 48" width="100%" height="46" role="img" aria-label="六步有界调度环">
            <rect
              x="14"
              y="7"
              width="302"
              height="34"
              rx="17"
              fill="none"
              stroke="#3b82f6"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              className={routeMotion ? "zygos-loop-dash" : ""}
            />
            {routeMotion && (
              <circle r="2.8" fill="#38bdf8">
                <animateMotion dur="3.2s" repeatCount="indefinite" path="M 31 7 H 299 A 17 17 0 0 1 299 41 H 31 A 17 17 0 0 1 31 7" />
              </circle>
            )}
            {[
              { x: 58, y: 7, label: "1.就绪" },
              { x: 165, y: 7, label: "2.定序" },
              { x: 272, y: 7, label: "3.查预算" },
              { x: 272, y: 41, label: "4.64KB派发" },
              { x: 165, y: 41, label: "5.更新依赖" },
              { x: 58, y: 41, label: "6.推/止步" },
            ].map((step) => (
              <g key={step.label}>
                <rect x={step.x - 32} y={step.y - 7.5} width="64" height="15" rx="7.5" fill="var(--color-surface-solid)" stroke="var(--color-brand-ring)" strokeWidth="1" />
                <text x={step.x} y={step.y + 3} textAnchor="middle" fill="var(--color-ink)" fontSize="8" fontWeight="600">{step.label}</text>
              </g>
            ))}
          </svg>
        </div>
      </SubDiagramCard>
    </>
  );
}

/* ============================================================================
 * 创新点二 · 3 块源码直观动图
 *   ① 5 路互盲完整求解泳道与真实票值 (agent-loop-context.ts)
 *   ② canonicalAnswerKey 归并柱状图 + 双对抗审计 + CERT1 (agent-answer-key/certificate)
 *   ③ 26×96 控制核 7 步防伪沙箱 + #inputHash 回执 (math_assets_runtime.py)
 * ========================================================================== */
function InnovationTwoDiagrams({
  spec,
  metrics,
  animateAlways,
}: {
  spec: InnovationSpec;
  metrics: DerivedThreeInnovationsMetrics;
  animateAlways: boolean;
}) {
  const [s1, s2, s3] = metrics.inn2SubStatuses;
  const laneMotion = animateAlways || s1 !== "pending";
  const auditMotion = animateAlways || s2 !== "pending";
  const toolMotion = animateAlways || s3 !== "pending";

  const fallbackLenses = [
    { label: "L1 直接推导", ans: null as string | null, done: false, c: "#3b82f6" },
    { label: "L2 逆向代回", ans: null as string | null, done: false, c: "#0ea5e9" },
    { label: "L3 独立复算", ans: null as string | null, done: false, c: "#38bdf8" },
    { label: "L4 分案查漏", ans: null as string | null, done: false, c: "#6366f1" },
    { label: "L5 边界核验", ans: null as string | null, done: false, c: "#10b981" },
  ];

  const laneColors = ["#3b82f6", "#0ea5e9", "#38bdf8", "#6366f1", "#10b981"];
  const lanes =
    metrics.ballots.length > 0
      ? metrics.ballots.slice(0, 5).map((b, i) => ({
          label: b.lensTitle ? b.lensTitle.slice(0, 8) : b.roleLabel.slice(0, 8),
          ans: b.candidatePlain?.slice(0, 8) || null,
          done: b.status === "completed",
          c: laneColors[i % laneColors.length],
        }))
      : fallbackLenses;

  const voteGroups = metrics.voteGroups.slice(0, 3);
  const maxVotes = Math.max(1, ...voteGroups.map((v) => v.count), metrics.topCandidateVotes);

  return (
    <>
      {/* 2-① 5 路真实互盲泳道 */}
      <SubDiagramCard
        code={spec.subSpecs[0].code}
        title={spec.subSpecs[0].title}
        moduleTag={spec.subSpecs[0].moduleTag}
        caption="CONSENSUS_BALLOT_LENSES 屏蔽历史草稿 → 每路生成完整答案 → 严禁碎片拼接"
        status={s1}
        accent={spec.accentColor}
        liveBadge={`${metrics.ballotCount > 0 ? metrics.ballotCount : 5} 盲解分支`}
      >
        <svg viewBox="0 0 330 186" width="100%" height="184" role="img" aria-label="5路互盲独立完整求解实况动图">
          {/* Left Source Anchor */}
          <rect x="6" y="54" width="54" height="78" rx="8" fill="var(--color-brand-tint)" stroke="#38bdf8" strokeWidth="1.3" />
          <text x="33" y="84" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="9" fontWeight="800">同题契约</text>
          <text x="33" y="99" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7.4">contextHash</text>
          <text x="33" y="112" textAnchor="middle" fill="#f59e0b" fontSize="7.2" fontWeight="700">互相屏蔽</text>

          {lanes.map((lane, i) => {
            const y = 12 + i * 33;
            const pathD = `M 60 93 C 76 93, 76 ${y + 13}, 90 ${y + 13} H 248 C 262 ${y + 13}, 262 93, 272 93`;
            return (
              <g key={`${lane.label}-${i}`}>
                <path
                  d={pathD}
                  stroke={lane.c}
                  strokeWidth="1.35"
                  strokeOpacity={lane.done ? 0.9 : 0.5}
                  fill="none"
                  className={laneMotion ? "zygos-svg-flow" : ""}
                />
                {laneMotion && (
                  <circle r="2.5" fill={lane.c}>
                    <animateMotion dur="2s" begin={`${i * 0.22}s`} repeatCount="indefinite" path={pathD} />
                  </circle>
                )}
                <rect
                  x="90"
                  y={y}
                  width="158"
                  height="26"
                  rx="6"
                  fill="var(--color-surface-solid)"
                  stroke={lane.done ? "#10b981" : lane.c}
                  strokeWidth="1.15"
                />
                <text x="98" y={y + 16.5} fill="var(--color-ink)" fontSize="8.3" fontWeight="700">
                  {lane.label}
                </text>
                {/* Live answer pill inside lane */}
                <rect
                  x="192"
                  y={y + 4.5}
                  width="48"
                  height="17"
                  rx="4"
                  fill={lane.ans ? "var(--color-state-success-bg)" : "var(--color-surface-sunken)"}
                  stroke={lane.ans ? "#10b981" : "var(--color-line)"}
                />
                <text
                  x="216"
                  y={y + 15.5}
                  textAnchor="middle"
                  fill={lane.ans ? "var(--color-state-success)" : "var(--color-ink-mute)"}
                  fontSize="7.6"
                  fontWeight="700"
                >
                  {lane.ans || (lane.done ? "✓ 完案" : "完整解")}
                </text>
              </g>
            );
          })}

          {/* Right Candidate Pool */}
          <rect x="272" y="48" width="52" height="90" rx="9" fill="var(--color-state-success-bg)" stroke="#10b981" strokeWidth="1.4" />
          <text x="298" y="80" textAnchor="middle" fill="var(--color-state-success)" fontSize="9.5" fontWeight="800">候选池</text>
          <text x="298" y="96" textAnchor="middle" fill="var(--color-ink)" fontSize="9.5" fontWeight="800">
            {metrics.ballotCount > 0 ? `${metrics.ballotCount} 票` : "5 路"}
          </text>
          <text x="298" y="112" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.2">整案归池</text>
        </svg>
      </SubDiagramCard>

      {/* 2-② 规范键真实计票 + 双对抗审计 + CERT1 */}
      <SubDiagramCard
        code={spec.subSpecs[1].code}
        title={spec.subSpecs[1].title}
        moduleTag={spec.subSpecs[1].moduleTag}
        caption="分式/根式/集合/选项规范归并 → 双对抗审(仅双审一致改锚) → CERT1"
        status={s2}
        accent={spec.accentColor}
        liveBadge={metrics.topCandidateVotes > 0 ? `领先 ${metrics.topCandidateVotes} 票` : `审计 ${metrics.auditCount}/2`}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.08fr", gap: "8px", height: "184px", alignItems: "stretch" }}>
          {/* Left: Real canonicalAnswerKey Tally */}
          <div style={{ padding: "8px", borderRadius: "8px", backgroundColor: "var(--color-surface-solid)", border: "1px solid var(--color-line)", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "9.8px", fontWeight: 700, color: "var(--color-ink-soft)" }}>canonicalKey 归并计票</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
              {voteGroups.length > 0 ? (
                voteGroups.map((vg, idx) => {
                  const pct = Math.max(14, Math.round((vg.count / maxVotes) * 100));
                  const lead = idx === 0;
                  return (
                    <div key={vg.key}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9.5px", marginBottom: "2px" }}>
                        <span style={{ fontWeight: 700, color: lead ? "var(--color-state-success)" : "var(--color-ink)", maxWidth: "85px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {vg.displayPlain || vg.displayCandidate}
                        </span>
                        <span className="zygos-tabular" style={{ fontWeight: 700, color: "var(--color-ink)" }}>
                          {vg.count} 票
                        </span>
                      </div>
                      <div style={{ height: "8px", borderRadius: "999px", backgroundColor: "var(--color-surface-sunken)", overflow: "hidden" }}>
                        <div
                          className={auditMotion && lead ? "zygos-tally-animate" : ""}
                          style={{
                            width: `${pct}%`,
                            height: "100%",
                            borderRadius: "999px",
                            background: lead ? "linear-gradient(90deg, #3b82f6, #10b981)" : "#6366f1",
                          }}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9.5px", marginBottom: "3px" }}>
                    <span style={{ fontWeight: 700, color: "var(--color-state-success)" }}>
                      {metrics.topCandidateText || "领先主桶"}
                    </span>
                    <span className="zygos-tabular" style={{ fontWeight: 700 }}>主候选</span>
                  </div>
                  <div style={{ height: "8px", borderRadius: "999px", backgroundColor: "var(--color-surface-sunken)", overflow: "hidden" }}>
                    <div className={auditMotion ? "zygos-tally-animate" : ""} style={{ width: "84%", height: "100%", borderRadius: "999px", background: "linear-gradient(90deg, #3b82f6, #10b981)" }} />
                  </div>
                </div>
              )}
            </div>

            {/* Canonical equivalence pills */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "3px" }}>
              {["\\frac 化约", "集合去重", "区间归一"].map((tag) => (
                <span key={tag} style={{ padding: "1px 5px", borderRadius: "4px", fontSize: "8.5px", backgroundColor: "var(--color-surface-sunken)", color: "var(--color-ink-mute)" }}>
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Right: Dual Adversarial Audits + CERT1 Rows */}
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "5px" }}>
            {[
              { idx: 0, title: "对抗审计 #1 · 反例", live: metrics.audits[0] },
              { idx: 1, title: "对抗审计 #2 · 复算", live: metrics.audits[1] },
            ].map((ad) => {
              const done = Boolean(ad.live) || metrics.auditCount > ad.idx;
              return (
                <div
                  key={ad.title}
                  style={{
                    padding: "6px 8px",
                    borderRadius: "7px",
                    backgroundColor: "var(--color-surface-solid)",
                    border: `1px solid ${done ? "#f59e0b" : "var(--color-line-strong)"}`,
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  {auditMotion && (
                    <div
                      className="zygos-scan-beam"
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "26px",
                        background: "linear-gradient(90deg, transparent, rgba(245,158,11,0.22), transparent)",
                        animationDelay: `${ad.idx * 0.6}s`,
                      }}
                    />
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "9.5px", fontWeight: 700, color: "#f59e0b" }}>
                    <span>{ad.title}</span>
                    <span style={{ color: done ? "#10b981" : "var(--color-ink-mute)" }}>
                      {done ? (ad.live?.agreement === false ? "提出替代" : "一致认可 ✓") : "互盲审"}
                    </span>
                  </div>
                  <div style={{ fontSize: "8.5px", color: "var(--color-ink-mute)", marginTop: "2px" }}>
                    双审同指替代项才允许改锚
                  </div>
                </div>
              );
            })}

            {/* CERT1 Gate LED Strip */}
            <div
              style={{
                padding: "6px 8px",
                borderRadius: "7px",
                backgroundColor: metrics.certObserved ? "var(--color-state-success-bg)" : "var(--color-surface-solid)",
                border: `1px solid ${metrics.certObserved ? "var(--color-state-success-border)" : "var(--color-line)"}`,
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9.5px", fontWeight: 700, color: metrics.certObserved ? "var(--color-state-success)" : "var(--color-ink-soft)" }}>
                <span>CERT1 结构化自检</span>
                <span>{metrics.certObserved ? "isCertified ✓" : "待收敛"}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "3px" }}>
                {["FINAL", "CHECK", "OPTS", "VERDICT"].map((row) => (
                  <span
                    key={row}
                    style={{
                      textAlign: "center",
                      fontSize: "7.8px",
                      fontFamily: "var(--font-mono)",
                      fontWeight: 700,
                      padding: "1px 2px",
                      borderRadius: "4px",
                      backgroundColor: metrics.certObserved ? "var(--color-surface-solid)" : "var(--color-surface-sunken)",
                      color: metrics.certObserved ? "#10b981" : "var(--color-ink-mute)",
                    }}
                  >
                    {row}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </SubDiagramCard>

      {/* 2-③ 26×96 防伪沙箱与 #inputHash 回执 */}
      <SubDiagramCard
        code={spec.subSpecs[2].code}
        title={spec.subSpecs[2].title}
        moduleTag={spec.subSpecs[2].moduleTag}
        caption="拒 9 控制核键 → inputHash 归一化 → 限域隔离计算 → 三元哈希回执"
        status={s3}
        accent={spec.accentColor}
        liveBadge={metrics.toolCount > 0 ? `${metrics.toolCount} 取证回执` : "26×96 目录"}
      >
        <svg viewBox="0 0 330 186" width="100%" height="184" role="img" aria-label="26x96控制核防伪沙箱与哈希回执动图">
          {/* Pipeline arrows */}
          <path d="M 88 74 H 104 M 180 74 H 196 M 248 74 H 262" stroke="#38bdf8" strokeWidth="1.6" fill="none" className={toolMotion ? "zygos-svg-flow" : ""} />

          {/* Reopen feedback loop */}
          <path
            d="M 294 128 C 294 166, 142 166, 142 128"
            stroke="#f59e0b"
            strokeWidth="1.4"
            strokeDasharray="4 3"
            fill="none"
            className={toolMotion ? "zygos-svg-flow-repair" : ""}
          />
          <rect x="160" y="152" width="124" height="16" rx="8" fill="var(--color-surface-solid)" stroke="#f59e0b" strokeWidth="1" />
          <text x="222" y="163" textAnchor="middle" fill="#f59e0b" fontSize="7.4" fontWeight="700">
            观测冲突 ↺ 重开闭合
          </text>

          {toolMotion && (
            <circle r="3" fill="#38bdf8">
              <animateMotion dur="2.1s" repeatCount="indefinite" path="M 88 74 H 262" />
            </circle>
          )}

          {/* Block 1: 26x96 Catalog & 9 Control-key Refusal */}
          <rect x="6" y="20" width="82" height="106" rx="8" fill="var(--color-surface-solid)" stroke="var(--color-line-strong)" />
          <text x="47" y="36" textAnchor="middle" fill="var(--color-ink)" fontSize="9" fontWeight="700">26×96 目录</text>
          <text x="47" y="48" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.2">82算子 + 14核</text>
          {[0, 1, 2, 3].map((r) =>
            [0, 1, 2, 3].map((c) => {
              const lit = (r * 4 + c) % 5 === 0 || (metrics.toolCount > 0 && r === 0 && c < 3);
              return (
                <rect
                  key={`${r}-${c}`}
                  x={14 + c * 17}
                  y={55 + r * 12}
                  width="13"
                  height="8"
                  rx="2"
                  fill={lit ? "#38bdf8" : "var(--color-surface-sunken)"}
                  stroke={lit ? "#0284c7" : "var(--color-line)"}
                  strokeWidth="0.8"
                />
              );
            }),
          )}
          <text x="47" y="116" textAnchor="middle" fill="#f59e0b" fontSize="7" fontWeight="700">拒 9 控制核键</text>

          {/* Block 2: Input Normalization + Alias */}
          <rect x="104" y="26" width="76" height="96" rx="8" fill="var(--color-brand-tint)" stroke="#3b82f6" strokeWidth="1.2" />
          <text x="142" y="48" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="8.8" fontWeight="800">规范鉴权</text>
          <text x="142" y="64" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7.3">别名对齐</text>
          <rect x="112" y="74" width="60" height="18" rx="4" fill="var(--color-surface-solid)" stroke="#3b82f6" />
          <text x="142" y="86" textAnchor="middle" fill="#38bdf8" fontSize="7.3" fontFamily="monospace" fontWeight="700">
            #{metrics.topToolHash ? metrics.topToolHash.slice(0, 7) : "inHash"}
          </text>
          <text x="142" y="109" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7">输入不可伪造</text>

          {/* Block 3: Isolated Subprocess Sandbox */}
          <rect x="196" y="28" width="52" height="92" rx="8" fill="var(--color-surface-solid)" stroke="#38bdf8" strokeWidth="1.2" />
          <text x="222" y="48" textAnchor="middle" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">限域沙箱</text>
          <circle cx="222" cy="76" r="14" fill="none" stroke="#38bdf8" strokeWidth="1.8" strokeDasharray="5 3" className={toolMotion ? "zygos-loop-dash" : ""} />
          <text x="222" y="79" textAnchor="middle" fill="#10b981" fontSize="7.4" fontWeight="700">双核算</text>
          <text x="222" y="107" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.9">checkResult</text>

          {/* Block 4: Live Exact Triple Receipt */}
          <rect x="262" y="20" width="64" height="106" rx="8" fill="var(--color-state-success-bg)" stroke="#10b981" strokeWidth="1.4" />
          <text x="294" y="38" textAnchor="middle" fill="var(--color-state-success)" fontSize="8.8" fontWeight="800">哈希回执</text>
          <text x="294" y="56" textAnchor="middle" fill="var(--color-ink)" fontSize="9.5" fontWeight="800">
            {metrics.topToolValue ? metrics.topToolValue.split("=").pop()?.trim().slice(0, 8) : "EXACT"}
          </text>
          <text x="294" y="74" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7" fontFamily="monospace">
            {metrics.topToolName ? metrics.topToolName.split(":").pop()?.slice(0, 10) : "math_asset"}
          </text>
          <text x="294" y="92" textAnchor="middle" fill="#10b981" fontSize="7.2" fontWeight="700">EXACT_INPUT</text>
          <text x="294" y="112" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.9">resultHash ✓</text>
        </svg>
      </SubDiagramCard>
    </>
  );
}

/* ============================================================================
 * 创新点三 · 3 块源码直观动图
 *   ① Append-only 链式账本 & 局部 STALE 精确传播 (host_checkpoint.py / p4-revise.ts)
 *   ② 18 类结构病历诊断矩阵 & 双锁微修门 (agent-answer-closure.ts / p4-repair.ts)
 *   ③ Fail-Closed 终态铁面裁决与红线常量 (p4-candidate.ts)
 * ========================================================================== */
function InnovationThreeDiagrams({
  spec,
  metrics,
  animateAlways,
}: {
  spec: InnovationSpec;
  metrics: DerivedThreeInnovationsMetrics;
  animateAlways: boolean;
}) {
  const [s1, s2, s3] = metrics.inn3SubStatuses;
  const staleMotion = animateAlways || s1 !== "pending";
  const repairMotion = animateAlways || s2 !== "pending";
  const finalMotion = animateAlways || s3 !== "pending";
  const cp = metrics.projection.controlPlane;

  return (
    <>
      {/* 3-① Append-only 链式日志 + 局部 STALE 传播图 */}
      <SubDiagramCard
        code={spec.subSpecs[0].code}
        title={spec.subSpecs[0].title}
        moduleTag={spec.subSpecs[0].moduleTag}
        caption="仅受质询下游标 STALE 重核 · 旁支义务 100% 保持 ACTIVE · SHA-256 无模型重放"
        status={s1}
        accent={spec.accentColor}
        liveBadge={metrics.eventCount > 0 ? `链式 ${metrics.eventCount} 帧` : "512 帧上界"}
      >
        <svg viewBox="0 0 330 186" width="100%" height="184" role="img" aria-label="链式事件账本与局部STALE精准失效传播动图">
          {/* Causal split edges */}
          <path d="M 60 54 C 76 54, 76 30, 96 30 H 214" stroke="#f59e0b" strokeWidth="1.6" fill="none" className={staleMotion ? "zygos-svg-flow-repair" : ""} />
          <path d="M 60 54 C 76 54, 76 80, 96 80 H 214" stroke="#10b981" strokeWidth="1.6" fill="none" />

          {staleMotion && (
            <circle r="2.8" fill="#fbbf24">
              <animateMotion dur="2s" repeatCount="indefinite" path="M 96 30 H 246" />
            </circle>
          )}

          {/* Root */}
          <rect x="8" y="36" width="52" height="36" rx="7" fill="var(--color-surface-solid)" stroke="#3b82f6" strokeWidth="1.3" />
          <text x="34" y="53" textAnchor="middle" fill="var(--color-ink)" fontSize="8.8" fontWeight="700">根契约</text>
          <text x="34" y="65" textAnchor="middle" fill="#3b82f6" fontSize="7.2">v{metrics.projection.taskDag.contractVersion}</text>

          {/* Upper: Challenged node -> Only dependent downstream goes STALE */}
          <rect x="96" y="12" width="92" height="36" rx="7" fill="var(--color-state-candidate-bg)" stroke="#f59e0b" strokeWidth="1.3" />
          <text x="142" y="28" textAnchor="middle" fill="var(--color-state-candidate)" fontSize="8.8" fontWeight="700">受质询回答</text>
          <text x="142" y="40" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.2">局部版本号 +1</text>

          <rect x="210" y="12" width="112" height="36" rx="7" fill="var(--color-state-candidate-bg)" stroke="#f59e0b" strokeDasharray="3 2" strokeWidth="1.3" />
          <text x="266" y="28" textAnchor="middle" fill="var(--color-state-candidate)" fontSize="8.8" fontWeight="700">相关下游 → STALE</text>
          <text x="266" y="40" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.2">仅重算受影响边</text>

          {/* Lower: Unaffected obligations locked ACTIVE */}
          <rect x="96" y="60" width="226" height="38" rx="7" fill="var(--color-state-success-bg)" stroke="#10b981" strokeWidth="1.4" />
          <text x="209" y="77" textAnchor="middle" fill="var(--color-state-success)" fontSize="9.2" fontWeight="800">
            其余无关义务 &amp; 正确推导 100% 保持 ACTIVE
          </text>
          <text x="209" y="90" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7.4">
            不回滚全局 · OUTCOME_UNKNOWN 自动阻断不安全重放
          </text>

          {/* Bottom: Append-only Hash Chain */}
          <rect x="8" y="110" width="314" height="68" rx="8" fill="var(--color-surface-solid)" stroke="var(--color-line)" />
          <text x="18" y="127" fill="var(--color-ink)" fontSize="8.6" fontWeight="700">
            Append-only 只增不改哈希账本
          </text>
          <text x="312" y="127" textAnchor="end" fill="#3b82f6" fontSize="7.5" fontWeight="700">
            512 帧/64 行上界
          </text>

          {[0, 1, 2, 3, 4].map((b) => (
            <g key={b}>
              <rect
                x={18 + b * 60}
                y="136"
                width="46"
                height="20"
                rx="4.5"
                fill={b === 4 ? "var(--color-brand-tint)" : "var(--color-surface-sunken)"}
                stroke={b === 4 ? "#3b82f6" : "var(--color-line-strong)"}
              />
              <text x={41 + b * 60} y="149.5" textAnchor="middle" fill="var(--color-ink)" fontSize="8" fontFamily="monospace" fontWeight="700">
                {b === 4 && metrics.eventCount > 0 ? `#${metrics.eventCount}` : `h#${b + 1}`}
              </text>
              {b < 4 && <line x1={64 + b * 60} y1="146" x2={78 + b * 60} y2="146" stroke="#3b82f6" strokeWidth="1.4" />}
            </g>
          ))}
          <text x="165" y="170" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7.2">
            Checkpoint v1 · 断点恢复预算只紧不松
          </text>
        </svg>
      </SubDiagramCard>

      {/* 3-② 18 类结构病历诊断 + 双锁微修门 */}
      <SubDiagramCard
        code={spec.subSpecs[1].code}
        title={spec.subSpecs[1].title}
        moduleTag={spec.subSpecs[1].moduleTag}
        caption="OBS / CERT / TEXT 三源 18 类机判缺陷 → 代码点绑定 + 双锁拦截退化"
        status={s2}
        accent={spec.accentColor}
        liveBadge={`审${cp.reviewCount} · 修${cp.repairAttempts}`}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.05fr", gap: "8px", height: "184px" }}>
          {/* Left: 18-class Closure Defect Matrix */}
          <div style={{ position: "relative", padding: "8px", borderRadius: "8px", backgroundColor: "var(--color-surface-solid)", border: "1px solid var(--color-line)", overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            {repairMotion && (
              <div className="zygos-scan-beam" style={{ position: "absolute", inset: 0, width: "28px", background: "linear-gradient(90deg, transparent, rgba(16,185,129,0.22), transparent)" }} />
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "9.5px", fontWeight: 700, color: "var(--color-ink-soft)" }}>18 类病历矩阵</span>
              <span style={{ fontSize: "8.5px", color: "#38bdf8", fontWeight: 700 }}>三源实证</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "4px" }}>
              {[
                "次数守恒",
                "扩域次数",
                "GF(2)秩/零",
                "实根个数",
                "分式归一",
                "选项覆盖",
              ].map((kind) => (
                <div
                  key={kind}
                  style={{
                    padding: "3px 5px",
                    borderRadius: "4.5px",
                    fontSize: "8.8px",
                    fontWeight: 600,
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                    color: "var(--color-ink)",
                    textAlign: "center",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {kind}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "8.5px", color: "var(--color-ink-mute)" }}>
              <span>质询 {cp.reviewChallengesCount}</span>
              <span>观测窗 {metrics.closure?.observationViews ?? metrics.toolCount}</span>
            </div>
          </div>

          {/* Right: P4RepairSession Double Locks */}
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "5px" }}>
            <div style={{ padding: "6px 8px", borderRadius: "7px", backgroundColor: "var(--color-brand-tint)", border: "1px solid var(--color-brand-ring)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: "9.5px", fontWeight: 700, color: "var(--color-brand-deep)" }}>REPAIR ≤ 2 微修门</div>
                <div style={{ fontSize: "8px", color: "var(--color-ink-soft)" }}>代码点 locator · 64KB · ≥26ms</div>
              </div>
              <span className="zygos-tabular" style={{ fontSize: "9.5px", fontWeight: 800, color: "var(--color-brand-deep)" }}>
                试 {cp.repairAttempts}
              </span>
            </div>

            <div style={{ padding: "6px 8px", borderRadius: "7px", backgroundColor: "var(--color-state-success-bg)", border: "1px solid var(--color-state-success-border)", display: "flex", alignItems: "center", gap: "6px" }}>
              <Lock size={13} color="#10b981" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: "9.2px", fontWeight: 700, color: "var(--color-state-success)" }}>锁 ① · 无新矛盾</div>
                <div style={{ fontSize: "8px", color: "var(--color-ink-mute)" }}>单调收严，禁引入未声明假设</div>
              </div>
            </div>

            <div style={{ padding: "6px 8px", borderRadius: "7px", backgroundColor: "var(--color-state-success-bg)", border: "1px solid var(--color-state-success-border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "5px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Lock size={13} color="#10b981" style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: "9.2px", fontWeight: 700, color: "var(--color-state-success)" }}>锁 ② · 置信不降</div>
                  <div style={{ fontSize: "8px", color: "var(--color-ink-mute)" }}>劣修保留母候选</div>
                </div>
              </div>
              {cp.repairRejected > 0 && (
                <span style={{ fontSize: "8.5px", fontWeight: 800, color: "#f59e0b" }}>拦 {cp.repairRejected}</span>
              )}
            </div>
          </div>
        </div>
      </SubDiagramCard>

      {/* 3-③ P4CandidateGate 终态红线裁决 */}
      <SubDiagramCard
        code={spec.subSpecs[2].code}
        title={spec.subSpecs[2].title}
        moduleTag={spec.subSpecs[2].moduleTag}
        caption="母候选保护 → 审校哈希与原时限对齐 → 恒守 candidateVerified=false 如实交付"
        status={s3}
        accent={spec.accentColor}
        liveBadge={metrics.isTerminal ? metrics.terminalStatus.toUpperCase() : "红线核验"}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "8px", height: "184px" }}>
          {/* 3 physical gate checks */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            {[
              { title: "母候选锁定", sub: "只护不替" },
              { title: "哈希一致性", sub: "targetHash" },
              { title: "原时限约束", sub: "禁回拨时钟" },
            ].map((gate) => (
              <div
                key={gate.title}
                style={{
                  padding: "7px 5px",
                  borderRadius: "8px",
                  backgroundColor: "var(--color-surface-solid)",
                  border: `1px solid ${finalMotion && metrics.isTerminal ? "var(--color-state-success-border)" : "var(--color-line)"}`,
                  textAlign: "center",
                }}
              >
                <CheckCircle2
                  size={14}
                  color={finalMotion && metrics.isTerminal ? "#10b981" : "var(--color-ink-mute)"}
                  style={{ margin: "0 auto 3px" }}
                />
                <div style={{ fontSize: "9.2px", fontWeight: 700, color: "var(--color-ink)" }}>{gate.title}</div>
                <div style={{ fontSize: "7.8px", color: "var(--color-ink-mute)" }}>{gate.sub}</div>
              </div>
            ))}
          </div>

          {/* Red-line invariant seal */}
          <div
            className={finalMotion ? "zygos-seal-animate" : ""}
            style={{
              padding: "9px 10px",
              borderRadius: "9px",
              backgroundColor: "var(--color-state-candidate-bg)",
              border: "1px solid var(--color-state-candidate-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
              <AlertTriangle size={15} color="var(--color-state-candidate)" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: "10px", fontWeight: 800, color: "var(--color-state-candidate)" }}>
                  candidate_verified = false
                </div>
                <div style={{ fontSize: "8.5px", color: "var(--color-ink-soft)" }}>
                  strictAcceptance = NOT_PERFORMED
                </div>
              </div>
            </div>
            <ShieldCheck size={17} color="var(--color-state-candidate)" style={{ flexShrink: 0 }} />
          </div>

          {/* Live terminal outcome row */}
          <div
            style={{
              padding: "7px 9px",
              borderRadius: "8px",
              backgroundColor: "var(--color-surface-solid)",
              border: "1px solid var(--color-line)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: "9.5px",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--color-ink-soft)" }}>
              {metrics.stopReason || "终态门控"}
            </span>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                fontWeight: 800,
                backgroundColor: metrics.isTerminal ? "var(--color-state-success-bg)" : "var(--color-surface-sunken)",
                color: metrics.isTerminal ? "var(--color-state-success)" : "var(--color-ink-mute)",
                border: `1px solid ${metrics.isTerminal ? "var(--color-state-success-border)" : "var(--color-line)"}`,
              }}
            >
              {metrics.isTerminal && metrics.answerHeadline
                ? `交付 ${metrics.answerHeadline.slice(0, 10)}`
                : metrics.terminalStatus}
            </span>
          </div>
        </div>
      </SubDiagramCard>
    </>
  );
}

export function InnovationSubRow({
  innovationId,
  spec,
  metrics,
  animateAlways = true,
}: {
  innovationId: InnovationId;
  spec: InnovationSpec;
  metrics: DerivedThreeInnovationsMetrics;
  animateAlways?: boolean;
}) {
  return (
    <div className="zygos-subdiag-container">
      <div className="zygos-subdiag-grid">
        {innovationId === "inn1" && (
          <InnovationOneDiagrams spec={spec} metrics={metrics} animateAlways={animateAlways} />
        )}
        {innovationId === "inn2" && (
          <InnovationTwoDiagrams spec={spec} metrics={metrics} animateAlways={animateAlways} />
        )}
        {innovationId === "inn3" && (
          <InnovationThreeDiagrams spec={spec} metrics={metrics} animateAlways={animateAlways} />
        )}
      </div>
    </div>
  );
}
