from __future__ import annotations

import json
import re
from importlib.resources import files

from .input_contracts import INTEGER_RULES, SCHEMAS
from .tool_contracts import CONTRACTS

METHODS = {
    "algorithm_simulation": "simulate a precise process and check its trace",
    "classical_geometry_compute": "translate geometric objects to explicit coordinates",
    "combinatorial_geometry": "count or cover finite geometric configurations",
    "concept_recall": "identify relevant definitions and theorem prerequisites",
    "constrained_tiling": "enumerate tilings with explicit shapes and constraints",
    "digit_dp": "track digit states, residues and finite boundaries",
    "diophantine": "derive integer-solution constraints and check bounded families",
    "extremal_construction": "construct witnesses and separate lower from upper bounds",
    "functional_equation": "choose substitutions, track domains and verify both directions",
    "game_strategy_proof": "state a strategy and check every modeled opponent response",
    "graph_extremal": "use forbidden subgraphs, matchings and finite certificates",
    "inclusion_exclusion_counting": "define the counted objects and their overlap correction",
    "inequality_extremum": "derive bounds and separately test candidate equality cases",
    "lattice_counting": "count explicit lattice regions without replacing global bounds",
    "linear_algebra_game": "reduce XOR constraints to finite GF(2) linear algebra",
    "minimax_dp": "define terminal values and state transitions before backward analysis",
    "number_theory_structure": "use divisibility, valuations and congruence structure",
    "numerical_methods": "use approximations with explicit step sizes and error limits",
    "probabilistic_model": "state the probability model before computing expectations",
    "symbolic_algebra": "preserve domains while manipulating equations and polynomials",
    "symbolic_calculus": "check differentiation and integration prerequisites",
    "transfer_matrix": "encode frontier states and check the finite transition model",
}


class SkillCatalog:
    def __init__(self):
        root = files("mathagent").joinpath("resources")
        self.root = root
        self.families = json.loads(
            root.joinpath("skill-mapping-manifest.json").read_text(encoding="utf-8")
        )["families"]
        self.by_id = {f["family_id"]: f for f in self.families}
        math_assets_path = root.joinpath("math-assets.json")
        if math_assets_path.is_file():
            catalog = json.loads(math_assets_path.read_text(encoding="utf-8"))
            self.tool_specs = {}
            for asset in catalog.get("assets", []):
                for beh in asset.get("behaviors", []):
                    spec = {
                        "required_params": list(beh.get("requiredParams", [])),
                        "optional_params": list(beh.get("optionalParams", [])),
                        "declared_scope": beh.get("declaredScope", asset.get("summary", "")),
                        "asset_id": asset["assetId"],
                        "target": beh["target"],
                    }
                    self.tool_specs[beh["target"]] = spec
                    legacy_name = beh.get("legacyToolName")
                    if legacy_name:
                        self.tool_specs[legacy_name] = spec
        else:
            self.tool_specs = {}

    def metadata(self):
        from .computation_policy import capability_metadata

        # All domains discoverable, but no full bodies in the first planning call.
        return (
            capability_metadata()
            + "\n"
            + "\n".join(
                f"{f['family_id']}: {METHODS[f['family_id']]}; tools={','.join(f['tools']) or 'independent reasoning'}"
                for f in self.families
            )
        )

    def search(self, text: str, suggested=(), *, context=()):
        valid = [f for f in suggested if f in self.by_id]
        keywords = {
            "algorithm_simulation": (
                "lz78",
                "lempel",
                "decode",
                "decoding",
                "encoding",
                "simulation",
                "模拟",
                "编码",
            ),
            "combinatorial_geometry": ("line cover", "separation", "组合几何"),
            "concept_recall": ("definition", "theorem", "定义", "定理", "统计学"),
            "constrained_tiling": ("tiling", "tile", "铺砌"),
            "diophantine": ("diophantine", "integer equation", "丢番图"),
            "extremal_construction": ("construction", "构造"),
            "functional_equation": ("functional equation", "函数方程"),
            "game_strategy_proof": ("game", "strategy", "博弈"),
            "inclusion_exclusion_counting": (
                "inclusion-exclusion",
                "rook",
                "permutation",
                "容斥",
            ),
            "inequality_extremum": ("inequality", "extremum", "不等式", "最值"),
            "lattice_counting": ("lattice", "格点"),
            "linear_algebra_game": ("gf2", "gf(2)", "nullspace", "xor", "线性代数"),
            "minimax_dp": (
                "minimax",
                "backward induction",
                "dynamic programming",
                "动态规划",
                "倒推",
            ),
            "numerical_methods": (
                "finite difference",
                "central difference",
                "richardson",
                "数值微分",
                "中心差分",
            ),
            "transfer_matrix": (
                "transfer matrix",
                "frontier",
                "independence polynomial",
                "independent set",
                "hamiltonian path",
                "转移矩阵",
                "哈密顿",
            ),
            "digit_dp": ("digit", "数位", "数字和"),
            "symbolic_algebra": (
                "algebra",
                "equation",
                "polynomial",
                "代数",
                "方程",
                "多项式",
            ),
            "symbolic_calculus": ("integral", "derivative", "积分", "导数"),
            "graph_extremal": ("graph", "matching", "图", "匹配"),
            "number_theory_structure": (
                "number theory",
                "prime",
                "divisib",
                "congruence",
                "数论",
                "素数",
                "整除",
            ),
            "probabilistic_model": ("probability", "expect", "概率", "期望"),
            "classical_geometry_compute": ("triangle", "circle", "三角形", "圆"),
        }
        lowered = text.lower().replace("_", " ").replace("-", " ")
        advice = (
            " ".join(str(s) for s in suggested)
            .lower()
            .replace("_", " ")
            .replace("-", " ")
        )
        background = " ".join(context).lower().replace("_", " ").replace("-", " ")

        def matched(word, haystack):
            word = word.replace("-", " ")
            suffix = r"[a-z]*" if word in {"divisib", "expect"} else r"s?"
            return (
                bool(
                    re.search(
                        r"(?<![a-z0-9])" + re.escape(word) + suffix + r"(?![a-z0-9])",
                        haystack,
                    )
                )
                if word.isascii()
                else word in haystack
            )

        scores = [
            (
                4
                * sum(
                    matched(word, lowered)
                    for word in (*words, family.replace("_", " "))
                )
                + 2
                * int(
                    family in valid
                    or any(
                        matched(word, advice)
                        for word in (*words, family.replace("_", " "))
                    )
                )
                + min(3, sum(matched(word, background) for word in words)),
                family,
            )
            for family, words in keywords.items()
        ]
        ranked = [
            family
            for score, family in sorted(
                scores,
                key=lambda row: (
                    -row[0],
                    valid.index(row[1]) if row[1] in valid else 99,
                    row[1],
                ),
            )
            if score
        ]
        return tuple(dict.fromkeys(ranked + valid))[
            :3
        ]  # Empty is an explicit general-reasoning path.

    def load_for(self, goal: str, suggestions=(), *, context=()):
        chosen = self.search(goal, suggestions, context=context)
        if not chosen:
            return ""
        # One complete relevant body, never the whole catalog or a truncated tail.
        body = self.root.joinpath("skills", chosen[0] + ".md").read_text(
            encoding="utf-8"
        )
        notes = []
        integer_rules = set()
        for name in self.by_id[chosen[0]]["tools"]:
            if name in CONTRACTS:
                property_name, scope = CONTRACTS[name]
                notes.append(
                    f"{name}: independent output check only for {property_name}; {scope}. Original problem mapping remains unverified."
                )
            elif name in SCHEMAS:
                notes.append(
                    f"{name}: execution input types={json.dumps(SCHEMAS[name])}; output is not independently certified."
                )
            if name in SCHEMAS:
                integer_rules.update(set(SCHEMAS[name].values()) & INTEGER_RULES.keys())
            spec = self.tool_specs.get(name, {})
            notes.append(
                f"{name} INPUT required={spec.get('required_params', [])}; "
                f"optional={spec.get('optional_params', [])}; "
                f"types={json.dumps(SCHEMAS.get(name, spec.get('input_schema', {})), ensure_ascii=False)}. "
                "Use these exact argument names; a tool name alone is not an executable proposal."
            )
        bounds = {key: INTEGER_RULES[key] for key in sorted(integer_rules)}
        return (
            body
            + "\n\nCurrent registered execution subset (supersedes broader source examples):\n"
            + "\n".join(notes)
            + "\nExplicit integer parameter ranges: "
            + json.dumps(bounds)
            + "\nOmitted arguments use registered defaults; all executions remain resource-bounded. No result establishes its own mapping to the original problem."
        )
