"""Bounded, untrusted computation observations with controller-owned identities."""

import json
import math
import re

from .runtime.config import fingerprint

SCHEMA = "math-computation-observation-v1"
ARRAYS = ("candidates", "relations", "counterexamples", "unresolved")
FIELDS = {
    "schema",
    "operation",
    "variables",
    "assumptions",
    "search_scope",
    *ARRAYS,
    "completeness_claim",
}

OUTPUT_HINT = (
    ' For candidate/relationship exploration print exactly one JSON object with schema="math-computation-observation-v1", '
    "operation, variables (array), assumptions (array), search_scope (explicit finite bounds object), candidates (array), "
    'relations (array), counterexamples (array), unresolved (array), completeness_claim="NOT_ESTABLISHED". '
    'A function candidate is {"object":"F(x)=3*x","domain":"real","parameters":"NONE","conditions":"NONE","target":"exact current target"}; '
    "this is a synthetic shape example, not an answer. Use actual computed objects, at most 16 total proposed objects, exact rational/expression strings, "
    "no NaN/Infinity, and no self-authored source/receipt IDs. Empty candidates means no candidate found, not no solutions. "
    "A plain scalar observation is also allowed for a scalar-only task, but never becomes the original answer without a separate consumer."
)


def parse_observation(output):
    if not isinstance(output, str) or len(output.encode()) > 65536:
        raise ValueError("output resource bound; no truncation permitted")

    def no_constant(value):
        raise ValueError("nonfinite constant " + value)

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate output field")
            result[key] = value
        return result

    data = json.loads(output, parse_constant=no_constant, object_pairs_hook=unique)
    if not isinstance(data, dict) or set(data) != FIELDS or data["schema"] != SCHEMA:
        raise ValueError("structured observation schema mismatch")
    if not isinstance(data["operation"], str) or not 0 < len(data["operation"]) <= 100:
        raise ValueError("operation required")
    for field in (*ARRAYS, "variables", "assumptions"):
        if not isinstance(data[field], list) or len(data[field]) > 16:
            raise ValueError("bounded observation arrays required")
    if sum(len(data[k]) for k in ("candidates", "relations", "counterexamples")) > 16:
        raise ValueError("at most 16 proposed objects per execution")
    if not isinstance(data["search_scope"], dict) or not data["search_scope"]:
        raise ValueError("explicit search scope required")

    def bounded(value, depth=0):
        if depth > 8:
            raise ValueError("output nesting bound")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("nonfinite output")
        if type(value) is int and value.bit_length() > 256:
            raise ValueError("integer output bound")
        if isinstance(value, str) and len(value) > 4000:
            raise ValueError("object text bound")
        if isinstance(value, (dict, list)):
            if len(value) > 32:
                raise ValueError("object field bound")
            for child in value.values() if isinstance(value, dict) else value:
                bounded(child, depth + 1)

    bounded(data)
    # A guest declaration, including EMPTY_SET, never establishes completeness.
    data["completeness_claim"] = "NOT_ESTABLISHED"
    data["candidates"] = list({fingerprint(x): x for x in data["candidates"]}.values())
    return data


def ingest_execution(store, job, artifact):
    result = json.loads(artifact.text)
    payload = result.get("result")
    output = payload.get("output", "") if isinstance(payload, dict) else ""
    try:
        structured = parse_observation(output)
        error = ""
    except (ValueError, TypeError, RecursionError):
        structured = None
        error = (
            "UNSTRUCTURED_OUTPUT: retained as observation, not a result object or proof"
        )
    row = {
        "schema": "bound-computation-result-v1",
        "artifact": artifact.id,
        "artifact_hash": artifact.digest,
        "job": job["id"],
        "source_hash": store.problem.digest,
        "contract_revision": job["contract_revision"],
        "runtime_hash": job["runtime_hash"],
        "proposal_hash": job["proposal_hash"],
        "execution_receipt_id": job["execution_receipt_id"],
        "effective_deadline": job["effective_deadline"],
        "structured": structured,
        "gap": error,
        "mathematical_status": "UNVERIFIED",
        "usable_output": bool(
            any(structured[k] for k in ("candidates", "relations", "counterexamples"))
        )
        if structured
        else (
            payload is not None
            if job["backend"] == "REGISTERED"
            else bool(
                re.fullmatch(
                    r"\s*[+-]?\d{1,78}(?:/[1-9]\d{0,77}|\.\d{1,78})?\s*", output
                )
            )
        ),
    }
    store.control.setdefault("computation_results", {})[artifact.id] = row
    store.control.setdefault("artifact_contracts", {})[artifact.id] = job[
        "contract_revision"
    ]
    if structured:
        from .goal_ledger import ingest_material

        for candidate in structured["candidates"]:
            # Only explicitly typed members enter the existing independent source checks.
            if not isinstance(candidate, dict) or set(candidate) != {
                "object",
                "domain",
                "parameters",
                "conditions",
                "target",
            }:
                continue
            if not all(
                isinstance(x, str) and x and not any(c in x for c in ";\n\r")
                for x in candidate.values()
            ):
                continue
            text = "BRANCH: {object}; BRANCH_DOMAIN: {domain}; PARAMETERS: {parameters}; BRANCH_CONDITIONS: {conditions}; BRANCH_TARGET: {target}".format(
                **candidate
            )
            ingest_material(
                store, artifact, text=text, origin="executed_" + job["backend"].lower()
            )
    store.event(
        "computation_observed",
        artifact=artifact.id,
        job=job["id"],
        structured=bool(structured),
        gap=error,
        mathematical_status="UNVERIFIED",
    )
    return row


def consumer_context(store, observation_id):
    row = store.control.get("computation_results", {}).get(observation_id)
    artifact = store.artifacts[observation_id]
    if not row or artifact.digest != row["artifact_hash"]:
        raise ValueError("missing or changed execution observation")
    # Full raw output is retained by hash. Do not repeat full guest code in the packet.
    result = json.loads(artifact.text)
    payload = row["structured"] or result.get("result")
    return (
        "\nActual execution observation (UNVERIFIED original mapping):\n"
        + json.dumps(
            {
                "artifact": artifact.id,
                "output_hash": artifact.digest,
                "proposal_hash": row["proposal_hash"],
                "execution_receipt_id": row["execution_receipt_id"],
                "result": payload,
                "remaining_gap": row["gap"],
                "completeness": "NOT_ESTABLISHED",
            },
            ensure_ascii=False,
        )
    )
