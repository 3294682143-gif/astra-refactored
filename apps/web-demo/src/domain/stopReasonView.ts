/**
 * stopReason 文案视图。
 *
 * 复用 @astra/web-contract 的 STOP_REASON_MAP（项目既定契约），
 * 并对契约未预注册但真实存在的终止码补充本地说明，
 * 使 timeout / 启动失败 / cancelled 与 candidate 在文案上可区分。
 */

import { classifyStopReason } from "@astra/web-contract";
import type { StopReasonInfo } from "@astra/web-contract";

export interface StopReasonView {
  readonly code: string;
  readonly title: string;
  readonly categoryTitle: string;
  readonly description: string;
  /** 该终止码是否已在契约中预注册。 */
  readonly registered: boolean;
}

const LOCAL_OVERRIDES: Record<
  string,
  { title: string; categoryTitle: string; description: string }
> = {
  CANCELLED: {
    title: "求解被取消",
    categoryTitle: "取消",
    description: "运行在收口前被取消（客户端断连或宿主停止），不视为交付候选。",
  },
  ERROR: {
    title: "运行发生未分类错误",
    categoryTitle: "系统故障",
    description: "运行时报告了未细分的错误终止码。",
  },
  BUDGET_EXCEEDED: {
    title: "求解调用预算已超限",
    categoryTitle: "预算 / 时限",
    description: "模型调用或工作单元超出设定上限，受控收口。",
  },
  MAX_ITER: {
    title: "达到最大迭代轮次",
    categoryTitle: "预算 / 时限",
    description: "达到最大迭代次数后受控收口。",
  },
  SOLVED: {
    title: "引擎自报已解出",
    categoryTitle: "引擎自报（未经形式化验证）",
    description: "引擎自报 SOLVED；本控制台不执行形式化验证，产物仍按待审候选呈现。",
  },
};

export function describeStopReason(code: string | null | undefined): StopReasonView {
  if (!code || !code.trim()) {
    return {
      code: "MISSING",
      title: "未提供终止原因",
      categoryTitle: "未知状态",
      description: "运行记录未携带 stopReason，前端不推测其结论。",
      registered: false,
    };
  }

  const local = LOCAL_OVERRIDES[code];
  if (local) {
    return { code, ...local, registered: false };
  }

  const info: StopReasonInfo = classifyStopReason(code);
  return {
    code: info.code,
    title: info.title,
    categoryTitle: info.categoryTitle,
    description: info.description,
    registered: info.category !== "OTHER",
  };
}