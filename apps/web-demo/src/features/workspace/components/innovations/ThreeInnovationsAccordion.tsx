import { ChevronDown, Layers } from "lucide-react";
import {
  THREE_INNOVATION_SPECS,
  type DerivedThreeInnovationsMetrics,
  type InnovationId,
} from "./innovationSpecs";
import { InnovationSubRow } from "./InnovationSubDiagrams";

interface ThreeInnovationsAccordionProps {
  metrics: DerivedThreeInnovationsMetrics;
  expandedIds: ReadonlySet<InnovationId>;
  onToggleExpand: (id: InnovationId) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  isLive?: boolean;
}

export function ThreeInnovationsAccordion({
  metrics,
  expandedIds,
  onToggleExpand,
  onExpandAll,
  onCollapseAll,
  isLive = true,
}: ThreeInnovationsAccordionProps) {
  const allExpanded = expandedIds.size === THREE_INNOVATION_SPECS.length;

  return (
    <section
      className="zygos-glass zygos-animate-in zygos-accordion"
      aria-labelledby="three-innovations-details-heading"
      style={{
        borderRadius: "20px",
        padding: "16px 18px",
        border: "1px solid var(--color-line-strong)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
          <span
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "8px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "var(--color-brand-tint)",
              border: "1px solid var(--color-brand-ring)",
              color: "var(--color-brand-deep)",
              flexShrink: 0,
            }}
          >
            <Layers size={14} />
          </span>
          <div>
            <h3
              id="three-innovations-details-heading"
              className="zygos-heading-balance"
              style={{ margin: 0, fontSize: "14.5px", fontWeight: 700, color: "var(--color-ink)" }}
            >
              三大核心创新点底层机制拆解
            </h3>
            <div style={{ fontSize: "11.5px", color: "var(--color-ink-mute)", marginTop: "1px" }}>
              默认折叠保持总览专注 · 展开横向查看每项机制的 3 块源码可视化动图
            </div>
          </div>
        </div>

        <button
          type="button"
          aria-expanded={allExpanded}
          onClick={allExpanded ? onCollapseAll : onExpandAll}
          className="zygos-btn-ghost"
          style={{ padding: "6px 12px", fontSize: "11.5px", borderRadius: "9px" }}
        >
          <span>{allExpanded ? "全部折叠收起" : "展开全部三大创新点"}</span>
        </button>
      </div>

      {/* 3 Native <details> Collapsible Innovation Panels */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {THREE_INNOVATION_SPECS.map((spec) => {
          const isOpen = expandedIds.has(spec.id);
          return (
            <details
              key={spec.id}
              id={`innovation-accordion-${spec.id}`}
              open={isOpen}
              onToggle={(e) => {
                const nextOpen = e.currentTarget.open;
                if (nextOpen !== isOpen) {
                  onToggleExpand(spec.id);
                }
              }}
              style={{
                borderRadius: "15px",
                border: isOpen
                  ? `1.5px solid ${spec.accentColor}77`
                  : "1px solid var(--color-line-strong)",
                backgroundColor: isOpen
                  ? "var(--color-surface-elevated)"
                  : "var(--color-surface)",
                overflow: "hidden",
                transition: "border-color 0.2s ease",
              }}
            >
              {/* Note: Per WCAG/Modern-Web-Guidance, never nest heading tags inside <summary>, keep marker next to label */}
              <summary
                style={{
                  padding: "12px 15px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  userSelect: "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0, flexWrap: "wrap" }}>
                  <ChevronDown
                    size={16}
                    color={isOpen ? spec.accentColor : "var(--color-ink-mute)"}
                    className="zygos-acc-marker"
                    aria-hidden="true"
                  />

                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "2px 9px",
                      borderRadius: "999px",
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: `${spec.accentColor}20`,
                      color: spec.accentColor,
                      border: `1px solid ${spec.accentColor}55`,
                      flexShrink: 0,
                    }}
                  >
                    {spec.shortName}
                  </span>

                  <span
                    className="zygos-heading-balance"
                    style={{
                      fontSize: "13.5px",
                      fontWeight: 700,
                      color: "var(--color-ink)",
                    }}
                  >
                    {spec.title}
                  </span>
                </div>

                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: isOpen ? spec.accentColor : "var(--color-ink-soft)",
                    flexShrink: 0,
                  }}
                >
                  {isOpen ? "收起 3 块动图" : "展开 3 块动图"}
                </span>
              </summary>

              {/* Disclosed Content: Compact mechanism line + 3 Horizontal Source-Backed Interactive Diagrams */}
              <div
                style={{
                  borderTop: "1px solid var(--color-line)",
                  padding: "13px 15px 15px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "11px",
                }}
              >
                <div
                  style={{
                    fontSize: "11.5px",
                    color: "var(--color-ink-mute)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {spec.slogan}
                </div>

                <InnovationSubRow
                  innovationId={spec.id}
                  spec={spec}
                  metrics={metrics}
                  animateAlways={isLive || metrics.isTerminal}
                />
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
