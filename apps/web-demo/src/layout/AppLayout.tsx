import { NavLink, Outlet } from "react-router";
import {
  Activity,
  Boxes,
  FlaskConical,
  Home,
  Layers,
  MessageSquareText,
  Orbit,
  Settings,
  Sparkles,
  Waypoints,
} from "lucide-react";

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Sparkles;
  readonly end?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/home", label: "门户", icon: Home, end: true },
  { to: "/solve", label: "求解工作台", icon: Sparkles, end: true },
  { to: "/chat", label: "产品对话", icon: MessageSquareText, end: true },
  { to: "/runs", label: "运行详情", icon: Activity },
  { to: "/batch", label: "批量评测", icon: Layers },
  { to: "/protocol", label: "协议观测", icon: Waypoints },
  { to: "/domains", label: "领域场景", icon: FlaskConical, end: true },
  { to: "/assets", label: "能力资产", icon: Boxes, end: true },
  { to: "/settings", label: "系统设置", icon: Settings, end: true },
];

export function AppLayout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", backgroundColor: "var(--color-surface-muted)", color: "var(--color-ink)" }}>
      {/* 侧栏 */}
      <aside
        aria-label="主导航"
        style={{
          position: "sticky",
          top: 0,
          display: "flex",
          height: "100vh",
          width: "240px",
          flexShrink: 0,
          flexDirection: "column",
          borderRight: "1px solid var(--color-line)",
          backgroundColor: "var(--color-brand-deep)",
        }}
      >
        {/* 品牌区 */}
        <div style={{ display: "flex", height: "64px", alignItems: "center", gap: "10px", borderBottom: "1px solid rgba(255,255,255,0.1)", padding: "0 20px" }}>
          <span style={{ display: "flex", width: "32px", height: "32px", alignItems: "center", justifyItems: "center", justifyContent: "center", borderRadius: "8px", backgroundColor: "rgba(255,255,255,0.12)", color: "#ffffff" }}>
            <Orbit size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#ffffff", letterSpacing: "0.5px" }}>
              Zygos · 天轭
            </div>
            <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap" }}>
              AI4S 科学智能体运行时
            </div>
          </div>
        </div>

        {/* 导航菜单 */}
        <nav style={{ flex: 1, padding: "16px 12px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" }}>
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              style={({ isActive }) => ({
                display: "flex",
                alignItems: "center",
                gap: "12px",
                borderRadius: "8px",
                padding: "9px 14px",
                fontSize: "14px",
                fontWeight: 500,
                textDecoration: "none",
                backgroundColor: isActive ? "rgba(255,255,255,0.15)" : "transparent",
                color: isActive ? "#ffffff" : "rgba(255,255,255,0.65)",
                transition: "all 0.15s ease",
              })}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* 赛事元数据标注 */}
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", padding: "14px 18px", fontSize: "11px", color: "rgba(255,255,255,0.45)", lineHeight: 1.5 }}>
          <div>兴智杯 · Track160</div>
          <div>AI4S 科学智能体 · 可复制推广</div>
        </div>
      </aside>

      {/* 主工作区 */}
      <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}>
        {/* 全局顶栏 */}
        <header
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            display: "flex",
            height: "64px",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--color-line)",
            backgroundColor: "rgba(255, 255, 255, 0.9)",
            backdropFilter: "blur(8px)",
            padding: "0 28px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-brand-deep)" }}>
              可观测控制台
            </span>
            <span style={{ fontSize: "12px", color: "var(--color-ink-mute)", borderLeft: "1px solid var(--color-line)", paddingLeft: "12px" }}>
              基于书生 Intern 大模型的 AI4S 科学智能体
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                borderRadius: "9999px",
                border: "1px solid var(--color-line)",
                backgroundColor: "var(--color-surface-muted)",
                padding: "4px 12px",
                fontSize: "12px",
                color: "var(--color-ink-soft)",
              }}
            >
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--color-brand)" }} />
              引擎状态: 未探测（以后端 /api/capabilities 声明为准）
            </span>
          </div>
        </header>

        {/* 主内容路由视口 */}
        <main style={{ flex: 1, padding: "28px", maxWidth: "1440px", width: "100%", margin: "0 auto" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
