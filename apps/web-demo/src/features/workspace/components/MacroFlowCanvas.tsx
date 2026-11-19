import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Boxes,
  ShieldAlert,
  Award,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Clock,
  Layers,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Cpu,
  Activity,
  GitBranch,
  LayoutGrid,
} from "lucide-react";
import {
  MACRO_STAGES,
  type EdgeKind,
  type MacroStageId,
  type ResearchNode,
  type ResearchViewModel,
} from "../../../domain/research/types";

interface MacroFlowCanvasProps {
  viewModel: ResearchViewModel;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  compact?: boolean;
}

type CanvasViewMode = "both" | "topology" | "cards";

const STAGE_ACCENT: Record<MacroStageId, string> = {
  stage_1_planning: "#3b82f6",
  stage_2_execution: "#38bdf8",
  stage_3_review: "#f59e0b",
  stage_4_delivery: "#10b981",
};

const EDGE_STYLE: Record<EdgeKind, { color: string; label: string }> = {
  sequence: { color: "#3b82f6", label: "因果推进" },
  dependency: { color: "#6366f1", label: "产物依赖" },
  evidence: { color: "#38bdf8", label: "证据支撑" },
  repair_loop: { color: "#f59e0b", label: "反例修复回流" },
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function MacroFlowCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  compact = false,
}: MacroFlowCanvasProps) {
  const [viewMode, setViewMode] = useState<CanvasViewMode>("topology");
  const [collapsedStages, setCollapsedStages] = useState<Record<string, boolean>>({});
  const [isPanelOpen, setIsPanelOpen] = useState(!compact);

  useEffect(() => {
    setIsPanelOpen(!compact);
  }, [viewModel.runId, compact]);

  const toggleStage = (stageId: string) => {
    setCollapsedStages((prev) => ({
      ...prev,
      [stageId]: !prev[stageId],
    }));
  };

  const expandAll = () => {
    setCollapsedStages({
      stage_1_planning: false,
      stage_2_execution: false,
      stage_3_review: false,
      stage_4_delivery: false,
    });
  };

  const collapseAll = () => {
    setCollapsedStages({
      stage_1_planning: true,
      stage_2_execution: true,
      stage_3_review: true,
      stage_4_delivery: true,
    });
  };

  const getStageIcon = (stageId: MacroStageId) => {
    const color = STAGE_ACCENT[stageId];
    switch (stageId) {
      case "stage_1_planning":
        return <FileText size={16} color={color} />;
      case "stage_2_execution":
        return <Boxes size={16} color={color} />;
      case "stage_3_review":
        return <ShieldAlert size={16} color={color} />;
      case "stage_4_delivery":
        return <Award size={16} color={color} />;
    }
  };

  const getStatusIcon = (status: ResearchNode["status"]) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 size={14} color="#10b981" />;
      case "running":
        return (
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: "#3b82f6",
              display: "inline-block",
              animation: "pulse 1.5s infinite",
            }}
          />
        );
      case "untriggered":
        return <span style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>○ 未触发</span>;
      case "unrecorded":
        return <HelpCircle size={14} color="var(--color-ink-mute)" />;
      case "failed":
        return <AlertCircle size={14} color="#ef4444" />;
      default:
        return <Clock size={14} color="var(--color-ink-mute)" />;
    }
  };

  const edges = viewModel.edges || [];
  const selectedIncoming = edges.filter((e) => e.target === selectedNodeId);
  const selectedOutgoing = edges.filter((e) => e.source === selectedNodeId);
  const connectedNodeIds = new Set([
    ...selectedIncoming.map((e) => e.source),
    ...selectedOutgoing.map((e) => e.target),
  ]);

  const hasRepairLoop = edges.some((e) => e.kind === "repair_loop");

  const nodesByStage = useMemo(
    () =>
      MACRO_STAGES.map((stage) => ({
        stage,
        nodes: viewModel.nodes.filter((n) => n.stage === stage.id),
      })),
    [viewModel.nodes],
  );

  // 计算 SVG 交互拓扑图的精确泳道与节点坐标
  const topologyLayout = useMemo(() => {
    const colWidth = 250;
    const colGap = 44;
    const padX = 28;
    const headerTop = 64;
    const nodeWidth = 216;
    const nodeHeight = 64;
    const rowGap = 24;

    const maxRows = Math.max(1, ...nodesByStage.map((s) => s.nodes.length));
    const repairOffset = hasRepairLoop ? 44 : 16;
    const totalWidth = padX * 2 + MACRO_STAGES.length * colWidth + (MACRO_STAGES.length - 1) * colGap;
    const totalHeight = headerTop + repairOffset + maxRows * (nodeHeight + rowGap) + 28;

    const positions = new Map<
      string,
      { x: number; y: number; cx: number; cy: number; stageIdx: number; node: ResearchNode }
    >();

    nodesByStage.forEach((group, stageIdx) => {
      const colX = padX + stageIdx * (colWidth + colGap);
      const x = colX + (colWidth - nodeWidth) / 2;
      group.nodes.forEach((node, rowIdx) => {
        const y = headerTop + repairOffset + rowIdx * (nodeHeight + rowGap);
        positions.set(node.id, {
          x,
          y,
          cx: x + nodeWidth / 2,
          cy: y + nodeHeight / 2,
          stageIdx,
          node,
        });
      });
    });

    return {
      totalWidth,
      totalHeight,
      colWidth,
      colGap,
      padX,
      headerTop,
      repairOffset,
      nodeWidth,
      nodeHeight,
      positions,
    };
  }, [nodesByStage, hasRepairLoop]);

  const { budget } = viewModel;
  const telemetryItems = [
    {
      label: "模型逻辑调用",
      value: `${budget.usedModelCalls} / ${budget.maxModelCalls || "∞"}`,
      ratio: budget.maxModelCalls > 0 ? Math.min(1, budget.usedModelCalls / budget.maxModelCalls) : 0,
      color: "#3b82f6",
      icon: Cpu,
    },
    {
      label: "数学资产加载",
      value: `${budget.usedMethodLoads} / ${budget.maxMethodLoads}`,
      ratio: budget.maxMethodLoads > 0 ? Math.min(1, budget.usedMethodLoads / budget.maxMethodLoads) : 0,
      color: "#38bdf8",
      icon: Boxes,
    },
    {
      label: "研究工作单元",
      value: `${budget.usedWorkUnits} / ${budget.maxWorkUnits || "∞"}`,
      ratio: budget.maxWorkUnits > 0 ? Math.min(1, budget.usedWorkUnits / budget.maxWorkUnits) : 0,
      color: "#10b981",
      icon: Activity,
    },
    {
      label: "观测耗时",
      value: formatDuration(budget.elapsedMs),
      ratio: 1,
      color: "#818cf8",
      icon: Clock,
    },
  ];

  return (
    <div
      className="zygos-glass zygos-animate-in"
      style={{
        borderRadius: "18px",
        padding: compact ? "18px 20px" : "24px",
        display: "flex",
        flexDirection: "column",
        gap: compact ? "16px" : "20px",
      }}
    >
      {/* 顶部控制栏与视图切换 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: isPanelOpen ? "1px solid var(--color-line)" : "none",
          paddingBottom: isPanelOpen ? "14px" : "0px",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "32px",
              height: "32px",
              borderRadius: "10px",
              backgroundColor: "var(--color-brand-tint)",
              border: "1px solid var(--color-brand-ring)",
            }}
          >
            <Layers size={16} color="var(--color-brand-mid)" />
          </span>
          <div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
              {compact ? "底层事件流明细与因果回放（按需展开）" : "宏观机制流与动态执行拓扑工作台"}
            </div>
            <div className="zygos-tabular" style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
              已投影 {viewModel.nodes.length} 个机制节点 · {edges.length} 条因果/证据/回流边
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {isPanelOpen && (
            <>
              {/* 视图模式 Segmented Switch */}
              <div
                style={{
                  display: "inline-flex",
                  padding: "3px",
                  borderRadius: "10px",
                  backgroundColor: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-line)",
                  gap: "2px",
                }}
              >
                {([
                  { id: "both" as const, label: "双视图", icon: Layers },
                  { id: "topology" as const, label: "SVG 拓扑流", icon: GitBranch },
                  { id: "cards" as const, label: "阶段详情卡", icon: LayoutGrid },
                ]).map((tab) => {
                  const Icon = tab.icon;
                  const active = viewMode === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setViewMode(tab.id)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "5px 10px",
                        borderRadius: "7px",
                        border: "none",
                        backgroundColor: active ? "var(--color-brand-tint)" : "transparent",
                        color: active ? "var(--color-brand-deep)" : "var(--color-ink-mute)",
                        fontSize: "12px",
                        fontWeight: active ? 600 : 500,
                        cursor: "pointer",
                        transition: "all 0.2s ease",
                      }}
                    >
                      <Icon size={13} />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {viewMode !== "topology" && (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button type="button" onClick={expandAll} className="zygos-btn-ghost" style={{ fontSize: "11px", padding: "5px 9px" }}>
                    全部展开
                  </button>
                  <button type="button" onClick={collapseAll} className="zygos-btn-ghost" style={{ fontSize: "11px", padding: "5px 9px" }}>
                    全部折叠
                  </button>
                </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setIsPanelOpen((prev) => !prev)}
            className="zygos-btn-ghost"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "12px",
              fontWeight: 600,
              padding: "6px 12px",
              color: "var(--color-brand-deep)",
              borderColor: "var(--color-brand-ring)",
              backgroundColor: isPanelOpen ? "transparent" : "var(--color-brand-tint)",
            }}
          >
            {isPanelOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            <span>{isPanelOpen ? "收起明细事件流" : "展开底层事件流"}</span>
          </button>
        </div>
      </div>

      {isPanelOpen && (
        <>

      {/* 实时预算与资源遥测胶囊条 (Telemetry Strip) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "10px",
        }}
      >
        {telemetryItems.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              style={{
                padding: "10px 14px",
                borderRadius: "12px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "11px", color: "var(--color-ink-mute)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <Icon size={12} color={item.color} />
                  {item.label}
                </span>
                <span className="zygos-tabular" style={{ fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--color-ink)" }}>
                  {item.value}
                </span>
              </div>
              <div style={{ height: "4px", borderRadius: "9999px", backgroundColor: "var(--color-line)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.round(item.ratio * 100)}%`,
                    borderRadius: "9999px",
                    background: `linear-gradient(90deg, ${item.color}, #60a5fa)`,
                    transition: "width 0.45s var(--ease-spring)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* 修复回流特别警示条（若存在 REPAIR 回流） */}
      {hasRepairLoop && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "10px 14px",
            backgroundColor: "var(--color-state-candidate-bg)",
            border: "1px solid var(--color-state-candidate-border)",
            borderRadius: "11px",
            fontSize: "12px",
            color: "var(--color-state-candidate)",
          }}
        >
          <RotateCcw size={15} style={{ flexShrink: 0 }} />
          <span>
            <strong>检测到受控反例修复回流：</strong>阶段 3（过程审查）已向阶段 2（研究执行）触发受控修订回流，因果弧线与前后产物均完整保存。
          </span>
        </div>
      )}

      {/* ============================================================
       * 交互式 SVG 贝塞尔连线与流动粒子拓扑画布
       * ============================================================ */}
      {viewMode !== "cards" && (
        <div
          style={{
            borderRadius: "14px",
            border: "1px solid var(--color-line-strong)",
            backgroundColor: "var(--color-surface-sunken)",
            padding: "14px",
            overflowX: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", padding: "0 4px", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
              实时机制因果拓扑图（点击节点打开右侧真实证据检查器）
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "11px", color: "var(--color-ink-mute)" }}>
              {(Object.entries(EDGE_STYLE) as [EdgeKind, { color: string; label: string }][]).map(([kind, meta]) => (
                <span key={kind} style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ width: "12px", height: "3px", borderRadius: "9999px", backgroundColor: meta.color }} />
                  {meta.label}
                </span>
              ))}
            </div>
          </div>

          {viewModel.nodes.length === 0 ? (
            <div style={{ padding: "36px 16px", textAlign: "center", fontSize: "13px", color: "var(--color-ink-mute)" }}>
              等待机制事件流注入节点...
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${topologyLayout.totalWidth} ${topologyLayout.totalHeight}`}
              style={{
                width: "100%",
                minWidth: "920px",
                height: "auto",
                display: "block",
              }}
            >
              <defs>
                <filter id="zygos-glow-blue" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="3.5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <filter id="zygos-glow-amber" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>

                {(Object.entries(EDGE_STYLE) as [EdgeKind, { color: string; label: string }][]).map(([kind, meta]) => (
                  <marker
                    key={kind}
                    id={`arrow-${kind}`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill={meta.color} />
                  </marker>
                ))}
              </defs>

              {/* 四大宏观泳道列背景 */}
              {MACRO_STAGES.map((stage, idx) => {
                const colX = topologyLayout.padX + idx * (topologyLayout.colWidth + topologyLayout.colGap);
                const isCurrent = viewModel.currentStage === stage.id;
                const accent = STAGE_ACCENT[stage.id];
                const stageNodes = nodesByStage[idx]?.nodes || [];

                return (
                  <g key={stage.id}>
                    <rect
                      x={colX}
                      y={10}
                      width={topologyLayout.colWidth}
                      height={topologyLayout.totalHeight - 20}
                      rx={14}
                      fill={isCurrent ? `${accent}14` : "rgba(148, 163, 184, 0.04)"}
                      stroke={isCurrent ? accent : "rgba(148, 163, 184, 0.16)"}
                      strokeWidth={isCurrent ? 1.5 : 1}
                    />
                    <text
                      x={colX + 14}
                      y={32}
                      fontSize="12"
                      fontWeight="700"
                      fill={isCurrent ? accent : "var(--color-ink)"}
                    >
                      {`0${stage.order} · ${stage.name}`}
                    </text>
                    <text
                      x={colX + 14}
                      y={49}
                      fontSize="10"
                      fill="var(--color-ink-mute)"
                    >
                      {`${stageNodes.length} 节点`}
                    </text>
                  </g>
                );
              })}

              {/* 真实拓扑边 SVG 贝塞尔连线 + 流动粒子 */}
              {edges.map((edge, edgeIdx) => {
                const src = topologyLayout.positions.get(edge.source);
                const tgt = topologyLayout.positions.get(edge.target);
                if (!src || !tgt) return null;

                const isRepair = edge.kind === "repair_loop";
                const edgeColor = EDGE_STYLE[edge.kind]?.color ?? "#3b82f6";
                const isHighlighted =
                  !selectedNodeId || edge.source === selectedNodeId || edge.target === selectedNodeId;

                let d = "";
                if (isRepair) {
                  // 修复回流弧线：从右侧审查节点顶部弧形回绕到执行节点上方
                  const startX = src.cx;
                  const startY = src.y;
                  const endX = tgt.cx;
                  const endY = tgt.y;
                  const arcLift = Math.max(46, Math.abs(startX - endX) * 0.22);
                  const topY = Math.min(startY, endY) - arcLift;
                  d = `M ${startX} ${startY} C ${startX} ${topY}, ${endX} ${topY}, ${endX} ${endY}`;
                } else if (src.stageIdx === tgt.stageIdx) {
                  // 同泳道纵向连线
                  const x1 = src.cx;
                  const y1 = src.y + topologyLayout.nodeHeight;
                  const x2 = tgt.cx;
                  const y2 = tgt.y;
                  const midY = (y1 + y2) / 2;
                  d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
                } else {
                  // 跨泳道水平三次贝塞尔连线
                  const goingRight = tgt.cx >= src.cx;
                  const x1 = goingRight ? src.x + topologyLayout.nodeWidth : src.x;
                  const y1 = src.cy;
                  const x2 = goingRight ? tgt.x : tgt.x + topologyLayout.nodeWidth;
                  const y2 = tgt.cy;
                  const dx = Math.max(44, Math.abs(x2 - x1) * 0.48);
                  const c1x = goingRight ? x1 + dx : x1 - dx;
                  const c2x = goingRight ? x2 - dx : x2 + dx;
                  d = `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
                }

                const pathId = `zygos-edge-path-${edgeIdx}`;

                return (
                  <g
                    key={edge.id}
                    opacity={isHighlighted ? 0.95 : 0.22}
                    filter={isRepair ? "url(#zygos-glow-amber)" : isHighlighted && selectedNodeId ? "url(#zygos-glow-blue)" : undefined}
                  >
                    <path
                      id={pathId}
                      d={d}
                      fill="none"
                      stroke={edgeColor}
                      strokeWidth={isRepair ? 2.3 : 1.7}
                      className={isRepair ? "zygos-svg-flow-repair" : "zygos-svg-flow"}
                      markerEnd={`url(#arrow-${edge.kind})`}
                    />
                    {(isRepair || isHighlighted) && (
                      <circle r={isRepair ? 3.5 : 2.5} fill={edgeColor}>
                        <animateMotion
                          dur={isRepair ? "2.1s" : "3.2s"}
                          repeatCount="indefinite"
                          begin={`${(edgeIdx % 6) * 0.25}s`}
                        >
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                      </circle>
                    )}
                  </g>
                );
              })}

              {/* 交互式拓扑节点胶囊 */}
              {Array.from(topologyLayout.positions.values()).map((pos) => {
                const { node, x, y } = pos;
                const isSelected = selectedNodeId === node.id;
                const isConnected = connectedNodeIds.has(node.id);
                const stageColor = STAGE_ACCENT[node.stage];
                const isFailed = node.status === "failed";
                const isRunning = node.status === "running";
                const statusDotColor = isFailed
                  ? "#ef4444"
                  : isRunning
                  ? "#3b82f6"
                  : node.status === "completed"
                  ? "#10b981"
                  : "#64748b";

                const truncatedLabel =
                  node.label.length > 17 ? `${node.label.slice(0, 17)}…` : node.label;
                const truncatedSummary =
                  node.summary.length > 21 ? `${node.summary.slice(0, 21)}…` : node.summary;

                return (
                  <g
                    key={node.id}
                    onClick={() => onSelectNode(node.id)}
                    style={{ cursor: "pointer" }}
                  >
                    {isRunning && (
                      <rect
                        x={x - 4}
                        y={y - 4}
                        width={topologyLayout.nodeWidth + 8}
                        height={topologyLayout.nodeHeight + 8}
                        rx={15}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        style={{ transformOrigin: `${pos.cx}px ${pos.cy}px`, animation: "zygos-pulse-ring 1.8s infinite" }}
                      />
                    )}
                    <rect
                      x={x}
                      y={y}
                      width={topologyLayout.nodeWidth}
                      height={topologyLayout.nodeHeight}
                      rx={12}
                      fill={isSelected ? "rgba(37, 99, 235, 0.22)" : "var(--color-surface-solid)"}
                      stroke={
                        isSelected
                          ? "#60a5fa"
                          : isConnected
                          ? "#10b981"
                          : isFailed
                          ? "#ef4444"
                          : "var(--color-line-strong)"
                      }
                      strokeWidth={isSelected ? 2.2 : 1.2}
                    />
                    {/* 左侧阶段色条 */}
                    <rect x={x} y={y + 8} width={4} height={topologyLayout.nodeHeight - 16} rx={2} fill={stageColor} />

                    {/* 状态光点 */}
                    <circle cx={x + 19} cy={y + 21} r={4.5} fill={statusDotColor} />

                    {/* 节点标题 */}
                    <text
                      x={x + 30}
                      y={y + 25}
                      fontSize="12"
                      fontWeight="700"
                      fill="var(--color-ink)"
                    >
                      {truncatedLabel}
                    </text>

                    {/* 摘要 / 耗时 */}
                    <text x={x + 16} y={y + 47} fontSize="10.5" fill="var(--color-ink-mute)">
                      {truncatedSummary}
                    </text>

                    {node.durationMs != null && (
                      <text
                        x={x + topologyLayout.nodeWidth - 12}
                        y={y + 47}
                        fontSize="10"
                        textAnchor="end"
                        fontFamily="var(--font-mono)"
                        fill={stageColor}
                      >
                        {node.durationMs}ms
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      )}

      {/* ============================================================
       * 分阶段详情卡片列表
       * ============================================================ */}
      {viewMode !== "topology" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {nodesByStage.map(({ stage, nodes }) => {
            const isCurrentActive = viewModel.currentStage === stage.id;
            const hasNodes = nodes.length > 0;
            const isCollapsed = collapsedStages[stage.id] ?? false;
            const accent = STAGE_ACCENT[stage.id];

            return (
              <div
                key={stage.id}
                style={{
                  backgroundColor: "var(--color-surface-sunken)",
                  borderRadius: "14px",
                  border: isCurrentActive ? `1.5px solid ${accent}` : "1px solid var(--color-line)",
                  boxShadow: isCurrentActive ? `0 8px 24px -10px ${accent}55` : "none",
                  padding: "16px 18px",
                  transition: "all 0.25s ease",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleStage(stage.id)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "11px" }}>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "32px",
                        height: "32px",
                        borderRadius: "9px",
                        backgroundColor: `${accent}1e`,
                        border: `1px solid ${accent}44`,
                      }}
                    >
                      {getStageIcon(stage.id)}
                    </span>
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)", display: "flex", alignItems: "center", gap: "8px" }}>
                        <span>阶段 {stage.order} · {stage.name}</span>
                        {isCurrentActive && (
                          <span
                            style={{
                              fontSize: "10px",
                              padding: "2px 8px",
                              borderRadius: "9999px",
                              backgroundColor: `${accent}26`,
                              border: `1px solid ${accent}55`,
                              color: accent,
                              fontWeight: 700,
                            }}
                          >
                            当前推进阶段
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "11.5px", color: "var(--color-ink-mute)", marginTop: "2px" }}>
                        {stage.subtitle}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span className="zygos-tabular" style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
                      {hasNodes ? `${nodes.length} 个机制节点` : "本轮尚未进入"}
                    </span>
                    <span style={{ color: "var(--color-ink-mute)", display: "inline-flex" }}>
                      {isCollapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
                    </span>
                  </div>
                </div>

                {!isCollapsed && hasNodes && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(275px, 1fr))",
                      gap: "12px",
                      marginTop: "14px",
                      borderTop: "1px solid var(--color-line)",
                      paddingTop: "14px",
                    }}
                  >
                    {nodes.map((node) => {
                      const isSelected = selectedNodeId === node.id;
                      const isConnected = connectedNodeIds.has(node.id);
                      const nodeInEdges = edges.filter((e) => e.target === node.id);
                      const nodeOutEdges = edges.filter((e) => e.source === node.id);

                      return (
                        <div
                          key={node.id}
                          onClick={() => onSelectNode(node.id)}
                          className="zygos-node-card"
                          style={{
                            backgroundColor: isSelected
                              ? "var(--color-brand-tint)"
                              : isConnected
                              ? "var(--color-state-success-bg)"
                              : "var(--color-surface)",
                            border: isSelected
                              ? "1.5px solid var(--color-brand-ring)"
                              : isConnected
                              ? "1px dashed var(--color-state-success-border)"
                              : "1px solid var(--color-line)",
                            borderRadius: "12px",
                            padding: "13px 15px",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between",
                            gap: "9px",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                            <span
                              style={{
                                fontSize: "13px",
                                fontWeight: 700,
                                color: isSelected ? "var(--color-brand-deep)" : "var(--color-ink)",
                              }}
                            >
                              {node.label}
                            </span>
                            <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                              {getStatusIcon(node.status)}
                            </span>
                          </div>

                          <div style={{ fontSize: "12px", lineHeight: 1.55, color: "var(--color-ink-soft)" }}>
                            {node.summary}
                          </div>

                          {(nodeInEdges.length > 0 || nodeOutEdges.some((e) => e.kind === "repair_loop")) && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", fontSize: "10px" }}>
                              {nodeInEdges.map((e) => (
                                <span
                                  key={e.id}
                                  style={{
                                    padding: "2px 6px",
                                    borderRadius: "5px",
                                    backgroundColor:
                                      e.kind === "repair_loop"
                                        ? "var(--color-state-candidate-bg)"
                                        : "var(--color-brand-tint)",
                                    color:
                                      e.kind === "repair_loop"
                                        ? "var(--color-state-candidate)"
                                        : "var(--color-brand-mid)",
                                    border: `1px solid ${
                                      e.kind === "repair_loop"
                                        ? "var(--color-state-candidate-border)"
                                        : "var(--color-brand-ring)"
                                    }`,
                                  }}
                                >
                                  {e.kind === "repair_loop"
                                    ? "↺ 修订回流"
                                    : e.kind === "evidence"
                                    ? "⚡ 证据支撑"
                                    : "← 依赖前置"}
                                </span>
                              ))}
                              {nodeOutEdges
                                .filter((e) => e.kind === "repair_loop")
                                .map((e) => (
                                  <span
                                    key={e.id}
                                    style={{
                                      padding: "2px 6px",
                                      borderRadius: "5px",
                                      backgroundColor: "var(--color-state-error-bg)",
                                      color: "var(--color-state-error)",
                                      border: "1px solid var(--color-state-error-border)",
                                    }}
                                  >
                                    ↺ 触发反例回流
                                  </span>
                                ))}
                            </div>
                          )}

                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              fontSize: "11px",
                              color: "var(--color-ink-mute)",
                              borderTop: "1px solid var(--color-line)",
                              paddingTop: "7px",
                            }}
                          >
                            <span>{node.evidenceId ? "包含真实证据" : "机制状态"}</span>
                            {node.durationMs != null && (
                              <span className="zygos-tabular" style={{ fontFamily: "var(--font-mono)" }}>
                                {node.durationMs}ms
                              </span>
                            )}
                            <span
                              style={{
                                color: "var(--color-brand-mid)",
                                fontWeight: 600,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "2px",
                              }}
                            >
                              详情 <ChevronRight size={11} />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
        </>
      )}
    </div>
  );
}
