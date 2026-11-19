import { useState, useEffect, useMemo } from "react";
import { NavLink, Link, Outlet, useLocation, useParams } from "react-router";
import {
  Orbit,
  Search,
  Plus,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Settings,
  Boxes,
  Layers,
  Activity,
  Sun,
  Moon,
  Maximize2,
  Minimize2,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { fetchRuns, type RunSummaryItem } from "../api/client";
import { toPlainAnswerText } from "../domain/research/plainAnswer";

const SIDEBAR_EXPANDED = 264;
const SIDEBAR_COLLAPSED = 64;

type ThemeMode = "dark" | "light";

export function AppLayout() {
  const location = useLocation();
  const { runId } = useParams<{ runId?: string }>();

  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showTools, setShowTools] = useState(true);
  const [stageMode, setStageMode] = useState(false);

  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem("zygos.theme");
      return saved === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("zygos.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });

  const [hiddenRunIds, setHiddenRunIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("zygos.sidebar.hiddenRunIds");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "zygos.sidebar.hiddenRunIds",
        JSON.stringify(hiddenRunIds),
      );
    } catch {
      /* ignore */
    }
  }, [hiddenRunIds]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("zygos.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("zygos.sidebar.collapsed", collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stageMode) {
        setStageMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stageMode]);

  useEffect(() => {
    let isCancelled = false;
    fetchRuns(40, 0).then((res) => {
      if (!isCancelled && res.ok && res.data.items) {
        setRuns(res.data.items);
      }
    });
    return () => {
      isCancelled = true;
    };
  }, [location.pathname]);

  // 判断当前路由是否为全幅工作区（/solve、/runs/:id、/runs/:id/answer、/runs/:id/replay）
  const isWorkspaceRoute =
    location.pathname === "/solve" ||
    location.pathname === "/" ||
    /^\/runs\/[^/]+(\/(replay|answer))?$/.test(location.pathname);

  const hiddenSet = useMemo(() => new Set(hiddenRunIds), [hiddenRunIds]);

  const hideRun = (targetId: string) => {
    setHiddenRunIds((prev) =>
      prev.includes(targetId) ? prev : [...prev, targetId],
    );
  };

  const restoreHiddenRuns = () => {
    setHiddenRunIds([]);
  };

  // 过滤历史运行（保留磁盘真实档案，支持前端隐藏以整理演示视图）
  const visibleBaseRuns = runs.filter((r) => !hiddenSet.has(r.run_id));
  const brokenVisibleRunIds = visibleBaseRuns
    .filter(
      (r) =>
        r.status === "error" || r.status === "failed" || r.status === "unsolved",
    )
    .map((r) => r.run_id);

  const hideBrokenRuns = () => {
    if (brokenVisibleRunIds.length === 0) return;
    setHiddenRunIds((prev) =>
      Array.from(new Set([...prev, ...brokenVisibleRunIds])),
    );
  };

  const filteredRuns = visibleBaseRuns.filter((r) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const scenario = (r.scenario || "").toLowerCase();
    const id = r.run_id.toLowerCase();
    return scenario.includes(q) || id.includes(q);
  });

  // 按今天与更早分组
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const todayRuns = filteredRuns.filter((r) => (r.created_at ? r.created_at * 1000 > oneDayAgo : false));
  const earlierRuns = filteredRuns.filter((r) => (r.created_at ? r.created_at * 1000 <= oneDayAgo : true));

  const renderStatusDot = (status: string) => {
    const colorMap: Record<string, string> = {
      candidate: "#38bdf8",
      running: "#fbbf24",
      unsolved: "#94a3b8",
      error: "#f87171",
      failed: "#f87171",
    };
    const titleMap: Record<string, string> = {
      candidate: "候选已收口",
      running: "执行中",
      unsolved: "未解收口",
      error: "异常",
      failed: "异常",
    };
    const bg = colorMap[status] || "#64748b";
    return (
      <span
        style={{
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          backgroundColor: bg,
          flexShrink: 0,
          boxShadow: status === "running" || status === "candidate" ? `0 0 8px ${bg}` : "none",
        }}
        title={titleMap[status] || status}
      />
    );
  };

  const renderRunLink = (r: RunSummaryItem) => {
    const isActive = runId === r.run_id;
    const tagMap: Record<string, { text: string; color: string; bg: string }> = {
      candidate: { text: "完成", color: "var(--color-state-success)", bg: "var(--color-state-success-bg)" },
      running: { text: "运行中", color: "var(--color-state-candidate)", bg: "var(--color-state-candidate-bg)" },
      unsolved: { text: "未解", color: "var(--color-ink-mute)", bg: "var(--color-surface-sunken)" },
      error: { text: "中断", color: "var(--color-state-error)", bg: "var(--color-state-error-bg)" },
      failed: { text: "异常", color: "var(--color-state-error)", bg: "var(--color-state-error-bg)" },
    };
    const tag = tagMap[r.status];
    return (
      <div
        key={r.run_id}
        className="zygos-nav-link"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2px",
          borderRadius: "9px",
          paddingRight: "4px",
          backgroundColor: isActive ? "var(--color-brand-tint)" : "transparent",
          border: isActive ? "1px solid var(--color-brand-ring)" : "1px solid transparent",
        }}
      >
        <Link
          to={`/runs/${r.run_id}`}
          title={`${r.run_id} · ${r.scenario || r.run_id}`}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 6px 8px 10px",
            fontSize: "12px",
            textDecoration: "none",
            color: isActive ? "var(--color-brand-deep)" : "var(--color-ink-soft)",
            fontWeight: isActive ? 600 : 400,
          }}
        >
          {renderStatusDot(r.status)}
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {(r.scenario && toPlainAnswerText(r.scenario, { singleLine: true })) || r.run_id}
          </span>
          {tag && (
            <span
              style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: "999px",
                color: tag.color,
                backgroundColor: tag.bg,
                flexShrink: 0,
              }}
            >
              {tag.text}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={() => hideRun(r.run_id)}
          aria-label={`移除历史记录 ${r.run_id}`}
          title="从左侧列表移除（仅前端视图隐藏，不删除磁盘归档）"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "22px",
            height: "22px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: "transparent",
            color: "var(--color-ink-mute)",
            cursor: "pointer",
            flexShrink: 0,
            opacity: 0.7,
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  };

  const navItems = [
    { to: "/runs", label: "运行记录索引", icon: Activity, end: true },
    { to: "/batch", label: "批量评测", icon: Layers, end: false },
    { to: "/assets", label: "全局资产目录", icon: Boxes, end: false },
    { to: "/settings", label: "系统配置", icon: Settings, end: false },
  ] as const;

  const railBtnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "40px",
    height: "40px",
    margin: "2px auto",
    borderRadius: "11px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "var(--color-ink-soft)",
    cursor: "pointer",
    textDecoration: "none",
    transition: "all 0.18s ease",
  };

  return (
    <div className="zygos-stage-shell">
      {/* 极光环境底图与数学网格 */}
      <div className="zygos-aurora-backdrop" />
      <div className="zygos-math-grid-overlay" />

      {/* 演示全屏模式退出胶囊 */}
      {stageMode && (
        <button
          type="button"
          onClick={() => setStageMode(false)}
          title="退出演示全屏 (Esc)"
          className="zygos-glass"
          style={{
            position: "fixed",
            left: "16px",
            bottom: "16px",
            zIndex: 60,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 14px",
            borderRadius: "9999px",
            color: "var(--color-brand-deep)",
            fontSize: "12px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Minimize2 size={14} />
          <span>退出舞台演示 (Esc)</span>
        </button>
      )}

      {/* 左侧 macOS/iPadOS 悬浮磨砂导航侧栏 */}
      {!stageMode && (
        <aside
          aria-label="研究会话与历史导航"
          className="zygos-glass"
          style={{
            position: "sticky",
            top: "12px",
            margin: "12px 0 12px 12px",
            display: "flex",
            height: "calc(100vh - 24px)",
            width: `${collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED}px`,
            flexShrink: 0,
            flexDirection: "column",
            borderRadius: "18px",
            zIndex: 30,
            transition: "width 0.32s var(--ease-spring)",
            overflow: "hidden",
          }}
        >
          {collapsed ? (
            /* ——— 收纳态：完整功能图标 Rail ——— */
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", height: "100%", paddingBottom: "10px" }}>
              <div
                style={{
                  display: "flex",
                  height: "58px",
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "center",
                  borderBottom: "1px solid var(--color-line)",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    width: "34px",
                    height: "34px",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "10px",
                    background: "linear-gradient(135deg, #2563eb 0%, #0f265c 100%)",
                    color: "#ffffff",
                    boxShadow: "0 4px 12px rgba(37,99,235,0.4)",
                  }}
                >
                  <Orbit size={18} />
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "10px 0", width: "100%" }}>
                <button
                  type="button"
                  onClick={() => setCollapsed(false)}
                  title="展开导航侧栏"
                  className="zygos-nav-link"
                  style={railBtnStyle}
                >
                  <ChevronRight size={18} />
                </button>

                <Link
                  to="/solve"
                  title="新建求解研究"
                  className="zygos-btn-primary"
                  style={{
                    width: "40px",
                    height: "40px",
                    margin: "4px auto",
                    borderRadius: "11px",
                    padding: 0,
                    textDecoration: "none",
                  }}
                >
                  <Plus size={18} />
                </Link>
              </div>

              <div style={{ width: "28px", height: "1px", backgroundColor: "var(--color-line)", margin: "6px 0" }} />

              <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, width: "100%", paddingTop: "4px" }}>
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      title={item.label}
                      className="zygos-nav-link"
                      style={({ isActive }) => ({
                        ...railBtnStyle,
                        backgroundColor: isActive ? "var(--color-brand-tint)" : "transparent",
                        borderColor: isActive ? "var(--color-brand-ring)" : "transparent",
                        color: isActive ? "var(--color-brand-deep)" : "var(--color-ink-soft)",
                      })}
                    >
                      <Icon size={17} />
                    </NavLink>
                  );
                })}
              </div>

              {/* 底部主题与演示开关 */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%" }}>
                <button
                  type="button"
                  onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                  title={theme === "dark" ? "切换学术昼光主题" : "切换深空舞台主题"}
                  className="zygos-nav-link"
                  style={railBtnStyle}
                >
                  {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                </button>
                <button
                  type="button"
                  onClick={() => setStageMode(true)}
                  title="开启发布会全屏演示模式"
                  className="zygos-nav-link"
                  style={railBtnStyle}
                >
                  <Maximize2 size={16} />
                </button>
              </div>
            </div>
          ) : (
            /* ——— 展开态：完整悬浮侧栏 ——— */
            <>
              {/* 品牌区 */}
              <div
                style={{
                  display: "flex",
                  height: "60px",
                  alignItems: "center",
                  gap: "10px",
                  borderBottom: "1px solid var(--color-line)",
                  padding: "0 12px 0 16px",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    width: "34px",
                    height: "34px",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "10px",
                    background: "linear-gradient(135deg, #2563eb 0%, #0f265c 100%)",
                    color: "#ffffff",
                    boxShadow: "0 4px 12px rgba(37,99,235,0.4)",
                    flexShrink: 0,
                  }}
                >
                  <Orbit size={18} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)", letterSpacing: "0.2px" }}>
                    Zygos · 天轭
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--color-ink-mute)", whiteSpace: "nowrap" }}>
                    面向 Intern-S1 的可信数学推理
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  title="向左收纳"
                  className="zygos-btn-ghost"
                  style={{
                    padding: "5px 8px",
                    borderRadius: "8px",
                    fontSize: "11px",
                    flexShrink: 0,
                  }}
                >
                  <ChevronLeft size={14} />
                  <span>收起</span>
                </button>
              </div>

              {/* 新建求解按钮 + 搜索框 */}
              <div style={{ padding: "14px 14px 10px 14px" }}>
                <Link
                  to="/solve"
                  className="zygos-btn-primary"
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: "10px",
                    fontSize: "13px",
                    textDecoration: "none",
                  }}
                >
                  <Plus size={16} />
                  <span>新建求解研究</span>
                </Link>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "7px",
                    marginTop: "10px",
                    padding: "7px 11px",
                    borderRadius: "9px",
                    backgroundColor: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-line)",
                  }}
                >
                  <Search size={13} color="var(--color-ink-mute)" />
                  <input
                    type="text"
                    placeholder="搜索研究题目或 Run ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      border: "none",
                      background: "transparent",
                      outline: "none",
                      fontSize: "12px",
                      width: "100%",
                      color: "var(--color-ink)",
                    }}
                  />
                </div>
              </div>

              {/* 历史研究列表 */}
              <div style={{ flex: 1, padding: "4px 10px 10px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {(brokenVisibleRunIds.length > 0 || hiddenRunIds.length > 0) && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "6px",
                      padding: "4px 6px 2px",
                      flexWrap: "wrap",
                    }}
                  >
                    {brokenVisibleRunIds.length > 0 && (
                      <button
                        type="button"
                        onClick={hideBrokenRuns}
                        title="一键隐藏状态为中断/未解/异常的左侧条目（不删除磁盘归档）"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "3px 8px",
                          borderRadius: "7px",
                          border: "1px solid var(--color-line)",
                          backgroundColor: "var(--color-surface-sunken)",
                          color: "var(--color-ink-soft)",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        <Trash2 size={11} />
                        <span>清理异常 ({brokenVisibleRunIds.length})</span>
                      </button>
                    )}
                    {hiddenRunIds.length > 0 && (
                      <button
                        type="button"
                        onClick={restoreHiddenRuns}
                        title="恢复此前从左侧列表隐藏的历史记录"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "3px 8px",
                          borderRadius: "7px",
                          border: "1px solid var(--color-brand-ring)",
                          backgroundColor: "var(--color-brand-tint)",
                          color: "var(--color-brand-deep)",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: "pointer",
                          marginLeft: "auto",
                        }}
                      >
                        <RotateCcw size={11} />
                        <span>恢复 ({hiddenRunIds.length})</span>
                      </button>
                    )}
                  </div>
                )}
                {todayRuns.length > 0 && (
                  <div>
                    <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-ink-mute)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "4px 8px" }}>
                      今天
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>{todayRuns.map(renderRunLink)}</div>
                  </div>
                )}
                {earlierRuns.length > 0 && (
                  <div>
                    <div style={{ fontSize: "10px", fontWeight: 700, color: "var(--color-ink-mute)", letterSpacing: "0.06em", textTransform: "uppercase", padding: "4px 8px" }}>
                      更早研究
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>{earlierRuns.map(renderRunLink)}</div>
                  </div>
                )}
                {filteredRuns.length === 0 && (
                  <div style={{ padding: "18px 8px", fontSize: "12px", color: "var(--color-ink-mute)", textAlign: "center", display: "flex", flexDirection: "column", gap: "8px", alignItems: "center" }}>
                    <span>暂无匹配研究记录</span>
                    {hiddenRunIds.length > 0 && (
                      <button
                        type="button"
                        onClick={restoreHiddenRuns}
                        className="zygos-btn-ghost"
                        style={{ padding: "4px 10px", fontSize: "11px" }}
                      >
                        <RotateCcw size={11} />
                        <span>恢复已移除的 {hiddenRunIds.length} 条记录</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* 底部：导航工具 + 主题/演示控制 */}
              <div style={{ borderTop: "1px solid var(--color-line)", backgroundColor: "var(--color-surface-sunken)" }}>
                <button
                  type="button"
                  onClick={() => setShowTools(!showTools)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "10px 14px",
                    border: "none",
                    backgroundColor: "transparent",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "var(--color-ink-soft)",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <Settings size={14} />
                    工具与工程控制台
                  </span>
                  {showTools ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>

                {showTools && (
                  <div style={{ padding: "0 10px 10px 10px", display: "flex", flexDirection: "column", gap: "2px" }}>
                    {navItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.end}
                          className="zygos-nav-link"
                          style={({ isActive }) => ({
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "7px 10px",
                            borderRadius: "8px",
                            fontSize: "12px",
                            textDecoration: "none",
                            backgroundColor: isActive ? "var(--color-brand-tint)" : "transparent",
                            border: isActive ? "1px solid var(--color-brand-ring)" : "1px solid transparent",
                            color: isActive ? "var(--color-brand-deep)" : "var(--color-ink-soft)",
                            fontWeight: isActive ? 600 : 400,
                          })}
                        >
                          <Icon size={14} />
                          <span>{item.label}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                )}

                {/* 主题与舞台模式快捷开关 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", padding: "8px 10px", borderTop: "1px solid var(--color-line)" }}>
                  <button
                    type="button"
                    onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                    className="zygos-btn-ghost"
                    style={{ padding: "6px 8px", fontSize: "11px", borderRadius: "8px" }}
                  >
                    {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
                    <span>{theme === "dark" ? "昼光" : "黑曜"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setStageMode(true)}
                    className="zygos-btn-ghost"
                    style={{ padding: "6px 8px", fontSize: "11px", borderRadius: "8px" }}
                  >
                    <Maximize2 size={13} />
                    <span>演示全屏</span>
                  </button>
                </div>

                <div style={{ padding: "8px 14px 10px", fontSize: "10px", color: "var(--color-ink-mute)", borderTop: "1px solid var(--color-line)", lineHeight: 1.45 }}>
                  <div>挑战杯 · 书生赛道 XH-202627</div>
                  <div>可信过程 · 资产复用 · 评委版</div>
                </div>
              </div>
            </>
          )}
        </aside>
      )}

      {/* 主工作区 */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          zIndex: 1,
        }}
      >
        {isWorkspaceRoute ? (
          <Outlet />
        ) : (
          <div className="zygos-page-container">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  );
}
