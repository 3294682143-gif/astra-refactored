import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertOctagon,
  BarChart3,
  CheckCircle2,
  FileSpreadsheet,
  FlaskConical,
  Layers,
  RefreshCw,
} from "lucide-react";
import {
  deleteProblemSet,
  fetchAblationRuns,
  fetchProblemSet,
  fetchProblemSets,
  fetchRuns,
  type AblationRunsQuery,
  type AblationRunsResponse,
  type ProblemSetDetail,
  type ProblemSetImportResponse,
  type ProblemSetSummary,
  type RunSummaryItem,
} from "@/api/client.ts";
import { normalizeStatusKind } from "@/components/StatusBadge.tsx";
import { MeasuredRunsSection, type RunTableSource } from "@/pages/batch/MeasuredRunsSection.tsx";
import { ProblemSetImportCard } from "@/pages/batch/ProblemSetImportCard.tsx";

export function BatchPage() {
  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [sourceMode, setSourceMode] = useState<RunTableSource>("eval200");
  const [evalData, setEvalData] = useState<AblationRunsResponse | null>(null);
  const [evalLoading, setEvalLoading] = useState(true);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalQuery, setEvalQuery] = useState<AblationRunsQuery>({
    limit: 50,
    offset: 0,
    sort: "config_problem",
    results_only: true,
    cap: 1000,
  });
  const evalReqSeqRef = useRef(0);

  const [importOpen, setImportOpen] = useState(false);
  const [problemSets, setProblemSets] = useState<readonly ProblemSetSummary[]>([]);
  const [problemSetsLoading, setProblemSetsLoading] = useState(false);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [selectedSetDetail, setSelectedSetDetail] = useState<ProblemSetDetail | null>(null);

  const loadBatchRuns = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    const res = await fetchRuns(200, 0);
    if (!res.ok) {
      setErrorMessage(res.error.message);
      setRuns([]);
      setLoading(false);
      return;
    }
    setRuns(res.data.items ?? []);
    setLoading(false);
  }, []);

  const loadEvalRuns = useCallback(async (query: AblationRunsQuery) => {
    const seq = ++evalReqSeqRef.current;
    setEvalLoading(true);
    setEvalError(null);
    const res = await fetchAblationRuns(query);
    if (seq !== evalReqSeqRef.current) return;
    if (!res.ok) {
      setEvalError(res.error.message);
      setEvalLoading(false);
      return;
    }
    setEvalData(res.data);
    setEvalLoading(false);
  }, []);

  const loadProblemSets = useCallback(async (preferSetId?: string) => {
    setProblemSetsLoading(true);
    const res = await fetchProblemSets();
    setProblemSetsLoading(false);
    if (!res.ok || !res.data.ok) return;
    const list = res.data.items ?? [];
    setProblemSets(list);
    const nextId =
      preferSetId && list.some((s) => s.set_id === preferSetId)
        ? preferSetId
        : selectedSetId && list.some((s) => s.set_id === selectedSetId)
          ? selectedSetId
          : list[0]?.set_id ?? null;
    setSelectedSetId(nextId);
  }, [selectedSetId]);

  useEffect(() => {
    void loadBatchRuns();
    void loadProblemSets();
  }, [loadBatchRuns, loadProblemSets]);

  useEffect(() => {
    void loadEvalRuns(evalQuery);
  }, [loadEvalRuns, evalQuery]);

  useEffect(() => {
    if (!selectedSetId) {
      setSelectedSetDetail(null);
      return;
    }
    let cancelled = false;
    void fetchProblemSet(selectedSetId).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data.ok) {
        setSelectedSetDetail(res.data.data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSetId]);

  const handleUpdateEvalQuery = useCallback((patch: Partial<AblationRunsQuery>) => {
    setEvalQuery((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleRefreshAll = useCallback(() => {
    void loadBatchRuns();
    void loadEvalRuns(evalQuery);
    void loadProblemSets();
  }, [loadBatchRuns, loadEvalRuns, loadProblemSets, evalQuery]);

  const handleImported = useCallback(
    (result: ProblemSetImportResponse) => {
      void loadBatchRuns();
      if (result.mode === "replays") {
        setSourceMode("local");
        return;
      }
      const newSetId = result.problem_set?.set_id;
      void loadProblemSets(newSetId);
      if (result.problem_set) {
        setSelectedSetId(result.problem_set.set_id);
        setSelectedSetDetail(result.problem_set);
      }
      setSourceMode(result.mode === "enqueue" ? "local" : "problem_sets");
    },
    [loadBatchRuns, loadProblemSets],
  );

  const handleDeleteProblemSet = useCallback(
    async (setId: string) => {
      const res = await deleteProblemSet(setId);
      if (res.ok) {
        setSelectedSetId((prev) => (prev === setId ? null : prev));
        setSelectedSetDetail((prev) => (prev?.set_id === setId ? null : prev));
        void loadProblemSets();
      }
    },
    [loadProblemSets],
  );

  const localStats = useMemo(() => {
    let candidateOrSolved = 0;
    let activeCount = 0;
    let failedCount = 0;

    for (const run of runs) {
      const kind = normalizeStatusKind(run.status);
      if (kind === "candidate" || kind === "solved" || kind === "finished") {
        candidateOrSolved += 1;
      } else if (kind === "running" || kind === "idle") {
        activeCount += 1;
      } else if (
        kind === "failed" ||
        kind === "error" ||
        kind === "timeout" ||
        kind === "aborted" ||
        kind === "cancelled"
      ) {
        failedCount += 1;
      }
    }

    return {
      total: runs.length,
      candidateOrSolved,
      activeCount,
      failedCount,
    };
  }, [runs]);

  const showingEvalKpi = sourceMode === "eval200" && evalData?.available;
  const evalStats = evalData?.stats_all;
  const kpiLoading = sourceMode === "eval200" ? evalLoading && !evalData : loading;

  const kpiCards =
    showingEvalKpi && evalStats
      ? [
          {
            label: "有候选结果样本总计",
            value: kpiLoading ? "—" : evalStats.total,
            hint: `已过滤未解与异常 · 共 ${Math.max(1, Math.ceil(evalStats.total / 50))} 页`,
            icon: Layers,
            color: "#3b82f6",
          },
          {
            label: "交付候选 (candidate)",
            value: kpiLoading ? "—" : evalStats.candidate,
            hint: "有效候选输出总数（不等于形式化通过）",
            icon: FlaskConical,
            color: "#f59e0b",
          },
          {
            label: "人工复核按题全对",
            value: kpiLoading ? "—" : evalStats.delivered_correct_count,
            hint: `共 ${evalStats.total} 次有结果样本（${((evalStats.delivered_correct_count / Math.max(1, evalStats.total)) * 100).toFixed(1)}%）`,
            icon: CheckCircle2,
            color: "#16a34a",
          },
          {
            label: "L2 完整轨迹条目",
            value: kpiLoading ? "—" : evalStats.l2_count,
            hint: `全部 ${evalStats.total} 条均含真实 .trace.json 事件流`,
            icon: Activity,
            color: "#38bdf8",
          },
        ]
      : [
          {
            label: "样本运行总计",
            value: loading ? "—" : localStats.total,
            hint: "来自 GET /api/runs?limit=200",
            icon: Layers,
            color: "#3b82f6",
          },
          {
            label: "候选 / 引擎自报收口",
            value: loading ? "—" : localStats.candidateOrSolved,
            hint: "不等于形式化证明通过",
            icon: FlaskConical,
            color: "#f59e0b",
          },
          {
            label: "进行中 / 待运行",
            value: loading ? "—" : localStats.activeCount,
            hint: "当前观测到的非终态条目",
            icon: Activity,
            color: "#38bdf8",
          },
          {
            label: "失败 / 超时 / 取消",
            value: loading ? "—" : localStats.failedCount,
            hint: "如实计入失败分母",
            icon: AlertOctagon,
            color: "#ef4444",
          },
        ];

  return (
    <div className="zygos-page-container" style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-brand-mid)",
              marginBottom: "6px",
            }}
          >
            <BarChart3 size={13} />
            <span>BATCH EVALUATION · 批量可信总览</span>
          </div>
          <h1
            className="zygos-keynote-title"
            style={{
              margin: 0,
              fontSize: "28px",
              fontWeight: 800,
              letterSpacing: "-0.025em",
            }}
          >
            批量评测与运行汇总
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: "13.5px", color: "var(--color-ink-soft)" }}>
            严格依据真实落盘单题运行日志统计分布，支持导入自定义 JSONL 题目集或历史 SolveResult 归档。
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            aria-expanded={importOpen}
            className="zygos-btn-ghost"
            style={{ padding: "8px 14px", fontSize: "12.5px" }}
          >
            <FileSpreadsheet size={14} />
            <span>导入 JSONL 题目集</span>
          </button>

          <button
            type="button"
            onClick={handleRefreshAll}
            disabled={loading || evalLoading}
            className="zygos-btn-primary"
            style={{ padding: "8px 14px", fontSize: "12.5px" }}
          >
            <RefreshCw size={14} className={loading || evalLoading ? "spin" : undefined} />
            <span>刷新统计</span>
          </button>
        </div>
      </div>

      {/* 4 KPI Stat Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "14px",
        }}
      >
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="zygos-bento"
              style={{
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink-soft)" }}>
                  {card.label}
                </span>
                <span
                  style={{
                    width: "30px",
                    height: "30px",
                    borderRadius: "9px",
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={15} color={card.color} />
                </span>
              </div>
              <div
                className="zygos-tabular"
                style={{
                  fontSize: "30px",
                  fontWeight: 800,
                  color: "var(--color-brand-deep)",
                  letterSpacing: "-0.03em",
                  lineHeight: 1.1,
                }}
              >
                {card.value}
              </div>
              <div style={{ fontSize: "11.5px", color: "var(--color-ink-mute)" }}>{card.hint}</div>
            </div>
          );
        })}
      </div>

      {/* JSONL Problem Set / Replay Archive Import Panel */}
      {importOpen ? (
        <ProblemSetImportCard
          onClose={() => setImportOpen(false)}
          onImported={handleImported}
        />
      ) : null}

      {/* Measured 1200 Single-Problem Run Logs, Imported Problem Sets & Local Runs Table */}
      <MeasuredRunsSection
        sourceMode={sourceMode}
        onChangeSourceMode={setSourceMode}
        localRuns={runs}
        localLoading={loading}
        localError={errorMessage}
        onRetryLocal={() => void loadBatchRuns()}
        evalData={evalData}
        evalLoading={evalLoading}
        evalError={evalError}
        evalQuery={evalQuery}
        onUpdateEvalQuery={handleUpdateEvalQuery}
        onRetryEval={() => void loadEvalRuns(evalQuery)}
        problemSets={problemSets}
        problemSetsLoading={problemSetsLoading}
        selectedSetId={selectedSetId}
        selectedSetDetail={selectedSetDetail}
        onSelectProblemSet={setSelectedSetId}
        onDeleteProblemSet={(id) => void handleDeleteProblemSet(id)}
        onOpenImport={() => setImportOpen(true)}
      />
    </div>
  );
}
