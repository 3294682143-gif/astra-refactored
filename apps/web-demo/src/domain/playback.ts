/**
 * PlaybackController —— 运行事件回放控制器。
 *
 * 特性：
 *   - play / pause / stepForward / stepBackward / jumpTo(seq) / setSpeed(0.5 | 1 | 2 | 5)
 *   - 历史游标独立于事件流：新事件到达时，历史游标不被强制推到最新
 *   - 分段快照缓存：每 20 条事件保留一份 RunViewState 快照，
 *     任意随机跳转只需最多折叠 < 20 条事件，实现 O(1) 毫秒级拖动
 *   - 纯浏览器环境安全，无 Node 内置库依赖
 */

import {
  type RunEventEnvelope,
  type RunViewState,
  createInitialRunViewState,
  reduceRun,
} from "./reduceRun.ts";

export type PlaybackSpeed = 0.5 | 1 | 2 | 5;

export const ALLOWED_SPEEDS: ReadonlyArray<PlaybackSpeed> = [0.5, 1, 2, 5];
export const DEFAULT_SNAPSHOT_INTERVAL = 20;
export const DEFAULT_BASE_INTERVAL_MS = 250;

export interface PlaybackSnapshot {
  readonly index: number;
  readonly seq: number;
  readonly state: RunViewState;
}

export type PlaybackListener = (controller: PlaybackController) => void;

export interface PlaybackControllerOptions {
  readonly initialRunId?: string;
  readonly snapshotInterval?: number;
  readonly baseIntervalMs?: number;
}

export class PlaybackController {
  private _events: RunEventEnvelope[] = [];
  private _snapshots: PlaybackSnapshot[] = [];
  private _currentIndex = -1;
  private _currentState: RunViewState;
  private _isPlaying = false;
  private _speed: PlaybackSpeed = 1;
  private _timerId: ReturnType<typeof setInterval> | null = null;
  private _listeners: Set<PlaybackListener> = new Set();

  readonly snapshotInterval: number;
  readonly baseIntervalMs: number;

  constructor(options: PlaybackControllerOptions = {}) {
    this.snapshotInterval = options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.baseIntervalMs = options.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this._currentState = createInitialRunViewState(options.initialRunId ?? "playback-run");
  }

  // ----------------------------------------------------------------- 属性访问
  get events(): readonly RunEventEnvelope[] {
    return this._events;
  }

  get totalEvents(): number {
    return this._events.length;
  }

  get currentIndex(): number {
    return this._currentIndex;
  }

  get currentSeq(): number {
    if (this._currentIndex >= 0 && this._currentIndex < this._events.length) {
      return this._events[this._currentIndex].seq;
    }
    return 0;
  }

  get state(): RunViewState {
    return this._currentState;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get speed(): PlaybackSpeed {
    return this._speed;
  }

  get progressRatio(): number {
    if (this._events.length === 0) return 0;
    if (this._currentIndex < 0) return 0;
    return (this._currentIndex + 1) / this._events.length;
  }

  // ----------------------------------------------------------------- 订阅机制
  subscribe(listener: PlaybackListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this._listeners) {
      listener(this);
    }
  }

  // ----------------------------------------------------------------- 加载与快照
  loadEvents(events: readonly RunEventEnvelope[], autoJumpToEnd = true): void {
    this.pause();
    this._events = [...events].sort((a, b) => a.seq - b.seq);
    this.rebuildSnapshots();

    if (autoJumpToEnd && this._events.length > 0) {
      this.jumpToIndex(this._events.length - 1);
    } else {
      this.jumpToIndex(Math.min(this._currentIndex, this._events.length - 1));
    }
  }

  /**
   * 追加新事件（实时模式）。
   * 严格遵循规范：若用户正停在历史游标处审查，新事件的到来绝不会强推游标！
   */
  addEvent(ev: RunEventEnvelope): void {
    const wasAtEnd = this._currentIndex === this._events.length - 1;
    this._events.push(ev);

    // 如果满足快照步长，在后台追加快照
    const newIdx = this._events.length - 1;
    if (newIdx % this.snapshotInterval === 0) {
      const prevState = this.computeStateAt(newIdx);
      this._snapshots.push({
        index: newIdx,
        seq: ev.seq,
        state: prevState,
      });
    }

    if (wasAtEnd && this._isPlaying) {
      // 正在播放且本来就在最新帧，自然跟随步进
      this.jumpToIndex(newIdx);
    } else {
      // 保持用户当前的游标不变，仅刷新进度和可用总数
      this.notify();
    }
  }

  private rebuildSnapshots(): void {
    this._snapshots = [];
    if (this._events.length === 0) return;

    let acc = createInitialRunViewState(this._currentState.runId);
    for (let i = 0; i < this._events.length; i++) {
      acc = reduceRun(acc, this._events[i]);
      if ((i + 1) % this.snapshotInterval === 0 || i === 0) {
        this._snapshots.push({
          index: i,
          seq: this._events[i].seq,
          state: acc,
        });
      }
    }
  }

  // ----------------------------------------------------------------- 游标与跳转
  jumpToIndex(targetIndex: number): void {
    const clamped = Math.max(-1, Math.min(targetIndex, this._events.length - 1));
    this._currentIndex = clamped;
    this._currentState = this.computeStateAt(clamped);
    this.notify();
  }

  jumpToSeq(seq: number): void {
    if (this._events.length === 0) return;
    let targetIdx = -1;
    for (let i = 0; i < this._events.length; i++) {
      if (this._events[i].seq <= seq) {
        targetIdx = i;
      } else {
        break;
      }
    }
    this.jumpToIndex(targetIdx);
  }

  private computeStateAt(targetIndex: number): RunViewState {
    if (targetIndex < 0 || this._events.length === 0) {
      return createInitialRunViewState(this._currentState.runId);
    }

    // 寻找在 targetIndex 之前且最接近的快照
    let baseIndex = -1;
    let baseState = createInitialRunViewState(this._currentState.runId);

    for (let i = this._snapshots.length - 1; i >= 0; i--) {
      if (this._snapshots[i].index <= targetIndex) {
        baseIndex = this._snapshots[i].index;
        baseState = this._snapshots[i].state;
        break;
      }
    }

    // 从快照点开始增量归约到 targetIndex
    let acc = baseState;
    for (let i = baseIndex + 1; i <= targetIndex; i++) {
      acc = reduceRun(acc, this._events[i]);
    }
    return acc;
  }

  // ----------------------------------------------------------------- 控制操作
  stepForward(): void {
    this.pause();
    if (this._currentIndex < this._events.length - 1) {
      this.jumpToIndex(this._currentIndex + 1);
    }
  }

  stepBackward(): void {
    this.pause();
    if (this._currentIndex > 0) {
      this.jumpToIndex(this._currentIndex - 1);
    } else if (this._currentIndex === 0) {
      this.jumpToIndex(-1);
    }
  }

  play(): void {
    if (this._isPlaying) return;
    if (this._currentIndex >= this._events.length - 1) {
      // 若已在末尾，重头播放
      this.jumpToIndex(0);
    }
    this._isPlaying = true;
    this.startTimer();
    this.notify();
  }

  pause(): void {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    this.stopTimer();
    this.notify();
  }

  togglePlay(): void {
    if (this._isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  setSpeed(speed: PlaybackSpeed): void {
    if (!ALLOWED_SPEEDS.includes(speed)) return;
    this._speed = speed;
    if (this._isPlaying) {
      this.stopTimer();
      this.startTimer();
    }
    this.notify();
  }

  private startTimer(): void {
    this.stopTimer();
    const interval = this.baseIntervalMs / this._speed;
    this._timerId = setInterval(() => {
      if (this._currentIndex < this._events.length - 1) {
        this.jumpToIndex(this._currentIndex + 1);
      } else {
        this.pause();
      }
    }, interval);
  }

  private stopTimer(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  destroy(): void {
    this.pause();
    this._listeners.clear();
  }
}
