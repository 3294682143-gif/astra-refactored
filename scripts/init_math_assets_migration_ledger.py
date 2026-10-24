#!/usr/bin/env python3
"""Build initial math-assets migration ledger (U0).

Maps 20 method cards, 22 math families, and 76 registered tools
to the 26 unified math assets defined in Astra Unified Math Assets Execution Doc.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 26 Unified Assets (Appendix A)
UNIFIED_ASSETS = [
    {"assetId": "math.equations", "name": "定义域与方程", "summary": "定义域、等价变换、方程与函数关系，完整性分别核对。"},
    {"assetId": "math.proof", "name": "证明与反例", "summary": "量词、证明义务、合法见证与反例；可请求有界计算辅助。"},
    {"assetId": "math.invariants", "name": "不变量与极值构造", "summary": "变化规则、不变量、双计数与构造边界。"},
    {"assetId": "math.recurrence", "name": "归纳与递推", "summary": "基例、递推依赖和闭合；有限打表只作观察。"},
    {"assetId": "math.finite-states", "name": "有限状态计数", "summary": "状态转移、数位条件、有限序列与网格路径。"},
    {"assetId": "math.combinatorics", "name": "有限组合计数", "summary": "有限枚举、容斥、禁位排列、计数与概率量的区分。"},
    {"assetId": "math.generating-functions", "name": "生成函数与系数", "summary": "多项式系数、有限生成函数和对象到系数的对应。"},
    {"assetId": "math.diophantine", "name": "整数方程", "summary": "整数条件、同余、二次族和符号解；保留搜索边界。"},
    {"assetId": "math.integration", "name": "积分与对称", "summary": "积分条件、变量、区间、对称和精确积分请求。"},
    {"assetId": "math.geometry", "name": "坐标与有限几何", "summary": "坐标、直线、角、有限点集与覆盖，保留退化及数值范围。"},
    {"assetId": "math.optimization", "name": "不等式与优化", "summary": "界、约束、驻点、取等及有限搜索，区分全局证明。"},
    {"assetId": "math.linear-algebra", "name": "线性代数", "summary": "数域、矩阵、秩、核空间、线性系统和极大子式。"},
    {"assetId": "math.probability", "name": "概率与随机过程", "summary": "概率建模、密度、期望、覆盖时间和近似概率。"},
    {"assetId": "math.limits", "name": "极限与收敛", "summary": "收敛条件、极限、局部与整体交换条件。"},
    {"assetId": "math.differential", "name": "微分与微分方程", "summary": "微分算子、Laplacian、三角化简及方程验证边界。"},
    {"assetId": "math.algebraic-structures", "name": "群环域与代数结构", "summary": "群结构、域扩张、代数关系、多项式根与分解。"},
    {"assetId": "math.topology", "name": "拓扑与局部整体", "summary": "拓扑定义、紧致、完备、局部与整体，指导和证明义务。"},
    {"assetId": "math.statistics", "name": "统计推断", "summary": "统计模型、估计、检验、充分性和适用条件。"},
    {"assetId": "math.regression", "name": "回归诊断", "summary": "OLS 系数、残差、拟合量和模型假设。"},
    {"assetId": "math.numerics", "name": "数值计算与误差", "summary": "插值、差分、外推、误差及闭式猜想的证据边界。"},
    {"assetId": "math.encoding", "name": "编码与序列", "summary": "LZ78 的编码、解码、校验与表示；与组合枚举分开解释。"},
    {"assetId": "math.graphs", "name": "有限图", "summary": "匹配、子图、Tutte 见证和有限图颜色约束。"},
    {"assetId": "math.tiling", "name": "铺砌与覆盖", "summary": "有限棋盘、形状、覆盖、颜色下界与具体铺砌证书。"},
    {"assetId": "math.games", "name": "有限博弈", "summary": "状态图、终局、策略见证、minimax 和有限牌组。"},
    {"assetId": "math.lattices", "name": "格点几何", "summary": "明确有限区域的格点与格上图形计数。"},
    {"assetId": "math.integer-structure", "name": "整数结构", "summary": "奇部、剩余表和有界数值半群。"},
]

# 20 Method Sources (Appendix B1)
METHOD_MAPPINGS = {
    "domain-equivalence": "math.equations",
    "proof-counterexamples": "math.proof",
    "invariants-extremal": "math.invariants",
    "induction-recurrence": "math.recurrence",
    "finite-state-dp": "math.finite-states",
    "counting-bijections": "math.combinatorics",
    "generating-functions": "math.generating-functions",
    "modular-crt": "math.diophantine",
    "integral-symmetry": "math.integration",
    "coordinates-geometry": "math.geometry",
    "inequalities-optimization": "math.optimization",
    "linearization-spectral": "math.linear-algebra",
    "conditioning-indicators": "math.probability",
    "convergence-limits": "math.limits",
    "differential-equations": "math.differential",
    "algebraic-structures": "math.algebraic-structures",
    "topology-local-global": "math.topology",
    "statistical-inference": "math.statistics",
    "regression-diagnostics": "math.regression",
    "numerical-approximation": "math.numerics",
}

# 22 Family Sources (Appendix B2)
FAMILY_MAPPINGS = {
    "algorithm_simulation": ["math.combinatorics", "math.encoding"],
    "classical_geometry_compute": ["math.geometry", "math.numerics"],
    "combinatorial_geometry": ["math.geometry"],
    "concept_recall": ["math.proof", "math.topology", "math.statistics"],
    "constrained_tiling": ["math.invariants", "math.tiling"],
    "digit_dp": ["math.finite-states"],
    "diophantine": ["math.diophantine"],
    "extremal_construction": ["math.invariants"],
    "functional_equation": ["math.equations", "math.graphs"],
    "game_strategy_proof": ["math.invariants", "math.games"],
    "graph_extremal": ["math.invariants", "math.graphs"],
    "inclusion_exclusion_counting": ["math.combinatorics"],
    "inequality_extremum": ["math.optimization", "math.numerics"],
    "lattice_counting": ["math.geometry", "math.lattices"],
    "linear_algebra_game": ["math.linear-algebra", "math.games"],
    "minimax_dp": ["math.finite-states", "math.games"],
    "number_theory_structure": ["math.recurrence", "math.diophantine", "math.integer-structure"],
    "numerical_methods": ["math.numerics"],
    "probabilistic_model": ["math.probability", "math.statistics", "math.regression"],
    "symbolic_algebra": ["math.equations", "math.linear-algebra", "math.algebraic-structures", "math.numerics"],
    "symbolic_calculus": ["math.integration", "math.limits", "math.differential"],
    "transfer_matrix": ["math.recurrence", "math.finite-states"],
}

# 76 Implementation Checklist (Appendix C)
TOOL_MIGRATIONS = [
    ("finite_group_structure", "math.algebraic-structures", "W0", "available"),
    ("splitting_field_degree_expr", "math.algebraic-structures", "W0", "partial"),
    ("bounded_enumeration", "math.combinatorics", "W0", "available"),
    ("count_avoiding_permutations", "math.combinatorics", "W0", "available"),
    ("rook_numbers", "math.combinatorics", "W0", "available"),
    ("circle_laplacian_expr", "math.differential", "W0", "available"),
    ("planar_laplacian_expr", "math.differential", "W0", "available"),
    ("solve_quadratic_diophantine", "math.diophantine", "W0", "partial"),
    ("symbolic_diophantine_with_timeout", "math.diophantine", "W0", "partial"),
    ("exact_check_expr", "math.equations", "W0", "available"),  # also split in D1
    ("polynomial_function_check", "math.equations", "W0", "available"),
    ("real_root_count_expr", "math.equations", "W0", "partial"),
    ("solve_system_guarded_expr", "math.equations", "W0", "partial"),
    ("count_by_digit_property", "math.finite-states", "W0", "available"),
    ("independence_polynomial_chain", "math.finite-states", "W0", "available"),
    ("transition_count", "math.finite-states", "W0", "available"),
    ("polynomial_expand_coefficients", "math.generating-functions", "W0", "available"),
    ("gf2_nullspace", "math.linear-algebra", "W0", "available"),
    ("gf2_rank", "math.linear-algebra", "W0", "available"),
    ("linear_system_solution_set", "math.linear-algebra", "W0", "available"),
    ("finite_difference_derivative", "math.numerics", "W0", "available"),
    ("interpolation_fit_check", "math.numerics", "W0", "available"),
    ("richardson_extrapolate", "math.numerics", "W0", "available"),
    ("cover_time_complete_graph", "math.probability", "W0", "available"),
    ("markov_expected_steps", "math.probability", "W0", "available"),
    ("stats_ols_check", "math.regression", "W0", "available"),
    ("format_phrases", "math.encoding", "W1", "available"),
    ("lz78_bit_string", "math.encoding", "W1", "available"),
    ("lz78_decode", "math.encoding", "W1", "available"),
    ("lz78_encode", "math.encoding", "W1", "available"),
    ("verify_phrases", "math.encoding", "W1", "available"),
    ("constraint_propagation_2coloring", "math.graphs", "W1", "available"),
    ("count_complete_bipartite_subgraphs", "math.graphs", "W1", "partial"),
    ("has_perfect_matching", "math.graphs", "W1", "partial"),
    ("triangle_free_check", "math.graphs", "W1", "partial"),
    ("tutte_violation", "math.graphs", "W1", "partial"),
    ("verify_perfect_matching", "math.graphs", "W1", "partial"),
    ("angle_at_vertex", "math.geometry", "W2", "partial"),
    ("area_bisection_coverage", "math.geometry", "W2", "partial"),
    ("count_angle_ratio_locus", "math.geometry", "W2", "partial"),
    ("line_cover_number", "math.geometry", "W2", "partial"),
    ("line_separation_number", "math.geometry", "W2", "partial"),
    ("line_through", "math.geometry", "W2", "partial"),
    ("worst_configuration_search", "math.geometry", "W2", "partial"),
    ("count_lattice_hexagons", "math.lattices", "W2", "available"),
    ("hexagon_lattice_points", "math.lattices", "W2", "available"),
    ("lattice_points_in_polygon", "math.lattices", "W2", "available"),
    ("deletion_divisible_largest", "math.finite-states", "W3", "available"),
    ("digit_sum_window_search", "math.finite-states", "W3", "available"),
    ("hamiltonian_paths_grid", "math.finite-states", "W3", "available"),
    ("deck_game_outcome", "math.games", "W3", "available"),
    ("gap_subsequence_discrepancy", "math.games", "W3", "available"),
    ("independent_reply_certificate", "math.games", "W3", "partial"),
    ("minimax_value_graph", "math.games", "W3", "available"),
    ("pairing_strategy_verify", "math.games", "W3", "partial"),
    ("win_draw_loss_graph", "math.games", "W3", "available"),
    ("check_tiling_certificate", "math.tiling", "W3", "partial"),
    ("coloring_bound", "math.tiling", "W3", "partial"),
    ("count_tilings", "math.tiling", "W3", "partial"),
    ("min_tiles_cover", "math.tiling", "W3", "partial"),
    ("unique_tiling_check", "math.tiling", "W3", "partial"),
    ("algebraic_polynomial_check", "math.algebraic-structures", "W4", "available"),
    ("wronskian_root_identity_expr", "math.algebraic-structures", "W4", "available"),
    ("solve_quadratic_discriminant_family", "math.diophantine", "W4", "partial"),
    ("frobenius_semigroup", "math.integer-structure", "W4", "partial"),
    ("odd_part", "math.integer-structure", "W4", "partial"),
    ("odd_part_table", "math.integer-structure", "W4", "partial"),
    ("double_counting_bound", "math.invariants", "W4", "partial"),
    ("polynomial_invariant_check", "math.invariants", "W4", "available"),
    ("closed_form_conjecture", "math.numerics", "W5", "partial"),
    ("identify_constant", "math.numerics", "W5", "partial"),
    ("verify_fd_certificate", "math.numerics", "W5", "available"),
    ("certificate_check_expr", "math.optimization", "W5", "partial"),
    ("numeric_extremum_search_expr", "math.optimization", "W5", "partial"),
    ("subset_gap_worst_case", "math.optimization", "W5", "partial"),
    ("normal_overflow_seats", "math.probability", "W5", "available"),
]


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    print(f"Loading sources from {ROOT} ...")

    # Verify tool registry
    tool_reg_path = ROOT / "mathagent/resources/tool-registry.json"
    tool_reg = json.loads(tool_reg_path.read_text(encoding="utf-8"))
    reg_tools = tool_reg["tools"]
    assert len(reg_tools) == 76, f"Expected 76 tools in registry, got {len(reg_tools)}"

    # Verify method cards
    methods_json_path = ROOT / "mathagent/resources/general_v11/data/methods.json"
    methods_json = json.loads(methods_json_path.read_text(encoding="utf-8"))
    methods_list = methods_json["methods"]
    assert len(methods_list) == 20, f"Expected 20 method cards, got {len(methods_list)}"

    # Method card files
    methods_entries = []
    for m in methods_list:
        mid = m["id"]
        target_asset = METHOD_MAPPINGS.get(mid)
        assert target_asset is not None, f"Unmapped method: {mid}"
        card_file = ROOT / "mathagent/resources/general_v11/references" / f"{mid}.md"
        sha = file_sha256(card_file) if card_file.exists() else None
        methods_entries.append({
            "sourceId": mid,
            "title": m["title"],
            "targetAssetId": target_asset,
            "sourcePath": f"mathagent/resources/general_v11/references/{mid}.md",
            "sourceSha256": sha,
            "status": "pending_migration"
        })

    # Family entries
    family_manifest_path = ROOT / "mathagent/resources/skill-mapping-manifest.json"
    family_manifest = json.loads(family_manifest_path.read_text(encoding="utf-8"))
    family_list = family_manifest["families"]
    assert len(family_list) == 22, f"Expected 22 families, got {len(family_list)}"

    families_entries = []
    for f in family_list:
        fid = f["family_id"]
        target_assets = FAMILY_MAPPINGS.get(fid, [])
        assert target_assets, f"Unmapped family: {fid}"
        skill_file = ROOT / "mathagent/resources/skills" / f"{fid}.md"
        sha = file_sha256(skill_file) if skill_file.exists() else None
        families_entries.append({
            "sourceFamilyId": fid,
            "targetAssetIds": target_assets,
            "sourcePath": f"mathagent/resources/skills/{fid}.md",
            "sourceSha256": sha,
            "status": "pending_migration"
        })

    # Tool migration entries
    assert len(TOOL_MIGRATIONS) == 76, f"Expected 76 migrations, got {len(TOOL_MIGRATIONS)}"
    tools_entries = []
    for idx, (tname, target_asset, batch, baseline_scope) in enumerate(TOOL_MIGRATIONS, 1):
        assert tname in reg_tools, f"Tool {tname} not found in registry"
        reg_info = reg_tools[tname]
        tools_entries.append({
            "number": idx,
            "toolName": tname,
            "targetAssetId": target_asset,
            "batch": batch,
            "baselineScope": baseline_scope,
            "family": reg_info.get("family"),
            "status": "pending_migration",
            "testFixture": None,
            "acceptanceStatus": "pending"
        })

    ledger = {
        "schemaVersion": "math-assets-migration-ledger-v1",
        "baselineCommit": "2265dff253175505068a7c323dd0a94d742b0e5d",
        "unifiedAssets": UNIFIED_ASSETS,
        "summary": {
            "canonicalAssetCount": len(UNIFIED_ASSETS),
            "migratedMethodSourcesTotal": len(methods_entries),
            "migratedFamilySourcesTotal": len(families_entries),
            "migratedImplementationSourcesTotal": len(tools_entries),
            "batches": {
                "W0": sum(1 for t in tools_entries if t["batch"] == "W0"),
                "W1": sum(1 for t in tools_entries if t["batch"] == "W1"),
                "W2": sum(1 for t in tools_entries if t["batch"] == "W2"),
                "W3": sum(1 for t in tools_entries if t["batch"] == "W3"),
                "W4": sum(1 for t in tools_entries if t["batch"] == "W4"),
                "W5": sum(1 for t in tools_entries if t["batch"] == "W5"),
            }
        },
        "methods": methods_entries,
        "families": families_entries,
        "implementations": tools_entries,
    }

    out_path = ROOT / "docs/math-assets-migration-ledger.json"
    out_path.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote ledger to {out_path} with {len(UNIFIED_ASSETS)} assets, {len(methods_entries)} methods, {len(families_entries)} families, {len(tools_entries)} tools.")
    print("Batch breakdown:", ledger["summary"]["batches"])


if __name__ == "__main__":
    main()
