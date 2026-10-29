"""Controller-owned failed-proposal feedback; never a computed mathematical premise."""

import json

from .runtime.config import fingerprint


def rejection_key(store, unit, proposal):
    return fingerprint(
        (store.problem.digest, unit.bottleneck_key, proposal.name, proposal.args)
    )


def failure_feedback(store, artifact_id):
    feedback = store.control.get("tool_failure_details", {}).get(artifact_id)
    if not feedback or feedback.get('tool') != 'generated_python':
        return feedback
    # Join to the real tool result, not to an exception-looking model sentence.
    with store.lock:
        events = tuple(store.events)
    for event in reversed(events):
        detail = event.get('details', {})
        if event.get('kind') != 'tool_result' or detail.get('target') != artifact_id:
            continue
        result = detail.get('result') or {}
        receipt = result.get('result') or {}
        status = result.get('status')
        if not isinstance(receipt, dict) or status not in {'resource_limited', 'error', 'ok'}:
            continue
        category = 'RESOURCE' if status == 'resource_limited' else 'PROGRAM_ERROR' if status == 'error' else 'OUTPUT'
        return dict(feedback, execution_class=category, not_a_mathematical_refutation=True,
                    execution_receipt={
                        'status': status, 'reason': receipt.get('reason'),
                        'exit_code': receipt.get('exit_code'),
                        'elapsed_seconds': receipt.get('elapsed_seconds'),
                        'output': str(receipt.get('output') or '')[:4000],
                        'source_event': event.get('sequence'), 'target': artifact_id,
                    })
    return feedback


def render_feedback(feedback):
    visible = {
        key: feedback[key]
        for key in (
            "tool",
            "args",
            "original_task",
            "failure_kind",
            "message",
            "supported_scope",
        )
    }
    if len(json.dumps(visible, ensure_ascii=False)) > 6000:
        visible["args"] = {
            "argument_names": list(feedback["args"]),
            "large_rejected_payload_omitted": True,
        }
    if feedback.get('execution_receipt'):
        visible['execution_class'] = feedback['execution_class']
        visible['execution_receipt'] = feedback['execution_receipt']
        visible['not_a_mathematical_refutation'] = True
    label = ("EXECUTION FAILURE — NOT A MATHEMATICAL RESULT:\n" if feedback.get('execution_receipt')
             else "REJECTED TOOL REQUEST — NOT AN EXECUTION RESULT:\n")
    return label + json.dumps(
        visible, ensure_ascii=False
    )


def recovery_instruction(feedback, *, python_available):
    if feedback.get('execution_receipt'):
        category = feedback['execution_class']
        advice = {
            'RESOURCE': 'The program exceeded a real sandbox resource bound. Use a smaller bounded subproblem, a derived finite expression, or a lower-cost algorithm; do not change the original mathematical inputs or increase limits. Avoid repeating broad symbolic searches unchanged.',
            'PROGRAM_ERROR': 'Repair the actual program error using the traceback, imports, symbol identities and API signatures. Preserve the original mathematical task; a program error is not a counterexample.',
            'OUTPUT': 'Execution returned but its output was unusable. Repair the declared output contract and explicitly check the original mapping; a printed assertion is not a proof.',
        }[category]
        return (' A real program ran. CLASS: ' + category + '. ' + advice
                + ' Repair the SAME original task. Propose bounded generated_python only when the sandbox is available; otherwise continue mathematical derivation. A repaired proposal must pass normal review, execute again, and be consumed before it supports a candidate.')
    instruction = (
        " Repair the rejected calculation request for the SAME original mathematical task and input. "
        "The supplied failure is controller feedback, not a mathematical result. "
        "Do not repeat the same rejected tool/arguments, shrink the problem parameters just to pass a limit, "
        "or claim that rejected code was executed. "
    )
    if feedback["failure_kind"] in {"OutsideAuditScope", "RepeatedRejectedProposal"}:
        if python_available:
            instruction += (
                "Prefer the enabled generated_python backend with a faithful, efficient, explicitly bounded implementation, "
                "or derive a sound reduction for another supported registered tool. "
                "WASI still has its original time/memory limits and R3 review: do not merely rerun the same exponential search at a larger size. "
            )
        else:
            instruction += (
                "Generated Python is unavailable; do not propose it or host Python. "
                "Use a supported registered alternative or identify the mathematical reduction needed. "
            )
    instruction += "If no sound bounded computation is available, return BLOCKED with that specific GAP; do not guess a result."
    return instruction
