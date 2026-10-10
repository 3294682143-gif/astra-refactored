"""Advisory tag routing. No question IDs, answer lookup, or applicability proof."""

import argparse
import json
from pathlib import Path
import sys
from reasoning_contracts import inspect_profile, selection_record

ROOT = Path(__file__).resolve().parents[1]


def _tags(profile, field):
    value = profile.get(field, [])
    if not isinstance(value, list) or len(value) > 64 or any(not isinstance(s, str) or not s or len(s) > 100 for s in value):
        raise ValueError(f"{field} must be a bounded string list")
    return set(value)


def load_registry(root=ROOT):
    data = json.loads((Path(root)/"data/methods.json").read_text(encoding="utf-8"))
    rows = data.get("methods")
    if data.get("schema") != "general-math-methods-v1" or not isinstance(rows, list):
        raise ValueError("invalid method registry")
    ids = [r["id"] for r in rows]
    if not ids or len(ids) != len(set(ids)) or data.get("method_count") != len(ids):
        raise ValueError("invalid method identities")
    by_id = {r["id"]: r for r in rows}
    for r in rows:
        path = Path(r["path"])
        if path.is_absolute() or ".." in path.parts or path.parts[:1] != ("references",):
            raise ValueError("invalid method resource path")
        resolved = (Path(root)/path).resolve()
        if not resolved.is_relative_to(Path(root).resolve()) or not resolved.is_file():
            raise ValueError("missing/outside method file")
        if any(dep not in by_id for dep in r.get("dependencies", [])):
            raise ValueError("missing method dependency")
    return by_id


def rank(profile, registry):
    if not isinstance(profile, dict):
        raise ValueError("profile must be an object")
    tasks, objects, structures = (_tags(profile, f) for f in ("tasks", "objects", "structures"))
    known, contradicted = (_tags(profile, f) for f in ("known_conditions", "contradicted_conditions"))
    requested, failed = (_tags(profile, f) for f in ("requested_methods", "failed_methods"))
    if known & contradicted:
        raise ValueError("condition simultaneously claimed known and contradicted")
    rows = []
    for mid, method in registry.items():
        score = (2*len(tasks & set(method["tasks"]))
                 + 4*len(objects & set(method["objects"]))
                 + 5*len(structures & set(method["structures"]))
                 + 20*int(mid in requested))
        # A common verb alone, e.g. "prove", does not select the whole library.
        meaningful = bool(objects & set(method["objects"]) or
                          structures & set(method["structures"]) or mid in requested)
        if not meaningful:
            continue
        conditions = set(method.get("conditions_to_check", []))
        blocked = sorted(conditions & contradicted)
        if mid in failed:
            blocked.append("previously_failed_without_new_evidence")
        rows.append({"id": mid, "score": score, "path": method["path"],
                     "read_status": "blocked" if blocked else "candidate",
                     "blocked_reasons": blocked,
                     "conditions_still_to_check": sorted(conditions-known),
                     "caller_claimed_known_conditions": sorted(conditions & known),
                     "matched_tags": {"tasks": sorted(tasks & set(method["tasks"])),
                                      "objects": sorted(objects & set(method["objects"])),
                                      "structures": sorted(structures & set(method["structures"]))},
                     "selection_record": selection_record(profile, mid),
                     "condition_semantics_independently_verified": False,
                     "applicability_proved": False})
    return sorted(rows, key=lambda r: (-r["score"], r["id"]))


def choose(profile, *, root=ROOT, loaded=(), max_new=2, max_distinct=5, byte_budget=14000):
    root = Path(root)
    registry = load_registry(root)
    if (type(max_new) is not int or not 0 <= max_new <= 5
            or type(max_distinct) is not int or not 0 <= max_distinct <= 20
            or type(byte_budget) is not int or not 0 <= byte_budget <= 100000):
        raise ValueError("invalid selection budgets")
    if (not isinstance(loaded, (list, tuple, set))
            or any(not isinstance(mid, str) for mid in loaded)
            or set(loaded)-registry.keys()):
        raise ValueError("invalid loaded methods")
    existing, chosen = set(loaded), []
    if len(existing) > max_distinct:
        raise ValueError("loaded set already exceeds declared distinct-card budget")
    ranked = rank(profile, registry)
    outside_requests = sorted(_tags(profile, "requested_methods")-registry.keys())
    external = profile.get("external_methods", [])
    if not isinstance(external, list) or len(external) > 8:
        raise ValueError("external_methods must be a bounded list")
    external_routes = []
    for item in external:
        if (not isinstance(item, dict) or not isinstance(item.get("name"), str)
                or not item["name"].strip() or not isinstance(item.get("rationale"), str)
                or not item["rationale"].strip()):
            raise ValueError("external method requires a name and brief rationale")
        external_routes.append({"name": item["name"], "rationale": item["rationale"],
                                "loaded_card": None, "applicability_proved": False})
    blocked = {r["id"] for r in ranked if r["read_status"] == "blocked"}
    contradicted = _tags(profile, "contradicted_conditions")
    failed = _tags(profile, "failed_methods")

    def closure(mid, stack=()):
        if mid in stack:
            raise ValueError("cyclic method dependencies")
        result = []
        for dep in registry[mid].get("dependencies", []):
            result.extend(closure(dep, stack+(mid,)))
        return list(dict.fromkeys(result+[mid]))

    used, skipped_budget = 0, False
    for candidate in ranked:
        if candidate["read_status"] != "candidate":
            continue
        unit = closure(candidate["id"])
        if any(mid in blocked or mid in failed
               or set(registry[mid].get("conditions_to_check", [])) & contradicted
               for mid in unit):
            continue
        new = [mid for mid in unit if mid not in existing and mid not in chosen]
        if not new:
            continue
        cost = sum((root/registry[mid]["path"]).stat().st_size for mid in new)
        if (len(chosen)+len(new) > max_new or len(existing)+len(chosen)+len(new) > max_distinct
                or used+cost > byte_budget):
            skipped_budget = True
            continue
        chosen.extend(new)
        used += cost
    status = ("selected" if chosen else "budget_exhausted" if skipped_budget
              else "already_loaded" if any(r["id"] in existing and r["read_status"] == "candidate" for r in ranked)
              else "outside_catalog" if outside_requests or external_routes else "no_match")
    return {"status": status, "selected": [{"id": mid, "path": registry[mid]["path"]} for mid in chosen],
            "body_bytes": used, "token_count": None, "ranking_is_not_probability": True,
            "conditions_are_caller_claims_not_proof": True, "candidates": ranked,
            "profile_record": inspect_profile(profile),
            "unregistered_method_requests": outside_requests, "external_routes": external_routes,
            "fallback": {"directory_is_not_whitelist": True,
                         "continue_with": ["direct_reasoning", "alternative_representation",
                                           "outside_catalog_method", "clarify_or_report_open_obligations"],
                         "resource": "references/general-search.md",
                         "new_permissions_granted": False}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, help="JSON profile; stdin if omitted")
    parser.add_argument("--loaded", nargs="*", default=[])
    parser.add_argument("--max-new", type=int, default=2)
    parser.add_argument("--byte-budget", type=int, default=14000)
    args = parser.parse_args()
    try:
        with args.profile.open("rb") if args.profile else sys.stdin.buffer as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError("profile input too large")
        result = choose(json.loads(raw), loaded=args.loaded, max_new=args.max_new,
                        byte_budget=args.byte_budget)
    except (OSError, ValueError, TypeError, KeyError, RecursionError, MemoryError) as exc:
        result = {"status": "invalid_input", "detail": str(exc)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
