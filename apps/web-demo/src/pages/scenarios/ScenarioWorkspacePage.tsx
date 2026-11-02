import { useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import {
  Play,
  BarChart3,
  Activity,
  Sparkles,
} from "lucide-react";

interface ScenarioManifest {
  readonly scenarioId: string;
  readonly version: string;
  readonly name: string;
  readonly domainType: string;
  readonly description: string;
  readonly goals: readonly string[];
  readonly requiredModelCapabilities: readonly string[];
  readonly requiresCodeIsolation: boolean;
}

interface ScenarioRole {
  readonly roleId: string;
  readonly name: string;
  readonly roleCategory: string;
  readonly ownedDimension: string;
  readonly description: string;
  readonly triggerCondition: string;
  readonly contextVisibility: string;
  readonly maxModelCallsPerTask: number;
}

interface ScenarioTeam {
  readonly teamId: string;
  readonly scenarioId: string;
  readonly roles: readonly ScenarioRole[];
  readonly defaultRoute: string;
  readonly maxRepairs: number;
}

interface ScenarioInputs {
  readonly inputKind: string;
  readonly supportedExtensions: readonly string[];
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly dataIsolationPolicy: string;
}

interface ScenarioResults {
  readonly primaryArtifactKind: string;
  readonly exportedFileNames: readonly string[];
  readonly requiredMetrics: readonly string[];
  readonly visualizerComponent: string;
}

interface ScenarioDetailResponse {
  readonly readinessStatus: "READY" | "NOT_READY";
  readonly readinessReasons: readonly string[];
  readonly manifest: ScenarioManifest;
  readonly inputs: ScenarioInputs;
  readonly team: ScenarioTeam;
  readonly results: ScenarioResults;
}

export function ScenarioWorkspacePage() {
  const { scenarioId = "math.research" } = useParams<{ scenarioId: string }>();

  // State is keyed on scenarioId to ensure isolation and zero cross-pollution
  const [detail, setDetail] = useState<ScenarioDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Input & execution states
  const [problemText, setProblemText] = useState("");
  const [literatureQuery, setLiteratureQuery] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [runResult, setRunResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"workspace" | "team" | "contract">("workspace");


  // Reset & load when scenarioId changes
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setRunResult(null);
    setProblemText("");
    setLiteratureQuery("");

    fetch(`/api/v2/scenarios/${encodeURIComponent(scenarioId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load scenario ${scenarioId}`);
        return res.json() as Promise<ScenarioDetailResponse>;
      })
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        // Default preset problem text based on domain
        if (scenarioId.includes("control")) {
          setProblemText("基于所挂载的受迫振子时序数据辨识质量、阻尼和刚度，并进行留出预测与残差审计");
          setSelectedAsset("benchmarks/control/oscillator_real_sample.csv");
        } else if (scenarioId.includes("heat") || scenarioId.includes("scientific_computing")) {
          setProblemText("数值求解一维导热方程边界条件收敛性与稳定性 (alpha=0.05, L=1.0)，验证CFL准则");
          setSelectedAsset("benchmarks/scientific_computing/heat_rod_experimental_sample.csv");
        } else if (scenarioId.includes("data_analysis")) {
          setProblemText("临床实验干预评分两组双样本 Welch t 检验与正态性诊断 (alpha=0.05, 检验统计量、p值与效应量)");
          setSelectedAsset("benchmarks/data_analysis/clinical_trial_sample.csv");
        } else {
          setProblemText("设 P(x) 为整系数多项式，满足对所有正整数 n 均有 P(n) 为完全平方数。证明 P(x) 是某整系数多项式的平方。");
          setSelectedAsset("");
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [scenarioId]);

  const handleFileUpload = async (file: File | null) => {
    if (!file) return;
    setIsUploading(true);
    setRunResult(null);
    try {
      if (file.size <= 0 || file.size > 25 * 1024 * 1024) {
        throw new Error("文件大小必须介于 1 字节与 25 MiB 之间");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      const res = await fetch("/api/v2/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentBase64: btoa(binary) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSelectedAsset(data.inputRef);
    } catch (err: any) {
      setRunResult({ status: "error", code: "UPLOAD_FAILED", error: err.message });
    } finally {
      setIsUploading(false);
    }
  };

  const handleExecute = async () => {
    if (!problemText.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setRunResult(null);

    try {
      const idempotencyKey = `scen-${scenarioId.replace(/[^a-zA-Z0-9]/g, "_")}-${Date.now()}`;
      const payload: Record<string, any> = {
        scenarioId,
        problem: problemText,
        idempotencyKey,
        inputRefs: selectedAsset ? [selectedAsset] : [],
        ...(literatureQuery.trim() ? { literatureQuery: literatureQuery.trim() } : {}),
      };

      const res = await fetch("/api/v2/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json_stringify(payload),
      });

      const data = await res.json();
      setRunResult(data);
    } catch (err: any) {
      setRunResult({ status: "error", code: "DISPATCH_FAILED", error: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExportArchive = async (format: "markdown" | "zip" | "json") => {
    try {
      const topicId = `topic_${scenarioId.replace(/[^a-zA-Z0-9]/g, "_")}`;
      await fetch("/api/v2/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicId,
          title: `${detail?.manifest.name || scenarioId} 课题归档`,
          scenarioId,
        }),
      });
      window.open(`/api/v2/topics/${encodeURIComponent(topicId)}/export?format=${format}`, "_blank");
    } catch (err: any) {
      alert(`导出课题失败: ${err.message}`);
    }
  };

  function json_stringify(obj: any): string {
    return JSON.stringify(obj, null, 2);
  }

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-ink-mute)" }}>
        正在动态装载科研场景 [{scenarioId}] 契约与运行时...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div style={{ padding: "30px", border: "1px solid #ff4d4f", borderRadius: "8px", background: "#fff1f0" }}>
        <h3>场景装载失败</h3>
        <p>{error}</p>
        <Link to="/domains" style={{ color: "#1677ff" }}>返回领域场景列表</Link>
      </div>
    );
  }

  const { manifest, team, inputs, results } = detail;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* 场景标头与导航 */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderRadius: "12px",
          border: "1px solid var(--color-line)",
          backgroundColor: "var(--color-surface)",
          padding: "20px 24px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: "4px",
                background: "var(--color-brand-deep)",
                color: "#ffffff",
              }}
            >
              {manifest.domainType.toUpperCase()}
            </span>
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: "var(--color-brand-deep)" }}>
              {manifest.name}
            </h1>
            <span style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>v{manifest.version}</span>
          </div>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-mute)", maxWidth: "800px" }}>
            {manifest.description}
          </p>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => setActiveTab("workspace")}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: activeTab === "workspace" ? "1px solid var(--color-brand)" : "1px solid var(--color-line)",
              background: activeTab === "workspace" ? "var(--color-brand-deep)" : "transparent",
              color: activeTab === "workspace" ? "#fff" : "inherit",
              cursor: "pointer",
            }}
          >
            科研工作区
          </button>
          <button
            onClick={() => setActiveTab("team")}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: activeTab === "team" ? "1px solid var(--color-brand)" : "1px solid var(--color-line)",
              background: activeTab === "team" ? "var(--color-brand-deep)" : "transparent",
              color: activeTab === "team" ? "#fff" : "inherit",
              cursor: "pointer",
            }}
          >
            智能体团队 ({team.roles.length})
          </button>
          <button
            onClick={() => setActiveTab("contract")}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: activeTab === "contract" ? "1px solid var(--color-brand)" : "1px solid var(--color-line)",
              background: activeTab === "contract" ? "var(--color-brand-deep)" : "transparent",
              color: activeTab === "contract" ? "#fff" : "inherit",
              cursor: "pointer",
            }}
          >
            审计契约
          </button>

          <button
            onClick={() => handleExportArchive("markdown")}
            title="导出 Markdown 课题研究报告"
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid var(--color-line)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            导出报告 (.md)
          </button>
          <button
            onClick={() => handleExportArchive("zip")}
            title="导出包含审计凭据的时间胶囊归档包"
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid var(--color-line)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            导出归档 (.zip)
          </button>
        </div>
      </header>

      {/* 主工作区视图 */}
      {activeTab === "workspace" && (
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: "20px" }}>
          {/* 左侧：输入与执行 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <section
              style={{
                borderRadius: "12px",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface)",
                padding: "20px",
              }}
            >
              <h2 style={{ fontSize: "15px", fontWeight: 600, margin: "0 0 12px", display: "flex", alignItems: "center", gap: "8px" }}>
                <Sparkles size={16} /> 课题输入与证据绑定 ({inputs.inputKind})
              </h2>

              <div style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "6px", color: "var(--color-ink-mute)" }}>
                  研究假设 / 课题陈述
                </label>
                <textarea
                  value={problemText}
                  onChange={(e) => setProblemText(e.target.value)}
                  rows={4}
                  style={{
                    width: "100%",
                    borderRadius: "8px",
                    border: "1px solid var(--color-line)",
                    padding: "10px",
                    fontSize: "13px",
                    boxSizing: "border-box",
                    fontFamily: "inherit",
                  }}
                  placeholder="请输入科学研究问题、初始边界条件或参数假设..."
                />
              </div>

              <div style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "6px", color: "var(--color-ink-mute)" }}>
                  文献检索式（可选；开放全文将进入研究证据链）
                </label>
                <input
                  type="text"
                  value={literatureQuery}
                  onChange={(event) => setLiteratureQuery(event.target.value)}
                  placeholder="例如: forced damped oscillator parameter identification"
                  style={{ width: "100%", borderRadius: "6px", border: "1px solid var(--color-line)", padding: "8px 10px", fontSize: "12px", boxSizing: "border-box" }}
                />
              </div>

              {inputs.supportedExtensions.length > 0 && (
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "6px", color: "var(--color-ink-mute)" }}>
                    上传或引用实验 / 基准数据 ({inputs.supportedExtensions.join(", ")})
                  </label>
                  <input
                    type="file"
                    accept={inputs.supportedExtensions.join(",")}
                    onChange={(event) => void handleFileUpload(event.target.files?.[0] ?? null)}
                    disabled={isUploading}
                    style={{ display: "block", marginBottom: "8px", fontSize: "12px" }}
                  />
                  <input
                    type="text"
                    value={selectedAsset}
                    onChange={(e) => setSelectedAsset(e.target.value)}
                    style={{
                      width: "100%",
                      borderRadius: "6px",
                      border: "1px solid var(--color-line)",
                      padding: "8px 10px",
                      fontSize: "12px",
                      boxSizing: "border-box",
                    }}
                    placeholder="例如: benchmarks/control/oscillator_real_sample.csv"
                  />
                  <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", marginTop: "4px" }}>
                    隔离策略: {inputs.dataIsolationPolicy} · 运行时状态: {detail.readinessStatus}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: "12px", color: "var(--color-ink-mute)" }}>
                    代码沙箱隔离: {manifest.requiresCodeIsolation
                      ? detail.readinessStatus === "READY" ? "隔离运行时就绪" : `未就绪 (${detail.readinessReasons.join(", ")})`
                      : "纯符号分析"}
                </div>
                <button
                  onClick={handleExecute}
                  disabled={isSubmitting || isUploading || !problemText.trim()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    backgroundColor: isSubmitting ? "#8c8c8c" : "var(--color-brand-deep)",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    padding: "8px 18px",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: isSubmitting ? "not-allowed" : "pointer",
                  }}
                >
                  <Play size={14} /> {isUploading ? "数据上传中..." : isSubmitting ? "多智能体协同推导中..." : "启动科研闭环"}
                </button>
              </div>
            </section>

            {/* 执行结果状态 */}
            {runResult && (
              <section
                style={{
                  borderRadius: "12px",
                  border: "1px solid var(--color-line)",
                  backgroundColor: "var(--color-surface)",
                  padding: "20px",
                }}
              >
                <h2 style={{ fontSize: "15px", fontWeight: 600, margin: "0 0 12px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <Activity size={16} /> 运行事实与诚实证据台账
                </h2>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "14px" }}>
                  <div style={{ padding: "8px 12px", background: "var(--color-surface-muted)", borderRadius: "6px", fontSize: "12px" }}>
                    <strong>Run ID:</strong> {runResult.runId || "N/A"}
                  </div>
                  <div style={{ padding: "8px 12px", background: "var(--color-surface-muted)", borderRadius: "6px", fontSize: "12px" }}>
                    <strong>状态:</strong> {runResult.status} ({runResult.code || runResult.stopReason || "NONE"})
                  </div>
                  <div style={{ padding: "8px 12px", background: "var(--color-surface-muted)", borderRadius: "6px", fontSize: "12px" }}>
                    <strong>候选已验证 (红线):</strong> {runResult.candidateVerified ? "TRUE" : "FALSE (未篡改)"}
                  </div>
                  <div style={{ padding: "8px 12px", background: "var(--color-surface-muted)", borderRadius: "6px", fontSize: "12px" }}>
                    <strong>已实际执行:</strong> {runResult.executed ? "YES" : "NO"}
                  </div>
                </div>

                {runResult.error && (
                  <div role="alert" style={{ marginBottom: "12px", color: "#cf1322", fontSize: "12px" }}>
                    {runResult.error}
                  </div>
                )}

                {runResult.final_response && (
                  <div>
                    <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "4px", color: "var(--color-ink-mute)" }}>
                      终态推导输出
                    </label>
                    <pre
                      style={{
                        padding: "10px",
                        borderRadius: "6px",
                        background: "#1e1e1e",
                        color: "#d4d4d4",
                        fontSize: "12px",
                        overflowX: "auto",
                        maxHeight: "220px",
                      }}
                    >
                      {typeof runResult.final_response === "string"
                        ? runResult.final_response
                        : JSON.stringify(runResult.final_response, null, 2)}
                    </pre>
                  </div>
                )}
              </section>
            )}
          </div>

          {/* 右侧：领域专用可视化组件 */}
          <div>
            <section
              style={{
                borderRadius: "12px",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface)",
                padding: "20px",
                minHeight: "450px",
              }}
            >
              <h2 style={{ fontSize: "15px", fontWeight: 600, margin: "0 0 16px", display: "flex", alignItems: "center", gap: "8px" }}>
                <BarChart3 size={16} /> 领域专用可视化: [{results.visualizerComponent}]
              </h2>

              {results.visualizerComponent === "MathDerivationView" && (
                <div style={{ padding: "16px", background: "var(--color-surface-muted)", borderRadius: "8px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "8px" }}>形式化符号推导与反例审计检验</div>
                  <p style={{ fontSize: "13px", color: "var(--color-ink-mute)" }}>
                    主推导链通过 Lean/Python 严格形式化审计，任何未闭合假设作为未决义务保留。
                  </p>
                  <div style={{ marginTop: "12px", padding: "10px", background: "#ffffff", borderRadius: "6px", border: "1px solid var(--color-line)", fontSize: "12px" }}>
                    <strong>待解义务:</strong> {results.requiredMetrics.join(", ")}
                  </div>
                </div>
              )}

              {results.visualizerComponent === "ControlDynamicsView" && (
                <div style={{ padding: "16px", background: "var(--color-surface-muted)", borderRadius: "8px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "8px" }}>相空间轨迹 (Phase Portrait) 与留出检验</div>
                  <div style={{ height: "180px", border: "1px dashed var(--color-line)", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                    [时序轨迹与相轨迹相位图: x(t) vs dx/dt 及真实样本对比]
                  </div>
                  <div style={{ marginTop: "12px", fontSize: "12px" }}>
                    <div><strong>考核指标:</strong> 辨识参数物理有效性 (m&gt;0, c&gt;0, k&gt;0)</div>
                    <div><strong>留出验证:</strong> 预测残差 RMSE &lt; 0.05</div>
                  </div>
                </div>
              )}

              {results.visualizerComponent === "ThermalSimulationView" && (
                <div style={{ padding: "16px", background: "var(--color-surface-muted)", borderRadius: "8px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "8px" }}>一维瞬态导热温度时空热力图与收敛阶</div>
                  <div style={{ height: "180px", border: "1px dashed var(--color-line)", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                    [时空温度分布热力图 T(x, t) · 网格收敛性对数曲线]
                  </div>
                  <div style={{ marginTop: "12px", fontSize: "12px" }}>
                    <div><strong>稳定性准则:</strong> CFL &lt;= 0.5 (实测 alpha * dt / dx^2)</div>
                    <div><strong>网格收敛阶:</strong> 空间二阶收敛 (observedOrder &gt;= 1.8)</div>
                  </div>
                </div>
              )}

              {results.visualizerComponent === "StatisticalAnalysisView" && (
                <div style={{ padding: "16px", background: "var(--color-surface-muted)", borderRadius: "8px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "8px" }}>统计推断森林图与置信区间 (Welch t-test)</div>
                  <div style={{ height: "180px", border: "1px dashed var(--color-line)", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa", fontSize: "12px", color: "var(--color-ink-mute)" }}>
                    [箱线图分布、双侧 95% 置信区间条与效应量 Cohen's d]
                  </div>
                  <div style={{ marginTop: "12px", fontSize: "12px" }}>
                    <div><strong>前提审计:</strong> Shapiro-Wilk 正态性检验与方差齐性诊断</div>
                    <div><strong>核心输出:</strong> t 统计量、自由度、精确 p 值与拒绝域判定</div>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* 智能体团队多角色视图 */}
      {activeTab === "team" && (
        <section
          style={{
            borderRadius: "12px",
            border: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface)",
            padding: "24px",
          }}
        >
          <div style={{ marginBottom: "16px" }}>
            <h2 style={{ fontSize: "17px", fontWeight: 600, margin: "0 0 6px" }}>
              场景专属多智能体协同团队 [{team.teamId}]
            </h2>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--color-ink-mute)" }}>
              默认路由调度: {team.defaultRoute} · 契约最大修复尝试: {team.maxRepairs} 次 · 团队角色独立拥有其评估维度
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
            {team.roles.map((role) => (
              <div
                key={role.roleId}
                style={{
                  borderRadius: "8px",
                  border: "1px solid var(--color-line)",
                  padding: "16px",
                  background: "var(--color-surface-muted)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--color-brand-deep)" }}>
                    {role.name}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      background: "#e6f4ff",
                      color: "#0958d9",
                    }}
                  >
                    {role.roleCategory}
                  </span>
                </div>
                <p style={{ fontSize: "12px", margin: "0 0 10px", color: "var(--color-ink)" }}>
                  {role.description}
                </p>
                <div style={{ fontSize: "11px", color: "var(--color-ink-mute)", lineHeight: "1.6" }}>
                  <div><strong>执掌维度:</strong> {role.ownedDimension}</div>
                  <div><strong>触发时机:</strong> {role.triggerCondition}</div>
                  <div><strong>上下文视野:</strong> {role.contextVisibility}</div>
                  <div><strong>模型调用上限:</strong> {role.maxModelCallsPerTask} 次/任务</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 契约细节视图 */}
      {activeTab === "contract" && (
        <section
          style={{
            borderRadius: "12px",
            border: "1px solid var(--color-line)",
            backgroundColor: "var(--color-surface)",
            padding: "24px",
          }}
        >
          <h2 style={{ fontSize: "17px", fontWeight: 600, margin: "0 0 12px" }}>
            场景不可变快照与证据契约规范
          </h2>
          <pre
            style={{
              padding: "16px",
              borderRadius: "8px",
              background: "#1e1e1e",
              color: "#d4d4d4",
              fontSize: "12px",
              overflowX: "auto",
            }}
          >
            {json_stringify(detail)}
          </pre>
        </section>
      )}
    </div>
  );
}
