"""Workspace snapshot and evidence projector for Astra Web BFF.

依据：《天轭前端Demo重构方案_评委版.md》第 6、8、9 节规范。
红线：
  1. candidate_verified 严格恒为 False。
  2. 真实事实保真：仅从真实 events 投影节点与证据，不臆造角色意见与依赖关系。
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from python.astra_bridge import host_checkpoint
from .config import DEFAULT_BUDGET


_R0_ROLE_META: Dict[str, Dict[str, str]] = {
    "MEANING": {
        "title": "题意对齐审查",
        "dimension": "PROBLEM_ALIGNMENT",
        "focus": "核对命题条件、边界约束、量化对象与目标一致",
    },
    "METHOD": {
        "title": "方法与域审查",
        "dimension": "SCOPE",
        "focus": "核对解题路线、领域域边界、反例风险与适用定理",
    },
    "TASK_TOOL": {
        "title": "任务与工具审查",
        "dimension": "TASK_COVERAGE",
        "focus": "核对子任务拆分完整性与计算资产/脚本调度需求",
    },
}

_INDEPENDENT_LENS_FALLBACKS: List[Dict[str, str]] = [
    {"title": "直推符号与条件核验视角", "desc": "沿原始数学陈述独立展开完整推导并逐项校验前提"},
    {"title": "对偶变换与等价重表征视角", "desc": "尝试变换变量、几何/代数等价转译后重新独立求解"},
    {"title": "极端边界与反例构造视角", "desc": "优先检验边界值、退化情形与潜在反例以锁定唯一解"},
    {"title": "不变量与模约化交叉视角", "desc": "借助守恒量、对称性或商结构进行跨尺度独立计算"},
    {"title": "逆向代回与完备性证明视角", "desc": "从候选答案反向代回原约束并核查解集完备无遗漏"},
]


def _to_plain_answer_text(raw: Optional[str]) -> str:
    if not raw:
        return ""
    s = str(raw).strip()
    for _ in range(4):
        nxt = re.sub(r"\\boxed\{([^{}]*)\}", r"\1", s)
        nxt = re.sub(r"\\(?:text|mathrm|mathbf|mathbb)\{([^{}]*)\}", r"\1", nxt)
        nxt = re.sub(r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"\1/\2", nxt)
        if nxt == s:
            break
        s = nxt
    s = re.sub(r"\\(?:left|right)\b", "", s)
    s = s.replace("$$", "").replace("$", "")
    return re.sub(r"\s+", " ", s).strip()


def _normalize_r0_verdict(raw: Any) -> Optional[str]:
    s = str(raw or "").upper()
    if s in ("NO_ISSUE", "PASS", "PASSED", "OK"):
        return "NO_ISSUE"
    if s in ("ISSUES", "ISSUE", "FAIL", "REJECT", "CHALLENGE"):
        return "ISSUES"
    if s == "UNKNOWN":
        return "UNKNOWN"
    return None

MACRO_STAGES = [
    {
        "id": "stage_1_planning",
        "name": "题意与规划",
        "subtitle": "R0角色审阅 · 义务拆解 · 方法路由",
        "order": 1,
    },
    {
        "id": "stage_2_execution",
        "name": "有界研究执行",
        "subtitle": "就绪任务 · 数学资产调用 · 答案闭合",
        "order": 2,
    },
    {
        "id": "stage_3_review",
        "name": "过程审查与修复",
        "subtitle": "R2质询 · 受控子候选 · R4复核准入",
        "order": 3,
    },
    {
        "id": "stage_4_delivery",
        "name": "终态交付",
        "subtitle": "权威交付决策 · 证据覆盖 · 边界说明",
        "order": 4,
    },
]


def _extract_payload(ev: Dict[str, Any]) -> Dict[str, Any]:
    p = ev.get("payload") or ev.get("data")
    return p if isinstance(p, dict) else {}


def project_workspace(
    run: Dict[str, Any],
    events: List[Dict[str, Any]],
    *,
    is_active: bool = False,
    checkpoint: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """将运行记录与事件流投影为评委版工作台规范快照。"""
    run_id = run.get("run_id") or ""
    summary = run.get("summary") or {}
    status = run.get("status") or "idle"
    problem = summary.get("problem") or run.get("scenario") or ""

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    evidences: Dict[str, Any] = {}

    current_stage = "stage_1_planning"
    final_answer: Optional[str] = summary.get("final_response")
    stop_reason: Optional[str] = summary.get("stopReason")

    model_calls = 0
    method_loads = 0
    work_units = 0
    first_at = 0
    last_at = 0

    tool_node_map: Dict[str, Dict[str, Any]] = {}

    dispatched_at_map: Dict[str, int] = {}
    request_phase_map: Dict[str, str] = {}
    request_latency_ms: Dict[str, int] = {}
    in_flight_requests: Dict[str, str] = {}
    r0_ordered_requests: List[str] = []

    r0_budget_enabled: Optional[bool] = None
    seen_r0_roles: Set[str] = set()
    seen_r0_aggregate = False
    r0_role_map: Dict[str, Dict[str, Any]] = {
        role: {
            "role": role,
            "title": meta["title"],
            "dimension": meta["dimension"],
            "focus": meta["focus"],
            "status": "untriggered",
            "verdict": None,
            "issueCount": 0,
            "requestId": None,
            "latencyMs": None,
            "nodeId": None,
            "evidenceId": None,
        }
        for role, meta in _R0_ROLE_META.items()
    }
    r0_aggregate_conclusion: Optional[str] = None
    r0_issue_dimensions: List[str] = []
    r0_stage_action: Optional[str] = None
    r0_stage_reason: Optional[str] = None
    r0_revision_triggered = False
    r0_recheck_observed = False
    r0_contract_version = 1
    r0_obligations_count: Optional[int] = None
    r0_tasks_count: Optional[int] = None

    max_consensus_budget: Optional[int] = None
    total_work_model_calls = 0
    total_consensus_model_calls = 0
    seed_candidate_raw: Optional[str] = None
    independent_ballots: List[Dict[str, Any]] = []
    audits: List[Dict[str, Any]] = []
    certificate_state: Dict[str, Any] = {
        "observed": False,
        "agreement": None,
        "certificateChecks": None,
        "certificateCertified": None,
        "auditOverrideDetected": False,
    }
    closure_state: Dict[str, Any] = {
        "observed": False,
        "closureRequested": False,
        "observationViews": 0,
        "observationUsed": False,
        "candidateChanged": False,
        "defects": [],
        "remainingDefects": [],
    }
    method_routes: List[str] = []
    method_routes_seen: Set[str] = set()
    closure_defects: List[str] = []
    closure_defects_seen: Set[str] = set()

    def _upsert_r0_role(
        role: str,
        verdict: Optional[str],
        issue_count: int,
        dimension_raw: Any,
        req_id: Optional[str],
        node_id: Optional[str],
        ev_id: Optional[str],
    ) -> None:
        cur = r0_role_map[role]
        resolved_req = req_id or cur.get("requestId")
        lat = request_latency_ms.get(resolved_req) if resolved_req else cur.get("latencyMs")
        if lat is None:
            lat = cur.get("latencyMs")
        next_verdict = verdict if verdict is not None else cur.get("verdict")
        next_status = "failed" if next_verdict == "ISSUES" else ("completed" if next_verdict is not None else cur["status"])
        cur.update({
            "dimension": str(dimension_raw) if isinstance(dimension_raw, str) and dimension_raw else cur["dimension"],
            "status": next_status,
            "verdict": next_verdict,
            "issueCount": issue_count,
            "requestId": resolved_req,
            "latencyMs": lat,
            "nodeId": node_id or cur.get("nodeId"),
            "evidenceId": ev_id or cur.get("evidenceId"),
        })

    for ev in events:
        seq = ev.get("seq", 0)
        kind = ev.get("kind") or ev.get("type", "")
        payload = _extract_payload(ev)
        at = ev.get("at") or ev.get("ts", 0)

        if at:
            if not first_at:
                first_at = at
            last_at = at

        if kind == "SESSION_INIT":
            if not problem and payload.get("problem"):
                problem = str(payload["problem"])
            budgets = payload.get("budgets")
            if isinstance(budgets, dict):
                if isinstance(budgets.get("maxR0"), (int, float)):
                    r0_budget_enabled = budgets["maxR0"] > 0
                if isinstance(budgets.get("maxConsensus"), (int, float)):
                    max_consensus_budget = int(budgets["maxConsensus"])

        elif kind in ("MODEL_REQUEST", "model_dispatched"):
            model_calls += 1
            req_id = str(payload.get("requestId") or payload.get("id") or f"req-{seq}")
            phase = str(payload.get("phase") or "WORK").upper()
            request_phase_map[req_id] = phase
            if isinstance(at, (int, float)) and at > 0:
                dispatched_at_map[req_id] = int(at)
            in_flight_requests[req_id] = phase

            if phase == "R0":
                r0_ordered_requests.append(req_id)
                role_order = ("MEANING", "METHOD", "TASK_TOOL")
                target_role = role_order[(len(r0_ordered_requests) - 1) % 3]
                cur = r0_role_map[target_role]
                if cur["verdict"] is None:
                    cur["status"] = "running"
                    cur["requestId"] = req_id
            elif phase == "WORK":
                total_work_model_calls += 1
            elif phase == "CONSENSUS":
                total_consensus_model_calls += 1

        elif kind == "model_returned":
            req_id = str(payload.get("requestId") or payload.get("id") or "")
            phase = str(payload.get("phase") or request_phase_map.get(req_id) or "").upper()
            if req_id:
                in_flight_requests.pop(req_id, None)
                start_at = dispatched_at_map.get(req_id)
                if isinstance(at, (int, float)) and start_at and int(at) >= start_at:
                    request_latency_ms[req_id] = int(at) - start_at
                if phase == "R0":
                    for role in ("MEANING", "METHOD", "TASK_TOOL"):
                        cur = r0_role_map[role]
                        if cur.get("requestId") == req_id:
                            cur["status"] = "failed" if cur.get("verdict") == "ISSUES" else "completed"
                            cur["latencyMs"] = request_latency_ms.get(req_id, cur.get("latencyMs"))

        elif kind == "R0_REVIEW":
            current_stage = "stage_1_planning"
            r0_budget_enabled = True
            role_raw = str(payload.get("role") or "").upper()
            if payload.get("recheck") is True:
                r0_recheck_observed = True

            if role_raw in ("MEANING", "METHOD", "TASK_TOOL"):
                recheck_tag = "recheck" if payload.get("recheck") else "init"
                seen_r0_roles.add(f"{role_raw}:{recheck_tag}")
                verdict = _normalize_r0_verdict(payload.get("verdict")) or "UNKNOWN"
                issue_count = int(payload.get("issueCount") or 0)
                req_id = payload.get("requestId") if isinstance(payload.get("requestId"), str) else None
                meta = _R0_ROLE_META[role_raw]
                node_id = f"node-r0-{role_raw.lower()}-{seq}"
                ev_id = f"ev-r0-{role_raw.lower()}-{seq}"
                lat = request_latency_ms.get(req_id) if req_id else None
                _upsert_r0_role(role_raw, verdict, issue_count, payload.get("dimension"), req_id, node_id, ev_id)

                nodes.append({
                    "id": node_id,
                    "stage": "stage_1_planning",
                    "label": f"R0 读题 · {meta['title']}",
                    "summary": f"{meta['focus']}（结论：{verdict}{f' · {issue_count} 项关注点' if issue_count > 0 else ''}）",
                    "status": "failed" if verdict == "ISSUES" else "completed",
                    "durationMs": lat,
                    "inputSummary": problem or "原始数学命题",
                    "outputSummary": f"维度 {payload.get('dimension') or meta['dimension']} · 结论 {verdict}",
                    "rationale": "R0 三方并行独立审题协议，彼此隔离不交叉污染",
                    "relations": {"taskId": req_id} if req_id else None,
                    "evidenceId": ev_id,
                    "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                })
                lat_line = f"\n* **真实响应耗时**：{lat / 1000.0:.2f} s" if lat is not None else ""
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": f"R0 独立读题审查：{meta['title']}",
                    "kind": "review_challenge",
                    "timestamp": at,
                    "markdownContent": (
                        f"### {meta['title']} ({role_raw})\n\n"
                        f"* **审查维度**：{payload.get('dimension') or meta['dimension']}\n"
                        f"* **审查结论**：{verdict}\n"
                        f"* **关注/问题数**：{issue_count}\n"
                        f"* **关联请求**：{req_id or '未记录'}{lat_line}\n\n"
                        f"> {meta['focus']}"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }
            elif role_raw == "AGGREGATE":
                seen_r0_aggregate = True
                conclusion = _normalize_r0_verdict(payload.get("conclusion") if "conclusion" in payload else payload.get("verdict")) or "UNKNOWN"
                r0_aggregate_conclusion = conclusion
                dims = payload.get("issueDimensions")
                if isinstance(dims, list):
                    r0_issue_dimensions = [str(d) for d in dims]
                if conclusion == "ISSUES":
                    r0_revision_triggered = True
                node_id = f"node-r0-aggregate-{seq}"
                ev_id = f"ev-r0-aggregate-{seq}"
                dim_text = f"（涉及维度：{' / '.join(r0_issue_dimensions)}）" if r0_issue_dimensions else ""
                nodes.append({
                    "id": node_id,
                    "stage": "stage_1_planning",
                    "label": "R0 三方读题聚合门控",
                    "summary": f"确定性聚合三角色评审结论：{conclusion}{dim_text}",
                    "status": "failed" if conclusion == "ISSUES" else "completed",
                    "inputSummary": "MEANING / METHOD / TASK_TOOL 三方独立评审结果",
                    "outputSummary": f"聚合结论：{conclusion}",
                    "rationale": "确定性汇总门控：任一方发现关键歧义或漏项即触发规划合同修订与重审",
                    "evidenceId": ev_id,
                    "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                })
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": "R0 读题确定性聚合结论",
                    "kind": "review_challenge",
                    "timestamp": at,
                    "markdownContent": (
                        f"### R0 读题聚合结论\n\n"
                        f"* **最终结论**：{conclusion}\n"
                        f"* **问题维度**：{', '.join(r0_issue_dimensions) if r0_issue_dimensions else '无'}\n"
                        f"* **是否复检**：{'是 (Recheck)' if payload.get('recheck') else '首轮聚合'}"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }
            elif role_raw == "STAGE":
                r0_stage_action = str(payload.get("action")) if isinstance(payload.get("action"), str) else None
                r0_stage_reason = str(payload.get("reason")) if isinstance(payload.get("reason"), str) else None
                if r0_stage_action in ("REVISE", "REVISED"):
                    r0_revision_triggered = True

        elif kind in ("CONTRACT", "CONTRACT_REVISED"):
            current_stage = "stage_1_planning"
            obligations = payload.get("obligations", 2)
            tasks = payload.get("tasks", 2)
            default_ver = r0_contract_version + 1 if kind == "CONTRACT_REVISED" else 1
            contract_version = int(payload.get("contractVersion") or default_ver)
            r0_contract_version = contract_version
            if isinstance(payload.get("obligations"), int):
                r0_obligations_count = payload["obligations"]
            if isinstance(payload.get("tasks"), int):
                r0_tasks_count = payload["tasks"]
            if kind == "CONTRACT_REVISED":
                r0_revision_triggered = True
            ev_id = f"ev-contract-{seq}"
            nodes.append({
                "id": f"node-contract-{seq}",
                "stage": "stage_1_planning",
                "label": f"规划合同修订 (v{contract_version})" if kind == "CONTRACT_REVISED" else "题意解析与合同义务",
                "summary": f"确立 v{contract_version} 执行合同：{obligations} 项证明义务与 {tasks} 个子任务",
                "status": "completed",
                "inputSummary": problem or "当前数学命题",
                "outputSummary": f"合同版本 v{contract_version}，分派 {tasks} 项研究任务",
                "rationale": "依据 R0 读题聚合反馈执行合同增量修订" if kind == "CONTRACT_REVISED" else "依据形式化约束与题目结构化解析协议",
                "relations": {"artifactVersion": f"v{contract_version}"},
                "evidenceId": ev_id,
                "technical": {"seq": seq, "eventKind": kind, "raw": payload},
            })
            evidences[ev_id] = {
                "id": ev_id,
                "runId": run_id,
                "title": f"规划合同修订记录 (v{contract_version})" if kind == "CONTRACT_REVISED" else "题意解析与规划义务合同",
                "kind": "contract",
                "timestamp": at,
                "markdownContent": (
                    f"### 题目命题\n\n{problem or '未记录题目文本'}\n\n"
                    f"### 规划合同义务 (v{contract_version})\n\n"
                    f"* **义务总数**：{obligations}\n"
                    f"* **子任务数**：{tasks}\n"
                    f"* **状态**：{'已完成 R0 后修订重编' if kind == 'CONTRACT_REVISED' else '已准入并初始化工作视图'}"
                ),
                "verified": False,
                "sourceEventSeq": seq,
                "rawPayload": payload,
            }

        elif kind == "METHOD_LOAD":
            method_loads += 1
            current_stage = "stage_2_execution"
            mid = str(payload.get("methodId") or "algebra_v1")
            rat = str(payload.get("rationale") or "加载针对性数学方法卡")
            nodes.append({
                "id": f"node-method-{seq}",
                "stage": "stage_2_execution",
                "label": f"方法路由: {mid}",
                "summary": rat,
                "status": "completed",
                "inputSummary": f"方法标识: {mid}",
                "outputSummary": "完成方法卡准入与上下文绑定",
                "rationale": rat,
                "technical": {"seq": seq, "eventKind": kind, "raw": payload},
            })

        elif kind in ("TOOL_OBSERVATION", "effect_returned"):
            current_stage = "stage_2_execution"
            call_id = str(payload.get("effectId") or payload.get("id") or f"tool-{seq}")
            tname = str(payload.get("tool") or payload.get("name") or "math_tool")
            raw_args = payload.get("args")
            raw_obs = payload.get("observation") if "observation" in payload else payload.get("result")
            status_val = str(payload.get("status") or "").upper()
            check_res = str(payload.get("checkResult") or "").upper()
            err_val = payload.get("error") or payload.get("reason")
            is_failed = (
                status_val in ("ERROR", "FAILED", "FAILURE")
                or check_res in ("FAILURE", "REJECTED")
                or bool(payload.get("error"))
            )

            ev_id = f"ev-tool-{call_id}"
            node_id = f"node-tool-{call_id}"

            if call_id in tool_node_map:
                node = tool_node_map[call_id]
                ev = evidences.get(ev_id)
                if tname != "math_tool" and (
                    not node.get("relations", {}).get("assetName")
                    or node.get("relations", {}).get("assetName") == "math_tool"
                ):
                    node["relations"]["assetName"] = tname
                    node["label"] = f"资产调用失败: {tname}" if node["status"] == "failed" else f"资产调用: {tname}"
                    node["summary"] = f"调用领域数学计算资产 {tname} 进行符号与结构验算"
                    if ev:
                        ev["title"] = f"数学资产调用回执: {tname}"

                if is_failed:
                    node["status"] = "failed"
                    asset_cur = node.get("relations", {}).get("assetName") or tname
                    node["label"] = f"资产调用失败: {asset_cur}"

                if raw_args is not None:
                    node["_raw_args"] = raw_args
                    node["inputSummary"] = (
                        json.dumps(raw_args, ensure_ascii=False, indent=2)
                        if isinstance(raw_args, (dict, list))
                        else str(raw_args)
                    )

                if raw_obs is not None:
                    node["_raw_obs"] = raw_obs
                    node["outputSummary"] = (
                        json.dumps(raw_obs, ensure_ascii=False, indent=2)
                        if isinstance(raw_obs, (dict, list))
                        else str(raw_obs)
                    )
                elif err_val is not None and not node.get("_raw_obs"):
                    node["_raw_obs"] = err_val
                    node["outputSummary"] = str(err_val)

                if isinstance(node["technical"]["raw"], dict):
                    node["technical"]["raw"][kind] = payload

                if ev:
                    in_s = node["inputSummary"]
                    out_s = node["outputSummary"]
                    st_str = "调用失败" if node["status"] == "failed" else "调用成功"
                    ev["markdownContent"] = (
                        f"### 资产名称\n`{node['relations'].get('assetName', tname)}`\n\n"
                        f"### 执行状态\n`{st_str}`\n\n"
                        f"### 调用参数\n```\n{in_s}\n```\n\n"
                        f"### 真实返回与观测\n```\n{out_s}\n```"
                    )
                    ev["rawPayload"] = node["technical"]["raw"]
            else:
                formatted_args = (
                    json.dumps(raw_args, ensure_ascii=False, indent=2)
                    if isinstance(raw_args, (dict, list))
                    else (str(raw_args) if raw_args is not None else "调用参数未记录")
                )
                if raw_obs is not None:
                    formatted_obs = (
                        json.dumps(raw_obs, ensure_ascii=False, indent=2)
                        if isinstance(raw_obs, (dict, list))
                        else str(raw_obs)
                    )
                elif err_val is not None:
                    formatted_obs = str(err_val)
                else:
                    formatted_obs = "回执与观测未记录"

                st = "failed" if is_failed else "completed"
                lbl = f"资产调用失败: {tname}" if is_failed else f"资产调用: {tname}"

                node = {
                    "id": node_id,
                    "stage": "stage_2_execution",
                    "label": lbl,
                    "summary": f"调用领域数学计算资产 {tname} 进行符号与结构验算",
                    "status": st,
                    "inputSummary": formatted_args,
                    "outputSummary": formatted_obs,
                    "rationale": "统一数学资产执行回执与观测",
                    "evidenceId": ev_id,
                    "relations": {"assetName": tname},
                    "_raw_args": raw_args,
                    "_raw_obs": raw_obs or err_val,
                    "technical": {"seq": seq, "eventKind": kind, "raw": {kind: payload}},
                }
                tool_node_map[call_id] = node
                nodes.append(node)

                st_str = "调用失败" if is_failed else "调用成功"
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": f"数学资产调用回执: {tname}",
                    "kind": "tool_receipt",
                    "timestamp": at,
                    "markdownContent": (
                        f"### 资产名称\n`{tname}`\n\n"
                        f"### 执行状态\n`{st_str}`\n\n"
                        f"### 调用参数\n```\n{formatted_args}\n```\n\n"
                        f"### 真实返回与观测\n```\n{formatted_obs}\n```"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }

        elif kind == "WORKUNIT":
            work_units += 1
            current_stage = "stage_2_execution"
            prop = payload.get("candidateProposal") or ""
            if isinstance(prop, str) and prop:
                final_answer = prop
            ev_id = f"ev-work-{seq}"
            nodes.append({
                "id": f"node-work-{seq}",
                "stage": "stage_2_execution",
                "label": f"研究工作单元 #{work_units}",
                "summary": "根据数学资产与推导生成阶段性候选推演",
                "status": "completed",
                "inputSummary": f"任务项 {payload.get('taskId', work_units)}",
                "outputSummary": (prop[:120] + "...") if len(prop) > 120 else prop,
                "rationale": "单步推导与形式化目标闭合",
                "evidenceId": ev_id,
                "technical": {"seq": seq, "eventKind": kind, "raw": payload},
            })
            if prop:
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": f"工作单元推导候选 #{work_units}",
                    "kind": "model_opinion",
                    "timestamp": at,
                    "markdownContent": (
                        f"### 推导内容\n\n{prop}\n\n"
                        f"> [!NOTE]\n> 本推导系研究单元生成候选，尚未通过形式化验证。"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }

        elif kind in ("REVIEW_CHALLENGE", "REPAIR"):
            if kind == "REPAIR" and str(payload.get("kind") or "") == "METHOD_ROUTE" and isinstance(payload.get("candidates"), list):
                for cand in payload["candidates"]:
                    if isinstance(cand, str) and cand.strip() and cand.strip() not in method_routes_seen:
                        method_routes_seen.add(cand.strip())
                        method_routes.append(cand.strip())

            round_tag = str(payload.get("round") or "").upper()
            if kind == "REVIEW_CHALLENGE" and round_tag == "R0":
                current_stage = "stage_1_planning"
                r0_budget_enabled = True
                role_raw = str(payload.get("role") or "").upper()
                recheck_tag = "recheck" if payload.get("recheck") else "init"
                if role_raw in ("MEANING", "METHOD", "TASK_TOOL"):
                    verdict = _normalize_r0_verdict(payload.get("verdict")) or "UNKNOWN"
                    issue_count = int(payload.get("issueCount") or 0)
                    role_key = f"{role_raw}:{recheck_tag}"
                    if role_key not in seen_r0_roles:
                        seen_r0_roles.add(role_key)
                        meta = _R0_ROLE_META[role_raw]
                        node_id = f"node-r0-{role_raw.lower()}-{seq}"
                        ev_id = f"ev-r0-{role_raw.lower()}-{seq}"
                        _upsert_r0_role(role_raw, verdict, issue_count, payload.get("dimension"), None, node_id, ev_id)
                        nodes.append({
                            "id": node_id,
                            "stage": "stage_1_planning",
                            "label": f"R0 读题 · {meta['title']}",
                            "summary": str(payload.get("rationale") or f"{meta['focus']}（结论：{verdict}）"),
                            "status": "failed" if verdict == "ISSUES" else "completed",
                            "inputSummary": problem or "原始数学命题",
                            "outputSummary": f"结论 {verdict}",
                            "rationale": "R0 三方独立审题协议",
                            "evidenceId": ev_id,
                            "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                        })
                        evidences[ev_id] = {
                            "id": ev_id,
                            "runId": run_id,
                            "title": f"R0 独立读题审查：{meta['title']}",
                            "kind": "review_challenge",
                            "timestamp": at,
                            "markdownContent": f"### {meta['title']} ({role_raw})\n\n* **结论**：{verdict}\n* **说明**：{payload.get('rationale') or meta['focus']}",
                            "verified": False,
                            "sourceEventSeq": seq,
                            "rawPayload": payload,
                        }
                elif role_raw == "AGGREGATE" and not seen_r0_aggregate:
                    seen_r0_aggregate = True
                    conclusion = _normalize_r0_verdict(payload.get("verdict") if "verdict" in payload else payload.get("conclusion")) or "UNKNOWN"
                    r0_aggregate_conclusion = conclusion
                    dims = payload.get("issueDimensions")
                    if isinstance(dims, list):
                        r0_issue_dimensions = [str(d) for d in dims]
                    node_id = f"node-r0-aggregate-{seq}"
                    ev_id = f"ev-r0-aggregate-{seq}"
                    nodes.append({
                        "id": node_id,
                        "stage": "stage_1_planning",
                        "label": "R0 三方读题聚合门控",
                        "summary": str(payload.get("rationale") or f"聚合结论：{conclusion}"),
                        "status": "failed" if conclusion == "ISSUES" else "completed",
                        "inputSummary": "MEANING / METHOD / TASK_TOOL 三方评审结果",
                        "outputSummary": f"聚合结论：{conclusion}",
                        "rationale": "R0 确定性聚合门控",
                        "evidenceId": ev_id,
                        "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                    })
                    evidences[ev_id] = {
                        "id": ev_id,
                        "runId": run_id,
                        "title": "R0 读题确定性聚合结论",
                        "kind": "review_challenge",
                        "timestamp": at,
                        "markdownContent": f"### R0 读题聚合结论\n\n* **最终结论**：{conclusion}\n* **说明**：{payload.get('rationale') or ''}",
                        "verified": False,
                        "sourceEventSeq": seq,
                        "rawPayload": payload,
                    }
                continue

            current_stage = "stage_3_review"
            is_challenge = (kind == "REVIEW_CHALLENGE")
            rat = str(payload.get("rationale") or payload.get("reason") or "专家与审查机制复核")
            special_kind = str(payload.get("kind") or "")
            decision = str(payload.get("decision") or "")
            raw_status = str(payload.get("status") or "")
            challenges_count = int(payload.get("challenges") or 0)

            is_rejected = (
                payload.get("rejected") is True
                or decision in ("rejected", "REVISE_REJECTED", "REJECT", "failed")
                or raw_status in ("rejected", "failed")
                or special_kind in ("G2_ROUTE_REJECT", "G2_ROUTE_CONTEXT_REJECTED", "REPAIR_PACKET_REJECTED")
                or (is_challenge and challenges_count > 0)
            )
            is_accepted = (
                payload.get("accepted") is True
                or decision in ("accepted", "ADMIT", "passed", "admitted")
                or raw_status in ("completed", "passed", "accepted")
                or special_kind in ("G2_ROUTE_ADMIT", "G2_ROUTE_PICK")
            )

            if is_rejected:
                node_status = "failed"
                decision_label = "拒绝准入"
                decision_summary = f"准入决策：已拒绝 ({rat})"
                node_label = "审查质询 (发现缺陷/未通过)" if is_challenge else "受控修复机制 (REPAIR - 拒绝准入)"
            elif is_accepted:
                node_status = "completed"
                decision_label = "合规准入"
                decision_summary = f"准入决策：已通过准入 ({rat})"
                node_label = "独立审查与质询 (R2/R4 - 已复核)" if is_challenge else "受控修复机制 (REPAIR - 准入生效)"
            else:
                node_status = "completed"
                decision_label = "合规受控"
                decision_summary = f"审查记录：{rat}"
                node_label = "独立审查与质询 (R2/R4)" if is_challenge else "受控修复机制 (REPAIR)"

            ev_id = f"ev-review-{seq}"
            nodes.append({
                "id": f"node-review-{seq}",
                "stage": "stage_3_review",
                "label": node_label,
                "summary": rat,
                "status": node_status,
                "inputSummary": "阶段候选与前置证明链",
                "outputSummary": decision_summary,
                "rationale": "依据反例搜索、边界检查与代数一致性",
                "evidenceId": ev_id,
                "technical": {"seq": seq, "eventKind": kind, "raw": payload},
            })
            evidences[ev_id] = {
                "id": ev_id,
                "runId": run_id,
                "title": ("审查与质询发现" if is_rejected else "审查与复核结论") if is_challenge else ("修复修订拒绝记录" if is_rejected else "修复准入与修订记录"),
                "kind": "review_challenge" if is_challenge else "repair_decision",
                "timestamp": at,
                "markdownContent": (
                    f"### 审查依据与结论\n\n{rat}\n\n"
                    f"* **审查类型**：{'专家交叉复核' if is_challenge else '受控反例修复'}\n"
                    f"* **准入决策**：{decision_label}\n"
                    f"* **复核结论**：{'未通过准入门禁，修订已废弃并回流' if is_rejected else ('已通过合规审查并准入生效' if is_accepted else '已完成过程记录')}"
                ),
                "verified": False,
                "sourceEventSeq": seq,
                "rawPayload": payload,
            }

        elif kind == "CONSENSUS":
            stage_raw = str(payload.get("stage") or "").upper()
            req_id = payload.get("requestId") if isinstance(payload.get("requestId"), str) else None
            lat = request_latency_ms.get(req_id) if req_id else None
            prev_cand = payload.get("previousCandidate") if isinstance(payload.get("previousCandidate"), str) else None
            next_cand = payload.get("nextCandidate") if isinstance(payload.get("nextCandidate"), str) else None
            agreement = payload.get("agreement") if isinstance(payload.get("agreement"), bool) else None

            if not seed_candidate_raw and prev_cand:
                seed_candidate_raw = prev_cand

            if stage_raw == "INDEPENDENT":
                current_stage = "stage_2_execution"
                idx = int(payload.get("round") or (len(independent_ballots) + 1))
                fb = _INDEPENDENT_LENS_FALLBACKS[(max(1, idx) - 1) % len(_INDEPENDENT_LENS_FALLBACKS)]
                lens_title = str(payload.get("lensTitle") or payload.get("lens") or payload.get("perspective") or fb["title"])
                lens_desc = str(payload.get("lensDescription") or fb["desc"])
                node_id = f"node-consensus-independent-{seq}"
                ev_id = f"ev-consensus-independent-{seq}"
                cand_plain = _to_plain_answer_text(next_cand) if next_cand else None
                canonical_key = (cand_plain or next_cand or "").lower().strip() or None

                independent_ballots.append({
                    "id": f"ballot-ind-{idx}-{seq}",
                    "kind": "INDEPENDENT",
                    "index": idx,
                    "roleLabel": f"独立盲解 #{idx}",
                    "lensTitle": lens_title,
                    "lensDescription": lens_desc,
                    "requestId": req_id,
                    "status": "completed",
                    "latencyMs": lat,
                    "candidateRaw": next_cand,
                    "candidatePlain": cand_plain,
                    "agreesWithPrevious": agreement,
                    "canonicalKey": canonical_key,
                    "nodeId": node_id,
                    "evidenceId": ev_id,
                })
                nodes.append({
                    "id": node_id,
                    "stage": "stage_2_execution",
                    "label": f"多 Agent 盲解 #{idx} · {lens_title}",
                    "summary": f"屏蔽历史候选独立重算{f'：{cand_plain[:60]}' if cand_plain else ''}",
                    "status": "completed",
                    "durationMs": lat,
                    "inputSummary": f"旋转求解视角：{lens_title}",
                    "outputSummary": f"独立候选：{cand_plain[:80]}" if cand_plain else "完成独立推导",
                    "rationale": "Blind Independent Solve：隔离上下文与前置答案，防止共识从众",
                    "relations": {"taskId": req_id} if req_id else None,
                    "evidenceId": ev_id,
                    "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                })
                lat_line = f"\n* **模型耗时**：{lat / 1000.0:.2f} s" if lat is not None else ""
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": f"独立盲解 #{idx} ({lens_title})",
                    "kind": "model_opinion",
                    "timestamp": at,
                    "markdownContent": (
                        f"### 独立盲解轮次 #{idx}\n\n"
                        f"* **探索视角**：{lens_title}\n"
                        f"* **与上一轮候选一致**：{'一致' if agreement is True else ('分歧' if agreement is False else '未比对')}\n"
                        f"* **输出摘要**：{cand_plain or '（无文本候选）'}{lat_line}"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }
            elif stage_raw == "AUDIT":
                current_stage = "stage_3_review"
                idx = len(audits) + 1
                mode_raw = str(payload.get("auditMode") or payload.get("mode") or ("COUNTEREXAMPLE" if idx % 2 == 1 else "PROOF_AUDIT"))
                mode_label = "反例攻防与边界证伪" if "COUNTER" in mode_raw.upper() else "证明链严密性与步骤审计"
                node_id = f"node-consensus-audit-{seq}"
                ev_id = f"ev-consensus-audit-{seq}"
                prev_plain = _to_plain_answer_text(prev_cand) if prev_cand else None
                next_plain = _to_plain_answer_text(next_cand) if next_cand else None
                audits.append({
                    "id": f"audit-{idx}-{seq}",
                    "index": idx,
                    "modeLabel": mode_label,
                    "requestId": req_id,
                    "latencyMs": lat,
                    "previousCandidate": prev_cand,
                    "nextCandidate": next_cand,
                    "previousPlain": prev_plain,
                    "nextPlain": next_plain,
                    "agreement": agreement,
                    "nodeId": node_id,
                    "evidenceId": ev_id,
                })
                nodes.append({
                    "id": node_id,
                    "stage": "stage_3_review",
                    "label": f"锚定对抗审计 #{idx} · {mode_label}",
                    "summary": (
                        f"对抗审计检出分歧或修正了主票候选（{(next_plain or '')[:50]}）"
                        if agreement is False
                        else "对抗审计维持多数派主票结论（一致确认）"
                    ),
                    "status": "failed" if agreement is False else "completed",
                    "durationMs": lat,
                    "inputSummary": f"待审主票：{prev_plain[:60]}" if prev_plain else "多数派汇总候选",
                    "outputSummary": "提出修订或风险标注" if agreement is False else "确认无推翻性反例或逻辑断层",
                    "rationale": "Anchored Adversarial Audit：基于投票聚类的主票候选实施高压证伪",
                    "relations": {"taskId": req_id} if req_id else None,
                    "evidenceId": ev_id,
                    "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                })
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": f"对抗审计 #{idx}：{mode_label}",
                    "kind": "review_challenge",
                    "timestamp": at,
                    "markdownContent": (
                        f"### 对抗审计 #{idx} ({mode_label})\n\n"
                        f"* **审计结论**：{'检出分歧/修正候选' if agreement is False else '确认主票成立'}\n"
                        f"* **审计前候选**：{prev_plain or '无'}\n"
                        f"* **审计后候选**：{next_plain or '无'}"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }
            elif stage_raw == "CERTIFICATE":
                current_stage = "stage_2_execution"
                node_id = f"node-consensus-certificate-{seq}"
                ev_id = f"ev-consensus-certificate-{seq}"
                checks = payload.get("certificateChecks") if isinstance(payload.get("certificateChecks"), int) else None
                certified = payload.get("certificateCertified") if isinstance(payload.get("certificateCertified"), bool) else None
                override_detected = bool(payload.get("auditOverrideDetected"))
                prev_plain = _to_plain_answer_text(prev_cand) if prev_cand else None
                next_plain = _to_plain_answer_text(next_cand) if next_cand else None
                certificate_state = {
                    "observed": True,
                    "requestId": req_id,
                    "latencyMs": lat,
                    "previousCandidate": prev_cand,
                    "nextCandidate": next_cand,
                    "previousPlain": prev_plain,
                    "nextPlain": next_plain,
                    "agreement": agreement,
                    "certificateChecks": checks,
                    "certificateCertified": certified,
                    "auditOverrideDetected": override_detected,
                    "nodeId": node_id,
                    "evidenceId": ev_id,
                }
                nodes.append({
                    "id": node_id,
                    "stage": "stage_2_execution",
                    "label": "CERT1 一致性自检证书",
                    "summary": f"执行确定性检验 {checks or 0} 项 · 候选{'发生修订' if agreement is False else '保持一致'}（certified={str(bool(certified)).lower()}）",
                    "status": "completed",
                    "durationMs": lat,
                    "inputSummary": prev_plain or "当前共识候选",
                    "outputSummary": next_plain or "自检输出候选",
                    "rationale": "CERT1 机制对最终候选做条件回代与独立性自洽核查",
                    "relations": {"taskId": req_id} if req_id else None,
                    "evidenceId": ev_id,
                    "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                })
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": "CERT1 结构化自检证书",
                    "kind": "checkpoint",
                    "timestamp": at,
                    "markdownContent": (
                        f"### CERT1 自检证书\n\n"
                        f"* **核验条目数**：{checks or 0}\n"
                        f"* **证书认证标志**：{'已通过自检项' if certified else '待人工/形式化复核'}\n"
                        f"* **前后一致**：{'一致' if agreement is True else ('有变更' if agreement is False else '未对比')}"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }
            elif stage_raw == "ANSWER_CLOSURE":
                current_stage = "stage_2_execution"
                node_id = f"node-consensus-closure-{seq}"
                ev_id = f"ev-consensus-closure-{seq}"
                defects = [str(d) for d in (payload.get("defects") or [])] if isinstance(payload.get("defects"), list) else []
                remaining = [str(d) for d in (payload.get("remainingDefects") or [])] if isinstance(payload.get("remainingDefects"), list) else []
                for d in defects:
                    if d not in closure_defects_seen:
                        closure_defects_seen.add(d)
                        closure_defects.append(d)
                obs_views = int(payload.get("observationViews") or 0)
                obs_used = bool(payload.get("observationUsed"))
                closure_req = bool(payload.get("closureRequested"))
                cand_changed = bool(payload.get("candidateChanged"))
                closure_state = {
                    "observed": True,
                    "closureRequested": closure_req,
                    "observationViews": obs_views,
                    "observationUsed": obs_used,
                    "candidateChanged": cand_changed,
                    "defects": list(closure_defects),
                    "remainingDefects": remaining,
                    "previousCandidate": prev_cand,
                    "nextCandidate": next_cand,
                    "nodeId": node_id,
                    "evidenceId": ev_id,
                }
                nodes.append({
                    "id": node_id,
                    "stage": "stage_2_execution",
                    "label": "答案闭合与资产对齐校验",
                    "summary": (
                        f"存在 {len(remaining)} 项未闭合缺陷（观测视角 {obs_views} 个）"
                        if remaining
                        else f"全量证明义务与观测视图（{obs_views} 项）闭合通过"
                    ),
                    "status": "failed" if remaining else "completed",
                    "inputSummary": f"程序计算观测视图 {obs_views} 项",
                    "outputSummary": f"残余缺陷：{'; '.join(remaining)}" if remaining else "答案闭合完整无缺陷",
                    "rationale": "Answer Closure 对齐工具真值观测与最终候选表述，杜绝晚到观测漏引",
                    "evidenceId": ev_id,
                    "technical": {"seq": seq, "eventKind": kind, "raw": payload},
                })
                evidences[ev_id] = {
                    "id": ev_id,
                    "runId": run_id,
                    "title": "答案闭合与工具回执一致性校验",
                    "kind": "checkpoint",
                    "timestamp": at,
                    "markdownContent": (
                        f"### 答案闭合报告\n\n"
                        f"* **观测视角数**：{obs_views}\n"
                        f"* **是否直接引用观测**：{'是' if obs_used else '否'}\n"
                        f"* **触发二次收口请求**：{'是' if closure_req else '否'}\n"
                        f"* **检出缺陷**：{', '.join(defects) if defects else '无'}\n"
                        f"* **残余缺陷**：{', '.join(remaining) if remaining else '无'}"
                    ),
                    "verified": False,
                    "sourceEventSeq": seq,
                    "rawPayload": payload,
                }
            elif stage_raw in ("LATE_OBSERVATION_DEFECT", "UNSOLVED_REFUSAL"):
                d_str = str(payload.get("reason") or payload.get("defect") or stage_raw)
                if d_str not in closure_defects_seen:
                    closure_defects_seen.add(d_str)
                    closure_defects.append(d_str)
                closure_state["observed"] = True
                closure_state["defects"] = list(closure_defects)

        elif kind in ("FINAL", "RESULT"):
            current_stage = "stage_4_delivery"
            ans = payload.get("final_response") or payload.get("answer")
            if isinstance(ans, str) and ans:
                final_answer = ans
            sr = payload.get("stopReason")
            if sr:
                stop_reason = str(sr)
            metrics = payload.get("metrics")
            if max_consensus_budget is None and isinstance(metrics, dict):
                bal = metrics.get("consensus_independent_ballots")
                if isinstance(bal, int) and bal > 0:
                    max_consensus_budget = bal + 3

    # 终态收口节点
    is_terminal = status in (
        "candidate", "unsolved", "aborted", "error", "timeout", "failed", "cancelled", "finished"
    )
    unresolved_obs = list(summary.get("unresolvedObligations") or [])
    if not unresolved_obs:
        for ev in events:
            if ev.get("kind") == "RESULT":
                p = _extract_payload(ev)
                unresolved_obs = list(p.get("unresolvedObligations") or [])
                if unresolved_obs:
                    break

    if is_terminal and not is_active:
        current_stage = "stage_4_delivery"
        is_cand = (status == "candidate")
        sr_text = stop_reason or "REVIEWS_COMPLETE"
        nodes.append({
            "id": "node-delivery-final",
            "stage": "stage_4_delivery",
            "label": "候选结论交付" if is_cand else "研究收口 (未解/受限)",
            "summary": (
                "满足审查约束，交付可信数学证明候选（待形式化验证）"
                if is_cand
                else f"因 {sr_text} 终止，交付当前已探索范围与未解说明"
            ),
            "status": "completed" if is_cand else "failed",
            "outputSummary": ((final_answer[:150] + "...") if final_answer and len(final_answer) > 150 else final_answer) or "无可用终态答案",
            "rationale": f"收口原因代码: {sr_text}",
            "technical": {
                "eventKind": "RESULT",
                "raw": {
                    "status": status,
                    "stopReason": stop_reason,
                    "unresolvedObligations": unresolved_obs,
                    **({"metrics": summary.get("metrics")} if isinstance(summary.get("metrics"), dict) else {}),
                },
            },
        })

    # 构建拓扑边（拒绝基于节点位置的猜测，Spec R2）
    # 1. 顺序执行流：工作流中按时间顺序发生的主干演进
    for i in range(len(nodes) - 1):
        c = nodes[i]
        n = nodes[i + 1]
        edges.append({
            "id": f"edge-{c['id']}->{n['id']}",
            "source": c["id"],
            "target": n["id"],
            "kind": "sequence",
        })

    # 2. 因果依赖与修复回流：仅在有显式精确引用时建立，严禁按时间或阶段顺序臆造因果 (Spec R2)
    # 审查/修复节点：仅当后续工作单元明确声明 supersedes/revisedFrom，或显式属于当前审查任务的修订时，才建立 repair_loop 回流边
    def _is_work_revision_of_review(sub_work: dict, review_node: dict) -> bool:
        rev_raw = review_node.get("technical", {}).get("raw", {})
        work_raw = sub_work.get("technical", {}).get("raw", {})
        if not isinstance(rev_raw, dict) or not isinstance(work_raw, dict):
            return False

        target_task = str(rev_raw.get("targetTaskId") or rev_raw.get("targetTask") or rev_raw.get("taskId") or "").strip()
        target_work = str(rev_raw.get("targetWorkUnitId") or rev_raw.get("targetNodeId") or "").strip()
        target_art = str(rev_raw.get("targetArtifactId") or (rev_raw.get("targetArtifactRef", {}).get("artifactId") if isinstance(rev_raw.get("targetArtifactRef"), dict) else rev_raw.get("targetArtifactRef") or "")).strip()

        # 1. 检查 sub_work 的 supersedes 声明
        supersedes = work_raw.get("supersedes")
        if supersedes:
            sup_art = str(supersedes.get("artifactId") if isinstance(supersedes, dict) else supersedes).strip()
            sup_task = str(supersedes.get("taskId") if isinstance(supersedes, dict) else "").strip()
            if target_art and sup_art == target_art:
                return True
            if target_task and (sup_art == target_task or sup_task == target_task):
                return True
            if target_work and sup_art == target_work:
                return True

        # 2. 检查 sub_work 的 revisedFrom / parentArtifactId
        revised_from = str(work_raw.get("revisedFrom") or work_raw.get("parentArtifactId") or "").strip()
        if revised_from:
            if target_art and revised_from == target_art:
                return True
            if target_task and revised_from == target_task:
                return True
            if target_work and revised_from == target_work:
                return True

        # 3. 检查 sub_work 显式声明 isRevision / is_repair 且 taskId 精确匹配 target_task
        is_rev_flag = bool(work_raw.get("isRevision") or work_raw.get("is_repair") or work_raw.get("isRepair"))
        work_task = str(work_raw.get("taskId") or "").strip()
        if is_rev_flag and target_task and work_task == target_task:
            return True

        # 4. 检查 review 显式指定 targetWorkUnitId 精确匹配 sub_work 的 id 或 workUnitId
        work_id = str(work_raw.get("workUnitId") or "").strip()
        if target_work and (target_work == sub_work["id"] or (work_id and target_work == work_id)):
            return True

        return False

    for i, node in enumerate(nodes):
        if node["stage"] == "stage_3_review":
            # 遍历后续工作节点，仅当存在可追溯的显式修订身份时建立修复回流边；若执行无关任务则保持时间顺序，无回流边 (Spec R2)
            for sub_work in nodes[i + 1 :]:
                if sub_work["stage"] == "stage_2_execution" and "work" in sub_work["id"]:
                    if _is_work_revision_of_review(sub_work, node):
                        edges.append({
                            "id": f"edge-repair-{node['id']}->{sub_work['id']}",
                            "source": node["id"],
                            "target": sub_work["id"],
                            "kind": "repair_loop",
                        })

        elif node.get("evidenceId") and "tool" in node["id"]:
            # 工具证据引用：仅当显式指定 taskId / targetWorkUnitId 时建立因果边，精确比对
            raw_data = node.get("technical", {}).get("raw", {})
            t_ref = None
            if isinstance(raw_data, dict):
                for sub in raw_data.values():
                    if isinstance(sub, dict) and (sub.get("taskId") or sub.get("workUnitId")):
                        t_ref = str(sub.get("taskId") or sub.get("workUnitId")).strip()
                        break
            if t_ref:
                matched_work = next(
                    (n["id"] for n in nodes if n["stage"] == "stage_2_execution" and (
                        n.get("technical", {}).get("raw", {}).get("taskId") == t_ref or
                        n.get("technical", {}).get("raw", {}).get("workUnitId") == t_ref or
                        n["id"] == t_ref
                    )),
                    None
                )
                if matched_work:
                    edges.append({
                        "id": f"edge-evidence-{node['id']}->{matched_work}",
                        "source": node["id"],
                        "target": matched_work,
                        "kind": "evidence",
                    })

    for n in nodes:
        n.pop("_raw_args", None)
        n.pop("_raw_obs", None)

    elapsed_ms = (last_at - first_at) if (last_at and first_at and last_at >= first_at) else 0

    budget = {
        "maxModelCalls": int(summary.get("max_model_calls") or 32),
        "usedModelCalls": model_calls,
        "maxMethodLoads": int(summary.get("max_method_loads") or 4),
        "usedMethodLoads": method_loads,
        "maxWorkUnits": int(summary.get("max_work_units") or 8),
        "usedWorkUnits": work_units,
        "elapsedMs": int(summary.get("elapsedMs") or elapsed_ms),
        "commitHash": summary.get("commitHash"),
    }

    # 同题恢复判定（方案 9.2 节）：
    # 严格检验真实中间检查点，原题哈希，未确认在途请求责任与剩余预算
    cp = checkpoint or run.get("checkpoint") or summary.get("checkpoint")
    recovery_eligible = False
    recovery_reason = "未检测到可信中间检查点，无法执行受约束续推"
    checkpoint_seq = None
    remaining_model_calls = 0
    remaining_method_loads = 0
    remaining_effects = 0

    if is_active:
        recovery_reason = "当前研究正在活跃执行中，禁止重复启动"
    elif status == "candidate":
        recovery_reason = "研究已完成终态候选，无需恢复"
    elif cp is None or not isinstance(cp, dict):
        recovery_reason = "未检测到可信中间检查点，无法执行受约束续推"
    else:
        prob_str = problem or summary.get("problem") or run.get("scenario") or ""
        prob_hash = hashlib.sha256(prob_str.encode("utf-8")).hexdigest()
        try:
            v_cp = host_checkpoint.verify_checkpoint(
                cp,
                problem_hash=prob_hash,
                contract_version=host_checkpoint.body_contract_version(cp),
            )
            unknowns = v_cp.get("unknownRequestIds") or []
            if len(unknowns) > 0:
                recovery_eligible = False
                recovery_reason = "存在未确认远端请求 (OUTCOME_UNKNOWN)，依据安全准则禁止自动续推"
            else:
                spent_m = v_cp.get("spent", {}).get("modelCalls", 0)
                max_m = v_cp.get("budget", {}).get("maxModelCalls", 0)
                spent_e = v_cp.get("spent", {}).get("effectCalls", 0)
                max_e = v_cp.get("budget", {}).get("maxEffects", 0)
                rem_m = max(0, max_m - spent_m)
                rem_e = max(0, max_e - spent_e)

                # Check deadline & duration (Standards S2)
                problem_seconds = float(summary.get("problem_seconds") or run.get("problem_seconds") or DEFAULT_BUDGET["problem_seconds"])
                duration_s = float(run.get("duration_s") or (summary.get("elapsedMs", 0) / 1000.0))
                created_at = float(run.get("created_at") or 0.0)
                now = time.time()
                deadline = created_at + problem_seconds if created_at > 0 else (now + max(0.0, problem_seconds - duration_s))
                rem_seconds_by_deadline = deadline - now if created_at > 0 else (problem_seconds - duration_s)
                rem_seconds_by_duration = problem_seconds - duration_s
                rem_seconds = min(rem_seconds_by_deadline, rem_seconds_by_duration)

                if duration_s >= problem_seconds or rem_seconds <= 0:
                    recovery_eligible = False
                    recovery_reason = f"原任务执行时间已超出限额 (限额 {problem_seconds}s，已耗时 {duration_s}s)，禁止恢复"
                elif rem_m <= 0:
                    recovery_eligible = False
                    recovery_reason = "原模型调用预算已耗尽，禁止超出原限额续推"
                else:
                    recovery_eligible = True
                    checkpoint_seq = len(v_cp.get("sessionLog", []))
                    remaining_model_calls = rem_m
                    remaining_effects = rem_e
                    remaining_method_loads = max(0, budget["maxMethodLoads"] - budget["usedMethodLoads"])
                    recovery_reason = f"可信检查点已就绪 (包含 #{checkpoint_seq} 步经认证事件，剩余模型预算 {rem_m})"
        except host_checkpoint.CheckpointError as exc:
            recovery_eligible = False
            recovery_reason = f"检查点校验失败 ({exc.code})，拒绝恢复"
        except Exception as exc:
            recovery_eligible = False
            recovery_reason = f"检查点解析异常 ({type(exc).__name__})，拒绝恢复"

    recovery = {
        "eligible": recovery_eligible,
        "reason": recovery_reason,
        "checkpointSeq": checkpoint_seq,
        "checkpointTime": last_at or 0,
        "remainingBudget": {
            "maxModelCalls": remaining_model_calls,
            "maxMethodLoads": remaining_method_loads,
            "maxEffects": remaining_effects,
        } if recovery_eligible else {},
    }

    first_work_with_candidate = next(
        (
            n for n in nodes
            if n["id"].startswith("node-work-")
            and isinstance((n.get("technical") or {}).get("raw", {}).get("candidateProposal"), str)
            and str((n.get("technical") or {}).get("raw", {}).get("candidateProposal")).strip() != ""
        ),
        None,
    )
    seed_node_id = first_work_with_candidate["id"] if first_work_with_candidate else None
    seed_evidence_id = first_work_with_candidate.get("evidenceId") if first_work_with_candidate else None
    if first_work_with_candidate and not seed_candidate_raw:
        seed_candidate_raw = str(first_work_with_candidate["technical"]["raw"]["candidateProposal"])

    all_ballots: List[Dict[str, Any]] = []
    if seed_candidate_raw:
        seed_plain = _to_plain_answer_text(seed_candidate_raw)
        seed_key = (seed_plain or seed_candidate_raw).lower().strip()
        all_ballots.append({
            "id": "ballot-seed-0",
            "kind": "SEED",
            "index": 0,
            "roleLabel": "初始种子候选 (Seed)",
            "lensTitle": "主推理链首轮生成",
            "lensDescription": "基于规划合同与数学工具观测生成的初始候选解答",
            "status": "completed",
            "candidateRaw": seed_candidate_raw,
            "candidatePlain": seed_plain,
            "agreesWithPrevious": None,
            "canonicalKey": seed_key,
            "nodeId": seed_node_id,
            "evidenceId": seed_evidence_id,
        })
    all_ballots.extend(independent_ballots)

    vote_buckets: Dict[str, Dict[str, Any]] = {}
    for idx, ballot in enumerate(all_ballots):
        c_raw = ballot.get("candidateRaw")
        c_key = ballot.get("canonicalKey")
        if not c_raw or not c_key:
            continue
        label = "Seed" if ballot["kind"] == "SEED" else f"Agent #{ballot['index']}"
        if c_key in vote_buckets:
            vote_buckets[c_key]["count"] += 1
            vote_buckets[c_key]["ballotLabels"].append(label)
        else:
            vote_buckets[c_key] = {
                "key": c_key,
                "displayCandidate": c_raw,
                "displayPlain": ballot.get("candidatePlain") or c_raw,
                "count": 1,
                "ballotLabels": [label],
                "firstOrder": idx,
            }

    sorted_buckets = sorted(vote_buckets.values(), key=lambda item: (-item["count"], item["firstOrder"]))
    top_key = sorted_buckets[0]["key"] if sorted_buckets else None
    vote_groups = [
        {
            "key": b["key"],
            "displayCandidate": b["displayCandidate"],
            "displayPlain": b["displayPlain"],
            "count": b["count"],
            "ballotLabels": b["ballotLabels"],
            "isFrontRunner": b["key"] == top_key,
        }
        for b in sorted_buckets
    ]
    front_runner_candidate = sorted_buckets[0]["displayPlain"] if sorted_buckets else None

    r0_agents = [r0_role_map[r] for r in ("MEANING", "METHOD", "TASK_TOOL")]
    any_r0_running = any(a["status"] == "running" for a in r0_agents)
    any_r0_done = any(a["status"] in ("completed", "failed") for a in r0_agents) or seen_r0_aggregate
    if r0_budget_enabled is False and not any_r0_running and not any_r0_done:
        r0_status = "skipped"
    elif any_r0_running:
        r0_status = "running"
    elif any_r0_done:
        r0_status = "completed"
    else:
        r0_status = "idle"

    r0_reading = {
        "enabled": r0_budget_enabled if r0_budget_enabled is not None else (True if (any_r0_done or any_r0_running) else None),
        "status": r0_status,
        "agents": r0_agents,
        "aggregateConclusion": r0_aggregate_conclusion,
        "issueDimensions": r0_issue_dimensions,
        "stageAction": r0_stage_action,
        "stageReason": r0_stage_reason,
        "revisionTriggered": r0_revision_triggered,
        "recheckObserved": r0_recheck_observed,
        "contractVersion": r0_contract_version,
        "obligationsCount": r0_obligations_count,
        "tasksCount": r0_tasks_count,
        "totalR0Calls": len(r0_ordered_requests),
    }

    if not method_routes and isinstance(summary.get("metrics"), dict):
        for raw_mid in summary["metrics"].get("method_ids") or []:
            if isinstance(raw_mid, str) and raw_mid and raw_mid not in method_routes_seen:
                method_routes_seen.add(raw_mid)
                method_routes.append(raw_mid)

    multi_agent_solving = {
        "maxConsensusBudget": max_consensus_budget,
        "totalWorkModelCalls": total_work_model_calls,
        "totalConsensusModelCalls": total_consensus_model_calls,
        "inFlightRequests": [{"requestId": k, "phase": v} for k, v in in_flight_requests.items()],
        "ballots": all_ballots,
        "voteGroups": vote_groups,
        "frontRunnerCandidate": front_runner_candidate,
        "audits": audits,
        "certificate": certificate_state,
        "closure": closure_state,
        "methodRoutes": method_routes,
    }

    return {
        "runId": run_id,
        "problem": problem,
        "mode": "running" if is_active else ("completed" if is_terminal else "unstarted"),
        "status": status,
        "stopReason": stop_reason,
        "candidateVerified": False,  # 红线
        "currentStage": current_stage,
        "stages": MACRO_STAGES,
        "nodes": nodes,
        "edges": edges,
        "evidences": evidences,
        "budget": budget,
        "recovery": recovery,
        "finalAnswer": final_answer,
        "unresolvedObligations": unresolved_obs,
        "r0Reading": r0_reading,
        "multiAgentSolving": multi_agent_solving,
        "rawEventsCount": len(events),
    }


def find_evidence_detail(
    run: Dict[str, Any],
    events: List[Dict[str, Any]],
    evidence_id: str,
) -> Optional[Dict[str, Any]]:
    """读取指定证据的详细内容。"""
    ws = project_workspace(run, events)
    return ws.get("evidences", {}).get(evidence_id)
