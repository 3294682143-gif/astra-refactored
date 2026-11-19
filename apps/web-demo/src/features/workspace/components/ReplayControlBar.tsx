import { useEffect, useMemo } from "react";
import {
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
} from "lucide-react";
import { getEventKind, type RunEventEnvelope } from "../../../domain/reduceRun";

interface ReplayControlBarProps {
  currentSeq: number;
  totalEvents: number;
  isPlaying: boolean;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  onSeek: (seq: number) => void;
  onSpeedChange: (speed: number) => void;
  onReset: () => void;
  events?: readonly RunEventEnvelope[];
}

interface EventTickStyle {
  color: string;
  label: string;
  height: number;
}

function classifyEventKind(kind: string): EventTickStyle {
  const k = kind.toLowerCase();
  if (
    k.includes("fail") ||
    k.includes("error") ||
    k.includes("reject") ||
    k.includes("blocked")
  ) {
    return {
      color: "var(--color-state-error, #ef4444)",
      label: kind,
      height: 14,
    };
  }
  if (k.includes("repair") || k.includes("counterexample") || k.includes("retry")) {
    return {
      color: "var(--color-state-candidate, #f59e0b)",
      label: kind,
      height: 14,
    };
  }
  if (k.includes("completed") || k.includes("verified") || k.includes("final") || k.includes("done")) {
    return {
      color: "var(--color-state-success, #34d399)",
      label: kind,
      height: 13,
    };
  }
  if (
    k.includes("started") ||
    k.includes("contract") ||
    k.includes("strategy") ||
    k.includes("subproblem") ||
    k.includes("evidence")
  ) {
    return {
      color: "var(--color-brand-mid, #60a5fa)",
      label: kind,
      height: 11,
    };
  }
  return {
    color: "var(--color-ink-mute, #7c8ba6)",
    label: kind || "event",
    height: 8,
  };
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

const SPEED_OPTIONS = [1, 2, 4, 6, 8] as const;

export function ReplayControlBar({
  currentSeq,
  totalEvents,
  isPlaying,
  speed,
  onPlay,
  onPause,
  onStepForward,
  onStepBackward,
  onSeek,
  onSpeedChange,
  onReset,
  events,
}: ReplayControlBarProps) {
  const safeTotal = Math.max(1, totalEvents);
  const clampedSeq = Math.min(safeTotal, Math.max(1, currentSeq));
  const progressPct =
    safeTotal > 1 ? ((clampedSeq - 1) / (safeTotal - 1)) * 100 : 100;

  const activeEventKind = useMemo(() => {
    if (!events || events.length === 0) return null;
    const ev = events[clampedSeq - 1];
    return ev ? getEventKind(ev) : null;
  }, [events, clampedSeq]);

  const activeStyle = useMemo(
    () => (activeEventKind ? classifyEventKind(activeEventKind) : null),
    [activeEventKind],
  );

  // When events exceed 120 items, keep ticks readable while preserving edge/milestones
  const renderedTicks = useMemo(() => {
    if (!events || events.length === 0) return [];
    const maxTicks = 120;
    const step = events.length > maxTicks ? Math.ceil(events.length / maxTicks) : 1;
    const items: Array<{
      seq: number;
      pct: number;
      style: EventTickStyle;
    }> = [];
    for (let i = 0; i < events.length; i += step) {
      const seq = i + 1;
      const pct = events.length > 1 ? (i / (events.length - 1)) * 100 : 0;
      items.push({
        seq,
        pct,
        style: classifyEventKind(getEventKind(events[i])),
      });
    }
    return items;
  }, [events]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (isPlaying) {
          onPause();
        } else {
          onPlay();
        }
      } else if (e.key === "ArrowLeft") {
        if (clampedSeq > 1) {
          e.preventDefault();
          onStepBackward();
        }
      } else if (e.key === "ArrowRight") {
        if (clampedSeq < safeTotal) {
          e.preventDefault();
          onStepForward();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isPlaying,
    clampedSeq,
    safeTotal,
    onPlay,
    onPause,
    onStepBackward,
    onStepForward,
  ]);

  return (
    <div
      style={{
        position: "sticky",
        bottom: "16px",
        zIndex: 30,
        padding: "0 24px 8px",
        pointerEvents: "none",
      }}
    >
      <div
        className="zygos-glass"
        style={{
          pointerEvents: "auto",
          maxWidth: "1120px",
          margin: "0 auto",
          borderRadius: "20px",
          padding: "12px 18px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          border: "1px solid var(--color-line-strong)",
          boxShadow: "var(--shadow-ambient)",
        }}
      >
        {/* Top Row: Transport, Frame Telemetry Pill, Speed & Shortcuts */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
            flexWrap: "wrap",
          }}
        >
          {/* Transport Cluster */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <button
              type="button"
              onClick={onReset}
              title="回到第 1 帧"
              aria-label="重置到第 1 帧"
              className="zygos-btn-ghost"
              style={{
                width: "34px",
                height: "34px",
                padding: 0,
                borderRadius: "10px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <RotateCcw size={15} />
            </button>

            <button
              type="button"
              onClick={onStepBackward}
              disabled={clampedSeq <= 1}
              title="上一帧 (←)"
              aria-label="上一帧"
              className="zygos-btn-ghost"
              style={{
                width: "34px",
                height: "34px",
                padding: 0,
                borderRadius: "10px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: clampedSeq <= 1 ? 0.42 : 1,
                cursor: clampedSeq <= 1 ? "not-allowed" : "pointer",
              }}
            >
              <SkipBack size={15} />
            </button>

            <button
              type="button"
              onClick={isPlaying ? onPause : onPlay}
              title={isPlaying ? "暂停 (Space)" : "播放推演时间轴 (Space)"}
              className="zygos-btn-primary"
              style={{
                height: "36px",
                padding: "0 16px",
                borderRadius: "999px",
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              <span>{isPlaying ? "暂停" : "播放回放"}</span>
            </button>

            <button
              type="button"
              onClick={onStepForward}
              disabled={clampedSeq >= safeTotal}
              title="下一帧 (→)"
              aria-label="下一帧"
              className="zygos-btn-ghost"
              style={{
                width: "34px",
                height: "34px",
                padding: 0,
                borderRadius: "10px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: clampedSeq >= safeTotal ? 0.42 : 1,
                cursor: clampedSeq >= safeTotal ? "not-allowed" : "pointer",
              }}
            >
              <SkipForward size={15} />
            </button>
          </div>

          {/* Active Frame Telemetry Pill */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "10px",
              padding: "5px 12px",
              borderRadius: "999px",
              backgroundColor: "var(--color-surface-sunken)",
              border: "1px solid var(--color-line)",
              fontSize: "12px",
              color: "var(--color-ink)",
            }}
          >
            <span
              className="zygos-tabular"
              style={{ fontWeight: 700, letterSpacing: "0.01em" }}
            >
              帧 {clampedSeq} / {totalEvents}
            </span>
            {activeEventKind && activeStyle && (
              <>
                <span
                  style={{
                    width: "1px",
                    height: "12px",
                    backgroundColor: "var(--color-line-strong)",
                  }}
                />
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    color: "var(--color-ink-soft)",
                  }}
                >
                  <span
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "999px",
                      backgroundColor: activeStyle.color,
                      boxShadow: `0 0 8px ${activeStyle.color}`,
                    }}
                  />
                  {activeEventKind}
                </span>
              </>
            )}
            <span
              style={{
                width: "1px",
                height: "12px",
                backgroundColor: "var(--color-line-strong)",
              }}
            />
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: isPlaying
                  ? "var(--color-brand-deep)"
                  : "var(--color-ink-mute)",
              }}
            >
              {isPlaying
                ? `正在演进 (${speed}x)`
                : clampedSeq >= safeTotal
                  ? "推演回放完毕"
                  : "已暂停 · 可拖拽进度"}
            </span>
          </div>

          {/* Speed Selector & Hint */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                color: "var(--color-ink-mute)",
              }}
            >
              <Sparkles size={12} />
              Space / ← →
            </span>

            <div
              role="group"
              aria-label="回放倍速"
              style={{
                display: "inline-flex",
                padding: "3px",
                borderRadius: "999px",
                backgroundColor: "var(--color-surface-sunken)",
                border: "1px solid var(--color-line)",
                gap: "2px",
              }}
            >
              {SPEED_OPTIONS.map((opt) => {
                const active = speed === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => onSpeedChange(opt)}
                    className="zygos-tabular"
                    style={{
                      padding: "4px 10px",
                      borderRadius: "999px",
                      border: "none",
                      fontSize: "12px",
                      fontWeight: active ? 700 : 500,
                      cursor: "pointer",
                      transition: "all 0.2s var(--ease-spring, ease)",
                      backgroundColor: active
                        ? "var(--color-brand)"
                        : "transparent",
                      color: active ? "#ffffff" : "var(--color-ink-soft)",
                      boxShadow: active ? "0 2px 8px rgba(37,99,235,0.3)" : "none",
                    }}
                  >
                    {opt}x
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom Row: Event Tick Strip + Precision Scrubber */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {renderedTicks.length > 0 && (
            <div
              aria-hidden="true"
              style={{
                position: "relative",
                height: "14px",
                width: "100%",
              }}
            >
              {renderedTicks.map((tick) => {
                const isActive = tick.seq === clampedSeq;
                const isPast = tick.seq <= clampedSeq;
                return (
                  <button
                    key={tick.seq}
                    type="button"
                    title={`跳转至第 ${tick.seq} 帧 · ${tick.style.label}`}
                    onClick={() => onSeek(tick.seq)}
                    style={{
                      position: "absolute",
                      left: `${tick.pct}%`,
                      bottom: 0,
                      transform: "translateX(-50%)",
                      width: isActive ? "4px" : "3px",
                      height: `${isActive ? 14 : tick.style.height}px`,
                      padding: 0,
                      border: "none",
                      borderRadius: "2px",
                      cursor: "pointer",
                      backgroundColor: tick.style.color,
                      opacity: isActive ? 1 : isPast ? 0.78 : 0.34,
                      boxShadow: isActive ? `0 0 8px ${tick.style.color}` : "none",
                      transition: "opacity 0.15s ease, height 0.15s ease",
                    }}
                  />
                );
              })}
            </div>
          )}

          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <input
              type="range"
              aria-label="时间轴进度滑块"
              min={1}
              max={safeTotal}
              value={clampedSeq}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="zygos-slider"
              style={{
                width: "100%",
                background: `linear-gradient(to right, var(--color-brand) 0%, var(--color-brand) ${progressPct}%, var(--color-line-strong) ${progressPct}%, var(--color-line-strong) 100%)`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
