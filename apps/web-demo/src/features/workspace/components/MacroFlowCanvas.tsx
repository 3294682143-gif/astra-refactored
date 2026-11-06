import { useState } from "react";
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
  ArrowDown,
  RotateCcw,
} from "lucide-react";
import {
  MACRO_STAGES,
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

export function MacroFlowCanvas({
  viewModel,
  selectedNodeId,
  onSelectNode,
  compact = false,
}: MacroFlowCanvasProps) {
  // 阶段折叠/展开状态，默认有节点的阶段展开，无节点的阶段折叠
  const [collapsedStages, setCollapsedStages] = useState<Record<string, boolean>>({});

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
    switch (stageId) {
      case "stage_1_planning":
        return <FileText size={17} color="var(--color-brand)" />;
      case "stage_2_execution":
        return <Boxes size={17} color="#0284c7" />;
      case "stage_3_review":
        return <ShieldAlert size={17} color="#d97706" />;
      case "stage_4_delivery":
        return <Award size={17} color="#16a34a" />;
    }
  };

  const getStatusIcon = (status: ResearchNode["status"]) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 size={14} color="#16a34a" />;
      case "running":
        return (
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: "var(--color-brand)",
              display: "inline-block",
            }}
          />
        );
      case "untriggered":
        return <span style={{ fontSize: "11px", color: "#94a3b8" }}>○ 未触发</span>;
      case "unrecorded":
        return <HelpCircle size={14} color="#94a3b8" />;
      case "failed":
        return <AlertCircle size={14} color="#dc2626" />;
      default:
        return <Clock size={14} color="#94a3b8" />;
    }
  };

  // 依赖关系网分析：针对当前选中的节点寻找直接前置与后置关联
  const edges = viewModel.edges || [];
  const selectedIncoming = edges.filter((e) => e.target === selectedNodeId);
  const selectedOutgoing = edges.filter((e) => e.source === selectedNodeId);
  const connectedNodeIds = new Set([
    ...selectedIncoming.map((e) => e.source),
    ...selectedOutgoing.map((e) => e.target),
  ]);

  const hasRepairLoop = edges.some((e) => e.kind === "repair_loop");

  // 按宏观阶段对节点进行分组
  const nodesByStage = MACRO_STAGES.map((stage) => ({
    stage,
    nodes: viewModel.nodes.filter((n) => n.stage === stage.id),
  }));

  return (
    <div
      style={{
        backgroundColor: "var(--color-surface-muted)",
        borderRadius: "12px",
        border: "1px solid var(--color-line)",
        padding: compact ? "16px" : "24px",
        display: "flex",
        flexDirection: "column",
        gap: compact ? "16px" : "20px",
      }}
    >
      {/* 顶部控制栏与说明 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--color-line)",
          paddingBottom: "12px",
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Layers size={17} color="var(--color-brand)" />
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
            {compact ? "机制流程总览" : "宏观机制流与执行拓扑工作台"}
          </span>
          <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
            （包含 {viewModel.nodes.length} 个节点，{edges.length} 条依赖与回流连线）
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {/* 阶段全部展开/折叠按钮 */}
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              onClick={expandAll}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: "4px",
                border: "1px solid var(--color-line-strong)",
                backgroundColor: "var(--color-surface)",
                cursor: "pointer",
                color: "var(--color-ink-soft)",
              }}
            >
              全部展开
            </button>
            <button
              type="button"
              onClick={collapseAll}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: "4px",
                border: "1px solid var(--color-line-strong)",
                backgroundColor: "var(--color-surface)",
                cursor: "pointer",
                color: "var(--color-ink-soft)",
              }}
            >
              全部折叠
            </button>
          </div>

          {/* 机制图例 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              fontSize: "11px",
              color: "var(--color-ink-soft)",
              backgroundColor: "var(--color-surface)",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid var(--color-line)",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "var(--color-brand)" }} />
              因果依赖
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#d97706" }} />
              修复回流
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#0284c7" }} />
              证据支持
            </span>
          </div>
        </div>
      </div>

      {/* 宏观流水管道导航器 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "var(--color-surface)",
          padding: "10px 16px",
          borderRadius: "8px",
          border: "1px solid var(--color-line)",
          fontSize: "12px",
          gap: "8px",
          overflowX: "auto",
        }}
      >
        {MACRO_STAGES.map((st, idx) => {
          const isCurrent = viewModel.currentStage === st.id;
          const stageNodeCount = viewModel.nodes.filter((n) => n.stage === st.id).length;
          return (
            <div key={st.id} style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: "160px" }}>
              <div
                onClick={() => toggleStage(st.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  backgroundColor: isCurrent ? "var(--color-brand-tint)" : "transparent",
                  border: isCurrent ? "1px solid var(--color-brand)" : "1px solid transparent",
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                {getStageIcon(st.id)}
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div style={{ fontWeight: isCurrent ? 700 : 500, color: isCurrent ? "var(--color-brand-deep)" : "var(--color-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    阶段 {st.order} · {st.name}
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--color-ink-mute)" }}>
                    {stageNodeCount} 个节点
                  </div>
                </div>
              </div>
              {idx < MACRO_STAGES.length - 1 && (
                <ChevronRight size={14} color="var(--color-line-strong)" style={{ flexShrink: 0 }} />
              )}
            </div>
          );
        })}
      </div>

      {/* 修复回流特别指示条（若存在 REPAIR 回流） */}
      {hasRepairLoop && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 14px",
            backgroundColor: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "6px",
            fontSize: "12px",
            color: "#92400e",
          }}
        >
          <RotateCcw size={14} />
          <span>
            <strong>检测到受控反例修复回流：</strong> 阶段 3（过程审查）已向阶段 2（研究执行）触发受控修订回流，前后产物均保存在证据链中。
          </span>
        </div>
      )}

      {/* 四大宏观阶段纵向流水卡 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {nodesByStage.map(({ stage, nodes }, stageIdx) => {
          const isCurrentActive = viewModel.currentStage === stage.id;
          const hasNodes = nodes.length > 0;
          const isCollapsed = collapsedStages[stage.id] ?? false;

          return (
            <div key={stage.id} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div
                style={{
                  backgroundColor: "var(--color-surface)",
                  borderRadius: "10px",
                  border: isCurrentActive
                    ? "2px solid var(--color-brand)"
                    : "1px solid var(--color-line-strong)",
                  boxShadow: isCurrentActive
                    ? "0 4px 12px rgba(49, 94, 168, 0.08)"
                    : "0 1px 3px rgba(0,0,0,0.02)",
                  padding: "16px 20px",
                  transition: "all 0.2s ease",
                }}
              >
                {/* 阶段标题与折叠开关 */}
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
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "30px",
                        height: "30px",
                        borderRadius: "8px",
                        backgroundColor: "var(--color-brand-tint)",
                      }}
                    >
                      {getStageIcon(stage.id)}
                    </span>
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-brand-deep)", display: "flex", alignItems: "center", gap: "6px" }}>
                        <span>阶段 {stage.order} · {stage.name}</span>
                        {isCurrentActive && (
                          <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px", backgroundColor: "var(--color-brand)", color: "#fff", fontWeight: 600 }}>
                            当前推进阶段
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--color-ink-mute)" }}>
                        {stage.subtitle}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
                      {hasNodes ? `${nodes.length} 个机制节点` : "本轮尚未进入"}
                    </span>
                    <button
                      type="button"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--color-ink-mute)",
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                    </button>
                  </div>
                </div>

                {/* 阶段内节点卡片流 */}
                {!isCollapsed && hasNodes && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                      gap: "12px",
                      marginTop: "16px",
                      borderTop: "1px solid var(--color-line)",
                      paddingTop: "14px",
                    }}
                  >
                    {nodes.map((node) => {
                      const isSelected = selectedNodeId === node.id;
                      const isConnected = connectedNodeIds.has(node.id);

                      // 提取与此节点直接相连的拓扑边
                      const nodeInEdges = edges.filter((e) => e.target === node.id);
                      const nodeOutEdges = edges.filter((e) => e.source === node.id);

                      return (
                        <div
                          key={node.id}
                          onClick={() => onSelectNode(node.id)}
                          style={{
                            backgroundColor: isSelected
                              ? "var(--color-brand-tint)"
                              : isConnected
                              ? "#f0fdf4"
                              : "var(--color-surface-muted)",
                            border: isSelected
                              ? "2px solid var(--color-brand)"
                              : isConnected
                              ? "1px dashed #16a34a"
                              : "1px solid var(--color-line)",
                            borderRadius: "8px",
                            padding: "12px 14px",
                            cursor: "pointer",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between",
                            gap: "8px",
                            transition: "all 0.15s ease",
                            boxShadow: isSelected ? "0 2px 8px rgba(49, 94, 168, 0.12)" : "none",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "6px" }}>
                            <span
                              style={{
                                fontSize: "13px",
                                fontWeight: 700,
                                color: isSelected ? "var(--color-brand)" : "var(--color-ink)",
                              }}
                            >
                              {node.label}
                            </span>
                            <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                              {getStatusIcon(node.status)}
                            </span>
                          </div>

                          <div
                            style={{
                              fontSize: "12px",
                              lineHeight: 1.5,
                              color: "var(--color-ink-soft)",
                            }}
                          >
                            {node.summary}
                          </div>

                          {/* 拓扑连线依据指示条 */}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", fontSize: "10px" }}>
                            {nodeInEdges.map((e) => (
                              <span
                                key={e.id}
                                style={{
                                  padding: "1px 5px",
                                  borderRadius: "3px",
                                  backgroundColor: e.kind === "repair_loop" ? "#fef3c7" : "#e0f2fe",
                                  color: e.kind === "repair_loop" ? "#92400e" : "#0369a1",
                                  border: `1px solid ${e.kind === "repair_loop" ? "#fde68a" : "#bae6fd"}`,
                                }}
                              >
                                {e.kind === "repair_loop" ? "↺ 修订回流" : e.kind === "evidence" ? "⚡ 证据支撑" : "← 依赖前置"}
                              </span>
                            ))}
                            {nodeOutEdges.filter((e) => e.kind === "repair_loop").map((e) => (
                              <span
                                key={e.id}
                                style={{
                                  padding: "1px 5px",
                                  borderRadius: "3px",
                                  backgroundColor: "#fee2e2",
                                  color: "#991b1b",
                                  border: "1px solid #fecaca",
                                }}
                              >
                                ↺ 触发反例回流
                              </span>
                            ))}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              fontSize: "11px",
                              color: "var(--color-ink-mute)",
                              borderTop: "1px solid rgba(0,0,0,0.04)",
                              paddingTop: "6px",
                            }}
                          >
                            <span>{node.evidenceId ? "包含详细证据" : "机制状态"}</span>
                            {node.durationMs != null && (
                              <span>{node.durationMs}ms</span>
                            )}
                            <span
                              style={{
                                color: "var(--color-brand)",
                                fontWeight: 600,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "2px",
                              }}
                            >
                              查看详情 <ChevronRight size={11} />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 阶段之间的过渡推进连线 */}
              {stageIdx < nodesByStage.length - 1 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    color: "var(--color-ink-mute)",
                    fontSize: "11px",
                    padding: "2px 0",
                  }}
                >
                  <ArrowDown size={14} color="var(--color-brand)" />
                  <span>阶段推进与产物准入</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
