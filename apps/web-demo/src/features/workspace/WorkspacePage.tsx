import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router";
import { ChevronDown, GitBranch } from "lucide-react";
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
import {
  UnstartedView,
  findArchivedRunForProblem,
  type StartResearchOptions,
} from "./components/UnstartedView";
import { MacroFlowCanvas } from "./components/MacroFlowCanvas";
import { MultiAgentSynergyStage } from "./components/MultiAgentSynergyStage";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import { ResultDeliveryCard } from "./result/ResultDeliveryCard";
import { AnswerPresentationPage } from "./result/AnswerPresentationPage";
import { ReplayControlBar } from "./components/ReplayControlBar";
import { RecoveryBanner } from "./components/RecoveryBanner";
import {
  deriveThreeInnovationsMetrics,
  type InnovationId,
} from "./components/innovations/innovationSpecs";
import { InnovationOverviewPipeline } from "./components/innovations/InnovationOverviewPipeline";
import { ThreeInnovationsAccordion } from "./components/innovations/ThreeInnovationsAccordion";

export function WorkspacePage() {
  const { runId } = useParams<{ runId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const isReplayRoute = location.pathname.endsWith("/replay");
  const isAnswerRoute = location.pathname.endsWith("/answer");
  const autoplayRequested = useMemo(
    () => new URLSearchParams(location.search).get("autoplay") === "1",
    [location.search],
  );
  const unfoldRequested = useMemo(
    () =>
      !isReplayRoute &&
      !isAnswerRoute &&
      (new URLSearchParams(location.search).get("unfold") === "1" ||
        Boolean((location.state as { unfold?: unknown } | null)?.unfold)),
    [isReplayRoute, isAnswerRoute, location.search, location.state],
  );
  const requestedProblem = useMemo(
    () => new URLSearchParams(location.search).get("problem") ?? "",
    [location.search],
  );
  const requestedReplaySpeed = useMemo(() => {
    const raw = Number(new URLSearchParams(location.search).get("speed"));
    return raw === 1 || raw === 2 || raw === 4 || raw === 6 || raw === 8
      ? raw
      : 6;
  }, [location.search]);

  // 本地归约与视图状态
  const [, setRunState] = useState(() =>
    createInitialRunViewState(runId || ""),
  );
  const [problemText, setProblemText] = useState("");
  const [viewModel, setViewModel] = useState<ResearchViewModel>(() =>
    projectRunToResearchView(createInitialRunViewState(runId || ""), ""),
  );

  const [completedView, setCompletedView] = useState<"answer" | "process">(() =>
    isAnswerRoute ? "answer" : "process",
  );
  const userPickedViewRef = useRef(false);
  const [expandedInnovations, setExpandedInnovations] = useState<Set<InnovationId>>(
    () => new Set(),
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
  const [unfoldIntervalMs, setUnfoldIntervalMs] = useState<number | null>(null);

  const sseRef = useRef<EventSource | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const autoAnswerTimerRef = useRef<number | null>(null);
  const authoritativeWorkspaceRef = useRef<ResearchViewModel | null>(null);
  const replayCursorRef = useRef(0);

  const handleChangeCompletedView = useCallback(
    (nextView: "answer" | "process") => {
      userPickedViewRef.current = true;
      setCompletedView(nextView);
      if (nextView === "answer") {
        setSelectedNodeId(null);
      }
      if (isAnswerRoute && nextView === "process" && runId) {
        navigate(`/runs/${encodeURIComponent(runId)}`);
      }
    },
    [isAnswerRoute, navigate, runId],
  );

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
    if (autoAnswerTimerRef.current) {
      clearTimeout(autoAnswerTimerRef.current);
      autoAnswerTimerRef.current = null;
    }
    setIsPlaying(false);
    setUnfoldIntervalMs(null);
    setSelectedNodeId(null);
    setErrorNotice(null);
    setExpandedInnovations(new Set());
    userPickedViewRef.current = false;
    setCompletedView(isAnswerRoute ? "answer" : "process");

    if (!runId) {
      // /solve 新建模式（支持从 /batch 导入题集带入 ?problem= 预填）
      const init = createInitialRunViewState("");
      setRunState(init);
      setProblemText(requestedProblem);
      const initialVm = projectRunToResearchView(init, requestedProblem);
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
        setProblemText(wsRes.data.problem);
        if (!unfoldRequested) {
          setViewModel(wsRes.data);
        }
        // 自动演进回放 / 快速展开时默认收起右侧抽屉以保留完整拓扑画布视角；手动点击任意节点仍可随时展开证据
        if (
          wsRes.data.nodes.length > 0 &&
          ((isReplayRoute && !autoplayRequested) || (!unfoldRequested && wsRes.data.mode !== "completed"))
        ) {
          setSelectedNodeId(wsRes.data.nodes[0].id);
        } else {
          setSelectedNodeId(null);
        }
      }

      // 拉取详细回放帧备用
      const replayRes = await fetchReplay(runId!);
      if (!isCancelled && replayRes.ok && replayRes.data.events) {
        const evs = replayRes.data.events;
        const resolvedProblem =
          (replayRes.data.details?.problem as string) ||
          authoritativeWorkspaceRef.current?.problem ||
          problemText;
        setAllReplayEvents(evs);

        const shouldStepFromStart =
          ((isReplayRoute && autoplayRequested) || unfoldRequested) && evs.length > 0;
        const initialCount = shouldStepFromStart ? 1 : evs.length;
        replayCursorRef.current = initialCount;
        setReplayCursor(initialCount);

        let cur = createInitialRunViewState(runId!);
        for (let i = 0; i < initialCount; i++) {
          cur = reduceRun(cur, evs[i]);
        }
        setRunState(cur);

        if (isReplayRoute || (unfoldRequested && evs.length > 1)) {
          const projected = projectRunToResearchView(cur, resolvedProblem, {
            serverBaseline: authoritativeWorkspaceRef.current || undefined,
            isReplay: true,
          });
          setViewModel(projected);
          if (isReplayRoute && autoplayRequested && evs.length > 1) {
            setReplaySpeed(requestedReplaySpeed);
            setIsPlaying(true);
          } else if (unfoldRequested && evs.length > 1) {
            const targetMs = Math.max(
              95,
              Math.min(240, Math.round(9600 / Math.max(1, evs.length - 1))),
            );
            setUnfoldIntervalMs(targetMs);
            setIsPlaying(true);
          }
        } else if (unfoldRequested && authoritativeWorkspaceRef.current) {
          setViewModel(authoritativeWorkspaceRef.current);
          setCompletedView("answer");
        }
      } else if (!isCancelled && unfoldRequested && authoritativeWorkspaceRef.current) {
        setViewModel(authoritativeWorkspaceRef.current);
        setCompletedView("answer");
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
      if (autoAnswerTimerRef.current) {
        clearTimeout(autoAnswerTimerRef.current);
        autoAnswerTimerRef.current = null;
      }
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [runId, isReplayRoute, isAnswerRoute, autoplayRequested, unfoldRequested, requestedReplaySpeed, requestedProblem]);

  // 2. 实时 SSE 连接管理 (监听具名事件、保证去重与终态收口)
  const connectSSE = useCallback((rid: string) => {
    if (sseRef.current) {
      sseRef.current.close();
    }

    const es = new EventSource(`/api/runs/${encodeURIComponent(rid)}/events`);
    sseRef.current = es;

    const KNOWN_EVENT_KINDS = [
      "SESSION_INIT",
      "R0_REVIEW",
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

      // 终态重刷服务端权威工作台快照，停留在三大创新点主舞台下方直接滑出最终结果卡
      void fetchWorkspace(rid).then((res) => {
        if (res.ok && res.data) {
          authoritativeWorkspaceRef.current = res.data;
          setViewModel(res.data);
          if (res.data.mode === "completed" && !userPickedViewRef.current) {
            setCompletedView(isAnswerRoute ? "answer" : "process");
            setSelectedNodeId(null);
          }
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
            if (!userPickedViewRef.current) {
              setCompletedView(isAnswerRoute ? "answer" : "process");
              setSelectedNodeId(null);
            }
          }
        }
      });
    };
  }, [problemText, isAnswerRoute]);

  // 3. 提交新研究 (Spec R3)
  const handleStartResearch = async (
    problem: string,
    options: StartResearchOptions,
  ) => {
    const matchedArchivedRunId = findArchivedRunForProblem(problem);
    if (matchedArchivedRunId) {
      navigate(`/runs/${encodeURIComponent(matchedArchivedRunId)}`, {
        state: { unfold: true },
      });
      return;
    }

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
      problem_seconds: options.problem_seconds,
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
      replayCursorRef.current = clamped;
      setReplayCursor(clamped);

      const resolvedProblem =
        problemText || authoritativeWorkspaceRef.current?.problem || "";

      // 从第一帧重新归约到当前帧
      let cur = createInitialRunViewState(runId || "");
      for (let i = 0; i < clamped; i++) {
        cur = reduceRun(cur, allReplayEvents[i]);
      }
      setRunState(cur);
      const projected = projectRunToResearchView(cur, resolvedProblem, {
        serverBaseline: authoritativeWorkspaceRef.current || undefined,
        isReplay: true,
      });
      setViewModel(projected);
    },
    [allReplayEvents, runId, problemText],
  );

  const handlePlayReplay = () => {
    userPickedViewRef.current = false;
    setCompletedView("process");
    if (replayCursorRef.current >= allReplayEvents.length) {
      handleSeekReplay(1);
    }
    setIsPlaying(true);
  };

  const handlePauseReplay = () => {
    setIsPlaying(false);
  };

  useEffect(() => {
    if (isPlaying) {
      const intervalMs =
        !isReplayRoute && unfoldIntervalMs !== null
          ? unfoldIntervalMs
          : Math.max(80, Math.floor(800 / replaySpeed));
      playTimerRef.current = window.setInterval(() => {
        const curSeq = replayCursorRef.current;
        const finishToAnswer = () => {
          setIsPlaying(false);
          if (!isReplayRoute && !userPickedViewRef.current) {
            if (unfoldIntervalMs !== null) {
              autoAnswerTimerRef.current = window.setTimeout(() => {
                if (authoritativeWorkspaceRef.current) {
                  setViewModel(authoritativeWorkspaceRef.current);
                }
                setUnfoldIntervalMs(null);
                setCompletedView("process");
                setSelectedNodeId(null);
              }, 450);
            } else {
              setCompletedView("process");
              setSelectedNodeId(null);
            }
          }
        };
        if (curSeq >= allReplayEvents.length) {
          finishToAnswer();
          return;
        }
        const next = curSeq + 1;
        handleSeekReplay(next);
        if (next >= allReplayEvents.length) {
          finishToAnswer();
        }
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
  }, [
    isPlaying,
    isReplayRoute,
    replaySpeed,
    unfoldIntervalMs,
    allReplayEvents.length,
    handleSeekReplay,
  ]);

  const showDedicatedAnswerPage =
    viewModel.mode === "completed" && (isAnswerRoute || completedView === "answer");

  const threeMetrics = useMemo(
    () =>
      deriveThreeInnovationsMetrics(
        viewModel,
        replayCursor > 0 ? replayCursor : allReplayEvents.length,
      ),
    [viewModel, replayCursor, allReplayEvents.length],
  );

  const handleToggleInnovationExpand = useCallback((id: InnovationId) => {
    setExpandedInnovations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        window.setTimeout(() => {
          document
            .getElementById(`innovation-accordion-${id}`)
            ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 80);
      }
      return next;
    });
  }, []);

  // 当前选中的节点与证据（含抽屉上下步进索引）
  const activeNodeIndex = selectedNodeId
    ? viewModel.nodes.findIndex((n) => n.id === selectedNodeId)
    : -1;
  const activeNode: ResearchNode | null =
    !showDedicatedAnswerPage && activeNodeIndex >= 0
      ? viewModel.nodes[activeNodeIndex]
      : null;
  const activeEvidence: ResearchEvidence | null =
    activeNode?.evidenceId ? viewModel.evidences[activeNode.evidenceId] || null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%", width: "100%" }}>
      {/* 顶栏 */}
      <WorkspaceHeader
        viewModel={viewModel}
        isReplay={isReplayRoute}
        isFastUnfold={unfoldIntervalMs !== null}
        completedView={completedView}
        onChangeCompletedView={handleChangeCompletedView}
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
          className="zygos-glass"
          style={{
            backgroundColor: "var(--color-state-error-bg)",
            borderBottom: "1px solid var(--color-state-error-border)",
            borderTop: "none",
            borderLeft: "none",
            borderRight: "none",
            borderRadius: 0,
            padding: "10px 24px",
            fontSize: "13px",
            color: "var(--color-state-error)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{errorNotice}</span>
          <button
            type="button"
            onClick={() => setErrorNotice(null)}
            style={{
              border: "none",
              background: "none",
              color: "var(--color-state-error)",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: "16px",
              lineHeight: 1,
            }}
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
          ) : showDedicatedAnswerPage ? (
            /* 独立最终答案呈现页（全部流程完成后进入，无四阶段细节干扰，纯文本/直接数字呈现） */
            <AnswerPresentationPage
              viewModel={viewModel}
              isReplay={isReplayRoute}
              onShowProcess={() => handleChangeCompletedView("process")}
            />
          ) : (
            /* 状态 2 & 3：三大核心创新点动态总览 + 直接结果呈现 + 可折叠三创新细则 */
            <>
              {/* 恢复提示横幅（仅在实时非回放态且具备有效检查点时展示） */}
              {!isReplayRoute && viewModel.recovery.eligible && (
                <RecoveryBanner
                  recovery={viewModel.recovery}
                  isResuming={isResuming}
                  onResume={handleResumeResearch}
                />
              )}

              {/* 总览重心：题目输入 -> 只展示三大总创新点动态流水线 -> 得出结果 */}
              <InnovationOverviewPipeline
                viewModel={viewModel}
                metrics={threeMetrics}
                expandedIds={expandedInnovations}
                onToggleExpand={handleToggleInnovationExpand}
              />

              {/* 结果输出：推演收敛后直接在三大创新点下方呈现高对比度候选结果卡 */}
              {viewModel.mode === "completed" ? (
                <ResultDeliveryCard
                  viewModel={viewModel}
                  onOpenAnswerPage={() => handleChangeCompletedView("answer")}
                />
              ) : (
                <div
                  className="zygos-glass"
                  style={{
                    borderRadius: "16px",
                    padding: "14px 18px",
                    border: "1px dashed var(--color-brand-ring)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
                    <span
                      className="zygos-live-dot"
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        backgroundColor: "var(--color-brand)",
                      }}
                    />
                    <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
                      三大创新机制正在协同推演与校验，收敛完成后将在此直接呈现最终候选结论……
                    </span>
                  </div>
                  <span style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>
                    已观测事件 {threeMetrics.eventCount} 帧 · 严格保持 candidateVerified = false
                  </span>
                </div>
              )}

              {/* 默认折叠：三大核心创新点底层机制拆解（每点横向 3 块源码可视化动图） */}
              <ThreeInnovationsAccordion
                metrics={threeMetrics}
                expandedIds={expandedInnovations}
                onToggleExpand={handleToggleInnovationExpand}
                onExpandAll={() =>
                  setExpandedInnovations(new Set(["inn1", "inn2", "inn3"]))
                }
                onCollapseAll={() => setExpandedInnovations(new Set())}
                isLive={viewModel.mode === "running" || isPlaying}
              />

              {/* 底层细节按需折叠：原四阶段节点流程图与全量因果事件审计 */}
              <details
                className="zygos-glass zygos-disclosure"
                style={{
                  borderRadius: "18px",
                  border: "1px solid var(--color-line)",
                  overflow: "hidden",
                }}
              >
                <summary
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 18px",
                    cursor: "pointer",
                    listStyle: "none",
                    userSelect: "none",
                  }}
                >
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                    <GitBranch size={15} color="var(--color-brand-mid)" />
                    <span style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--color-ink)" }}>
                      底层运行机理拓扑与节点证据明细（按需审计展开）
                    </span>
                    <span style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>
                      · 含完整 M1 DAG / R0 / 5+2+1 / 四阶段因果流 ({viewModel.nodes.length} 节点)
                    </span>
                  </div>
                  <ChevronDown size={16} className="zygos-chevron" color="var(--color-ink-mute)" />
                </summary>

                <div
                  style={{
                    padding: "0 16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "18px",
                  }}
                >
                  <MultiAgentSynergyStage
                    viewModel={viewModel}
                    r0Reading={viewModel.r0Reading}
                    multiAgentSolving={viewModel.multiAgentSolving}
                    activeStage={viewModel.currentStage}
                    isRunning={viewModel.mode === "running"}
                    problemText={viewModel.problem}
                    onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
                  />

                  <MacroFlowCanvas
                    viewModel={viewModel}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
                    compact={viewModel.mode === "completed"}
                  />
                </div>
              </details>
            </>
          )}
        </div>

        {/* 右侧节点详情与证据抽屉 */}
        {activeNode && (
          <EvidenceDrawer
            node={activeNode}
            evidence={activeEvidence}
            onClose={() => setSelectedNodeId(null)}
            nodeIndex={activeNodeIndex}
            totalNodes={viewModel.nodes.length}
            onPrevNode={
              activeNodeIndex > 0
                ? () => setSelectedNodeId(viewModel.nodes[activeNodeIndex - 1].id)
                : undefined
            }
            onNextNode={
              activeNodeIndex >= 0 && activeNodeIndex < viewModel.nodes.length - 1
                ? () => setSelectedNodeId(viewModel.nodes[activeNodeIndex + 1].id)
                : undefined
            }
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
          events={allReplayEvents}
        />
      )}
    </div>
  );
}
