import { useState, useEffect } from "react";
import { NavLink, Link, Outlet, useLocation, useParams } from "react-router";
import {
  Orbit,
  Search,
  Plus,
  ChevronDown,
  ChevronUp,
  Settings,
  Boxes,
  Layers,
  Activity,
} from "lucide-react";
import { fetchRuns, type RunSummaryItem } from "../api/client";

export function AppLayout() {
  const location = useLocation();
  const { runId } = useParams<{ runId?: string }>();

  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showTools, setShowTools] = useState(false);

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

  // 过滤历史运行
  const filteredRuns = runs.filter((r) => {
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
    switch (status) {
      case "candidate":
        return <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--color-brand)" }} title="候选已收口" />;
      case "running":
        return <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "#eab308" }} title="执行中" />;
      case "unsolved":
        return <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "#94a3b8" }} title="未解收口" />;
      case "error":
      case "failed":
        return <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "#dc2626" }} title="异常" />;
      default:
        return <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "#cbd5e1" }} />;
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", backgroundColor: "var(--color-surface-muted)", color: "var(--color-ink)" }}>
      {/* 左侧统一历史与会话侧栏 (方案 4.1 节规范) */}
      <aside
        aria-label="研究会话与历史导航"
        style={{
          position: "sticky",
          top: 0,
          display: "flex",
          height: "100vh",
          width: "250px",
          flexShrink: 0,
          flexDirection: "column",
          borderRight: "1px solid var(--color-line)",
          backgroundColor: "#ffffff",
          zIndex: 30,
        }}
      >
        {/* 品牌区 */}
        <div
          style={{
            display: "flex",
            height: "56px",
            alignItems: "center",
            gap: "10px",
            borderBottom: "1px solid var(--color-line)",
            padding: "0 18px",
          }}
        >
          <span
            style={{
              display: "flex",
              width: "30px",
              height: "30px",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "8px",
              backgroundColor: "var(--color-brand-deep)",
              color: "#ffffff",
            }}
          >
            <Orbit size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-brand-deep)", letterSpacing: "0.3px" }}>
              Zygos · 天轭
            </div>
            <div style={{ fontSize: "10px", color: "var(--color-ink-mute)", whiteSpace: "nowrap" }}>
              面向 Intern-S1 的数学推理
            </div>
          </div>
        </div>

        {/* 新建求解按钮 */}
        <div style={{ padding: "14px 14px 10px 14px" }}>
          <Link
            to="/solve"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              width: "100%",
              padding: "9px 14px",
              borderRadius: "8px",
              backgroundColor: "var(--color-brand)",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              textDecoration: "none",
              boxShadow: "0 2px 6px rgba(49, 94, 168, 0.2)",
              transition: "all 0.15s ease",
            }}
          >
            <Plus size={16} />
            新建求解研究
          </Link>

          {/* 搜索历史 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginTop: "10px",
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "var(--color-surface-muted)",
              border: "1px solid var(--color-line)",
            }}
          >
            <Search size={13} color="var(--color-ink-mute)" />
            <input
              type="text"
              placeholder="搜索研究题目..."
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
        <div
          style={{
            flex: 1,
            padding: "6px 10px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          {todayRuns.length > 0 && (
            <div>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-ink-mute)", padding: "4px 8px" }}>
                今天
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {todayRuns.map((r) => {
                  const isActive = runId === r.run_id;
                  return (
                    <Link
                      key={r.run_id}
                      to={`/runs/${r.run_id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        fontSize: "12px",
                        textDecoration: "none",
                        backgroundColor: isActive ? "var(--color-brand-tint)" : "transparent",
                        color: isActive ? "var(--color-brand)" : "var(--color-ink)",
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      {renderStatusDot(r.status)}
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.scenario || r.run_id}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {earlierRuns.length > 0 && (
            <div>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-ink-mute)", padding: "4px 8px" }}>
                更早研究
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {earlierRuns.map((r) => {
                  const isActive = runId === r.run_id;
                  return (
                    <Link
                      key={r.run_id}
                      to={`/runs/${r.run_id}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        fontSize: "12px",
                        textDecoration: "none",
                        backgroundColor: isActive ? "var(--color-brand-tint)" : "transparent",
                        color: isActive ? "var(--color-brand)" : "var(--color-ink)",
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      {renderStatusDot(r.status)}
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.scenario || r.run_id}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {filteredRuns.length === 0 && (
            <div style={{ padding: "16px 8px", fontSize: "12px", color: "var(--color-ink-mute)", textAlign: "center" }}>
              暂无匹配研究记录
            </div>
          )}
        </div>

        {/* 底部：工具与设置折叠区 (保留批量评测、能力资产、系统设置) */}
        <div style={{ borderTop: "1px solid var(--color-line)", backgroundColor: "#fcfdfe" }}>
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
              工具与工程设置
            </span>
            {showTools ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>

          {showTools && (
            <div style={{ padding: "4px 10px 10px 10px", display: "flex", flexDirection: "column", gap: "2px" }}>
              <NavLink
                to="/runs"
                end
                style={({ isActive }) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  textDecoration: "none",
                  backgroundColor: isActive ? "var(--color-surface-sunken)" : "transparent",
                  color: isActive ? "var(--color-brand)" : "var(--color-ink-soft)",
                })}
              >
                <Activity size={14} />
                <span>运行记录索引</span>
              </NavLink>

              <NavLink
                to="/batch"
                style={({ isActive }) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  textDecoration: "none",
                  backgroundColor: isActive ? "var(--color-surface-sunken)" : "transparent",
                  color: isActive ? "var(--color-brand)" : "var(--color-ink-soft)",
                })}
              >
                <Layers size={14} />
                <span>批量评测</span>
              </NavLink>

              <NavLink
                to="/assets"
                style={({ isActive }) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  textDecoration: "none",
                  backgroundColor: isActive ? "var(--color-surface-sunken)" : "transparent",
                  color: isActive ? "var(--color-brand)" : "var(--color-ink-soft)",
                })}
              >
                <Boxes size={14} />
                <span>全局资产目录</span>
              </NavLink>

              <NavLink
                to="/settings"
                style={({ isActive }) => ({
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  textDecoration: "none",
                  backgroundColor: isActive ? "var(--color-surface-sunken)" : "transparent",
                  color: isActive ? "var(--color-brand)" : "var(--color-ink-soft)",
                })}
              >
                <Settings size={14} />
                <span>系统配置</span>
              </NavLink>
            </div>
          )}

          <div
            style={{
              padding: "10px 14px",
              fontSize: "10px",
              color: "var(--color-ink-mute)",
              borderTop: "1px solid var(--color-line)",
              lineHeight: 1.4,
            }}
          >
            <div>挑战杯 · 书生赛道 XH-202627</div>
            <div>可信过程 · 资产复用 · 评委版</div>
          </div>
        </div>
      </aside>

      {/* 主工作区 */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Outlet />
      </main>
    </div>
  );
}
