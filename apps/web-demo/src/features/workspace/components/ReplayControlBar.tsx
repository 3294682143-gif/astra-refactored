import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
} from "lucide-react";

interface ReplayControlBarProps {
  currentSeq: number;
  totalEvents: number;
  isPlaying: boolean;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onSeek: (seq: number) => void;
  onSpeedChange: (speed: number) => void;
  onReset: () => void;
}

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
}: ReplayControlBarProps) {
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 15,
        backgroundColor: "rgba(255, 255, 255, 0.95)",
        backdropFilter: "blur(8px)",
        borderTop: "1px solid var(--color-line-strong)",
        boxShadow: "0 -4px 16px rgba(0,0,0,0.04)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "20px",
      }}
    >
      {/* 播放控制按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <button
          type="button"
          onClick={onReset}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            borderRadius: "6px",
            border: "1px solid var(--color-line)",
            backgroundColor: "transparent",
            cursor: "pointer",
            color: "var(--color-ink-soft)",
          }}
          title="重置到第一帧"
        >
          <RotateCcw size={14} />
        </button>

        <button
          type="button"
          onClick={onStepBackward}
          disabled={currentSeq <= 1}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            borderRadius: "6px",
            border: "1px solid var(--color-line)",
            backgroundColor: "transparent",
            cursor: currentSeq <= 1 ? "not-allowed" : "pointer",
            color: currentSeq <= 1 ? "var(--color-ink-mute)" : "var(--color-ink)",
          }}
          title="单步后退"
        >
          <SkipBack size={14} />
        </button>

        <button
          type="button"
          onClick={isPlaying ? onPause : onPlay}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "38px",
            height: "38px",
            borderRadius: "50%",
            backgroundColor: "var(--color-brand)",
            color: "#ffffff",
            border: "none",
            cursor: "pointer",
            boxShadow: "0 2px 6px rgba(49, 94, 168, 0.3)",
          }}
          title={isPlaying ? "暂停" : "播放"}
        >
          {isPlaying ? <Pause size={17} /> : <Play size={17} style={{ marginLeft: "2px" }} />}
        </button>

        <button
          type="button"
          onClick={onStepForward}
          disabled={currentSeq >= totalEvents}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            borderRadius: "6px",
            border: "1px solid var(--color-line)",
            backgroundColor: "transparent",
            cursor: currentSeq >= totalEvents ? "not-allowed" : "pointer",
            color: currentSeq >= totalEvents ? "var(--color-ink-mute)" : "var(--color-ink)",
          }}
          title="单步前进"
        >
          <SkipForward size={14} />
        </button>
      </div>

      {/* 进度条与序列拖动 */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "14px" }}>
        <input
          type="range"
          min={1}
          max={totalEvents || 1}
          value={currentSeq}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={{
            flex: 1,
            cursor: "pointer",
            accentColor: "var(--color-brand)",
          }}
        />

        <div style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--color-ink-soft)", whiteSpace: "nowrap" }}>
          事件帧 <strong>{currentSeq}</strong> / {totalEvents}
        </div>
      </div>

      {/* 速率切换 */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {[1, 2, 4].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeedChange(s)}
            style={{
              padding: "4px 8px",
              borderRadius: "4px",
              border: "1px solid",
              borderColor: speed === s ? "var(--color-brand)" : "var(--color-line)",
              backgroundColor: speed === s ? "var(--color-brand-tint)" : "transparent",
              color: speed === s ? "var(--color-brand)" : "var(--color-ink-soft)",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}
