"""Workspace snapshot and evidence projector for Astra Web BFF.

依据：《天轭前端Demo重构方案_评委版.md》第 6、8、9 节规范。
红线：
  1. candidate_verified 严格恒为 False。
  2. 真实事实保真：仅从真实 events 投影节点与证据，不臆造角色意见与依赖关系。
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict, List, Optional

from python.astra_bridge import host_checkpoint
from .config import DEFAULT_BUDGET

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

        elif kind in ("CONTRACT", "CONTRACT_REVISED"):
            current_stage = "stage_1_planning"
            obligations = payload.get("obligations", 2)
            tasks = payload.get("tasks", 2)
            ev_id = f"ev-contract-{seq}"
            nodes.append({
                "id": f"node-contract-{seq}",
                "stage": "stage_1_planning",
                "label": "题意解析与合同义务",
                "summary": f"解析题目目标，确立 {obligations} 项证明义务与 {tasks} 个执行阶段",
                "status": "completed",
                "inputSummary": problem or "当前数学命题",
                "outputSummary": "确立目标义务表，分派初始研究任务",
                "rationale": "依据形式化约束与题目结构化解析协议",
                "evidenceId": ev_id,
                "technical": {"seq": seq, "eventKind": kind, "raw": payload},
            })
            evidences[ev_id] = {
                "id": ev_id,
                "runId": run_id,
                "title": "题意解析与规划义务合同",
                "kind": "contract",
                "timestamp": at,
                "markdownContent": (
                    f"### 题目命题\n\n{problem or '未记录题目文本'}\n\n"
                    f"### 规划合同义务\n\n"
                    f"* **义务总数**：{obligations}\n"
                    f"* **子任务数**：{tasks}\n"
                    f"* **状态**：已准入并初始化工作视图"
                ),
                "verified": False,
                "sourceEventSeq": seq,
                "rawPayload": payload,
            }

        elif kind in ("MODEL_REQUEST", "model_dispatched"):
            model_calls += 1

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

        elif kind in ("FINAL", "RESULT"):
            current_stage = "stage_4_delivery"
            ans = payload.get("final_response") or payload.get("answer")
            if isinstance(ans, str) and ans:
                final_answer = ans
            sr = payload.get("stopReason")
            if sr:
                stop_reason = str(sr)

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
