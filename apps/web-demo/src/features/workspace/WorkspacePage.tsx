import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router";
import {
  createRun,
  fetchReplay,
  fetchWorkspace,
  resumeRun,
  fetchRun,
} from "../../api/client";
import {
  createInitialRunViewState,
  reduceRun,
  type RunEventEnvelope,
} from "../../domain/reduceRun";
import { projectRunToResearchView } from "../../domain/research/projectResearchView";
import type {
  ResearchViewModel,
  ResearchNode,
  ResearchEvidence,
} from "../../domain/research/types";

import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { UnstartedView, type StartResearchOptions } from "./components/UnstartedView";
import { MacroFlowCanvas } from "./components/MacroFlowCanvas";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { ResultDeliveryCard } from "./result/ResultDeliveryCard";
import { ReplayControlBar } from "./components/ReplayControlBar";
import { RecoveryBanner } from "./components/RecoveryBanner";

export function WorkspacePage() {
  const { runId } = useParams<{ runId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const isReplayRoute = location.pathname.endsWith("/replay");

  // 本地归约与视图状态
  const [, setRunState] = useState(() =>
    createInitialRunViewState(runId || ""),
  );
  const [problemText, setProblemText] = useState("");
  const [viewModel, setViewModel] = useState<ResearchViewModel>(() =>
    projectRunToResearchView(createInitialRunViewState(runId || ""), ""),
  );

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  // 回放专用状态
  const [allReplayEvents, setAllReplayEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [replayCursor, setReplayCursor] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);

  const sseRef = useRef<EventSource | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const authoritativeWorkspaceRef = useRef<ResearchViewModel | null>(null);

  // 1. 当 URL 改变或切换 runId 时重置与重新加载
  useEffect(() => {
    // 关闭前一个 SSE
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    if (playTimerRef.current) {
      clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setIsPlaying(false);
    setSelectedNodeId(null);
    setErrorNotice(null);

    if (!runId) {
      // /solve 新建模式
      const init = createInitialRunViewState("");
      setRunState(init);
      setProblemText("");
      const initialVm = projectRunToResearchView(init, "");
      authoritativeWorkspaceRef.current = initialVm;
      setViewModel(initialVm);
      return;
    }

    // 已有 runId：读取后端数据
    let isCancelled = false;

    async function loadRunData() {
      // 优先拉取专门的工作台快照
      const wsRes = await fetchWorkspace(runId!);
      if (!isCancelled && wsRes.ok && wsRes.data) {
        authoritativeWorkspaceRef.current = wsRes.data;
        setViewModel(wsRes.data);
        setProblemText(wsRes.data.problem);
        if (wsRes.data.nodes.length > 0) {
          setSelectedNodeId(wsRes.data.nodes[0].id);
        }
      }

      // 拉取详细回放帧备用
      const replayRes = await fetchReplay(runId!);
      if (!isCancelled && replayRes.ok && replayRes.data.events) {
        const evs = replayRes.data.events;
        setAllReplayEvents(evs);
        setReplayCursor(evs.length);

        let cur = createInitialRunViewState(runId!);
        for (const ev of evs) {
          cur = reduceRun(cur, ev);
        }
        setRunState(cur);

        // 如果在回放路由下，采用带服务端基准的回放投影；否则保持权威快照
        if (isReplayRoute) {
          const projected = projectRunToResearchView(
            cur,
            (replayRes.data.details?.problem as string) || problemText,
            {
              serverBaseline: authoritativeWorkspaceRef.current || undefined,
              isReplay: true,
            }
          );
          setViewModel(projected);
        }
      }

      // 若状态仍为 running，接通实时 SSE
      const runItem = await fetchRun(runId!);
      if (!isCancelled && runItem.ok && runItem.data.status === "running") {
        connectSSE(runId!);
      }
    }

    loadRunData();

    return () => {
      isCancelled = true;
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [runId, isReplayRoute]);

  // 2. 实时 SSE 连接管理 (监听具名事件、保证去重与终态收口)
  const connectSSE = useCallback((rid: string) => {
    if (sseRef.current) {
      sseRef.current.close();
    }

    const es = new EventSource(`/api/runs/${encodeURIComponent(rid)}/events`);
    sseRef.current = es;

    const KNOWN_EVENT_KINDS = [
      "SESSION_INIT",
      "CONTRACT",
      "CONTRACT_REVISED",
      "TASK_STARTED",
      "MODEL_REQUEST",
      "WORKUNIT",
      "TOOL_OBSERVATION",
      "REVIEW_CHALLENGE",
      "METHOD_LOAD",
      "REPAIR",
      "CONSENSUS",
      "TRUNCATION",
      "FINAL",
      "RESULT",
      "model_dispatched",
      "model_returned",
      "effect_returned",
      "message",
      "error",
    ];

    const handleFrame = (dataStr: string) => {
      try {
        const raw = JSON.parse(dataStr);
        setRunState((prev) => {
          const next = reduceRun(prev, raw);
          setViewModel(
            projectRunToResearchView(next, prev.messages[0] || problemText, {
              serverBaseline: authoritativeWorkspaceRef.current || undefined,
              isReplay: false,
            })
          );
          return next;
        });
      } catch (err) {
        console.warn("SSE frame parse error:", err);
      }
    };

    // 为每个具名事件注册事件监听
    for (const kind of KNOWN_EVENT_KINDS) {
      es.addEventListener(kind, (e: MessageEvent) => {
        handleFrame(e.data);
      });
    }

    // 默认回退监听
    es.onmessage = (e: MessageEvent) => {
      handleFrame(e.data);
    };

    es.addEventListener("close", (e: MessageEvent) => {
      if (e.data) {
        handleFrame(e.data);
      }
      es.close();
      sseRef.current = null;

      // 终态重刷服务端权威工作台快照
      void fetchWorkspace(rid).then((res) => {
        if (res.ok && res.data) {
          authoritativeWorkspaceRef.current = res.data;
          setViewModel(res.data);
        }
      });
    });

    es.onerror = () => {
      // 离线断网或短暂断线后，不直接强制永久 close，让 EventSource 自动按退避重连；
      // 并拉取服务端权威快照以可靠补齐断线期间的事件帧与状态对齐 (Spec R4)
      if (authoritativeWorkspaceRef.current?.mode === "completed") {
        es.close();
        sseRef.current = null;
        return;
      }
      void fetchWorkspace(rid).then((res) => {
        if (res.ok && res.data) {
          authoritativeWorkspaceRef.current = res.data;
          setViewModel(res.data);
          if (res.data.mode === "completed") {
            es.close();
            sseRef.current = null;
          }
        }
      });
    };
  }, [problemText]);

  // 3. 提交新研究 (Spec R3)
  const handleStartResearch = async (
    problem: string,
    options: StartResearchOptions,
  ) => {
    setIsSubmitting(true);
    setErrorNotice(null);

    const res = await createRun({
      problem,
      max_model_calls: options.max_model_calls,
      max_work_units: options.max_work_units,
      max_effects: options.max_effects,
      max_reviews: options.max_reviews,
      max_method_loads: options.max_method_loads,
      max_repairs: options.max_repairs,
      max_consensus: options.max_consensus,
      max_r0: options.max_r0,
      engine: "ts",
    });

    setIsSubmitting(false);

    if (res.ok) {
      navigate(`/runs/${res.data.run_id}`);
    } else {
      setErrorNotice(res.error.message || "启动求解任务失败");
    }
  };

  // 4. 同题恢复执行 (方案 9 节)
  const handleResumeResearch = async () => {
    if (!runId || isResuming) return;
    setIsResuming(true);
    setErrorNotice(null);

    const res = await resumeRun(runId);
    setIsResuming(false);

    if (res.ok) {
      navigate(`/runs/${res.data.run_id}`);
    } else {
      setErrorNotice(res.error.message || "同题恢复申请未被接受");
    }
  };

  // 5. 回放步进与播放器调度
  const handleSeekReplay = useCallback(
    (targetSeq: number) => {
      if (allReplayEvents.length === 0) return;
      const clamped = Math.max(1, Math.min(targetSeq, allReplayEvents.length));
      setReplayCursor(clamped);

      // 从第一帧重新归约到当前帧
      let cur = createInitialRunViewState(runId || "");
      for (let i = 0; i < clamped; i++) {
        cur = reduceRun(cur, allReplayEvents[i]);
      }
      setRunState(cur);
      const projected = projectRunToResearchView(cur, problemText, {
        serverBaseline: authoritativeWorkspaceRef.current || undefined,
        isReplay: true,
      });
      setViewModel(projected);
    },
    [allReplayEvents, runId, problemText],
  );

  const handlePlayReplay = () => {
    if (replayCursor >= allReplayEvents.length) {
      handleSeekReplay(1);
    }
    setIsPlaying(true);
  };

  const handlePauseReplay = () => {
    setIsPlaying(false);
  };

  useEffect(() => {
    if (isPlaying) {
      const intervalMs = Math.max(150, Math.floor(1000 / replaySpeed));
      playTimerRef.current = window.setInterval(() => {
        setReplayCursor((prev) => {
          if (prev >= allReplayEvents.length) {
            setIsPlaying(false);
            return prev;
          }
          const next = prev + 1;
          handleSeekReplay(next);
          return next;
        });
      }, intervalMs);
    } else if (playTimerRef.current) {
      clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }

    return () => {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, replaySpeed, allReplayEvents.length, handleSeekReplay]);

  // 当前选中的节点与证据
  const activeNode: ResearchNode | null =
    viewModel.nodes.find((n) => n.id === selectedNodeId) || null;
  const activeEvidence: ResearchEvidence | null =
    activeNode?.evidenceId ? viewModel.evidences[activeNode.evidenceId] || null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%", width: "100%" }}>
      {/* 顶栏 */}
      <WorkspaceHeader
        viewModel={viewModel}
        isReplay={isReplayRoute}
        onToggleReplay={() => {
          if (isReplayRoute) {
            navigate(`/runs/${runId}`);
          } else {
            navigate(`/runs/${runId}/replay`);
          }
        }}
        onResume={viewModel.recovery.eligible ? handleResumeResearch : undefined}
      />

      {/* 异常错误浮条 */}
      {errorNotice && (
        <div
          style={{
            backgroundColor: "#fef2f2",
            borderBottom: "1px solid #fecaca",
            padding: "10px 24px",
            fontSize: "13px",
            color: "#991b1b",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{errorNotice}</span>
          <button
            type="button"
            onClick={() => setErrorNotice(null)}
            style={{ border: "none", background: "none", color: "#991b1b", cursor: "pointer", fontWeight: 700 }}
          >
            ×
          </button>
        </div>
      )}

      {/* 主工作区内容 */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
        {/* 左侧主画布 */}
        <div
          style={{
            flex: 1,
            padding: "24px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "24px",
            minWidth: 0,
          }}
        >
          {viewModel.mode === "unstarted" ? (
            /* 状态 1：未开始 (居中输入 + 案例) */
            <UnstartedView onSubmit={handleStartResearch} isLoading={isSubmitting} />
          ) : (
            /* 状态 2 & 3：运行中或已完成 */
            <>
              {/* 恢复提示横幅（仅在实时非回放态且具备有效检查点时展示） */}
              {!isReplayRoute && viewModel.recovery.eligible && (
                <RecoveryBanner
                  recovery={viewModel.recovery}
                  isResuming={isResuming}
                  onResume={handleResumeResearch}
                />
              )}

              {/* 宏观机制流程图 */}
              <MacroFlowCanvas
                viewModel={viewModel}
                selectedNodeId={selectedNodeId}
                onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
                compact={viewModel.mode === "completed"}
              />

              {/* 已完成状态：展示宽幅数学结果交付与覆盖表 */}
              {viewModel.mode === "completed" && (
                <ResultDeliveryCard viewModel={viewModel} />
              )}
            </>
          )}
        </div>

        {/* 右侧节点详情与证据抽屉 */}
        {activeNode && (
          <EvidenceDrawer
            node={activeNode}
            evidence={activeEvidence}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>

      {/* 回放控制器底栏 */}
      {isReplayRoute && allReplayEvents.length > 0 && (
        <ReplayControlBar
          currentSeq={replayCursor}
          totalEvents={allReplayEvents.length}
          isPlaying={isPlaying}
          speed={replaySpeed}
          onPlay={handlePlayReplay}
          onPause={handlePauseReplay}
          onStepForward={() => handleSeekReplay(replayCursor + 1)}
          onStepBackward={() => handleSeekReplay(replayCursor - 1)}
          onSeek={handleSeekReplay}
          onSpeedChange={(s) => setReplaySpeed(s)}
          onReset={() => handleSeekReplay(1)}
        />
      )}
    </div>
  );
}
