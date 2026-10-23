# D-02 交付：apps/web-demo 工程骨架 / 设计系统 / 构建

以下为完整可落地源码，目录结构：

```
apps/web-demo/
├── index.html
├── package.json
├── tsconfig.json            # DOM/Bundler —— 独立、不继承根 Node 配置
├── tsconfig.node.json       # 仅覆盖 vite.config.ts 的 Node 侧
├── vite.config.ts
└── src/
    ├── main.tsx
    ├── router.tsx
    ├── index.css            # Tailwind v4 tokens（方向 B）
    ├── layout/AppLayout.tsx
    ├── components/
    │   ├── StatusBadge.tsx
    │   ├── ResultCard.tsx
    │   ├── DataSourceBadge.tsx
    │   ├── PanelEmptyState.tsx
    │   └── ErrorBoundary.tsx
    └── pages/
        ├── SolvePage.tsx
        ├── RunsPage.tsx
        ├── RunDetailPage.tsx
        ├── RunReplayPage.tsx
        ├── BatchPage.tsx
        ├── AssetsPage.tsx
        ├── SettingsPage.tsx
        └── NotFoundPage.tsx
```

---

## 1. `apps/web-demo/package.json`

```json
{
  "name": "@astra/web-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@astra/web-contract": "workspace:*",
    "clsx": "^2.1.1",
    "lucide-react": "^0.469.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.1.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/node": "^22.10.2",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^2.1.8"
  },
  "engines": {
    "node": ">=20.11.0"
  }
}
```

要点：
- `react` / `react-dom` 锁 19，`react-router` 走 7 系列（`react-router` 包本体已含 `createBrowserRouter` / `NavLink` / `RouterProvider`，**无需** `react-router-dom`）。
- `@astra/web-contract` 用 `workspace:*`，被 monorepo 解析，**不通过 npm registry**。
- 构建工具为 Vite（SPA），构建产物 `dist/`。
- `test` 独立于 workspace 根，避免污染其它包。

---

## 2. `apps/web-demo/vite.config.ts`

```ts
/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // 独立 SPA，不挂载到任何根路径之外的 base
  base: '/',

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: false,
    host: '127.0.0.1',
  },

  preview: {
    port: 4173,
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },

  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
```

---

## 3. `apps/web-demo/tsconfig.json`（DOM/Bundler，独立）

```jsonc
{
  "compilerOptions": {
    /* —— 目标环境：浏览器 + ESNext 打包器 —— */
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "types": ["vite/client"],

    /* —— 严格性 —— */
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,

    /* —— 输出：仅做类型检查，产物交给 Vite —— */
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,

    /* —— 路径别名，与 vite.config.ts 对齐 —— */
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
```

> 关键约束：`tsconfig.json` **不** `extends` 根目录任何 Node 配置，`lib` 里没有 `NodeJS.*`，`types` 只挂 `vite/client`。因此不会把 Node 全局类型泄漏到前端工程，也不会在全局 `tsc -b` 时污染其它包。

---

## 4. `apps/web-demo/tsconfig.node.json`（隔离 `vite.config.ts`）

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["vite.config.ts"]
}
```

---

## 5. `apps/web-demo/index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#0F265C" />
    <meta
      name="description"
      content="Zygos · astra —— 求解观测工作台（演示）"
    />
    <title>Zygos · astra</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

## 6. `apps/web-demo/src/index.css`（Tailwind v4 · 方向 B tokens）

```css
@import "tailwindcss";

/* ============================================================
 * 设计系统 Token —— 方向 B
 * 书生先锋蓝 #1152B6  +  天轭深蓝 #0F265C
 * ============================================================ */
@theme {
  /* —— 品牌主色 —— */
  --color-brand:            #1152B6; /* 书生先锋蓝 */
  --color-brand-mid:        #3C74CC; /* 过渡蓝 */
  --color-brand-deep:       #0F265C; /* 天轭深蓝 */
  --color-brand-tint:       #E9F0FA; /* 浅底 */
  --color-brand-ring:       #C9DAF1; /* 描边 */
  --color-brand-ink:        #0B1B42; /* 深墨（正文强调） */

  /* —— 中性面 —— */
  --color-surface:          #FFFFFF;
  --color-surface-muted:    #F6F8FB;
  --color-surface-sunken:   #EEF2F8;

  /* —— 描边 / 分隔 —— */
  --color-line:             #E2E8F2;
  --color-line-strong:      #CBD6E6;

  /* —— 文本层级 —— */
  --color-ink:              #0F1B2D;
  --color-ink-soft:         #47566E;
  --color-ink-mute:         #7B8AA1;

  /* —— 语义状态 —— */
  --color-state-candidate:     #B45309;
  --color-state-candidate-bg:  #FEF3C7;
  --color-state-unsolved:      #475569;
  --color-state-unsolved-bg:   #E2E8F0;
  --color-state-error:         #B91C1C;
  --color-state-error-bg:      #FEE2E2;
  --color-state-stale:         #6B7280;
  --color-state-stale-bg:      #F3F4F6;

  /* —— 字体 —— */
  --font-sans:
    "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono:
    "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;

  /* —— 圆角 —— */
  --radius-card: 0.875rem;
}

@layer base {
  html,
  body,
  #root {
    height: 100%;
  }

  body {
    margin: 0;
    background-color: var(--color-surface-muted);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-feature-settings: "cv02", "cv03", "cv04", "cv11";
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  :focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
    border-radius: 4px;
  }

  ::selection {
    background-color: var(--color-brand-tint);
    color: var(--color-brand-deep);
  }
}

@layer utilities {
  /* 供 AppLayout / 卡片复用的品牌渐变条 */
  .astra-brand-rule {
    background-image: linear-gradient(
      90deg,
      var(--color-brand) 0%,
      var(--color-brand-deep) 100%
    );
  }
}
```

---

## 7. `apps/web-demo/src/main.tsx`

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { router } from './router';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  // 骨架期快速失败，避免静默白屏
  throw new Error('[web-demo] #root 挂载点不存在，请检查 index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
```

---

## 8. `apps/web-demo/src/components/StatusBadge.tsx`

```tsx
import clsx from 'clsx';
import { AlertOctagon, CircleHelp, FlaskConical, History } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** 与契约层对齐的状态枚举（前端表现态） */
export type StatusKind = 'candidate' | 'unsolved' | 'error' | 'stale';

interface StatusConfig {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tone: string;
  readonly dot: string;
}

const REGISTRY: Record<StatusKind, StatusConfig> = {
  candidate: {
    label: '候选',
    icon: FlaskConical,
    tone: 'bg-state-candidate-bg text-state-candidate ring-state-candidate/25',
    dot: 'bg-state-candidate',
  },
  unsolved: {
    label: '未解',
    icon: CircleHelp,
    tone: 'bg-state-unsolved-bg text-state-unsolved ring-state-unsolved/25',
    dot: 'bg-state-unsolved',
  },
  error: {
    label: '错误',
    icon: AlertOctagon,
    tone: 'bg-state-error-bg text-state-error ring-state-error/25',
    dot: 'bg-state-error',
  },
  stale: {
    label: '陈旧',
    icon: History,
    tone: 'bg-state-stale-bg text-state-stale ring-state-stale/25',
    dot: 'bg-state-stale',
  },
};

export interface StatusBadgeProps {
  status: StatusKind;
  /** 覆盖默认中文文案（如「候选中」「已过期」） */
  label?: string;
  size?: 'sm' | 'md';
  /** 是否显示前置圆点（默认 true） */
  showDot?: boolean;
  className?: string;
}

export function StatusBadge({
  status,
  label,
  size = 'md',
  showDot = true,
  className,
}: StatusBadgeProps) {
  const cfg = REGISTRY[status];
  const Icon = cfg.icon;
  const text = label ?? cfg.label;

  return (
    <span
      role="status"
      aria-label={`状态：${text}`}
      data-status={status}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset',
        'whitespace-nowrap select-none transition-colors',
        size === 'sm' ? 'px-2 py-0.5 text-[11px] leading-4' : 'px-2.5 py-1 text-xs leading-5',
        cfg.tone,
        className,
      )}
    >
      {showDot ? (
        <span
          aria-hidden
          className={clsx(
            'rounded-full',
            size === 'sm' ? 'size-1.5' : 'size-2',
            cfg.dot,
          )}
        />
      ) : (
        <Icon
          aria-hidden
          className={size === 'sm' ? 'size-3' : 'size-3.5'}
          strokeWidth={2.25}
        />
      )}
      <span>{text}</span>
    </span>
  );
}

/** 供图例 / 筛选器复用 */
export const STATUS_KINDS: readonly StatusKind[] = [
  'candidate',
  'unsolved',
  'error',
  'stale',
] as const;
```

---

## 9. `apps/web-demo/src/components/DataSourceBadge.tsx`

```tsx
import clsx from 'clsx';
import { Database, History, ScanSearch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type DataSourceLevel = 'L1' | 'L2' | 'L3';

interface SourceConfig {
  readonly level: DataSourceLevel;
  readonly name: string;
  readonly caption: string;
  readonly icon: LucideIcon;
  readonly tone: string;
}

const REGISTRY: Record<DataSourceLevel, SourceConfig> = {
  L1: {
    level: 'L1',
    name: '摘要',
    caption: '压缩摘要层：仅保留用于快速浏览的关键字段',
    icon: Database,
    tone: 'bg-surface-sunken text-ink-soft ring-line-strong',
  },
  L2: {
    level: 'L2',
    name: '历史',
    caption: '历史轨迹层：包含多次观测与时间序列',
    icon: History,
    tone: 'bg-brand-tint text-brand-deep ring-brand-ring',
  },
  L3: {
    level: 'L3',
    name: '完整观察',
    caption: '完整观察层：保留原始证据与全部字段',
    icon: ScanSearch,
    tone: 'bg-brand-deep/10 text-brand-deep ring-brand-deep/25',
  },
};

export interface DataSourceBadgeProps {
  level: DataSourceLevel;
  /** 显示右侧描述文案（默认 false） */
  withCaption?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function DataSourceBadge({
  level,
  withCaption = false,
  size = 'md',
  className,
}: DataSourceBadgeProps) {
  const cfg = REGISTRY[level];
  const Icon = cfg.icon;

  return (
    <span
      className={clsx('inline-flex items-center gap-1.5', className)}
      title={cfg.caption}
      data-source-level={level}
    >
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-md font-medium ring-1 ring-inset',
          size === 'sm' ? 'px-1.5 py-0.5 text-[11px] leading-4' : 'px-2 py-1 text-xs leading-5',
          cfg.tone,
        )}
      >
        <Icon aria-hidden className={size === 'sm' ? 'size-3' : 'size-3.5'} strokeWidth={2} />
        <span>
          {cfg.level} · {cfg.name}
        </span>
      </span>

      {withCaption && (
        <span className="text-xs text-ink-mute">{cfg.caption}</span>
      )}
    </span>
  );
}

/** 供图例使用 */
export const DATA_SOURCE_LEVELS: readonly DataSourceLevel[] = ['L1', 'L2', 'L3'] as const;

export function dataSourceCaption(level: DataSourceLevel): string {
  return REGISTRY[level].caption;
}
```

---

## 10. `apps/web-demo/src/components/ResultCard.tsx`

> 契约约束：**严禁**出现「已验证 / 正确 / 已确认 / 结论成立」类表述。
> 仅允许「候选」「未解」「待评估 / 待复核」「观测记录」措辞。

```tsx
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Clock3, Info, TriangleAlert } from 'lucide-react';

import { StatusBadge, type StatusKind } from './StatusBadge';
import { DataSourceBadge, type DataSourceLevel } from './DataSourceBadge';

export interface ResultCardProps {
  /** 卡片标题（问题 / 任务标识） */
  title: string;
  /** 当前表现态：仅 candidate / unsolved / error / stale 四种 */
  status: StatusKind;
  /** 数据来源层级 */
  source: DataSourceLevel;
  /** 候选答案正文 —— 仅在 status === 'candidate' 且存在时渲染 */
  answer?: string;
  /** 未解说明 —— status === 'unsolved' 时渲染 */
  unsolvedReason?: string;
  /** 错误摘要 —— status === 'error' 时渲染 */
  errorMessage?: string;
  /** 附加备注（任意状态） */
  note?: string;
  /** 更新时间（ISO 或已格式化字符串） */
  updatedAt?: string;
  /** 右上角操作区 */
  actions?: ReactNode;
  /** 底部额外内容 */
  footer?: ReactNode;
  className?: string;
}

export function ResultCard({
  title,
  status,
  source,
  answer,
  unsolvedReason,
  errorMessage,
  note,
  updatedAt,
  actions,
  footer,
  className,
}: ResultCardProps) {
  const showAnswer = status === 'candidate' && Boolean(answer?.trim());
  const showUnsolved = status === 'unsolved';
  const showError = status === 'error';

  return (
    <article
      data-result-card
      data-status={status}
      className={clsx(
        'group relative flex flex-col overflow-hidden rounded-[var(--radius-card)]',
        'border border-line bg-surface shadow-[0_1px_2px_rgba(15,38,92,0.04)]',
        'transition-shadow hover:shadow-[0_4px_16px_rgba(15,38,92,0.08)]',
        className,
      )}
    >
      {/* 顶部 2px 品牌渐变条 */}
      <span aria-hidden className="astra-brand-rule absolute inset-x-0 top-0 h-0.5" />

      <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0 flex-1 space-y-2">
          <h3
            className="truncate text-[15px] leading-6 font-semibold text-ink"
            title={title}
          >
            {title}
          </h3>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={status} size="sm" />
            <DataSourceBadge level={source} size="sm" />

            {updatedAt && (
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-mute">
                <Clock3 aria-hidden className="size-3" />
                <time>{updatedAt}</time>
              </span>
            )}
          </div>
        </div>

        {actions && <div className="shrink-0">{actions}</div>}
      </header>

      <div className="flex-1 space-y-3 px-5 pb-5">
        {showAnswer && (
          <section
            aria-label="候选答案"
            className="rounded-lg border border-brand-ring/70 bg-brand-tint/50 px-3.5 py-3"
          >
            <p className="mb-1 text-[11px] font-medium tracking-wide text-brand-deep/80">
              候选答案
            </p>
            <p className="text-sm leading-6 whitespace-pre-wrap text-ink">
              {answer}
            </p>
          </section>
        )}

        {showUnsolved && (
          <section
            aria-label="未解说明"
            className="flex gap-2.5 rounded-lg border border-line bg-surface-muted px-3.5 py-3"
          >
            <Info
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-state-unsolved"
              strokeWidth={2}
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-[11px] font-medium tracking-wide text-ink-soft">
                未解说明
              </p>
              <p className="text-sm leading-6 whitespace-pre-wrap text-ink-soft">
                {unsolvedReason?.trim() || '当前观测未能给出候选答案，需补充约束后重试。'}
              </p>
            </div>
          </section>
        )}

        {showError && (
          <section
            aria-label="错误信息"
            className="flex gap-2.5 rounded-lg border border-state-error/25 bg-state-error-bg px-3.5 py-3"
          >
            <TriangleAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-state-error"
              strokeWidth={2}
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-[11px] font-medium tracking-wide text-state-error">
                执行错误
              </p>
              <p className="font-mono text-xs leading-5 break-words text-state-error">
                {errorMessage?.trim() || '未知错误'}
              </p>
            </div>
          </section>
        )}

        {note?.trim() && (
          <p className="text-xs leading-5 text-ink-mute">{note}</p>
        )}
      </div>

      {footer && (
        <footer className="border-t border-line bg-surface-muted/60 px-5 py-3">
          {footer}
        </footer>
      )}
    </article>
  );
}
```

---

## 11. `apps/web-demo/src/components/PanelEmptyState.tsx`

```tsx
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { FileQuestion, Inbox } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type EmptyVariant = 'empty' | 'missing';

export interface PanelEmptyStateProps {
  /** 变体：empty = 暂无数据；missing = 目标缺失 / 未找到 */
  variant?: EmptyVariant;
  /** 自定义图标，缺省按 variant 选择 */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** 次级提示（灰色小字，如「可尝试切换数据层级」） */
  hint?: string;
  /** 操作区（按钮 / 链接） */
  action?: ReactNode;
  className?: string;
}

export function PanelEmptyState({
  variant = 'empty',
  icon,
  title,
  description,
  hint,
  action,
  className,
}: PanelEmptyStateProps) {
  const Icon = icon ?? (variant === 'missing' ? FileQuestion : Inbox);
  const isMissing = variant === 'missing';

  return (
    <div
      role="status"
      aria-live="polite"
      data-empty-variant={variant}
      className={clsx(
        'flex flex-col items-center justify-center rounded-[var(--radius-card)]',
        'border border-dashed px-6 py-14 text-center',
        isMissing
          ? 'border-state-candidate/35 bg-state-candidate-bg/40'
          : 'border-line-strong bg-surface/60',
        className,
      )}
    >
      <div
        className={clsx(
          'mb-4 flex size-12 items-center justify-center rounded-full ring-1 ring-inset',
          isMissing
            ? 'bg-state-candidate-bg text-state-candidate ring-state-candidate/25'
            : 'bg-brand-tint text-brand ring-brand-ring',
        )}
      >
        <Icon aria-hidden className="size-6" strokeWidth={1.75} />
      </div>

      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>

      {description?.trim() && (
        <p className="mt-2 max-w-md text-sm leading-6 text-ink-soft">
          {description}
        </p>
      )}

      {hint?.trim() && (
        <p className="mt-1.5 max-w-md text-xs leading-5 text-ink-mute">{hint}</p>
      )}

      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
```

---

## 12. `apps/web-demo/src/components/ErrorBoundary.tsx`

```tsx
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import clsx from 'clsx';
import { RefreshCw, ShieldAlert } from 'lucide-react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 局部标题，如「运行详情」「资产面板」 */
  scope?: string;
  /** 自定义渲染 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 上报钩子（本地日志 / telemetry） */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * 变更该值时自动清空错误态 —— 适合与路由参数 / 请求 id 绑定，
   * 避免切换页面后仍停留在旧错误界面。
   */
  resetKey?: unknown;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 局部隔离：控制台留痕，不抛出不吞整体
    // eslint-disable-next-line no-console
    console.error(`[web-demo][ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}]`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, fallback, scope, className } = this.props;

    if (error === null) return children;
    if (fallback) return fallback(error, this.reset);

    return (
      <div
        role="alert"
        data-error-boundary
        className={clsx(
          'flex flex-col items-center justify-center rounded-[var(--radius-card)]',
          'border border-state-error/25 bg-state-error-bg/50 px-6 py-12 text-center',
          className,
        )}
      >
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-state-error/10 text-state-error ring-1 ring-inset ring-state-error/25">
          <ShieldAlert aria-hidden className="size-6" strokeWidth={1.75} />
        </div>

        <h3 className="text-[15px] font-semibold text-ink">
          {scope ? `${scope}渲染失败` : '模块渲染失败'}
        </h3>

        <p className="mt-2 max-w-md text-sm leading-6 text-ink-soft">
          该错误已被局部隔离，页面其余区域不受影响。
        </p>

        <pre className="mt-3 max-w-full overflow-x-auto rounded-md bg-surface/80 px-3 py-2 font-mono text-xs leading-5 text-state-error">
          {error.message}
        </pre>

        <button
          type="button"
          onClick={this.reset}
          className={clsx(
            'mt-5 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium',
            'bg-brand text-white transition-colors hover:bg-brand-mid',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          )}
        >
          <RefreshCw aria-hidden className="size-4" strokeWidth={2} />
          重试
        </button>
      </div>
    );
  }
}
```

---

## 13. `apps/web-demo/src/layout/AppLayout.tsx`

```tsx
import { NavLink, Outlet } from 'react-router';
import clsx from 'clsx';
import {
  Activity,
  Boxes,
  Layers,
  Orbit,
  Settings,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** 精确匹配（用于根级条目，避免 /runs 命中 /runs/:id） */
  readonly end?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/solve',    label: '求解',   icon: Sparkles, end: true },
  { to: '/runs',     label: '运行',   icon: Activity, end: true },
  { to: '/batch',    label: '批量',   icon: Layers,   end: true },
  { to: '/assets',   label: '资产',   icon: Boxes,    end: true },
  { to: '/settings', label: '设置',   icon: Settings, end: true },
];

export function AppLayout() {
  return (
    <div className="flex min-h-screen bg-surface-muted text-ink">
      {/* ============ 侧栏 ============ */}
      <aside
        aria-label="主导航"
        className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-brand-deep"
      >
        {/* 品牌区 */}
        <div className="flex h-16 items-center gap-2.5 border-b border-white/10 px-5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-white/10 ring-1 ring-inset ring-white/15">
            <Orbit aria-hidden className="size-4.5 text-white" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-wide text-white">
              Zygos
            </p>
            <p className="truncate text-[11px] leading-4 text-white/55">
              astra 求解观测台
            </p>
          </div>
        </div>

        {/* 导航项 */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                  'transition-colors duration-150',
                  isActive
                    ? 'bg-white/12 text-white'
                    : 'text-white/60 hover:bg-white/8 hover:text-white/90',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    aria-hidden
                    className={clsx(
                      'size-4.5 shrink-0 transition-colors',
                      isActive ? 'text-white' : 'text-white/55 group-hover:text-white/85',
                    )}
                    strokeWidth={2}
                  />
                  <span className="truncate">{label}</span>
                  {isActive && (
                    <span aria-hidden className="ml-auto h-4 w-0.5 rounded-full bg-white/80" />
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* 底部署名 */}
        <div className="border-t border-white/10 px-5 py-3">
          <p className="font-mono text-[10px] leading-4 text-white/40">
            demo · 观测结果仅供评估参考
          </p>
        </div>
      </aside>

      {/* ============ 主区 ============ */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/85 px-6 backdrop-blur-sm">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-brand-deep">
              工作台
            </h1>
            <p className="truncate text-[11px] leading-4 text-ink-mute">
              求解 · 运行 · 批量 · 资产统一视图
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-[11px] text-ink-soft sm:inline-flex">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              契约已挂载
            </span>
          </div>
        </