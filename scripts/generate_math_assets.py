#!/usr/bin/env python3
"""Generate canonical mathagent/resources/math-assets.json (U1).

Builds the single source of truth containing all 26 unified math assets,
migrating instructions from 20 method cards and 22 family descriptors,
and binding 82 computational behaviors representing all 76 registered tools
(including exact_check_expr split across 7 assets).
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 26 Unified Math Assets with full instructions, schemas, examples, and behavior bindings
ASSETS_SPEC = [
    {
        "assetId": "math.equations",
        "name": "定义域与方程",
        "version": "1.0.0",
        "summary": "分析定义域约束、等价代数变换、实根多项式判别与代数方程系统解集。",
        "instructions": {
            "conditions": [
                "原式及变量域可明确保留，求解目标是原式而非约分/平方后的替代式",
                "对可能为零、异号、参数退化的代数变形必须拆分支讨论",
                "函数方程必须明确全称量词与自变量取值范围"
            ],
            "procedure": [
                "变形前先登记分母非零、根号被开方式非负、对数真数大于零等定义域限制",
                "对推导变形严格区分'充要等价'与'必要推导'；必要推导后必须代回原式排除增根",
                "求完整解集时必须独立证明解集的完备性（无漏解）",
                "调用实根判别或多项式化简核对中间代数步骤的严格零差"
            ],
            "misuse": [
                "把 sqrt(x^2) 无条件写成 x，忽略绝对值与分支",
                "把多项式等价化简等同于求解完原方程，忽略约去因式导致的定义域改变",
                "把隔离实解个数的数值探测当作完整代数证明"
            ],
            "verificationBoundary": "符号计算与化简仅保证给定输入在代数上的严格零差与孤立根计数，不自动证明原题建模与定义域还原的完整性。"
        },
        "behaviors": [
            {
                "target": "real_roots",
                "implementationRef": "impl.equations.real-roots.v1",
                "legacyToolName": "real_root_count_expr",
                "legacyOperation": None,
                "declaredScope": "Exact real root count of a univariate rational polynomial via Sturm sequence",
                "requiredParams": ["expression"],
                "optionalParams": ["variable", "timeout_ms"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.real-roots.v1"
            },
            {
                "target": "simplify",
                "implementationRef": "impl.equations.simplify.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "SIMPLIFY",
                "declaredScope": "Exact algebraic canonicalization and zero-residual verification of rational expressions",
                "requiredParams": ["expression"],
                "optionalParams": ["variable"],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial.v1"
            },
            {
                "target": "solve_system",
                "implementationRef": "impl.equations.solve-system.v1",
                "legacyToolName": "solve_system_guarded_expr",
                "legacyOperation": None,
                "declaredScope": "Isolated real solutions count for guarded affine or decoupled polynomial systems",
                "requiredParams": ["expressions", "variables"],
                "optionalParams": ["timeout_ms", "n_starts", "seed"],
                "resultType": "integer",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "function_identity",
                "implementationRef": "impl.equations.function-identity.v1",
                "legacyToolName": "polynomial_function_check",
                "legacyOperation": None,
                "declaredScope": "Exact identity check and counterexample search for polynomial candidates in functional equations",
                "requiredParams": ["equation", "function", "argument", "variables", "expression"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial-identity.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "求三次方程 x^3 - 3x + 1 = 0 的不同实根个数", "input": {"target": "real_roots", "expression": "x**3 - 3*x + 1", "variable": "x"}},
                {"description": "验证代数式化简零差", "input": {"target": "simplify", "expression": "(x**2 - 1)/(x - 1)", "variable": "x"}}
            ],
            "negative": [
                {"description": "含超越函数方程的全局解析解求解", "reason": "超越方程全局解集超出代数方程算子边界，应转入分析推理。"}
            ]
        }
    },
    {
        "assetId": "math.proof",
        "name": "证明与反例",
        "version": "1.0.0",
        "summary": "命题逻辑结构化分析、量词转换、证明义务分解与有限反例/见证搜索。",
        "instructions": {
            "conditions": [
                "命题包含明确全称量词 ∀ 或存在量词 ∃",
                "否定全称命题只需构造一个满足前提且否定结论的具体见证反例",
                "证明全称命题必须给出一般性演绎，有限个例不能当作证明"
            ],
            "procedure": [
                "识别待证命题的前提集合 P 与结论集合 Q",
                "对否定全称命题 ∀x P(x) => Q(x)，转换为存在性寻找 ∃x (P(x) ∧ ¬Q(x))",
                "在极小退化边界或小规模有限参数空间中暴力搜索潜在反例",
                "若找到具体反例，给出显式参数并验证其严格满足反例条件"
            ],
            "misuse": [
                "在有限个小参数上验证成立后，声称已证明全称命题",
                "构造的反例并不满足题设前提 P"
            ],
            "verificationBoundary": "反例见证只对显式构造的具体对象有效；未找到反例不能作为命题成立的数学证明。"
        },
        "behaviors": [],
        "examples": {
            "positive": [
                {"description": "命题分析与反例寻找指导", "input": {"target": "analyze", "question": "是否存在不满足可交换性的4阶有限群？"}}
            ],
            "negative": [
                {"description": "请求输出任意哥德巴赫猜想的机器证明", "reason": "超出有界推理能力，应分解为具体有限引理。"}
            ]
        }
    },
    {
        "assetId": "math.invariants",
        "name": "不变量与极值构造",
        "version": "1.0.0",
        "summary": "离散变换下的守恒不变量、单调势能函数、双计数界与极值构型构造。",
        "instructions": {
            "conditions": [
                "系统经历离散状态转移或局域操作",
                "存在模同余、奇偶性、拓扑指标或多项式守恒量",
                "包含二元关系发生图的双计数（Double Counting）"
            ],
            "procedure": [
                "写出基本操作引起的状态变化量 ΔS",
                "寻找在所有允许操作下保持严格不变的映射 I(S_next) = I(S_curr)",
                "对比初始状态 I(S_0) 与目标状态 I(S_target)，若二者在不变量下不相等，则目标不可达",
                "若构建不等式界，通过二元关系发生矩阵的行和与列和建立双计数等式"
            ],
            "misuse": [
                "假设的单调势能存在反弹循环却声称必定终止",
                "把局部极值误当成全局唯一极值构型"
            ],
            "verificationBoundary": "不变量检查只验证给定变换在代数上是否严格零差；不变量相符不代表目标态必定可达。"
        },
        "behaviors": [
            {
                "target": "polynomial_invariant",
                "implementationRef": "impl.invariants.poly-invariant.v1",
                "legacyToolName": "polynomial_invariant_check",
                "legacyOperation": None,
                "declaredScope": "Exact check of polynomial invariance under forward discrete polynomial mappings",
                "requiredParams": ["base_variables", "variables", "forward", "target", "invariants"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial-identity.v1"
            },
            {
                "target": "double_counting",
                "implementationRef": "impl.invariants.double-counting.v1",
                "legacyToolName": "double_counting_bound",
                "legacyOperation": None,
                "declaredScope": "Exact comparison and bounding between two incidence count views",
                "requiredParams": ["count_a", "count_b"],
                "optionalParams": ["description"],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "验证变换 (x, y) -> (x+y, x-y) 下的多项式不变性", "input": {"target": "polynomial_invariant", "base_variables": ["x", "y"], "variables": ["x", "y"], "forward": ["x+y", "x-y"], "target": "x**2+y**2", "invariants": ["x**2+y**2"]}}
            ],
            "negative": [
                {"description": "无限维动力系统的全局吸收集分析", "reason": "超出有限多项式不变量边界。"}
            ]
        }
    },
    {
        "assetId": "math.recurrence",
        "name": "归纳与递推",
        "version": "1.0.0",
        "summary": "数学归纳法逻辑链、线性与非线性递推数列、良基偏序结构。",
        "instructions": {
            "conditions": [
                "离散参数 n 满足良基性（通常 n ∈ N* 或良基偏序集合）",
                "后继状态可由有限个前驱状态的确定性递推关系表示",
                "基例验证充分且不存在降次漏洞"
            ],
            "procedure": [
                "严格验证初始基例（例如 n=1, 2）",
                "明确写出归纳假设：假设对所有 k < n 命题成立（强归纳）或 k = n 成立（弱归纳）",
                "推导 n+1 状态时，必须显式标明归纳假设的应用位置与适用边界",
                "对递推数列可通过特征方程、生成函数或转移矩阵求解精确通项"
            ],
            "misuse": [
                "基例验证不充分（如斐波那契型二阶递推只验证了 n=1 漏掉 n=2）",
                "在归纳步中暗中引入了未被归纳假设覆盖的全局性质"
            ],
            "verificationBoundary": "前有限项的小样本打表只能作为规律猜想的经验支撑，严禁直接替代归纳步的逻辑演绎。"
        },
        "behaviors": [],
        "examples": {
            "positive": [
                {"description": "分析递推数列 a_{n+1} = 2a_n + 1 的归纳假设与特征根", "input": {"target": "analyze", "question": "求解 a_{n+1} = 2*a_n + 1, a_1 = 1 的通项公式"}}
            ],
            "negative": [
                {"description": "打表前5项即断言高阶非线性数列的通项", "reason": "有限数值打表不是通项成立的充分证明。"}
            ]
        }
    },
    {
        "assetId": "math.finite-states",
        "name": "有限状态计数",
        "version": "1.0.0",
        "summary": "有限自动机状态转移路径计数、数位DP特征统计与网格哈密顿路径分析。",
        "instructions": {
            "conditions": [
                "状态空间为有限集（|S| ≤ 64）",
                "步数或序列长度明确（L ≤ 6）",
                "转移规则具有马尔可夫无后效性"
            ],
            "procedure": [
                "划分有限状态集合并明确转移拓扑与初始/终止状态集",
                "提取转移矩阵或转移边集 [[u,v],...]",
                "调用精确状态转移计数算子计算长度为 L 的有效序列总数",
                "对数位性质计数，指定基数、最大位数及同余模数"
            ],
            "misuse": [
                "混淆顶点序列长度（length）与边数（edges）",
                "把连续状态或带有无限记忆的状态强行压缩为有限状态模型"
            ],
            "verificationBoundary": "计数结果严格受限于指定的有限状态机拓扑与有界步长，不推广至连续状态系统。"
        },
        "behaviors": [
            {
                "target": "transition_count",
                "implementationRef": "impl.finite-states.transition-count.v1",
                "legacyToolName": "transition_count",
                "legacyOperation": None,
                "declaredScope": "Exact count of vertex sequences of specified length in a finite state graph",
                "requiredParams": ["length", "num_states", "transitions"],
                "optionalParams": ["starts", "ends"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "independence_polynomial",
                "implementationRef": "impl.finite-states.independence-poly.v1",
                "legacyToolName": "independence_polynomial_chain",
                "legacyOperation": None,
                "declaredScope": "Independence polynomial coefficients for path graph P_n",
                "requiredParams": ["n"],
                "optionalParams": [],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "digit_property_count",
                "implementationRef": "impl.finite-states.digit-property.v1",
                "legacyToolName": "count_by_digit_property",
                "legacyOperation": None,
                "declaredScope": "Exact integer count of numbers formed by given digits satisfying modular property",
                "requiredParams": ["digit_set", "max_digits"],
                "optionalParams": ["modulus", "residue", "include_zero"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "deletion_divisible_largest",
                "implementationRef": "impl.finite-states.deletion-divisible.v1",
                "legacyToolName": "deletion_divisible_largest",
                "legacyOperation": None,
                "declaredScope": "Search for largest divisible number under digit deletion property",
                "requiredParams": [],
                "optionalParams": ["distinct_digits", "max_digits"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "digit_sum_window",
                "implementationRef": "impl.finite-states.digit-sum-window.v1",
                "legacyToolName": "digit_sum_window_search",
                "legacyOperation": None,
                "declaredScope": "Search window properties on digit sum modular sequences",
                "requiredParams": ["window", "modulus"],
                "optionalParams": ["max_n"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "hamiltonian_paths_grid",
                "implementationRef": "impl.finite-states.hamiltonian-paths.v1",
                "legacyToolName": "hamiltonian_paths_grid",
                "legacyOperation": None,
                "declaredScope": "Exact count of directed Hamiltonian paths on bounded grid graphs",
                "requiredParams": ["width", "height"],
                "optionalParams": ["vertical", "right", "wrap", "start_rows", "end_rows"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算2状态自动机长为3的转移序列数", "input": {"target": "transition_count", "length": 3, "num_states": 2, "transitions": [[0, 1], [1, 0], [1, 1]]}},
                {"description": "计算数位属于{1,2,3}且被3整除的三位数个数", "input": {"target": "digit_property_count", "digit_set": [1, 2, 3], "max_digits": 3, "modulus": 3, "residue": 0, "include_zero": False}}
            ],
            "negative": [
                {"description": "无限状态连续马尔可夫链稳态分布", "reason": "超出离散有限状态转移矩阵算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.combinatorics",
        "name": "有限组合计数",
        "version": "1.0.0",
        "summary": "排列组合、容斥原理、禁位排列（错排）与车多项式系数计算。",
        "instructions": {
            "conditions": [
                "问题涉及离散有限集合上的选法、排列、划分或匹配",
                "包含禁位排列或棋盘多项式约束",
                "严格区分纯整数计数值与基于等可能样本空间的概率比值"
            ],
            "procedure": [
                "明确样本空间大小与所求事件的目标约束集合",
                "若存在互斥划分，应用加法原理；若存在独立步骤，应用乘法原理",
                "若存在交叠约束，建立容斥原理展开式 ∑ (-1)^k S_k",
                "调用有界枚举、禁位排列或车数算子核实有限小规模基线数值"
            ],
            "misuse": [
                "把有界枚举算出的分子整数直接当作最终概率答案",
                "车多项式禁位坐标行列颠倒或超出棋盘大小 0 <= r, c < n"
            ],
            "verificationBoundary": "组合工具输出的是显式输入的有界纯整数组合数，不直接推导无限族序列的渐近阶。"
        },
        "behaviors": [
            {
                "target": "enumerate",
                "implementationRef": "impl.combinatorics.bounded-enum.v1",
                "legacyToolName": "bounded_enumeration",
                "legacyOperation": None,
                "declaredScope": "Exact discrete predicate evaluation and subset counting on bounded universes",
                "requiredParams": ["choose", "predicate"],
                "optionalParams": ["objects", "ranges"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "avoiding_permutations",
                "implementationRef": "impl.combinatorics.avoiding-perms.v1",
                "legacyToolName": "count_avoiding_permutations",
                "legacyOperation": None,
                "declaredScope": "Exact count of permutations avoiding specified forbidden coordinate pairs",
                "requiredParams": ["n", "forbidden"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "rook_numbers",
                "implementationRef": "impl.combinatorics.rook-numbers.v1",
                "legacyToolName": "rook_numbers",
                "legacyOperation": None,
                "declaredScope": "Exact coefficients of the rook polynomial for forbidden board subsets",
                "requiredParams": ["n", "forbidden"],
                "optionalParams": [],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算4阶完全错排数（对角线禁位）", "input": {"target": "avoiding_permutations", "n": 4, "forbidden": [[0, 0], [1, 1], [2, 2], [3, 3]]}},
                {"description": "计算3x3棋盘禁位对角线车多项式系数", "input": {"target": "rook_numbers", "n": 3, "forbidden": [[0, 0], [1, 1], [2, 2]]}}
            ],
            "negative": [
                {"description": "求解连续随机游走首达时间分布", "reason": "不属于离散禁位排列或有限组合枚举范围。"}
            ]
        }
    },
    {
        "assetId": "math.generating-functions",
        "name": "生成函数与系数",
        "version": "1.0.0",
        "summary": "多项式乘积展开、形式幂级数展开与特定单项式系数提取。",
        "instructions": {
            "conditions": [
                "组合序列可用形式幂级数 A(x) = ∑ a_n x^n 编码",
                "涉及多项式卷积乘积或高阶幂次展开",
                "需要提取指定次数项的严格有理系数"
            ],
            "procedure": [
                "根据组合对象的构造规则（组合类序列、并集、笛卡尔积）建立母函数",
                "将待提取表达式规范化为标准有理多项式字符串",
                "调用多项式系数展开算子，指定变量与参数名",
                "获取目标项系数并核实符号与指数匹配"
            ],
            "misuse": [
                "对超越函数母函数强行当作有限多项式输入导致截断失真",
                "忽略参数（parameters）与主变量（variables）的区别"
            ],
            "verificationBoundary": "展开计算仅保证输入有限多项式乘积展开后的系数精确性，不证明形式幂级数收敛域半径。"
        },
        "behaviors": [
            {
                "target": "expand_coefficients",
                "implementationRef": "impl.generating-functions.expand-coeff.v1",
                "legacyToolName": "polynomial_expand_coefficients",
                "legacyOperation": None,
                "declaredScope": "Exact coefficient extraction from multivariate polynomial expressions",
                "requiredParams": ["expression", "variables", "parameters"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "展开 (x+1)^5*(x-2)^2 并提取多项式系数", "input": {"target": "expand_coefficients", "expression": "(x+1)**5 * (x-2)**2", "variables": ["x"], "parameters": []}}
            ],
            "negative": [
                {"description": "解析函数在奇异点附近的本性奇点展开", "reason": "超出有限多项式代数展开范围。"}
            ]
        }
    },
    {
        "assetId": "math.diophantine",
        "name": "整数方程",
        "version": "1.0.0",
        "summary": "齐次与非齐次二元二次不定方程、符号同余解法与判别式族求解。",
        "instructions": {
            "conditions": [
                "未知数严格限制为整数集 Z",
                "涉及同余模方程或佩尔（Pell）型二次不定方程",
                "系数均为精确整数"
            ],
            "procedure": [
                "将不定方程化简为标准二次型 a*x^2 + b*x*y + c*y^2 + d*x + e*y + f = 0",
                "分析二次型判别式 Δ = b^2 - 4ac 的符号与平方性（椭圆型/双曲型/抛物型）",
                "调用二次不定方程解法或符号解算子获取最小正整数解或基础解系",
                "若存在参数同余，结合中国剩余定理（CRT）合成模解"
            ],
            "misuse": [
                "给整型参数 a..f 传入浮点数或带引号的字符串",
                "将局部模同余有解误判为全局整数解必然存在（忽略局部-全局原则失效情形）"
            ],
            "verificationBoundary": "求解结果仅涵盖算法已证明覆盖的有界搜索区间或代数有限基础解，不外推至超越数方程。"
        },
        "behaviors": [
            {
                "target": "quadratic_diophantine",
                "implementationRef": "impl.diophantine.quadratic.v1",
                "legacyToolName": "solve_quadratic_diophantine",
                "legacyOperation": None,
                "declaredScope": "Exact integer solution search for quadratic Diophantine equations ax^2+bxy+cy^2+dx+ey+f=0",
                "requiredParams": ["a", "b", "c", "d", "e", "f"],
                "optionalParams": ["y_bound"],
                "resultType": "set",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "symbolic_diophantine",
                "implementationRef": "impl.diophantine.symbolic.v1",
                "legacyToolName": "symbolic_diophantine_with_timeout",
                "legacyOperation": None,
                "declaredScope": "Symbolic Diophantine solver for general polynomial equations over integers",
                "requiredParams": ["lhs"],
                "optionalParams": ["rhs", "variables", "timeout_ms"],
                "resultType": "set",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "quadratic_discriminant_family",
                "implementationRef": "impl.diophantine.discriminant-family.v1",
                "legacyToolName": "solve_quadratic_discriminant_family",
                "legacyOperation": None,
                "declaredScope": "Search for integer roots of parameterized quadratic discriminant polynomials",
                "requiredParams": ["c2", "c1", "c0", "x_lo", "x_hi"],
                "optionalParams": [],
                "resultType": "set",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "求解二元二次不定方程 x^2 - 2y^2 = 1 (Pell方程)", "input": {"target": "quadratic_diophantine", "a": 1, "b": 0, "c": -2, "d": 0, "e": 0, "f": -1, "y_bound": 100}}
            ],
            "negative": [
                {"description": "高次无解性费马大定理证明请求", "reason": "超出有限不定方程求解器算法支持边界。"}
            ]
        }
    },
    {
        "assetId": "math.integration",
        "name": "积分与对称",
        "version": "1.0.0",
        "summary": "一元与多元定积分符号计算、区间对称性奇偶约化与三角有理积分。",
        "instructions": {
            "conditions": [
                "被积函数在积分区间上处处有限或具有可积的弱奇点",
                "积分上下限明确为具体常数或符号常数（如 0, 1, pi, oo）",
                "不包含未知的抽象算子或任意自定义未定函数"
            ],
            "procedure": [
                "检查区间对称性与被积函数关于中心点对称性（区间 [-a, a] 奇偶性或 [0, pi] 三角翻转）",
                "将 LaTeX 积分公式规范转换为 SymPy 可读的数学表达式字符串（如 \\int_0^1 x^2 dx -> x**2）",
                "调用精确符号定积分算子，指定积分变量与上下限",
                "核对返回的精确有理数或符号常数值（如 pi/4, ln(2) 等）"
            ],
            "misuse": [
                "把发散的瑕积分或广义积分当成收敛并接受假象主值",
                "忽略分母零点穿过积分区间的断点"
            ],
            "verificationBoundary": "定积分结果仅验证显式输入表达式在所给上下限内的严格符号求值，不判定题面本身是否满足条件可积。"
        },
        "behaviors": [
            {
                "target": "definite_integral",
                "implementationRef": "impl.integration.definite.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "DEFINITE_INTEGRAL",
                "declaredScope": "Exact symbolic evaluation of definite integrals over bounded or unbounded intervals",
                "requiredParams": ["expression", "variable", "lower", "upper"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算定积分 int_0^pi sin(x) dx", "input": {"target": "definite_integral", "expression": "sin(x)", "variable": "x", "lower": "0", "upper": "pi"}}
            ],
            "negative": [
                {"description": "计算发散积分 int_0^1 1/x^2 dx", "reason": "积分在零点发散，算子将返回未定义或错误。"}
            ]
        }
    },
    {
        "assetId": "math.geometry",
        "name": "坐标与有限几何",
        "version": "1.0.0",
        "summary": "解析几何坐标建系、直线相交分离数、顶点夹角与几何构型极端情形搜索。",
        "instructions": {
            "conditions": [
                "几何图形可通过笛卡尔坐标或斜坐标系数值化",
                "涉及有限个点集、线段或多边形边界",
                "点坐标为精确有理数或浮点数"
            ],
            "procedure": [
                "选取对称轴或主基底建立坐标系并计算各关键顶点坐标",
                "建立直线方程与夹角余弦公式",
                "调用夹角计算、直线覆盖数或面积平分线算子进行数值核算",
                "对极值构型调用有界搜索分析最劣配置"
            ],
            "misuse": [
                "忽略三点共线或多线共点的退化构型",
                "把局部数值搜索得到的最差构型当作全局唯一最大值定理"
            ],
            "verificationBoundary": "几何算子只在输入的显式离散点集与坐标上保证局部计算，不自动外推为仿射/射影几何全局定理。"
        },
        "behaviors": [
            {
                "target": "angle_at_vertex",
                "implementationRef": "impl.geometry.angle-vertex.v1",
                "legacyToolName": "angle_at_vertex",
                "legacyOperation": None,
                "declaredScope": "Exact angle cosine/radian computation at vertex given three coordinate points",
                "requiredParams": ["p", "v", "q"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "area_bisection_coverage",
                "implementationRef": "impl.geometry.area-bisection.v1",
                "legacyToolName": "area_bisection_coverage",
                "legacyOperation": None,
                "declaredScope": "Geometric area bisection and line coverage evaluation on polygons",
                "requiredParams": ["vertices"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "count_angle_ratio_locus",
                "implementationRef": "impl.geometry.angle-ratio.v1",
                "legacyToolName": "count_angle_ratio_locus",
                "legacyOperation": None,
                "declaredScope": "Sampled geometric locus point counts under angle ratio conditions",
                "requiredParams": ["p", "q", "r"],
                "optionalParams": ["ratio", "n_samples"],
                "resultType": "integer",
                "evidenceCeiling": "SAMPLED_OBSERVATION",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "line_cover_number",
                "implementationRef": "impl.geometry.line-cover.v1",
                "legacyToolName": "line_cover_number",
                "legacyOperation": None,
                "declaredScope": "Minimum lines required to cover a finite set of plane points",
                "requiredParams": ["points", "max_lines"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "line_separation_number",
                "implementationRef": "impl.geometry.line-separation.v1",
                "legacyToolName": "line_separation_number",
                "legacyOperation": None,
                "declaredScope": "Minimum lines required to strictly separate differently colored point sets",
                "requiredParams": ["points", "colors"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "line_through",
                "implementationRef": "impl.geometry.line-through.v1",
                "legacyToolName": "line_through",
                "legacyOperation": None,
                "declaredScope": "Exact line equation coefficients passing through two distinct coordinate points",
                "requiredParams": ["p", "q"],
                "optionalParams": [],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "worst_configuration_search",
                "implementationRef": "impl.geometry.worst-config.v1",
                "legacyToolName": "worst_configuration_search",
                "legacyOperation": None,
                "declaredScope": "Search for extremal worst-case point configurations under geometric separation bounds",
                "requiredParams": ["objective"],
                "optionalParams": ["red", "blue", "line_budget", "grid", "samples", "seed"],
                "resultType": "scalar",
                "evidenceCeiling": "SAMPLED_OBSERVATION",
                "consumer": "record.bounded-observation.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "求过点 (0,0) 与 (1,2) 的直线方程系数", "input": {"target": "line_through", "p": [0, 0], "q": [1, 2]}}
            ],
            "negative": [
                {"description": "两重合点求直线方程", "reason": "重合点无法唯一定义直线。"}
            ]
        }
    },
    {
        "assetId": "math.optimization",
        "name": "不等式与优化",
        "version": "1.0.0",
        "summary": "多元不等式取等条件分析、拉格朗日乘子约束极值、有界采样与凸优化检查。",
        "instructions": {
            "conditions": [
                "目标函数与约束函数在定义域上有界可微或属于凸函数族",
                "边界与内部驻点均必须完整核查",
                "严格区分取等条件的充要性"
            ],
            "procedure": [
                "识别约束集（紧致性、凸性）与目标函数极值方向",
                "列出驻点方程并求解 KKT / 拉格朗日条件",
                "在小范围有界多维盒式区域中进行数值极值探索与反例证书检查",
                "核对等号成立的充分必要条件"
            ],
            "misuse": [
                "将数值采样的近似极大值当作绝对严格全局最大值",
                "忽略定义域边界点处的极值可能大于内部驻点值"
            ],
            "verificationBoundary": "数值优化与多点采样只提供局部上界或下界经验证据，不构成全域无条件解析不等式证明。"
        },
        "behaviors": [
            {
                "target": "certificate_check",
                "implementationRef": "impl.optimization.cert-check.v1",
                "legacyToolName": "certificate_check_expr",
                "legacyOperation": None,
                "declaredScope": "Randomized bounded domain sampling to test functional inequality non-negativity",
                "requiredParams": ["expression", "variables", "bounds"],
                "optionalParams": ["n_samples", "seed"],
                "resultType": "boolean",
                "evidenceCeiling": "SAMPLED_OBSERVATION",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "numeric_extremum_search",
                "implementationRef": "impl.optimization.extremum-search.v1",
                "legacyToolName": "numeric_extremum_search_expr",
                "legacyOperation": None,
                "declaredScope": "Bounded local numerical search for extrema of scalar multivariable expressions",
                "requiredParams": ["expression", "variables", "bounds"],
                "optionalParams": ["maximize"],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "subset_gap_worst_case",
                "implementationRef": "impl.optimization.subset-gap.v1",
                "legacyToolName": "subset_gap_worst_case",
                "legacyOperation": None,
                "declaredScope": "Worst-case subset sum gap optimization over bounded real sequences",
                "requiredParams": ["bound", "target", "n_terms"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "在区间 [0,1]x[0,1] 上随机采样检验 x+y >= 2*sqrt(x*y)", "input": {"target": "certificate_check", "expression": "x + y - 2*sqrt(x*y)", "variables": ["x", "y"], "bounds": [[0, 1], [0, 1]]}}
            ],
            "negative": [
                {"description": "无界开区间上任意非线性函数的最优解", "reason": "无界域数值搜索无法收敛且超出有界采样范围。"}
            ]
        }
    },
    {
        "assetId": "math.linear-algebra",
        "name": "线性代数",
        "version": "1.0.0",
        "summary": "实数/有理数及有限域GF(2)矩阵分析、秩、核空间维数、线性方程组解集与极大子式多项式。",
        "instructions": {
            "conditions": [
                "明确矩阵所在数域（特别区分有理数域 Q、实数域 R 与有限域 GF(2)）",
                "矩阵行向量与列向量维度匹配，严格遵循线性映射定义",
                "对多项式矩阵，极大子式（Alexander多项式）在单位因子意义下唯一"
            ],
            "procedure": [
                "确认输入矩阵的数域编码（GF(2) 采用非负整数二进制行向量编码；Q 采用有理数字符串或整数矩阵）",
                "调用矩阵秩（Rank）或零空间（Nullspace）算子进行高斯消元",
                "对线性方程组 Ax=b，提取其解空间状态（EMPTY/UNIQUE/AFFINE）与特解向量",
                "对纽结理论或多项式矩阵，计算极大子式的最高阶行列式因子，并核查 Laurent 单位等价"
            ],
            "misuse": [
                "把 GF(2) 模 2 算出的秩误当作实数矩阵的秩",
                "把线性方程组解向量中变量的位置次序弄混"
            ],
            "verificationBoundary": "线性代数算子给出显式输入矩阵在指定数域上的精确代数指标，不承担原始几何问题到矩阵建模的合法性论证。"
        },
        "behaviors": [
            {
                "target": "gf2_rank",
                "implementationRef": "impl.linear.gf2-rank.v1",
                "legacyToolName": "gf2_rank",
                "legacyOperation": None,
                "declaredScope": "Exact rank of binary matrix over GF(2)",
                "requiredParams": ["rows"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.explicit-rank.v1"
            },
            {
                "target": "gf2_nullspace",
                "implementationRef": "impl.linear.gf2-nullspace.v1",
                "legacyToolName": "gf2_nullspace",
                "legacyOperation": None,
                "declaredScope": "Exact nullspace basis vectors of binary matrix over GF(2)",
                "requiredParams": ["rows", "width"],
                "optionalParams": [],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.explicit-nullity.v1"
            },
            {
                "target": "solution_set",
                "implementationRef": "impl.linear.solution-set.v1",
                "legacyToolName": "linear_system_solution_set",
                "legacyOperation": None,
                "declaredScope": "Exact affine/unique/empty solution set of rational linear systems",
                "requiredParams": ["matrix", "rhs", "variables", "domain"],
                "optionalParams": [],
                "resultType": "set",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.linear-system-status.v1"
            },
            {
                "target": "maximal_minors",
                "implementationRef": "impl.linear.maximal-minors.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "MAXIMAL_MINORS",
                "declaredScope": "Exact maximal minor polynomial invariants under Laurent unit normalization",
                "requiredParams": ["matrix", "variable"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.degree-conservation.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "求 GF(2) 上由整数行编码 [1, 2, 3] 的 3x3 矩阵的秩", "input": {"target": "gf2_rank", "rows": [1, 2, 3]}},
                {"description": "解二元一次方程组 x+y=3, 2x-y=0", "input": {"target": "solution_set", "matrix": [[1, 1], [2, -1]], "rhs": ["3", "0"], "variables": ["x", "y"], "domain": "RATIONAL"}}
            ],
            "negative": [
                {"description": "非线性超越方程组求解", "reason": "必须使用线性方程组矩阵与向量输入。"}
            ]
        }
    },
    {
        "assetId": "math.probability",
        "name": "概率与随机过程",
        "version": "1.0.0",
        "summary": "概率密度函数积分归一化、马尔可夫链吸收态期望步数、图随机游走完全覆盖时间与正态近似。",
        "instructions": {
            "conditions": [
                "连续型随机变量概率密度在支持集上非负且全实数轴积分为 1",
                "离散马尔可夫链转移矩阵满足行和精确等于 1 且为有限方阵",
                "完全图随机游走覆盖时间模型无自环且顶点数 ≥ 2"
            ],
            "procedure": [
                "对密度函数求广义积分核对归一化常数 c，若积分不为 1 则报告 NORMALIZATION 缺陷",
                "对有限状态马氏链建立首达时间第一步分析（First-step analysis）线性方程组",
                "调用覆盖时间算子获取图 K_n 上的精确有理数覆盖时间期望值",
                "对大样本正态近似核对是否进行了连续性校正（continuity correction）"
            ],
            "misuse": [
                "把只验证了积分为 1 的函数直接当作密度函数，忽略可能在某些区间为负数",
                "把离散计数的分子误当成最终事件概率"
            ],
            "verificationBoundary": "概率计算仅核对给定解析密度或有限马氏链转移矩阵的数值与精确有理结果，不验证先验建模的物理真实性。"
        },
        "behaviors": [
            {
                "target": "density_check",
                "implementationRef": "impl.probability.density-check.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "DENSITY_CHECK",
                "declaredScope": "Exact normalization and non-negativity verification of candidate probability density functions",
                "requiredParams": ["expression", "variable", "lower", "upper"],
                "optionalParams": ["density"],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "cover_time",
                "implementationRef": "impl.probability.cover-time.v1",
                "legacyToolName": "cover_time_complete_graph",
                "legacyOperation": None,
                "declaredScope": "Exact rational expected cover time for random walks on complete graph K_n",
                "requiredParams": ["num_vertices"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.cover-time.v1"
            },
            {
                "target": "markov_expected_steps",
                "implementationRef": "impl.probability.markov-steps.v1",
                "legacyToolName": "markov_expected_steps",
                "legacyOperation": None,
                "declaredScope": "Exact or high-precision expected steps to hitting target states in discrete Markov chains",
                "requiredParams": ["transition", "start", "targets"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "normal_overflow_seats",
                "implementationRef": "impl.probability.normal-overflow.v1",
                "legacyToolName": "normal_overflow_seats",
                "legacyOperation": None,
                "declaredScope": "Normal approximation for seat allocation and overflow probabilities with continuity correction",
                "requiredParams": ["total", "groups", "overflow_bound"],
                "optionalParams": ["continuity_correction"],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "求完全图 K_4 上随机游走的期望覆盖时间", "input": {"target": "cover_time", "num_vertices": 4}},
                {"description": "验证指数分布密度函数 exp(-x) 在 [0, oo) 上的归一化", "input": {"target": "density_check", "expression": "exp(-x)", "variable": "x", "lower": "0", "upper": "oo"}}
            ],
            "negative": [
                {"description": "连续鞅与布朗运动首达时分布", "reason": "超出有限状态马氏链与一维基本密度函数算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.limits",
        "name": "极限与收敛",
        "version": "1.0.0",
        "summary": "数列与函数极限计算、罗必达法则、泰勒展开近似与极限存在性判断。",
        "instructions": {
            "conditions": [
                "自变量趋近点明确（实数点 x0 或 +/-oo）",
                "单侧极限时必须指明方向（+ 或 -）",
                "严格区分概念定义讨论与具体数值极限求值"
            ],
            "procedure": [
                "检查待求极限的未定式类型（0/0, oo/oo, 0*oo, 1^oo 等）",
                "在应用洛必达法则前必须验证导数之比极限存在，严禁循环求导",
                "调用符号极限算子计算精确极限标量值",
                "核对单选题选项中是否存在相同的精确有理数/符号常数"
            ],
            "misuse": [
                "把概念性定义题或讨论极限存在性的题目强行送入数值计算算子",
                "在极限乘积中只对一部分因子取极限而保留另一部分变量"
            ],
            "verificationBoundary": "极限算子返回显式输入表达式在所给方向上的严格符号极限值，不代替分析学一致收敛性证明。"
        },
        "behaviors": [
            {
                "target": "limit",
                "implementationRef": "impl.limits.exact-limit.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "LIMIT",
                "declaredScope": "Exact symbolic limit evaluation of mathematical expressions",
                "requiredParams": ["expression", "variable", "point"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算极限 lim_{x->0} sin(x)/x", "input": {"target": "limit", "expression": "sin(x)/x", "variable": "x", "point": "0"}}
            ],
            "negative": [
                {"description": "叙述函数极限的 epsilon-delta 语言严格定义", "reason": "概念题无需调用极限数值算子，直接走推理分析。"}
            ]
        }
    },
    {
        "assetId": "math.differential",
        "name": "微分与微分方程",
        "version": "1.0.0",
        "summary": "平面与流形微分算子（Laplacian）、三角恒等式化简约化与微分方程特解验证。",
        "instructions": {
            "conditions": [
                "函数具有二阶或以上连续可导性 C^2",
                "拉普拉斯算子坐标系明确（直角坐标、极坐标或单位圆周）",
                "三角表达式只包含标准正余弦多项式或有理式"
            ],
            "procedure": [
                "对平面坐标计算 Δf = f_xx + f_yy；对单位圆周计算 d^2 f / d theta^2",
                "对复杂三角函数复合调用三角恒等约化算子消除高次项与倍角",
                "将候选解代回常微分方程验证残差是否为恒等零",
                "若求通解，结合初值条件或齐次解基底检查自由度"
            ],
            "misuse": [
                "在极坐标系下误用平面直角坐标系的微分算子公式",
                "把局部三角近似值当作恒等化简结论"
            ],
            "verificationBoundary": "微分算子计算严格基于显式解析表达式求导，不扩展到不连续广义函数或非光滑流形分布导数。"
        },
        "behaviors": [
            {
                "target": "circle_laplacian",
                "implementationRef": "impl.differential.circle-laplacian.v1",
                "legacyToolName": "circle_laplacian_expr",
                "legacyOperation": None,
                "declaredScope": "Exact Laplacian computation on unit circle for trigonometric functions",
                "requiredParams": ["expression"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial.v1"
            },
            {
                "target": "planar_laplacian",
                "implementationRef": "impl.differential.planar-laplacian.v1",
                "legacyToolName": "planar_laplacian_expr",
                "legacyOperation": None,
                "declaredScope": "Exact planar Laplacian d^2/dx^2 + d^2/dy^2 computation for multivariable expressions",
                "requiredParams": ["expression", "variables"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial.v1"
            },
            {
                "target": "trig_reduce",
                "implementationRef": "impl.differential.trig-reduce.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "TRIG_REDUCE",
                "declaredScope": "Exact trigonometric expression reduction and identity simplification",
                "requiredParams": ["expression", "variable"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算 f(theta)=sin(theta) 在单位圆上的 Laplacian", "input": {"target": "circle_laplacian", "expression": "sin(theta)"}},
                {"description": "计算 f(x,y)=x^2*y 的平面直角坐标 Laplacian", "input": {"target": "planar_laplacian", "expression": "x**2 * y", "variables": ["x", "y"]}}
            ],
            "negative": [
                {"description": "非线性抛物型偏微分方程的弱解存在性分析", "reason": "超出有限解析算子与符号化简边界。"}
            ]
        }
    },
    {
        "assetId": "math.algebraic-structures",
        "name": "群环域与代数结构",
        "version": "1.0.0",
        "summary": "有限群结构普查、阶数不超过64的子群全普查、换位子群、分裂域次数与代数扩域因式分解。",
        "instructions": {
            "conditions": [
                "群为命名有限群（如 S_n, A_n, D_n, Z_n, K_4, Q_8）或给定显式置换生成元",
                "群阶数 |G| ≤ 64 时可享受换位子群 derived_size 与按阶汇总 subgroup_summary 全普查",
                "多项式扩域满足极小多项式不可约性条件"
            ],
            "procedure": [
                "调用有限群结构算子获取群阶、共轭类、中心阶、交换性、循环性、换位子群阶与子群普查",
                "核对多选题或单选题关于'所有 d 阶子群是否阿贝尔/循环/正规'、'是否存在 d 阶子群'选项",
                "对多项式在有理数域 Q 上的分裂域计算其 Galois 扩张次数 [E:Q]",
                "在多选题中，若某选项被子群普查证明为真但候选答案漏选，必须及时补选"
            ],
            "misuse": [
                "把阶数大于64时缺失的子群普查字段当作不存在子群",
                "混淆群元素的阶（element order）与子群的阶（subgroup order）"
            ],
            "verificationBoundary": "群论算子在有界置换闭包或明确命名群上提供 100% 确定性全普查数据，不适用于无限阶李群或拓扑群。"
        },
        "behaviors": [
            {
                "target": "group_structure",
                "implementationRef": "impl.algebra.finite-group.v1",
                "legacyToolName": "finite_group_structure",
                "legacyOperation": None,
                "declaredScope": "Exact structural census of finite groups: order, center, derived subgroup, and subgroup summary by order for |G|<=64",
                "requiredParams": [],
                "optionalParams": ["generators", "named_group", "degree"],
                "resultType": "census",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.finite-group-option.v1"
            },
            {
                "target": "splitting_field_degree",
                "implementationRef": "impl.algebra.splitting-field.v1",
                "legacyToolName": "splitting_field_degree_expr",
                "legacyOperation": None,
                "declaredScope": "Exact degree [E:Q] of the splitting field of univariate polynomials over rationals",
                "requiredParams": ["expression"],
                "optionalParams": ["variable", "timeout_ms"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "factor_over_extension",
                "implementationRef": "impl.algebra.factor-extension.v1",
                "legacyToolName": "exact_check_expr",
                "legacyOperation": "FACTOR_OVER_EXTENSION",
                "declaredScope": "Exact polynomial factorization over algebraic field extensions",
                "requiredParams": ["expression", "variable", "minimal_polynomials"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial.v1"
            },
            {
                "target": "algebraic_polynomial_check",
                "implementationRef": "impl.algebra.poly-check.v1",
                "legacyToolName": "algebraic_polynomial_check",
                "legacyOperation": None,
                "declaredScope": "Verify minimal polynomial relations for algebraic generator combinations",
                "requiredParams": ["minimal_polynomial", "generator", "argument", "target", "expression", "variable"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial-identity.v1"
            },
            {
                "target": "wronskian_root_identity",
                "implementationRef": "impl.algebra.wronskian-roots.v1",
                "legacyToolName": "wronskian_root_identity_expr",
                "legacyOperation": None,
                "declaredScope": "Verify Wronskian determinant root identities for polynomial families",
                "requiredParams": ["expression", "variable", "roots"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.polynomial-identity.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "分析二面体群 D8 的子群普查与换位子群阶数", "input": {"target": "group_structure", "named_group": "D8"}},
                {"description": "求四元数群 Q8 是否可交换及中心阶数", "input": {"target": "group_structure", "named_group": "Q8"}},
                {"description": "求多项式 x^4-2 在 Q 上的分裂域次数", "input": {"target": "splitting_field_degree", "expression": "x**4 - 2", "variable": "x"}}
            ],
            "negative": [
                {"description": "求无限群 GL(n, R) 的子群分类", "reason": "超出有限群结构普查算子定义域。"}
            ]
        }
    },
    {
        "assetId": "math.topology",
        "name": "拓扑与局部整体",
        "version": "1.0.0",
        "summary": "点集拓扑性质推理、紧致性、连通性、分离公理与商拓扑概念辨析。",
        "instructions": {
            "conditions": [
                "问题涉及拓扑空间 (X, τ)、度量空间或连续映射",
                "命题通常为全称概念判断、反例构造或局部到整体的延拓分析",
                "没有直接匹配的有限离散数值算子，以严格演绎推理为主"
            ],
            "procedure": [
                "明确所在拓扑结构（开集族公理、基与子基）",
                "验证紧致性（每个开覆盖都有有限子覆盖）或序列紧致性",
                "对连通性检查是否存在非平凡既开又闭子集",
                "对分离性检查 T0, T1, T2(Hausdorff), 正规空间公理",
                "若命题为假，在常见经典反例（如实数上的索根弗雷线、双原点直线、拓扑学家的正弦曲线）中寻找见证"
            ],
            "misuse": [
                "把度量空间下的结论（如紧致等价于有界闭集）错误套用到一般拓扑空间",
                "把连续映射保持局部性质误当成保持完备性"
            ],
            "verificationBoundary": "本资产纯属概念与严格推理指导，不产生数值观察，也不伪造计算结果。"
        },
        "behaviors": [],
        "examples": {
            "positive": [
                {"description": "分析拓扑空间中紧致集与闭集的关系及反例", "input": {"target": "analyze", "question": "非 Hausdorff 空间中紧致子集是否必定为闭集？"}}
            ],
            "negative": [
                {"description": "请求输出连续映射在紧集上的数值积分", "reason": "数值积分属于 math.integration 资产。"}
            ]
        }
    },
    {
        "assetId": "math.statistics",
        "name": "统计推断",
        "version": "1.0.0",
        "summary": "极大似然估计、充分统计量分解、费雪信息量与假设检验拒绝域分析。",
        "instructions": {
            "conditions": [
                "样本数据服从参数化概率分布族 P_theta",
                "似然函数可解析表达且关于参数可微或满足单调性",
                "以符号推断、充分性判定与大样本性质为主"
            ],
            "procedure": [
                "写出独立同分布样本的联合对数似然函数 ln L(theta; x)",
                "求得分函数（Score function）与费雪信息矩阵 I(theta)",
                "根据 Neyman-Fisher 因子分解定理识别充分统计量 T(X)",
                "构建置信区间或似然比检验统计量并推导渐近卡方分布"
            ],
            "misuse": [
                "在支撑集依赖于未知参数（如均匀分布 U(0, theta)）时盲目对似然求导置零",
                "将置信度 1-alpha 误解释为参数落在该区间的概率"
            ],
            "verificationBoundary": "统计推断指导基于标准数理统计公理体系，不承担未经验证的真实物理观测数据清洗职责。"
        },
        "behaviors": [],
        "examples": {
            "positive": [
                {"description": "推导泊松分布样本的充分统计量与完备性", "input": {"target": "analyze", "question": "求独立泊松样本的最小充分统计量与一致最小方差无偏估计。"}}
            ],
            "negative": [
                {"description": "请求拟合真实百万条观测数据", "reason": "超出有界符号推断范围。"}
            ]
        }
    },
    {
        "assetId": "math.regression",
        "name": "回归诊断",
        "version": "1.0.0",
        "summary": "普通最小二乘法（OLS）参数拟合、残差平方和、多重共线性与模型诊断。",
        "instructions": {
            "conditions": [
                "成对或多元数值样本数据 (x_i, y_i) 明确给出",
                "回归模型关于待估参数具有线性形式 y = X*beta + eps",
                "需要核对斜率、截距或拟合优度 R^2 的精确数值断言"
            ],
            "procedure": [
                "提取数据样本列表并计算各阶离差平方和与协方差",
                "调用最小二乘核查算子计算精确斜率与截距",
                "比对候选答案或选项文本中声明的回归系数数值",
                "若算子返回 claim_matches == False，触发 OLS_MISMATCH 闭环缺陷"
            ],
            "misuse": [
                "在明显非线性关系下未经验证盲目套用一元线性回归公式",
                "把样本相关系数 r=0 误等价于两变量统计独立"
            ],
            "verificationBoundary": "回归算子仅核实给定样本数值的 OLS 正规方程精确有理数解，不保证回归模型的真实因果性。"
        },
        "behaviors": [
            {
                "target": "ols_check",
                "implementationRef": "impl.regression.ols-check.v1",
                "legacyToolName": "stats_ols_check",
                "legacyOperation": None,
                "declaredScope": "Exact OLS linear regression fit verification on explicit paired data points",
                "requiredParams": ["data"],
                "optionalParams": ["claimed"],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.ols-regression.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "对点对数据 (0,1), (1,3), (2,5) 做最小二乘拟合核实", "input": {"target": "ols_check", "data": [[0, 1], [1, 3], [2, 5]], "claimed": {"slope": "2", "intercept": "1"}}}
            ],
            "negative": [
                {"description": "非参数核密度回归估计", "reason": "超出经典 OLS 线性多项式回归算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.numerics",
        "name": "数值计算与误差",
        "version": "1.0.0",
        "summary": "拉格朗日多项式插值核验、数值有限差分导数、理查森外推与闭式常量识别猜想。",
        "instructions": {
            "conditions": [
                "插值点集坐标互异且数量有界（<= 32）",
                "差分步长 h 在数值稳定区间内（1e-6 <= h <= 1）",
                "严格区分有限样本数值猜想与形式代数证明"
            ],
            "procedure": [
                "对多项式插值问题，调用插值拟合核查算子计算在各节点上的残差",
                "若所有节点残差均为零，则当前候选多项式即为唯一拉格朗日插值多项式",
                "对导数逼近，调用中心差分或向前/向后差分结合 Richardson 外推提高收敛阶",
                "对高精度数值常量，调用识别常数算子猜想其闭式表达（如 pi, e 等分式）"
            ],
            "misuse": [
                "将闭式猜想（identify_constant）直接当作定理证明来用",
                "在插值节点非零残差时仍强制声称多项式过这几个点"
            ],
            "verificationBoundary": "插值检验仅保证多项式在给定离散点处精确取值，闭式猜想不构成数学同一性证明。"
        },
        "behaviors": [
            {
                "target": "interpolation_fit",
                "implementationRef": "impl.numerics.interpolation-fit.v1",
                "legacyToolName": "interpolation_fit_check",
                "legacyOperation": None,
                "declaredScope": "Exact evaluation of polynomial interpolation residuals at specified distinct points",
                "requiredParams": ["points", "expression", "variable"],
                "optionalParams": [],
                "resultType": "polynomial",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.interpolation-residual.v1"
            },
            {
                "target": "finite_difference",
                "implementationRef": "impl.numerics.finite-diff.v1",
                "legacyToolName": "finite_difference_derivative",
                "legacyOperation": None,
                "declaredScope": "Numerical finite difference derivative approximation (central/forward/backward)",
                "requiredParams": ["f", "x", "h"],
                "optionalParams": ["method"],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "richardson_extrapolate",
                "implementationRef": "impl.numerics.richardson.v1",
                "legacyToolName": "richardson_extrapolate",
                "legacyOperation": None,
                "declaredScope": "Higher-order Richardson extrapolation for numerical derivative approximations",
                "requiredParams": ["f", "x", "h"],
                "optionalParams": ["method", "order"],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "verify_fd_certificate",
                "implementationRef": "impl.numerics.verify-fd-cert.v1",
                "legacyToolName": "verify_fd_certificate",
                "legacyOperation": None,
                "declaredScope": "Verification of finite difference convergence order certificates",
                "requiredParams": ["f", "x", "h", "method", "certificate"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            },
            {
                "target": "closed_form_conjecture",
                "implementationRef": "impl.numerics.closed-form-conjecture.v1",
                "legacyToolName": "closed_form_conjecture",
                "legacyOperation": None,
                "declaredScope": "Conjectures closed-form expressions for high-precision decimal numbers",
                "requiredParams": ["value"],
                "optionalParams": [],
                "resultType": "conjecture",
                "evidenceCeiling": "CONJECTURE",
                "consumer": "record.conjecture.v1"
            },
            {
                "target": "identify_constant",
                "implementationRef": "impl.numerics.identify-constant.v1",
                "legacyToolName": "identify_constant",
                "legacyOperation": None,
                "declaredScope": "Identify candidate mathematical constants from numeric approximations",
                "requiredParams": ["value"],
                "optionalParams": ["basis"],
                "resultType": "conjecture",
                "evidenceCeiling": "CONJECTURE",
                "consumer": "record.conjecture.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "验证拉格朗日插值多项式在点 (0,1), (1,4), (2,9) 上是否为 (x+1)^2", "input": {"target": "interpolation_fit", "points": [[0, 1], [1, 4], [2, 9]], "expression": "(x+1)**2", "variable": "x"}},
                {"description": "在 x=1.0 处用步长 h=0.01 计算 f(x)=x^3 的中心差分导数", "input": {"target": "finite_difference", "f": "x**3", "x": 1.0, "h": 0.01, "method": "central"}}
            ],
            "negative": [
                {"description": "把识别出的经验常数直接当作解析证明", "reason": "常量识别只属于 CONJECTURE 证据，不构成严格证明。"}
            ]
        }
    },
    {
        "assetId": "math.encoding",
        "name": "编码与序列",
        "version": "1.0.0",
        "summary": "LZ78 规范词典编码、解码、短语表示与比特串解析。",
        "instructions": {
            "conditions": [
                "字符集明确且有限",
                "短语由 (前缀索引, 新字符) 二元组构成",
                "编码为规范无损字典压缩算法"
            ],
            "procedure": [
                "调用 lz78_encode 生成规范短语字典序列",
                "调用 lz78_decode 对短语进行无损逆向重构",
                "调用 verify_phrases 检查短语字典与原始消息是否完全匹配",
                "若涉及定长比特编码，调用 lz78_bit_string 按位解析"
            ],
            "misuse": [
                "混淆 LZ78 词典索引的 0 基准（空前缀）与非空前缀",
                "把非规范短语直接当作压缩标准结果"
            ],
            "verificationBoundary": "编解码算子严格检验确定性 LZ78 规范文本与比特表示，不涵盖其他复杂熵编码。"
        },
        "behaviors": [
            {
                "target": "lz78_encode",
                "implementationRef": "impl.encoding.lz78-encode.v1",
                "legacyToolName": "lz78_encode",
                "legacyOperation": None,
                "declaredScope": "Exact LZ78 compression dictionary encoding of input string",
                "requiredParams": ["message"],
                "optionalParams": [],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.encoding-phrases.v1"
            },
            {
                "target": "lz78_decode",
                "implementationRef": "impl.encoding.lz78-decode.v1",
                "legacyToolName": "lz78_decode",
                "legacyOperation": None,
                "declaredScope": "Exact LZ78 phrase dictionary decoding into text string",
                "requiredParams": ["phrases"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.encoding-phrases.v1"
            },
            {
                "target": "lz78_bit_string",
                "implementationRef": "impl.encoding.lz78-bit-string.v1",
                "legacyToolName": "lz78_bit_string",
                "legacyOperation": None,
                "declaredScope": "Bit string serialization of LZ78 dictionary phrases",
                "requiredParams": ["phrases", "symbol_code", "index_bits"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.encoding-phrases.v1"
            },
            {
                "target": "format_phrases",
                "implementationRef": "impl.encoding.format-phrases.v1",
                "legacyToolName": "format_phrases",
                "legacyOperation": None,
                "declaredScope": "Formatting of LZ78 dictionary phrases into standardized LaTeX/text representations",
                "requiredParams": ["phrases"],
                "optionalParams": ["style", "sep", "latex", "with_words", "pair"],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.encoding-phrases.v1"
            },
            {
                "target": "verify_phrases",
                "implementationRef": "impl.encoding.verify-phrases.v1",
                "legacyToolName": "verify_phrases",
                "legacyOperation": None,
                "declaredScope": "Exact verification of LZ78 phrase sequences against original message",
                "requiredParams": ["phrases", "message"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.encoding-phrases.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "对字符串 'ABABABABA' 进行 LZ78 规范词典编码", "input": {"target": "lz78_encode", "message": "ABABABABA"}}
            ],
            "negative": [
                {"description": "霍夫曼动态变长树优化", "reason": "超出 LZ78 固定词典编解码算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.graphs",
        "name": "有限图",
        "version": "1.0.0",
        "summary": "有限简单图、完全二分图子图计数、完全匹配、Tutte 条件破坏集与二染色约束传播。",
        "instructions": {
            "conditions": [
                "顶点集与边集均为有限简单图（无重边、无自环）",
                "图的阶数 n ≤ 64",
                "明确完全匹配定义或二部图性质"
            ],
            "procedure": [
                "构建顶点数 n 与无向边集合 [[u,v],...]",
                "调用完全匹配存在性判断或匹配证书核查算子",
                "若不存在完全匹配，调用 Tutte 破坏集搜索算子获取反例割集 S 使得 q(G-S) > |S|",
                "对二部图染色，调用约束传播二染色算子核实奇圈冲突"
            ],
            "misuse": [
                "把无完全匹配的图误判为具有完全匹配",
                "在有向图或含重边的图上套用简单无向图匹配定理"
            ],
            "verificationBoundary": "图算子给出输入有限图的严格组合拓扑特征或反例见证，不推广至无限图。"
        },
        "behaviors": [
            {
                "target": "has_perfect_matching",
                "implementationRef": "impl.graphs.has-matching.v1",
                "legacyToolName": "has_perfect_matching",
                "legacyOperation": None,
                "declaredScope": "Exact decision of perfect matching existence in finite graphs",
                "requiredParams": ["n", "edges"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.graph-matching.v1"
            },
            {
                "target": "verify_perfect_matching",
                "implementationRef": "impl.graphs.verify-matching.v1",
                "legacyToolName": "verify_perfect_matching",
                "legacyOperation": None,
                "declaredScope": "Verification of explicit perfect matching edge set in finite graphs",
                "requiredParams": ["n", "edges", "matching"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.graph-matching.v1"
            },
            {
                "target": "tutte_violation",
                "implementationRef": "impl.graphs.tutte-violation.v1",
                "legacyToolName": "tutte_violation",
                "legacyOperation": None,
                "declaredScope": "Search for Tutte violation subset S where odd components q(G-S) > |S|",
                "requiredParams": ["n", "edges"],
                "optionalParams": ["max_subsets"],
                "resultType": "vector",
                "evidenceCeiling": "WITNESS_FOR_INPUT",
                "consumer": "verify.graph-matching.v1"
            },
            {
                "target": "triangle_free_check",
                "implementationRef": "impl.graphs.triangle-free.v1",
                "legacyToolName": "triangle_free_check",
                "legacyOperation": None,
                "declaredScope": "Exact verification of triangle-free property in finite graphs",
                "requiredParams": ["n", "edges"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.graph-matching.v1"
            },
            {
                "target": "count_complete_bipartite_subgraphs",
                "implementationRef": "impl.graphs.count-bipartite-subgraphs.v1",
                "legacyToolName": "count_complete_bipartite_subgraphs",
                "legacyOperation": None,
                "declaredScope": "Exact count of complete bipartite subgraphs K_{s,t} in finite graphs",
                "requiredParams": ["n", "edges", "s", "t"],
                "optionalParams": ["injective"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "constraint_propagation_2coloring",
                "implementationRef": "impl.graphs.2coloring.v1",
                "legacyToolName": "constraint_propagation_2coloring",
                "legacyOperation": None,
                "declaredScope": "2-coloring constraint propagation and odd-cycle conflict detection",
                "requiredParams": ["points", "edges", "fixed"],
                "optionalParams": [],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.graph-matching.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "判断4顶点路径图 P_4 是否有完全匹配", "input": {"target": "has_perfect_matching", "n": 4, "edges": [[0, 1], [1, 2], [2, 3]]}}
            ],
            "negative": [
                {"description": "图的哈密顿回路 NP-hard 无界求解", "reason": "超出有限多项式匹配与局部图分析算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.tiling",
        "name": "铺砌与覆盖",
        "version": "1.0.0",
        "summary": "有限网格棋盘骨牌铺砌计数、染色法不变量下界与最小多联骨牌覆盖。",
        "instructions": {
            "conditions": [
                "棋盘为有限网格 rows x cols",
                "骨牌形状（如 domino, tromino, tetris）有明确单元格坐标定义与旋转反射规则",
                "严格区分完全铺满（Full Tiling）与约束半铺（Constrained Partial Tiling）"
            ],
            "procedure": [
                "建立棋盘尺寸与禁位/障碍格集合",
                "调用 count_tilings 算子计算确切铺法数（小板精确值）",
                "调用 coloring_bound 通过黑白染色或同余模乘积计算覆盖下界",
                "调用 check_tiling_certificate 验证显式摆放方案是否构成合法铺砌"
            ],
            "misuse": [
                "把染色法给出的必要下界当作充要可铺满结论",
                "大棋盘直接盲目调用无界回溯枚举导致超时"
            ],
            "verificationBoundary": "铺砌算子在小尺寸棋盘上给出精确整数计数或证书，大棋盘需以染色不变量证明为主。"
        },
        "behaviors": [
            {
                "target": "check_tiling_certificate",
                "implementationRef": "impl.tiling.check-cert.v1",
                "legacyToolName": "check_tiling_certificate",
                "legacyOperation": None,
                "declaredScope": "Exact verification of concrete polyomino placement configurations on a grid",
                "requiredParams": ["rows", "cols", "placements"],
                "optionalParams": ["tile_shape_spec", "tile_area", "constraint_spec"],
                "resultType": "boolean",
                "evidenceCeiling": "WITNESS_FOR_INPUT",
                "consumer": "verify.tiling-certificate.v1"
            },
            {
                "target": "coloring_bound",
                "implementationRef": "impl.tiling.coloring-bound.v1",
                "legacyToolName": "coloring_bound",
                "legacyOperation": None,
                "declaredScope": "Lower bound computation for grid coverings via invariant coloring schemes",
                "requiredParams": ["board_spec", "tile_shape_spec", "coloring_spec"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "count_tilings",
                "implementationRef": "impl.tiling.count-tilings.v1",
                "legacyToolName": "count_tilings",
                "legacyOperation": None,
                "declaredScope": "Exact count of valid polyomino coverings under constraints on small boards",
                "requiredParams": ["rows", "cols"],
                "optionalParams": ["tile_shape_spec", "constraint_spec", "tile_area", "max_nodes"],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "min_tiles_cover",
                "implementationRef": "impl.tiling.min-cover.v1",
                "legacyToolName": "min_tiles_cover",
                "legacyOperation": None,
                "declaredScope": "Minimum number of tiles required to cover specified target cells",
                "requiredParams": ["rows", "cols", "tile_shape_spec", "target_spec"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "unique_tiling_check",
                "implementationRef": "impl.tiling.unique-tiling.v1",
                "legacyToolName": "unique_tiling_check",
                "legacyOperation": None,
                "declaredScope": "Decision and witness of unique tiling configurations under marked cell constraints",
                "requiredParams": ["rows", "cols", "marked_cells"],
                "optionalParams": ["tile_shape_spec", "tile_area", "max_nodes"],
                "resultType": "boolean",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.tiling-certificate.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算 2x4 棋盘用 1x2 骨牌完全铺满的方案数", "input": {"target": "count_tilings", "rows": 2, "cols": 4, "tile_shape_spec": {"cells": [[0, 0], [0, 1]], "allow_rotations": True}}}
            ],
            "negative": [
                {"description": "100x100 棋盘的全部五格骨牌枚举", "reason": "状态树巨大，应使用代数或双曲切比雪夫多项式理论。"}
            ]
        }
    },
    {
        "assetId": "math.games",
        "name": "有限博弈",
        "version": "1.0.0",
        "summary": "双人无偏博弈胜负态判定、Minimax 博弈图状态值计算与对策配对策略核查。",
        "instructions": {
            "conditions": [
                "有限状态博弈图（有向无环或具有确定平局/循环规则）",
                "双人交替行动，完全信息且无随机外力",
                "获胜或终止规则明确（常规博弈或反常博弈反转）"
            ],
            "procedure": [
                "识别博弈终端胜负平状态集合",
                "调用 minimax_value_graph 逆向回溯计算各顶点的博弈价值（胜/负/平）",
                "对对称或对策博弈，调用 pairing_strategy_verify 核实配对策略的封闭性",
                "对比初始状态的博弈值以给出最优策略决策"
            ],
            "misuse": [
                "在存在平局环路的博弈中错误假设一定在有限步内决出胜负",
                "策略配对集合未覆盖对手的所有合法走步威胁"
            ],
            "verificationBoundary": "博弈算子在显式有限博弈状态图上进行精确回溯或配对验证，不扩展到不完全信息博弈。"
        },
        "behaviors": [
            {
                "target": "deck_game_outcome",
                "implementationRef": "impl.games.deck-game.v1",
                "legacyToolName": "deck_game_outcome",
                "legacyOperation": None,
                "declaredScope": "Exact outcome determination for finite card/deck draw games",
                "requiredParams": ["d"],
                "optionalParams": [],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.game-outcome.v1"
            },
            {
                "target": "gap_subsequence_discrepancy",
                "implementationRef": "impl.games.gap-discrepancy.v1",
                "legacyToolName": "gap_subsequence_discrepancy",
                "legacyOperation": None,
                "declaredScope": "Discrepancy bounds on sequence game gap states",
                "requiredParams": ["spec"],
                "optionalParams": ["spec.max_gap"],
                "resultType": "scalar",
                "evidenceCeiling": "NUMERICAL_FOR_INPUT",
                "consumer": "verify.game-outcome.v1"
            },
            {
                "target": "independent_reply_certificate",
                "implementationRef": "impl.games.independent-reply.v1",
                "legacyToolName": "independent_reply_certificate",
                "legacyOperation": None,
                "declaredScope": "Verification of independent reply strategy certificates under conflict graphs",
                "requiredParams": ["elements", "conflicts"],
                "optionalParams": ["max_elements", "max_conflicts"],
                "resultType": "boolean",
                "evidenceCeiling": "WITNESS_FOR_INPUT",
                "consumer": "verify.game-outcome.v1"
            },
            {
                "target": "minimax_value_graph",
                "implementationRef": "impl.games.minimax-graph.v1",
                "legacyToolName": "minimax_value_graph",
                "legacyOperation": None,
                "declaredScope": "Exact backward-induction minimax game values on directed state graphs",
                "requiredParams": ["spec"],
                "optionalParams": ["spec.maximizer_states", "spec.initial", "state_budget"],
                "resultType": "scalar",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.game-outcome.v1"
            },
            {
                "target": "pairing_strategy_verify",
                "implementationRef": "impl.games.pairing-strategy.v1",
                "legacyToolName": "pairing_strategy_verify",
                "legacyOperation": None,
                "declaredScope": "Formal verification of involution pairing strategy against threat sets",
                "requiredParams": ["elements", "partner"],
                "optionalParams": ["threat_sets", "max_elements", "max_threats"],
                "resultType": "boolean",
                "evidenceCeiling": "WITNESS_FOR_INPUT",
                "consumer": "verify.game-outcome.v1"
            },
            {
                "target": "win_draw_loss_graph",
                "implementationRef": "impl.games.wdl-graph.v1",
                "legacyToolName": "win_draw_loss_graph",
                "legacyOperation": None,
                "declaredScope": "Complete Win/Draw/Loss status labeling on finite game digraphs",
                "requiredParams": ["spec"],
                "optionalParams": ["spec.initial", "state_budget"],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "verify.game-outcome.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "验证双人配对策略在元素对划分上的完备性", "input": {"target": "pairing_strategy_verify", "elements": [1, 2, 3, 4], "partner": {"1": 2, "2": 1, "3": 4, "4": 3}}}
            ],
            "negative": [
                {"description": "非完全信息无限下注德州扑克纳什均衡求解", "reason": "超出有限完全信息确定性博弈图算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.lattices",
        "name": "格点几何",
        "version": "1.0.0",
        "summary": "正方格点与六角格点图形计数、整点多边形皮克公式（Pick's theorem）分析。",
        "instructions": {
            "conditions": [
                "顶点坐标均为精确二维整数格点 Z^2 或标准六角蜂窝格点",
                "多边形为非自交简单多边形",
                "格点尺度参数 n ≤ 100"
            ],
            "procedure": [
                "提取多边形有序连续顶点坐标",
                "调用 lattice_points_in_polygon 算子计算内部格点数 I 与边界格点数 B",
                "应用皮克公式 Area = I + B/2 - 1 交叉核验多边形有理面积",
                "对蜂窝格点六边形，调用正六角格点计数算子获取包含的整点总数"
            ],
            "misuse": [
                "在顶点非整数坐标的多边形上盲目套用皮克定理",
                "多边形边界自交导致格点重复或内外部划分错误"
            ],
            "verificationBoundary": "格点算子保证在明确给出的离散点阵与多边形上精确求出整点个数，不扩展到分形边界。"
        },
        "behaviors": [
            {
                "target": "count_lattice_hexagons",
                "implementationRef": "impl.lattices.count-hexagons.v1",
                "legacyToolName": "count_lattice_hexagons",
                "legacyOperation": None,
                "declaredScope": "Exact count of regular hexagon subgraphs in triangular/hexagonal lattices",
                "requiredParams": ["n"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "hexagon_lattice_points",
                "implementationRef": "impl.lattices.hex-points.v1",
                "legacyToolName": "hexagon_lattice_points",
                "legacyOperation": None,
                "declaredScope": "Exact lattice point count inside scaled regular hexagon boundaries",
                "requiredParams": ["n"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            },
            {
                "target": "lattice_points_in_polygon",
                "implementationRef": "impl.lattices.points-in-polygon.v1",
                "legacyToolName": "lattice_points_in_polygon",
                "legacyOperation": None,
                "declaredScope": "Exact interior and boundary integer lattice point count for simple polygons via Pick's theorem",
                "requiredParams": ["vertices"],
                "optionalParams": [],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.exact-count.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算顶点为 (0,0), (4,0), (0,3) 的直角三角形内的格点数", "input": {"target": "lattice_points_in_polygon", "vertices": [[0, 0], [4, 0], [0, 3]]}},
                {"description": "计算边长为 3 的六角格点六边形内部点数", "input": {"target": "hexagon_lattice_points", "n": 3}}
            ],
            "negative": [
                {"description": "单位圆内部的高斯圆问题渐近界", "reason": "非多边形曲线边界超出离散多边形格点算子范围。"}
            ]
        }
    },
    {
        "assetId": "math.integer-structure",
        "name": "整数结构",
        "version": "1.0.0",
        "summary": "整数奇部分解、素因数结构、数值半群 Frobenius 数与麦克诺顿硬币问题。",
        "instructions": {
            "conditions": [
                "研究对象为非负整数或正整数集",
                "数值半群由一组互素正整数生成元 gcd(a_1, ..., a_k) = 1 生成",
                "奇部抽取 n = 2^k * m 中 m 为奇数"
            ],
            "procedure": [
                "调用 odd_part 抽取正整数去除所有 2 因数后的最大奇因数",
                "对区间整数生成 odd_part_table 进行素因子筛法分析",
                "调用 frobenius_semigroup 算子计算最大的不能被生成元线性非负整数组合表示的整数 g(A)",
                "分析数值半群的缺失数（gaps）集合与亏格"
            ],
            "misuse": [
                "在生成元不互素时求解 Frobenius 麦克诺顿数（此时存在无限个不可表示整数）",
                "将奇部的乘法性质错误线性外推至加法"
            ],
            "verificationBoundary": "算子在给定界限内严格计算整数结构分解与半群性质，不代替解析数论素数分布渐近估计。"
        },
        "behaviors": [
            {
                "target": "frobenius_semigroup",
                "implementationRef": "impl.integer-structure.frobenius.v1",
                "legacyToolName": "frobenius_semigroup",
                "legacyOperation": None,
                "declaredScope": "Frobenius coin problem: maximum integer not representable as non-negative combination of coprime generators",
                "requiredParams": ["generators", "limit"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "odd_part",
                "implementationRef": "impl.integer-structure.odd-part.v1",
                "legacyToolName": "odd_part",
                "legacyOperation": None,
                "declaredScope": "Exact odd part extraction n / 2^{v_2(n)} for positive integers",
                "requiredParams": ["n"],
                "optionalParams": [],
                "resultType": "integer",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "compare.scalar-value.v1"
            },
            {
                "target": "odd_part_table",
                "implementationRef": "impl.integer-structure.odd-part-table.v1",
                "legacyToolName": "odd_part_table",
                "legacyOperation": None,
                "declaredScope": "Tabulation of odd parts and modular distributions up to limit",
                "requiredParams": ["limit"],
                "optionalParams": ["modulus"],
                "resultType": "vector",
                "evidenceCeiling": "EXACT_FOR_INPUT",
                "consumer": "record.bounded-observation.v1"
            }
        ],
        "examples": {
            "positive": [
                {"description": "计算整数 120 的最大奇数因子", "input": {"target": "odd_part", "n": 120}},
                {"description": "计算生成元 {3, 5} 的 Frobenius 数 (最大不可表示数)", "input": {"target": "frobenius_semigroup", "generators": [3, 5], "limit": 100}}
            ],
            "negative": [
                {"description": "求解实数加法半群结构", "reason": "只支持离散整数生成元。"}
            ]
        }
    }
]


def build_unified_assets_catalog():
    print(f"Building canonical math-assets.json with {len(ASSETS_SPEC)} assets...")

    # Validation checks
    assert len(ASSETS_SPEC) == 26, f"Expected 26 assets, got {len(ASSETS_SPEC)}"

    asset_ids = set()
    total_behaviors = 0
    tools_mapped = set()

    for asset in ASSETS_SPEC:
        aid = asset["assetId"]
        assert aid not in asset_ids, f"Duplicate assetId: {aid}"
        asset_ids.add(aid)

        # Verify instructions
        inst = asset["instructions"]
        assert len(inst["conditions"]) >= 1, f"{aid} missing conditions"
        assert len(inst["procedure"]) >= 1, f"{aid} missing procedure"
        assert len(inst["misuse"]) >= 1, f"{aid} missing misuse"
        assert len(inst["verificationBoundary"]) >= 5, f"{aid} missing verificationBoundary"

        # Generate inputSchema
        targets = ["analyze"] + [b["target"] for b in asset["behaviors"]]
        asset["inputSchema"] = {
            "type": "object",
            "required": ["target"],
            "properties": {
                "target": {
                    "type": "string",
                    "enum": targets,
                    "description": "Mathematical target of the request"
                },
                "question": {
                    "type": "string",
                    "description": "For analyze target: the mathematical question or theorem to inspect"
                },
                "assumptions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "For analyze target: list of explicit mathematical assumptions"
                }
            }
        }

        # For each behavior, add its required/optional params to inputSchema properties
        for b in asset["behaviors"]:
            total_behaviors += 1
            tool_name = b["legacyToolName"]
            tools_mapped.add(tool_name)
            for param in b["requiredParams"] + b["optionalParams"]:
                if param not in asset["inputSchema"]["properties"]:
                    asset["inputSchema"]["properties"][param] = {
                        "description": f"Parameter {param} for target {b['target']}"
                    }
            assert b["consumer"] is not None and b["consumer"] != "NONE", f"Behavior {b['target']} has invalid consumer"
            assert b["evidenceCeiling"] in {
                "EXACT_FOR_INPUT", "NUMERICAL_FOR_INPUT", "WITNESS_FOR_INPUT",
                "SAMPLED_OBSERVATION", "CONJECTURE", "GUIDANCE"
            }, f"Invalid evidence ceiling: {b['evidenceCeiling']}"

        # Verify examples
        assert len(asset["examples"]["positive"]) >= 1, f"{aid} missing positive example"
        assert len(asset["examples"]["negative"]) >= 1, f"{aid} missing negative example"

    print(f"Verified all 26 assets.")
    print(f"Total computational behaviors: {total_behaviors}")
    print(f"Total distinct legacy tools mapped: {len(tools_mapped)}")
    assert len(tools_mapped) == 76, f"Expected 76 distinct legacy tools mapped, got {len(tools_mapped)}"

    catalog = {
        "schemaVersion": "math-assets-v1",
        "catalogVersion": "1.0.0",
        "description": "Canonical unified math assets definition catalog for Astra.",
        "assets": ASSETS_SPEC
    }

    out_file = ROOT / "mathagent/resources/math-assets.json"
    out_file.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Successfully generated {out_file} (bytes: {out_file.stat().st_size})")


if __name__ == "__main__":
    build_unified_assets_catalog()
