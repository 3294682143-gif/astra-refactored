import type { DerivedThreeInnovationsMetrics } from "./innovationSpecs";

interface ArchSvgProps {
  metrics: DerivedThreeInnovationsMetrics;
  animated: boolean;
}

/**
 * 架构一：契约编排 DAG · R0 三角色互盲 · 8 维探针路由 · 6 步有界调度 · TS/Python 协议隔离带
 */
export function InnovationOneArchitectureSvg({ metrics, animated }: ArchSvgProps) {
  const { taskDag, routing } = metrics.projection;
  const r0Done = metrics.r0DoneCount;

  return (
    <svg
      viewBox="0 0 360 226"
      width="100%"
      height="220"
      role="img"
      aria-label="创新点一契约编译、R0互盲审校与双核调度架构图"
    >
      <defs>
        <linearGradient id="arch1-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>

      {/* Row 1: 题目 -> 哈希范围 -> 契约 DAG -> 快照锁定 */}
      <path
        d="M 66 23 H 88 M 162 23 H 184 M 272 23 H 294"
        stroke="url(#arch1-grad)"
        strokeWidth="1.6"
        fill="none"
        className={animated ? "zygos-svg-flow" : ""}
      />
      {animated && (
        <circle r="2.6" fill="#60a5fa">
          <animateMotion dur="2s" repeatCount="indefinite" path="M 66 23 H 294" />
        </circle>
      )}

      <rect x="6" y="6" width="60" height="34" rx="6" fill="var(--color-surface-solid)" stroke="var(--color-line-strong)" />
      <text x="36" y="21" textAnchor="middle" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">原题入栈</text>
      <text x="36" y="33" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7">UTF-8 只读</text>

      <rect x="88" y="6" width="74" height="34" rx="6" fill="var(--color-brand-tint)" stroke="#3b82f6" strokeWidth="1.1" />
      <text x="125" y="21" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="8.5" fontWeight="700">哈希鉴权</text>
      <text x="125" y="33" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7">Hash + Scope</text>

      <rect x="184" y="6" width="88" height="34" rx="6" fill="var(--color-surface-solid)" stroke="#3b82f6" strokeWidth="1.2" />
      <text x="228" y="21" textAnchor="middle" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">契约 DAG</text>
      <text x="228" y="33" textAnchor="middle" fill="#38bdf8" fontSize="7.2" fontWeight="700">
        {taskDag.tasks.length} 义务 · {taskDag.edges.length} 边
      </text>

      <rect x="294" y="6" width="60" height="34" rx="6" fill="var(--color-state-success-bg)" stroke="#10b981" strokeWidth="1.1" />
      <text x="324" y="21" textAnchor="middle" fill="var(--color-state-success)" fontSize="8.5" fontWeight="700">契约 v{taskDag.contractVersion}</text>
      <text x="324" y="33" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7">快照锁定</text>

      {/* Fork DAG -> R0 3-role parallel blind isolation */}
      <path
        d="M 228 40 V 50 M 61 50 H 299 M 61 50 V 56 M 180 50 V 56 M 299 50 V 56"
        stroke="#3b82f6"
        strokeWidth="1.3"
        fill="none"
        className={animated ? "zygos-svg-flow" : ""}
      />

      {[
        { x: 10, title: "R0 题意审", sub: "对齐核验" },
        { x: 129, title: "R0 方法审", sub: "域风险检" },
        { x: 248, title: "R0 工具审", sub: "覆盖检查" },
      ].map((role, idx) => {
        const lit = r0Done > idx;
        return (
          <g key={role.title}>
            <rect
              x={role.x}
              y="56"
              width="102"
              height="34"
              rx="6"
              fill="var(--color-surface-solid)"
              stroke={lit ? "#10b981" : "#3b82f6"}
              strokeWidth="1.2"
            />
            <text x={role.x + 51} y="71" textAnchor="middle" fill="var(--color-ink)" fontSize="8.3" fontWeight="700">
              {role.title}
            </text>
            <text x={role.x + 51} y="83" textAnchor="middle" fill={lit ? "var(--color-state-success)" : "var(--color-ink-mute)"} fontSize="7">
              {lit ? "✓ 互盲通过" : role.sub}
            </text>
          </g>
        );
      })}

      {/* Physical blind isolation walls */}
      <line x1="120.5" y1="58" x2="120.5" y2="88" stroke="#f59e0b" strokeDasharray="2.5 2" strokeWidth="1.2" />
      <line x1="239.5" y1="58" x2="239.5" y2="88" stroke="#f59e0b" strokeDasharray="2.5 2" strokeWidth="1.2" />

      {/* Merge R0 -> 8-dim Probe & 6-step Scheduler */}
      <path
        d="M 61 90 V 100 H 299 V 90 M 180 100 V 108"
        stroke="#38bdf8"
        strokeWidth="1.4"
        fill="none"
        className={animated ? "zygos-svg-flow" : ""}
      />

      <rect x="10" y="108" width="162" height="46" rx="7" fill="var(--color-surface-solid)" stroke="#38bdf8" strokeWidth="1.2" />
      <text x="91" y="123" textAnchor="middle" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">
        8 维结构签名探针
      </text>
      {/* Visual 8-dim LED probe strip */}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const hit = i < routing.matchedCount;
        return (
          <rect
            key={i}
            x={30 + i * 16}
            y="129"
            width="11"
            height="7"
            rx="2"
            fill={hit ? "#10b981" : "var(--color-surface-sunken)"}
            stroke={hit ? "#10b981" : "var(--color-line-strong)"}
            strokeWidth="0.9"
          />
        );
      })}
      <text x="91" y="148" textAnchor="middle" fill="#38bdf8" fontSize="7.4" fontWeight="700">
        命中 {routing.matchedCount}/8 维 · 保守回退
      </text>

      <path d="M 172 131 H 190" stroke="#10b981" strokeWidth="1.6" fill="none" className={animated ? "zygos-svg-flow" : ""} />

      <rect x="190" y="108" width="160" height="46" rx="7" fill="var(--color-brand-tint)" stroke="#3b82f6" strokeWidth="1.2" />
      <text x="270" y="123" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="8.5" fontWeight="700">
        6 步有界调度环
      </text>
      <rect x="200" y="128" width="40" height="12" rx="3" fill="var(--color-surface-solid)" stroke="var(--color-line)" />
      <text x="220" y="137" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.8" fontWeight="600">就绪定序</text>
      <rect x="250" y="128" width="40" height="12" rx="3" fill="var(--color-surface-solid)" stroke="var(--color-line)" />
      <text x="270" y="137" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.8" fontWeight="600">门控查账</text>
      <rect x="300" y="128" width="40" height="12" rx="3" fill="var(--color-surface-solid)" stroke="var(--color-line)" />
      <text x="320" y="137" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.8" fontWeight="600">裁剪派发</text>
      <text x="270" y="149" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7">
        上下文 ≤64KB · ≤2 资产
      </text>

      {/* TS / Python Protocol Isolation Barrier */}
      <line x1="6" y1="167" x2="354" y2="167" stroke="#f59e0b" strokeWidth="1.4" strokeDasharray="5 3" />
      <rect x="108" y="159.5" width="144" height="15" rx="7.5" fill="var(--color-surface-solid)" stroke="#f59e0b" strokeWidth="1" />
      <text x="180" y="169.5" textAnchor="middle" fill="#f59e0b" fontSize="7.4" fontWeight="700">
        TS / Python 协议隔离带
      </text>

      {/* Bottom: Python Host Control Core */}
      <rect x="10" y="180" width="340" height="40" rx="7" fill="var(--color-surface-sunken)" stroke="var(--color-line-strong)" />
      <text x="20" y="195" fill="var(--color-ink)" fontSize="8.2" fontWeight="700">
        Python 受信控制核
      </text>
      <text x="340" y="195" textAnchor="end" fill="#f59e0b" fontSize="7.3" fontWeight="700">
        UsageLedger 预算只紧不松
      </text>
      {[
        { x: 20, w: 68, label: "session 绑定" },
        { x: 96, w: 72, label: "题纹防篡改" },
        { x: 176, w: 64, label: "8 字段重签" },
        { x: 248, w: 92, label: "全局账本封账" },
      ].map((chip) => (
        <g key={chip.label}>
          <rect x={chip.x} y="201" width={chip.w} height="13" rx="3.5" fill="var(--color-surface-solid)" stroke="var(--color-line)" />
          <text x={chip.x + chip.w / 2} y="210" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.9" fontWeight="600">
            {chip.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * 架构二：5 路隔离盲解 -> canonical 计票与双对抗审计 -> CERT1 -> 7 步 26×96 防伪沙箱
 */
export function InnovationTwoArchitectureSvg({ metrics, animated }: ArchSvgProps) {
  const { routing } = metrics.projection;
  const bestTool =
    routing.toolReceipts.find((tr) => Boolean(tr.valuePreview)) ??
    routing.toolReceipts.find((tr) => tr.toolName !== "math_asset") ??
    routing.toolReceipts[0];

  const shortVal = bestTool?.valuePreview
    ? bestTool.valuePreview.split("=").pop()?.trim().slice(0, 10)
    : "EXACT";

  const lenses = [
    { y: 8, label: "L1 直接求解", c: "#3b82f6" },
    { y: 28, label: "L2 逆向代回", c: "#0ea5e9" },
    { y: 48, label: "L3 独立复算", c: "#38bdf8" },
    { y: 68, label: "L4 分案查漏", c: "#6366f1" },
    { y: 88, label: "L5 边界极端", c: "#10b981" },
  ];

  return (
    <svg
      viewBox="0 0 360 226"
      width="100%"
      height="220"
      role="img"
      aria-label="创新点二5+2+1互盲协同与26×96防伪沙箱架构图"
    >
      {/* 5 Parallel Blind Solve Lanes */}
      {lenses.map((l, idx) => {
        const done = metrics.ballotCount > idx;
        return (
          <g key={l.label}>
            <path
              d={`M 102 ${l.y + 8} C 126 ${l.y + 8}, 126 56, 148 56`}
              stroke={l.c}
              strokeWidth="1.2"
              fill="none"
              className={animated ? "zygos-svg-flow" : ""}
            />
            {animated && (
              <circle r="2.2" fill={l.c}>
                <animateMotion
                  dur="2s"
                  begin={`${idx * 0.18}s`}
                  repeatCount="indefinite"
                  path={`M 102 ${l.y + 8} C 126 ${l.y + 8}, 126 56, 148 56`}
                />
              </circle>
            )}
            <rect
              x="8"
              y={l.y}
              width="94"
              height="16"
              rx="4.5"
              fill="var(--color-surface-solid)"
              stroke={done ? "#10b981" : l.c}
              strokeWidth="1"
            />
            <text x="55" y={l.y + 11} textAnchor="middle" fill="var(--color-ink)" fontSize="7.6" fontWeight="600">
              {l.label}
            </text>
          </g>
        );
      })}

      {/* Canonical Vote Bucket */}
      <rect x="148" y="10" width="96" height="92" rx="7" fill="var(--color-surface-solid)" stroke="#38bdf8" strokeWidth="1.2" />
      <text x="196" y="25" textAnchor="middle" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">规范归并计票</text>
      <text x="196" y="37" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="7">整案不拼接</text>

      <rect x="157" y="45" width="78" height="28" rx="5" fill="var(--color-state-success-bg)" stroke="#10b981" />
      <text x="196" y="57" textAnchor="middle" fill="var(--color-state-success)" fontSize="8.2" fontWeight="800">
        {metrics.topCandidateText ? `领先: ${metrics.topCandidateText.slice(0, 7)}` : "候选计票"}
      </text>
      <text x="196" y="68" textAnchor="middle" fill="var(--color-ink)" fontSize="7.6" fontWeight="700">
        {metrics.topCandidateVotes > 0 ? `${metrics.topCandidateVotes} 票汇聚` : `${metrics.ballotCount} 路票`}
      </text>

      <text x="196" y="88" textAnchor="middle" fill="#38bdf8" fontSize="7.2" fontWeight="700">
        hash 互盲隔离
      </text>

      {/* Arrows -> Audits & CERT1 */}
      <path d="M 244 26 H 262 M 244 56 H 262 M 244 86 H 262" stroke="#f59e0b" strokeWidth="1.2" fill="none" className={animated ? "zygos-svg-flow" : ""} />

      <rect x="262" y="10" width="90" height="27" rx="5.5" fill="var(--color-state-candidate-bg)" stroke="#f59e0b" strokeWidth="1.1" />
      <text x="307" y="22" textAnchor="middle" fill="var(--color-state-candidate)" fontSize="8" fontWeight="700">对抗审 #1</text>
      <text x="307" y="32" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.8">反例证伪</text>

      <rect x="262" y="42" width="90" height="27" rx="5.5" fill="var(--color-state-candidate-bg)" stroke="#f59e0b" strokeWidth="1.1" />
      <text x="307" y="54" textAnchor="middle" fill="var(--color-state-candidate)" fontSize="8" fontWeight="700">对抗审 #2</text>
      <text x="307" y="64" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.8">双一致改锚</text>

      <rect x="262" y="74" width="90" height="28" rx="5.5" fill={metrics.certObserved ? "var(--color-state-success-bg)" : "var(--color-surface-solid)"} stroke="#10b981" strokeWidth="1.2" />
      <text x="307" y="87" textAnchor="middle" fill="var(--color-state-success)" fontSize="8.2" fontWeight="700">CERT1 门</text>
      <text x="307" y="97" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.9">
        {metrics.certObserved ? "证书已核验 ✓" : "证书校验中"}
      </text>

      {/* Sandbox Protocol Barrier */}
      <line x1="6" y1="118" x2="354" y2="118" stroke="#38bdf8" strokeWidth="1.3" strokeDasharray="4 3" />
      <rect x="106" y="110.5" width="148" height="15" rx="7.5" fill="var(--color-surface-solid)" stroke="#38bdf8" strokeWidth="1" />
      <text x="180" y="120.5" textAnchor="middle" fill="#38bdf8" fontSize="7.4" fontWeight="700">
        26×96 防伪沙箱总线
      </text>

      {/* 4-Stage Sandbox Pipeline */}
      <path d="M 84 156 H 98 M 176 156 H 190 M 266 156 H 280" stroke="#10b981" strokeWidth="1.4" fill="none" className={animated ? "zygos-svg-flow" : ""} />

      {/* Reopen loopback */}
      <path
        d="M 316 179 C 316 206, 137 206, 137 179"
        stroke="#f59e0b"
        strokeWidth="1.3"
        strokeDasharray="3 2"
        fill="none"
        className={animated ? "zygos-svg-flow-repair" : ""}
      />
      <rect x="166" y="196" width="122" height="14" rx="7" fill="var(--color-surface-solid)" stroke="#f59e0b" strokeWidth="1" />
      <text x="227" y="205.5" textAnchor="middle" fill="#f59e0b" fontSize="7" fontWeight="700">
        观测冲突 ↺ 重开闭合
      </text>

      <rect x="8" y="135" width="76" height="44" rx="6" fill="var(--color-surface-solid)" stroke="var(--color-line-strong)" />
      <text x="46" y="150" textAnchor="middle" fill="var(--color-ink)" fontSize="8" fontWeight="700">① 鉴权防注</text>
      <text x="46" y="162" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.9">拒 9 控制键</text>
      <text x="46" y="173" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.7">目录指纹</text>

      <rect x="98" y="135" width="78" height="44" rx="6" fill="var(--color-brand-tint)" stroke="#3b82f6" />
      <text x="137" y="150" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="8" fontWeight="700">② 算子映射</text>
      <text x="137" y="162" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7">26 资产 × 96</text>
      <text x="137" y="173" textAnchor="middle" fill="#38bdf8" fontSize="6.8" fontFamily="monospace">
        {bestTool?.sourceInputHash ? `#${bestTool.sourceInputHash.slice(0, 7)}` : "#inputHash"}
      </text>

      <rect x="190" y="135" width="76" height="44" rx="6" fill="var(--color-surface-solid)" stroke="#38bdf8" />
      <text x="228" y="150" textAnchor="middle" fill="var(--color-ink)" fontSize="8" fontWeight="700">③ 限域沙箱</text>
      <text x="228" y="162" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.9">双算核交叉</text>
      <text x="228" y="173" textAnchor="middle" fill="#10b981" fontSize="6.9">精度入账</text>

      <rect x="280" y="135" width="72" height="44" rx="6" fill="var(--color-state-success-bg)" stroke="#10b981" />
      <text x="316" y="150" textAnchor="middle" fill="var(--color-state-success)" fontSize="8" fontWeight="700">④ 哈希回执</text>
      <text x="316" y="162" textAnchor="middle" fill="var(--color-ink)" fontSize="7.6" fontWeight="800">
        {shortVal}
      </text>
      <text x="316" y="173" textAnchor="middle" fill="var(--color-ink-mute)" fontSize="6.7">精确实证</text>
    </svg>
  );
}

/**
 * 架构三：链式账本 · 局部 STALE 传播图 · 18 类病历矩阵 · 防退化双锁 · Fail-Closed 裁决门
 */
export function InnovationThreeArchitectureSvg({ metrics, animated }: ArchSvgProps) {
  const cp = metrics.projection.controlPlane;

  return (
    <svg
      viewBox="0 0 360 226"
      width="100%"
      height="220"
      role="img"
      aria-label="创新点三链式溯源、局部STALE失效传播、18类病历双锁与铁面裁决门架构图"
    >
      {/* Row 1: Chained Hash Log + Mini Local STALE DAG */}
      <rect x="8" y="8" width="152" height="66" rx="6.5" fill="var(--color-surface-solid)" stroke="#3b82f6" strokeWidth="1.1" />
      <text x="84" y="22" textAnchor="middle" fill="var(--color-ink)" fontSize="8.4" fontWeight="700">
        链式事件账本 ({metrics.eventCount} 帧)
      </text>
      {/* 4 chained hash blocks */}
      {["h₀", "h₁", "h₂", "hₙ"].map((h, i) => (
        <g key={h}>
          <rect x={18 + i * 34} y="30" width="24" height="16" rx="3.5" fill="var(--color-brand-tint)" stroke="#3b82f6" strokeWidth="0.9" />
          <text x={30 + i * 34} y="41" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="7.4" fontWeight="700">{h}</text>
          {i < 3 && <path d={`M ${42 + i * 34} 38 H ${52 + i * 34}`} stroke="#38bdf8" strokeWidth="1.2" />}
        </g>
      ))}
      <text x="84" y="60" textAnchor="middle" fill="#3b82f6" fontSize="7.1" fontWeight="600">
        无模型重放 · 断点预算只紧不松
      </text>

      <path d="M 160 41 H 176" stroke="#f59e0b" strokeWidth="1.5" fill="none" className={animated ? "zygos-svg-flow-repair" : ""} />

      {/* Local STALE mini DAG */}
      <rect x="176" y="8" width="176" height="66" rx="6.5" fill="var(--color-surface-solid)" stroke="var(--color-line-strong)" />
      <text x="264" y="22" textAnchor="middle" fill="var(--color-ink)" fontSize="8.4" fontWeight="700">
        局部 STALE 传播图
      </text>
      <rect x="186" y="29" width="66" height="17" rx="4" fill="var(--color-state-candidate-bg)" stroke="#f59e0b" strokeDasharray="3 2" />
      <text x="219" y="40.5" textAnchor="middle" fill="var(--color-state-candidate)" fontSize="7" fontWeight="700">质询项 STALE</text>
      <path d="M 252 37.5 H 272" stroke="#f59e0b" strokeWidth="1.2" className={animated ? "zygos-svg-flow-repair" : ""} />
      <rect x="272" y="29" width="70" height="17" rx="4" fill="var(--color-state-candidate-bg)" stroke="#f59e0b" />
      <text x="307" y="40.5" textAnchor="middle" fill="var(--color-ink)" fontSize="7" fontWeight="700">下游精准重核</text>

      <rect x="186" y="51" width="156" height="16" rx="4" fill="var(--color-state-success-bg)" stroke="#10b981" />
      <text x="264" y="62" textAnchor="middle" fill="var(--color-state-success)" fontSize="7.2" fontWeight="700">
        旁支义务 100% ACTIVE
      </text>

      {/* Row 2: 18-class Diagnostic Grid + Repair Double Locks */}
      <rect x="8" y="84" width="166" height="76" rx="6.5" fill="var(--color-surface-solid)" stroke="#38bdf8" strokeWidth="1.1" />
      <text x="91" y="99" textAnchor="middle" fill="var(--color-ink)" fontSize="8.4" fontWeight="700">
        18 类病历闭合诊断
      </text>
      {[
        { x: 16, y: 106, text: "次数守恒" },
        { x: 68, y: 106, text: "扩域次数" },
        { x: 120, y: 106, text: "矩阵秩" },
        { x: 16, y: 124, text: "实根个数" },
        { x: 68, y: 124, text: "分式归一" },
        { x: 120, y: 124, text: "选项覆盖" },
      ].map((p) => (
        <g key={p.text}>
          <rect x={p.x} y={p.y} width="46" height="14" rx="3" fill="var(--color-surface-sunken)" stroke="var(--color-line)" />
          <text x={p.x + 23} y={p.y + 9.5} textAnchor="middle" fill="var(--color-ink-soft)" fontSize="6.9" fontWeight="600">
            {p.text}
          </text>
        </g>
      ))}
      <text x="91" y="151" textAnchor="middle" fill="#38bdf8" fontSize="7.4" fontWeight="700">
        实测: 审查 {cp.reviewCount} · 修复 {cp.repairAttempts}
      </text>

      <path d="M 174 122 H 190" stroke="#10b981" strokeWidth="1.6" fill="none" className={animated ? "zygos-svg-flow" : ""} />

      <rect x="190" y="84" width="162" height="76" rx="6.5" fill="var(--color-brand-tint)" stroke="#3b82f6" strokeWidth="1.1" />
      <text x="271" y="99" textAnchor="middle" fill="var(--color-brand-deep)" fontSize="8.4" fontWeight="700">
        防退化双锁 (≤2 轮)
      </text>
      <text x="271" y="114" textAnchor="middle" fill="var(--color-ink-soft)" fontSize="7">
        反例 / 缺口准入 · 26ms · 原文定位
      </text>
      <rect x="199" y="124" width="69" height="25" rx="4.5" fill="var(--color-state-success-bg)" stroke="#10b981" />
      <text x="233.5" y="139.5" textAnchor="middle" fill="var(--color-state-success)" fontSize="7.3" fontWeight="700">锁1 无新矛盾</text>
      <rect x="274" y="124" width="69" height="25" rx="4.5" fill="var(--color-state-success-bg)" stroke="#10b981" />
      <text x="308.5" y="139.5" textAnchor="middle" fill="var(--color-state-success)" fontSize="7.3" fontWeight="700">锁2 置信不降</text>

      {/* Row 3: Fail-Closed Candidate Gate */}
      <path d="M 271 160 V 171" stroke="#10b981" strokeWidth="1.5" fill="none" className={animated ? "zygos-svg-flow" : ""} />

      <rect
        x="8"
        y="172"
        width="344"
        height="46"
        rx="7.5"
        fill="var(--color-state-candidate-bg)"
        stroke="#f59e0b"
        strokeWidth="1.2"
        className={animated ? "zygos-seal-animate" : ""}
      />
      <text x="18" y="191" fill="var(--color-ink)" fontSize="8.5" fontWeight="700">
        Fail-Closed 铁面裁决门
      </text>
      <text x="18" y="206" fill="var(--color-ink-soft)" fontSize="7.1">
        保留最优母候选 · {metrics.stopReason || "REVISE_REJECTED"}
      </text>

      <rect x="198" y="182" width="84" height="25" rx="5" fill="var(--color-surface-solid)" stroke="#f59e0b" />
      <text x="240" y="198" textAnchor="middle" fill="var(--color-state-candidate)" fontSize="7.6" fontWeight="800">
        Verified=false
      </text>

      <rect x="288" y="182" width="56" height="25" rx="5" fill="var(--color-state-success-bg)" stroke="#10b981" />
      <text x="316" y="198" textAnchor="middle" fill="var(--color-state-success)" fontSize="8" fontWeight="800">
        {metrics.isTerminal && metrics.answerHeadline ? `输出 ${metrics.answerHeadline.slice(0, 6)}` : metrics.terminalStatus}
      </text>
    </svg>
  );
}
