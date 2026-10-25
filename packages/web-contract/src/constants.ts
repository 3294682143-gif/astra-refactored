/**
 * @file constants.ts
 * Browser-safe runtime constants, stopReason classifications, and UI mappings for Zygos.
 * Strictly zero Node built-in dependencies.
 */

export type StopReasonCategory = "NORMAL" | "MATH_UNSOLVED" | "BUDGET_DEADLINE" | "SYSTEM_FAILURE" | "OTHER";

export interface StopReasonInfo {
  code: string;
  title: string;
  category: StopReasonCategory;
  categoryTitle: string;
  description: string;
}

export const STOP_REASON_MAP: Record<string, StopReasonInfo> = {
  REVIEWS_COMPLETE: {
    code: "REVIEWS_COMPLETE",
    title: "评审结束，交付候选",
    category: "NORMAL",
    categoryTitle: "正常交付",
    description: "求解与各轮评审均完成，已交付合规候选答案。",
  },
  NO_CANDIDATE: {
    code: "NO_CANDIDATE",
    title: "未能形成候选答案",
    category: "MATH_UNSOLVED",
    categoryTitle: "数学未解",
    description: "推理分支未能收敛出符合约束条件的候选解。",
  },
  REVISE_REJECTED: {
    code: "REVISE_REJECTED",
    title: "修复未通过门控审查",
    category: "MATH_UNSOLVED",
    categoryTitle: "数学未解",
    description: "针对挑战提出的修复产物未通过门控审查。若保留有原候选答案则依规交付原候选，否则标为未解。",
  },
  BUDGET_EXHAUSTED: {
    code: "BUDGET_EXHAUSTED",
    title: "求解调用预算已耗尽",
    category: "BUDGET_DEADLINE",
    categoryTitle: "预算 / 时限",
    description: "模型调用次数或工作单元执行已达设定上限，智能体受控收口。",
  },
  DEADLINE_EXCEEDED: {
    code: "DEADLINE_EXCEEDED",
    title: "运行超过规定时限",
    category: "BUDGET_DEADLINE",
    categoryTitle: "预算 / 时限",
    description: "运行总时长达到上限（problem_seconds），安全终止并回收资源。",
  },
  SPAWN_FAILED: {
    code: "SPAWN_FAILED",
    title: "运行时启动失败",
    category: "SYSTEM_FAILURE",
    categoryTitle: "系统故障",
    description: "底层 Node 子进程启动失败，请检查环境路径与 bundle 完整性。",
  },
  TIMEOUT: {
    code: "TIMEOUT",
    title: "子进程通信超时",
    category: "SYSTEM_FAILURE",
    categoryTitle: "系统故障",
    description: "Host 与 Node 运行时协议通信超时，子进程未在预定时限响应。",
  },
  CHILD_FAILED: {
    code: "CHILD_FAILED",
    title: "运行时进程异常退出",
    category: "SYSTEM_FAILURE",
    categoryTitle: "系统故障",
    description: "Node 运行时非零退出或 stderr 输出错误，触发故障安全终止。",
  },
  FIELD_VALUE: {
    code: "FIELD_VALUE",
    title: "协议结果字段校验失败",
    category: "SYSTEM_FAILURE",
    categoryTitle: "系统故障",
    description: "运行时返回的数据载荷未能通过核心协议 Schema 校验。",
  },
  TRANSPORT_STOP: {
    code: "TRANSPORT_STOP",
    title: "模型通信传输中断",
    category: "SYSTEM_FAILURE",
    categoryTitle: "系统故障",
    description: "远端模型 API 发生网络传输异常或通道中断。",
  },
};

export function classifyStopReason(code: string | undefined | null): StopReasonInfo {
  if (!code) {
    return {
      code: "UNKNOWN",
      title: "未知原因",
      category: "OTHER",
      categoryTitle: "未知状态",
      description: "未提供明确的 stopReason 码。",
    };
  }
  return (
    STOP_REASON_MAP[code] ?? {
      code,
      title: `自定义终止码 (${code})`,
      category: "OTHER",
      categoryTitle: "其他",
      description: `遇到未预注册的终止代码: ${code}`,
    }
  );
}
