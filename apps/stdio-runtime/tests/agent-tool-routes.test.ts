import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticToolRoute } from "../src/agent-semantics.js";

function routeId(problem: string): string | null {
  return semanticToolRoute(problem)?.id ?? null;
}

test("the four new whitelisted tool families have deterministic semantic routes", () => {
  const realRoots = semanticToolRoute("求方程 x^3-3x+1=0 的实根个数。");
  assert.equal(realRoots?.toolName, "real_root_count_expr");
  assert.equal(realRoots?.operation, "REAL_ROOT_COUNT");
  assert.match(realRoots?.argsTemplate ?? "", /expression/u);
  assert.match(realRoots?.argsTemplate ?? "", /variable/u);

  const splitting = semanticToolRoute("求多项式 x^4-2 在 Q 上的分裂域次数 [E:Q]。");
  assert.equal(splitting?.toolName, "splitting_field_degree_expr");
  assert.equal(splitting?.operation, "SPLITTING_FIELD_DEGREE");
  assert.match(splitting?.argsTemplate ?? "", /expression/u);

  const circle = semanticToolRoute("求 f(theta)=sin(theta) 在单位圆上的 Laplacian。");
  assert.equal(circle?.toolName, "circle_laplacian_expr");
  assert.equal(circle?.operation, "CIRCLE_LAPLACIAN");
  assert.match(circle?.argsTemplate ?? "", /theta/u);

  const planar = semanticToolRoute("计算 f(x,y)=x^2*y 的平面 Laplacian。");
  assert.equal(planar?.toolName, "planar_laplacian_expr");
  assert.equal(planar?.operation, "PLANAR_LAPLACIAN");
  assert.match(planar?.argsTemplate ?? "", /variables/u);
});

test("existing finite-enumeration and exact-check routes keep their priority", () => {
  assert.equal(
    semanticToolRoute("从袋中随机抽取两个球，求概率。")?.toolName,
    "bounded_enumeration",
  );
  const determinant = semanticToolRoute("计算给定矩阵的亚历山大多项式 P(t)。");
  assert.equal(determinant?.toolName, "exact_check_expr");
  assert.equal(determinant?.operation, "MAXIMAL_MINORS");
  assert.equal(
    semanticToolRoute("求随机变量的概率密度函数 f(x)。")?.operation,
    "DENSITY_CHECK",
  );
  assert.equal(semanticToolRoute("求极限 lim_{x->0} sin(x)/x。")?.operation, "LIMIT");
});

test("circle wins over the planar fallback but neither wins without Laplacian wording", () => {
  assert.equal(routeId("单位圆上的 Laplacian"), "CIRCLE_LAPLACIAN");
  assert.equal(routeId("平面上的 Laplacian"), "PLANAR_LAPLACIAN");
  assert.equal(routeId("单位圆上的积分"), null);
  assert.equal(routeId("平面几何中的三角形面积"), null);
  assert.equal(routeId("计算给定矩阵的行列式。"), null);
  assert.equal(routeId("求离散随机变量的分布列。"), null);
});

test("routing is semantic and independent of unrelated answer-shaped text", () => {
  assert.equal(routeId("求方程 x^2-2=0 的实根个数，答案是 2，题号 #7。"), "REAL_ROOT_COUNT");
  assert.equal(routeId("求多项式 x^3-1 的分裂域次数，答案是 3。"), "SPLITTING_FIELD_DEGREE");
  assert.notEqual(routeId("判断下列命题是否正确。"), "REAL_ROOT_COUNT");
});

test("polynomial expansion wording routes only coefficient-expansion requests", () => {
  const expand = semanticToolRoute("将 (x+1)(x-2) 展开，求展开式中 x^2 的系数。");
  assert.equal(expand?.toolName, "polynomial_expand_coefficients");
  assert.equal(expand?.operation, "EXPAND_COEFFICIENTS");
  assert.match(expand?.argsTemplate ?? "", /expression/u);
  assert.match(expand?.argsTemplate ?? "", /variables/u);
  assert.match(expand?.argsTemplate ?? "", /parameters/u);

  assert.notEqual(
    semanticToolRoute("求 x^2-2=0 的实根。")?.toolName,
    "polynomial_expand_coefficients",
  );
  assert.notEqual(
    semanticToolRoute("求多项式 x^2-1 的根。")?.toolName,
    "polynomial_expand_coefficients",
  );
});

test("linear-system wording requires an explicit system", () => {
  const system = semanticToolRoute(
    "解线性方程组 \\begin{cases} x+y=3 \\\\ 2x-y=0 \\end{cases}。",
  );
  assert.equal(system?.toolName, "linear_system_solution_set");
  assert.equal(system?.operation, "SOLUTION_SET");
  assert.match(system?.argsTemplate ?? "", /matrix/u);
  assert.match(system?.argsTemplate ?? "", /rhs/u);
  assert.match(system?.argsTemplate ?? "", /variables/u);
  assert.match(system?.argsTemplate ?? "", /domain/u);

  assert.notEqual(
    semanticToolRoute("求解 x+1=0。")?.toolName,
    "linear_system_solution_set",
  );
  assert.notEqual(
    semanticToolRoute("求矩阵 A 的特征值。")?.toolName,
    "linear_system_solution_set",
  );
});

test("finite enumeration widening covers discrete counting but not continuous probability", () => {
  assert.equal(
    semanticToolRoute("从 5 个不同元素中选取 3 个，有多少种不同的选法？")?.toolName,
    "bounded_enumeration",
  );
  assert.equal(
    semanticToolRoute("求集合 {1,2,3,4} 的子集个数。")?.operation,
    "ENUMERATE",
  );
  assert.notEqual(
    semanticToolRoute("设连续型随机变量 X 的概率密度为 f(x)=2x，求 E[X]。")?.toolName,
    "bounded_enumeration",
  );
});

test("series-limit widening covers series sums but not plain integrals", () => {
  assert.equal(
    semanticToolRoute("求级数 \\sum_{n=1}^{\\infty} 1/n^2 的和。")?.operation,
    "LIMIT",
  );
  assert.equal(semanticToolRoute("数列收敛到 0 的渐近极限。")?.operation, "LIMIT");
  assert.notEqual(semanticToolRoute("计算定积分 ∫_0^1 x^2 dx。")?.operation, "LIMIT");
});

test("characteristic-polynomial expansion keeps the determinant route", () => {
  const determinant = semanticToolRoute("计算矩阵 A 的特征多项式，并展开求 t^2 的系数。");
  assert.equal(determinant?.toolName, "exact_check_expr");
  assert.equal(determinant?.operation, "MAXIMAL_MINORS");
});

test("semantic routing is deterministic and call-order independent", () => {
  const samples = [
    "将 (x+1)^5 展开，求 x^3 的系数。",
    "解方程组 \\begin{cases} x+y=1 \\\\ x-y=3 \\end{cases}。",
    "求 A_4 中共轭类的个数。",
    "求级数 \\sum_{n=1}^{\\infty} 1/n^2 的和。",
  ];
  const forward = samples.map((problem) => semanticToolRoute(problem));
  const reverse = [...samples].reverse().map((problem) => semanticToolRoute(problem)).reverse();
  assert.deepEqual(forward, reverse);
  assert.deepEqual(semanticToolRoute(samples[0] as string), forward[0]);
  assert.deepEqual(semanticToolRoute(samples[0] as string), forward[0]);
});


test("interpolation wording routes only explicit interpolation requests", () => {
  const interpolate = semanticToolRoute(
    "给定数据点 (0,1)、(1,4)、(2,9)，用拉格朗日插值求过这些点的多项式。",
  );
  assert.equal(interpolate?.toolName, "interpolation_fit_check");
  assert.equal(interpolate?.operation, "INTERPOLATION_FIT");
  assert.match(interpolate?.argsTemplate ?? "", /points/u);
  assert.match(interpolate?.argsTemplate ?? "", /expression/u);
  assert.match(interpolate?.argsTemplate ?? "", /variable/u);

  assert.equal(
    semanticToolRoute("Use Newton interpolation to fit these points.")?.toolName,
    "interpolation_fit_check",
  );
  assert.notEqual(
    semanticToolRoute("求概率 P(X=1)。")?.toolName,
    "interpolation_fit_check",
  );
  assert.notEqual(
    semanticToolRoute("设 X 服从正态分布，求 E[X]。")?.toolName,
    "interpolation_fit_check",
  );
});

test("OLS wording routes only explicit least-squares/regression requests", () => {
  const ols = semanticToolRoute(
    "对下列成对数据做最小二乘拟合直线，并给出回归系数和残差。",
  );
  assert.equal(ols?.toolName, "stats_ols_check");
  assert.equal(ols?.operation, "OLS_CHECK");
  assert.match(ols?.argsTemplate ?? "", /data/u);
  assert.match(ols?.argsTemplate ?? "", /slope/u);
  assert.match(ols?.argsTemplate ?? "", /intercept/u);

  assert.equal(
    semanticToolRoute("Compute the OLS regression coefficient for these pairs.")?.toolName,
    "stats_ols_check",
  );
  assert.notEqual(semanticToolRoute("求概率 P(X=1)。")?.toolName, "stats_ols_check");
  assert.notEqual(
    semanticToolRoute("设 X 服从指数分布，求其概率密度。")?.toolName,
    "stats_ols_check",
  );
});

test("finite-group wording requires cycles or a supported group name plus structure wording", () => {
  const subgroup = semanticToolRoute(
    "在 S_3 中，求由置换 (12) 和 (123) 生成的子群的阶、元素阶与共轭类。",
  );
  assert.equal(subgroup?.toolName, "finite_group_structure");
  assert.equal(subgroup?.operation, "GROUP_STRUCTURE");
  assert.match(subgroup?.argsTemplate ?? "", /generators/u);
  assert.match(subgroup?.argsTemplate ?? "", /degree/u);
  assert.match(subgroup?.argsTemplate ?? "", /named_group/u);

  assert.equal(
    semanticToolRoute(
      "For the permutation group generated by (12) and (123), list the conjugacy classes.",
    )?.toolName,
    "finite_group_structure",
  );
  assert.equal(
    semanticToolRoute("判断置换 (12345) 的元素的阶。")?.operation,
    "GROUP_STRUCTURE",
  );

  // A named group from the supported vocabulary is enough for structure wording.
  const namedA4 = semanticToolRoute("求 $A_4$ 中共轭类的个数。");
  assert.equal(namedA4?.toolName, "finite_group_structure");
  assert.equal(namedA4?.operation, "GROUP_STRUCTURE");
  assert.equal(
    semanticToolRoute("S_3 的元素阶。")?.operation,
    "GROUP_STRUCTURE",
  );
  assert.equal(
    semanticToolRoute("D_8 是否可交换？")?.operation,
    "GROUP_STRUCTURE",
  );

  // Group terminology without a supported name or explicit cycles stays out.
  assert.notEqual(
    semanticToolRoute("设群 G 同态，判断下列关于群同态的命题是否正确。")?.toolName,
    "finite_group_structure",
  );
  assert.notEqual(
    semanticToolRoute("判断下列关于群同态的命题是否正确。")?.toolName,
    "finite_group_structure",
  );
  // Ring/field wording belongs to another family even when a name/cycle appears.
  assert.notEqual(
    semanticToolRoute("设 R 是环，求由置换 (12) 生成的子群。")?.toolName,
    "finite_group_structure",
  );
  assert.notEqual(
    semanticToolRoute("设 F 是域，求由置换 (12) 生成的子群。")?.toolName,
    "finite_group_structure",
  );
  assert.notEqual(
    semanticToolRoute("设 R 是环，求 A_4 的中心。")?.toolName,
    "finite_group_structure",
  );
  assert.notEqual(
    semanticToolRoute("设 F 是域，求 A_4 的阶。")?.toolName,
    "finite_group_structure",
  );
});

test("definite-integral wording routes explicit bounded integral values only", () => {
  const chinese = semanticToolRoute("计算定积分 ∫_0^1 x^2 dx。");
  assert.equal(chinese?.toolName, "exact_check_expr");
  assert.equal(chinese?.operation, "DEFINITE_INTEGRAL");
  assert.match(chinese?.argsTemplate ?? "", /expression/u);
  assert.match(chinese?.argsTemplate ?? "", /variable/u);
  assert.match(chinese?.argsTemplate ?? "", /lower/u);
  assert.match(chinese?.argsTemplate ?? "", /upper/u);

  assert.equal(
    semanticToolRoute("求 \\int_{0}^{1} x^2 dx 的值。")?.operation,
    "DEFINITE_INTEGRAL",
  );
  assert.equal(
    semanticToolRoute("Evaluate the definite integral \\int_1^2 (x+1) dx.")?.operation,
    "DEFINITE_INTEGRAL",
  );
  assert.equal(routeId("求 ∫_0^{\\pi} sin x dx 的值。"), "EXACT_DEFINITE_INTEGRAL");

  // A purely qualitative discussion asks for no value, so it never routes.
  assert.notEqual(
    semanticToolRoute("判断反常积分 ∫_1^{\\infty} 1/x^{p} dx 的收敛性。")?.operation,
    "DEFINITE_INTEGRAL",
  );
  assert.notEqual(
    semanticToolRoute("讨论 ∫_0^1 1/x dx 的可积性。")?.operation,
    "DEFINITE_INTEGRAL",
  );
  // A bare integral sign without limits and without a compute verb is not enough.
  assert.notEqual(routeId("设 f 连续，讨论 ∫ f 的几何意义。"), "EXACT_DEFINITE_INTEGRAL");
  assert.notEqual(routeId("积分在物理中的应用。"), "EXACT_DEFINITE_INTEGRAL");
});

test("simplification wording routes explicit expression reductions only", () => {
  const fraction = semanticToolRoute("化简 (x^2-1)/(x-1)。");
  assert.equal(fraction?.toolName, "exact_check_expr");
  assert.equal(fraction?.operation, "SIMPLIFY");
  assert.match(fraction?.argsTemplate ?? "", /expression/u);
  assert.match(fraction?.argsTemplate ?? "", /variable/u);

  assert.equal(
    semanticToolRoute("先通分再化简：1/(x-1) - 1/(x+1)。")?.operation,
    "SIMPLIFY",
  );
  assert.equal(semanticToolRoute("约分 \\frac{6x}{8x^2}。")?.operation, "SIMPLIFY");
  assert.equal(
    semanticToolRoute("Simplify the expression (x^2-4)/(x-2).")?.operation,
    "SIMPLIFY",
  );
  assert.equal(
    semanticToolRoute("Reduce the fraction 6/8 to lowest terms.")?.operation,
    "SIMPLIFY",
  );

  // An explicit expansion or coefficient request keeps the expansion route.
  assert.equal(
    semanticToolRoute("将 (x+1)^5 展开，求 x^3 的系数。")?.operation,
    "EXPAND_COEFFICIENTS",
  );
  assert.equal(
    semanticToolRoute("将 (x+1)(x-2) 展开，求展开式中 x^2 的系数。")?.operation,
    "EXPAND_COEFFICIENTS",
  );
  // Solving an equation is not a simplification of an expression.
  assert.notEqual(semanticToolRoute("解方程 x^2-1=0 并化简。")?.operation, "SIMPLIFY");
  assert.notEqual(routeId("设 X 服从正态分布，求其概率密度。"), "EXACT_SIMPLIFY");
});

test("the limit, integral and simplification routes are mutually exclusive", () => {
  // A `\\lim` item stays LIMIT even when an integral appears inside it.
  assert.equal(
    routeId("求 \\lim_{x\\to 0} \\frac{\\int_0^x \\sin t dt}{x}。"),
    "EXACT_LIMIT",
  );
  assert.equal(routeId("求极限 lim_{x->0} sin(x)/x。"), "EXACT_LIMIT");
  assert.equal(routeId("求级数 \\sum_{n=1}^{\\infty} 1/n^2 的和。"), "EXACT_LIMIT");
  // An `\\int` item is never the LIMIT family.
  assert.equal(routeId("计算定积分 \\int_0^1 x^2 dx。"), "EXACT_DEFINITE_INTEGRAL");
  assert.equal(routeId("求 ∫_0^{\\pi} sin x dx 的值。"), "EXACT_DEFINITE_INTEGRAL");
  assert.notEqual(routeId("计算定积分 \\int_0^1 x^2 dx。"), "EXACT_LIMIT");
  // A simplification item is neither a limit nor an integral.
  assert.equal(routeId("化简 (x^2-1)/(x-1)。"), "EXACT_SIMPLIFY");
  assert.notEqual(routeId("化简 (x^2-1)/(x-1)。"), "EXACT_LIMIT");
});

test("the integral and simplification routes are deterministic", () => {
  const samples = [
    "计算定积分 \\int_0^1 x^2 dx。",
    "求 ∫_0^{\\pi} sin x dx 的值。",
    "化简 (x^2-1)/(x-1)。",
    "先通分再化简：1/(x-1) - 1/(x+1)。",
    "求极限 lim_{x->0} sin(x)/x。",
    "判断反常积分 ∫_1^{\\infty} 1/x^{p} dx 的收敛性。",
  ];
  const forward = samples.map((problem) => semanticToolRoute(problem));
  const reverse = [...samples].reverse().map((problem) => semanticToolRoute(problem)).reverse();
  assert.deepEqual(forward, reverse);
  for (const problem of samples) {
    assert.deepEqual(semanticToolRoute(problem), semanticToolRoute(problem));
  }
  assert.deepEqual(forward.map((route) => route?.id ?? null), [
    "EXACT_DEFINITE_INTEGRAL",
    "EXACT_DEFINITE_INTEGRAL",
    "EXACT_SIMPLIFY",
    "EXACT_SIMPLIFY",
    "EXACT_LIMIT",
    null,
  ]);
});

test("quadratic Diophantine wording routes finite two-variable integer equations only", () => {
  const route = semanticToolRoute("求二次丢番图方程 x^2+y^2=25 的整数解。");
  assert.equal(route?.id, "SOLVE_QUADRATIC_DIOPHANTINE");
  assert.equal(route?.toolName, "solve_quadratic_diophantine");
  assert.equal(route?.operation, "SOLVE_QUADRATIC_DIOPHANTINE");
  for (const field of ["a", "b", "c", "d", "e", "f", "y_bound"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(
    routeId("求丢番图方程 x^2-2y^2=1 的整数解。"),
    "SOLVE_QUADRATIC_DIOPHANTINE",
  );
  assert.equal(routeId("求方程 x^2-2=0 的整数解。"), null);
  assert.equal(routeId("求解 x^2+y^2 的最小值。"), null);
});

test("symbolic Diophantine wording requires an explicit symbolic search", () => {
  const route = semanticToolRoute(
    "用符号方法求解丢番图方程 x^2+y^2=25 的整数解集。",
  );
  assert.equal(route?.id, "SYMBOLIC_DIOPHANTINE");
  assert.equal(route?.toolName, "symbolic_diophantine_with_timeout");
  assert.equal(route?.operation, "SYMBOLIC_DIOPHANTINE");
  for (const field of ["lhs", "rhs", "variables", "timeout_ms"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(
    routeId("求解下列多项式方程组的全部整数解集。"),
    "SYMBOLIC_DIOPHANTINE",
  );
  assert.equal(routeId("解方程 x^2-4=0。"), null);
  assert.notEqual(routeId("求二次丢番图方程 x^2+y^2=25 的整数解。"), "SYMBOLIC_DIOPHANTINE");
});

test("system-of-expressions wording routes nonlinear polynomial systems only", () => {
  const route = semanticToolRoute("解下列非线性方程组 x^2+y^2=1, x-y=0。");
  assert.equal(route?.id, "SYSTEM_OF_EXPRESSIONS");
  assert.equal(route?.toolName, "solve_system_guarded_expr");
  assert.equal(route?.operation, "SYSTEM_OF_EXPRESSIONS");
  for (const field of ["expressions", "variables", "timeout_ms", "n_starts", "seed"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(
    routeId("求联立多项式方程 x^2+y^2=1 与 x-y=0 的实解。"),
    "SYSTEM_OF_EXPRESSIONS",
  );
  assert.notEqual(
    semanticToolRoute("解线性方程组 x+y=3, x-y=1。")?.id,
    "SYSTEM_OF_EXPRESSIONS",
  );
  assert.notEqual(routeId("解非线性方程 x^2=2。"), "SYSTEM_OF_EXPRESSIONS");
});

test("polynomial identity wording routes claimed functional equality checks only", () => {
  const route = semanticToolRoute(
    "验证多项式恒等式 f(x+y)=f(x)+f(y) 对 f(x)=x 是否成立。",
  );
  assert.equal(route?.id, "POLYNOMIAL_FUNCTION_CHECK");
  assert.equal(route?.toolName, "polynomial_function_check");
  assert.equal(route?.operation, "POLYNOMIAL_FUNCTION_CHECK");
  for (const field of ["equation", "function", "argument", "variables", "expression"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(
    routeId("将 f(x)=x^2 代入核验恒等式 f(x+y)=f(x)+f(y) 是否成立。"),
    "POLYNOMIAL_FUNCTION_CHECK",
  );
  assert.notEqual(
    semanticToolRoute("将 (x+1)(x-2) 展开，求展开式中 x^2 的系数。")?.id,
    "POLYNOMIAL_FUNCTION_CHECK",
  );
  assert.notEqual(routeId("化简 (x^2-1)/(x-1)。"), "POLYNOMIAL_FUNCTION_CHECK");
});

test("GF(2) rank wording requires binary linear-space context and rank wording", () => {
  const route = semanticToolRoute("求 GF(2) 上矩阵的秩。");
  assert.equal(route?.id, "GF2_RANK");
  assert.equal(route?.toolName, "gf2_rank");
  assert.equal(route?.operation, "GF2_RANK");
  assert.match(route?.argsTemplate ?? "", /"rows"/u);

  assert.equal(routeId("求二元矩阵的秩。"), "GF2_RANK");
  assert.equal(routeId("Compute the rank of the binary matrix over GF(2)."), "GF2_RANK");
  assert.equal(routeId("求实数矩阵的秩。"), null);
});

test("GF(2) nullspace wording requires binary linear-space context and kernel wording", () => {
  const route = semanticToolRoute("求 GF(2) 上矩阵的零空间（核空间）。");
  assert.equal(route?.id, "GF2_NULLSPACE");
  assert.equal(route?.toolName, "gf2_nullspace");
  assert.equal(route?.operation, "GF2_NULLSPACE");
  for (const field of ["rows", "width"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(routeId("求模 2 下的线性相关关系。"), "GF2_NULLSPACE");
  assert.notEqual(routeId("求 GF(2) 上矩阵的秩。"), "GF2_NULLSPACE");
  assert.equal(routeId("求实数矩阵的零空间。"), null);
});

test("the Phase-2 semantic families keep their mutual exclusions", () => {
  // A linear system stays with its own family, while a non-linear system does not.
  assert.equal(routeId("解线性方程组 x+y=3, x-y=1。"), "LINEAR_SYSTEM_SOLUTION_SET");
  assert.equal(routeId("解下列非线性方程组 x^2+y^2=1, x-y=0。"), "SYSTEM_OF_EXPRESSIONS");
  assert.notEqual(routeId("解下列非线性方程组 x^2+y^2=1, x-y=0。"), "LINEAR_SYSTEM_SOLUTION_SET");
  // A plain single equation is not a Diophantine route.
  assert.equal(routeId("解方程 x^2-4=0。"), null);
  assert.equal(routeId("求方程 x^2=25 的整数解。"), null);
  assert.notEqual(routeId("求方程 x^2=25 的整数解。"), "SOLVE_QUADRATIC_DIOPHANTINE");
  // Integer-solution system wording stays symbolic rather than generic system.
  assert.equal(routeId("求解下列多项式方程组的全部整数解集。"), "SYMBOLIC_DIOPHANTINE");
  assert.notEqual(routeId("求解下列多项式方程组的全部整数解集。"), "SYSTEM_OF_EXPRESSIONS");
  // A GF(2) kernel question is never the rank family, even through linear-system prose.
  assert.equal(routeId("求 GF(2) 上矩阵的零空间（核空间）。"), "GF2_NULLSPACE");
  assert.notEqual(routeId("求 GF(2) 上矩阵的零空间（核空间）。"), "GF2_RANK");
  assert.equal(routeId("求 GF(2) 上齐次线性方程组的零空间。"), "GF2_NULLSPACE");
  assert.notEqual(routeId("求 GF(2) 上齐次线性方程组的零空间。"), "LINEAR_SYSTEM_SOLUTION_SET");
});

test("the Phase-2 semantic routes are deterministic and call-order independent", () => {
  const samples = [
    "求二次丢番图方程 x^2+y^2=25 的整数解。",
    "用符号方法求解丢番图方程 x^2+y^2=25 的整数解集。",
    "解下列非线性方程组 x^2+y^2=1, x-y=0。",
    "验证多项式恒等式 f(x+y)=f(x)+f(y) 对 f(x)=x 是否成立。",
    "求 GF(2) 上矩阵的秩。",
    "求 GF(2) 上矩阵的零空间（核空间）。",
    "解方程 x^2-4=0。",
  ];
  const forward = samples.map((problem) => semanticToolRoute(problem));
  const reverse = [...samples].reverse().map((problem) => semanticToolRoute(problem)).reverse();
  assert.deepEqual(forward, reverse);
  for (const problem of samples) {
    assert.deepEqual(semanticToolRoute(problem), semanticToolRoute(problem));
  }
  assert.deepEqual(forward.map((route) => route?.id ?? null), [
    "SOLVE_QUADRATIC_DIOPHANTINE",
    "SYMBOLIC_DIOPHANTINE",
    "SYSTEM_OF_EXPRESSIONS",
    "POLYNOMIAL_FUNCTION_CHECK",
    "GF2_RANK",
    "GF2_NULLSPACE",
    null,
  ]);
});

test("transition-count wording requires state transitions plus a count phrase", () => {
  const route = semanticToolRoute(
    "有向图有 3 个状态，状态转移如图，求长为 4 的顶点序列数。",
  );
  assert.equal(route?.id, "TRANSITION_COUNT");
  assert.equal(route?.toolName, "transition_count");
  assert.equal(route?.operation, "TRANSITION_COUNT");
  for (const field of ["length", "num_states", "transitions"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }
  assert.notEqual(route?.id, "FINITE_ENUMERATION");

  assert.equal(routeId("求有向图中长度为 3 的路径条数。"), null);
  assert.notEqual(
    routeId("求有向图中长度为 3 的路径条数。"),
    "TRANSITION_COUNT",
  );
});

test("independence-polynomial-chain wording is path-specific", () => {
  const route = semanticToolRoute("求路图 P_5 的独立集多项式的系数。");
  assert.equal(route?.id, "INDEPENDENCE_POLYNOMIAL_CHAIN");
  assert.equal(route?.toolName, "independence_polynomial_chain");
  assert.match(route?.argsTemplate ?? "", /"n"/u);
  assert.notEqual(route?.id, "EXPAND_COEFFICIENTS");
  assert.notEqual(route?.id, "FINITE_ENUMERATION");

  assert.equal(routeId("求一般图的最大独立集。"), null);
  assert.notEqual(routeId("求一般图的最大独立集。"), "INDEPENDENCE_POLYNOMIAL_CHAIN");
});

test("digit-property wording requires decimal digit-set or digit-DP context", () => {
  const route = semanticToolRoute("由数字集合 {1,2,3} 组成且能被 3 整除的数有多少个？");
  assert.equal(route?.id, "COUNT_BY_DIGIT_PROPERTY");
  assert.equal(route?.toolName, "count_by_digit_property");
  for (const field of ["digit_set", "max_digits", "modulus", "residue", "include_zero"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }
  assert.notEqual(route?.id, "FINITE_ENUMERATION");

  assert.equal(routeId("一个数的各位数字之和是多少？"), null);
  assert.notEqual(routeId("一个数的各位数字之和是多少？"), "COUNT_BY_DIGIT_PROPERTY");
});

test("rook-number wording requires an explicit forbidden-board rook request", () => {
  const route = semanticToolRoute("求 3x3 棋盘禁位棋盘的车多项式的系数。");
  assert.equal(route?.id, "ROOK_NUMBERS");
  assert.equal(route?.toolName, "rook_numbers");
  for (const field of ["n", "forbidden"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }
  assert.notEqual(route?.id, "EXPAND_COEFFICIENTS");
  assert.notEqual(route?.id, "FINITE_ENUMERATION");

  assert.equal(routeId("求 8 皇后问题的解的个数。"), null);
  assert.notEqual(routeId("求 8 皇后问题的解的个数。"), "ROOK_NUMBERS");
});

test("avoiding-permutation wording requires forbidden positions or derangements", () => {
  const route = semanticToolRoute(
    "求 4 个元素的禁止位置集合的排列数，避开所有禁位。",
  );
  assert.equal(route?.id, "COUNT_AVOIDING_PERMUTATIONS");
  assert.equal(route?.toolName, "count_avoiding_permutations");
  for (const field of ["n", "forbidden"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }
  assert.notEqual(route?.id, "FINITE_ENUMERATION");

  assert.equal(routeId("求 5 个元素的全排列数。"), "FINITE_ENUMERATION");
  assert.notEqual(routeId("求 5 个元素的全排列数。"), "COUNT_AVOIDING_PERMUTATIONS");
});

test("Markov expectation wording requires both a chain and a hitting expectation", () => {
  const route = semanticToolRoute(
    "设马尔可夫链的转移概率矩阵为 P，求从状态 0 到状态 2 的期望步数。",
  );
  assert.equal(route?.id, "MARKOV_EXPECTED_STEPS");
  assert.equal(route?.toolName, "markov_expected_steps");
  for (const field of ["transition", "start", "targets"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }
  // The broad finite-enumeration family must never win this item.
  assert.notEqual(route?.id, "FINITE_ENUMERATION");

  assert.equal(
    routeId("设马尔可夫链的转移概率矩阵为 P，求其平稳分布。"),
    null,
  );
  assert.notEqual(
    routeId("设马尔可夫链的转移概率矩阵为 P，求其平稳分布。"),
    "MARKOV_EXPECTED_STEPS",
  );
});

test("complete-graph cover-time wording requires complete-graph and cover wording", () => {
  const route = semanticToolRoute("求完全图 K_4 上随机游走的覆盖时间。");
  assert.equal(route?.id, "COVER_TIME_COMPLETE_GRAPH");
  assert.equal(route?.toolName, "cover_time_complete_graph");
  assert.match(route?.argsTemplate ?? "", /"num_vertices"/u);
  // A cover-time walk is not the state-transition sequence family.
  assert.notEqual(route?.id, "TRANSITION_COUNT");

  const vertexCover = semanticToolRoute(
    "求完全图 K_5 上随机游走访问所有顶点的期望步数。",
  );
  assert.equal(vertexCover?.id, "COVER_TIME_COMPLETE_GRAPH");
  assert.notEqual(vertexCover?.id, "TRANSITION_COUNT");

  assert.equal(routeId("求完全图 K_5 的边数。"), null);
  assert.notEqual(routeId("求完全图 K_5 的边数。"), "COVER_TIME_COMPLETE_GRAPH");
});

test("finite-difference wording excludes explicit Richardson requests", () => {
  const route = semanticToolRoute(
    "用中心差分近似求 f(x)=x^3 在 x=1 处的导数，步长 h=0.01。",
  );
  assert.equal(route?.id, "FINITE_DIFFERENCE_DERIVATIVE");
  assert.equal(route?.toolName, "finite_difference_derivative");
  for (const field of ["f", "x", "h", "method"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(routeId("求 f(x)=x^3 在 x=1 处的精确导数。"), null);
  assert.equal(
    routeId("用 Richardson 外推改进中心差分的数值导数结果。"),
    "RICHARDSON_EXTRAPOLATE",
  );
  assert.notEqual(
    routeId("用 Richardson 外推改进中心差分的数值导数结果。"),
    "FINITE_DIFFERENCE_DERIVATIVE",
  );
});

test("Richardson extrapolation wording has its own route", () => {
  const route = semanticToolRoute(
    "使用 Richardson 外推法计算 f(x)=x^3 在 x=1 处的数值导数。",
  );
  assert.equal(route?.id, "RICHARDSON_EXTRAPOLATE");
  assert.equal(route?.toolName, "richardson_extrapolate");
  for (const field of ["f", "x", "h", "method", "order"]) {
    assert.match(route?.argsTemplate ?? "", new RegExp(`"${field}"`, "u"));
  }

  assert.equal(
    routeId("使用中心差分计算数值导数。"),
    "FINITE_DIFFERENCE_DERIVATIVE",
  );
  assert.notEqual(
    routeId("使用中心差分计算数值导数。"),
    "RICHARDSON_EXTRAPOLATE",
  );
});

test("the Phase-3 tool routes are deterministic and call-order independent", () => {
  const samples = [
    "有向图有 3 个状态，状态转移如图，求长为 4 的顶点序列数。",
    "求有向图中长度为 3 的路径条数。",
    "求路图 P_5 的独立集多项式的系数。",
    "求一般图的最大独立集。",
    "由数字集合 {1,2,3} 组成且能被 3 整除的数有多少个？",
    "一个数的各位数字之和是多少？",
    "求 3x3 棋盘禁位棋盘的车多项式的系数。",
    "求 8 皇后问题的解的个数。",
    "求 4 个元素的禁止位置集合的排列数，避开所有禁位。",
    "求 5 个元素的全排列数。",
    "设马尔可夫链的转移概率矩阵为 P，求从状态 0 到状态 2 的期望步数。",
    "设马尔可夫链的转移概率矩阵为 P，求其平稳分布。",
    "求完全图 K_4 上随机游走的覆盖时间。",
    "求完全图 K_5 的边数。",
    "用中心差分近似求 f(x)=x^3 在 x=1 处的导数，步长 h=0.01。",
    "求 f(x)=x^3 在 x=1 处的精确导数。",
    "使用 Richardson 外推法计算 f(x)=x^3 在 x=1 处的数值导数。",
    "使用中心差分计算数值导数。",
  ];
  const forward = samples.map((problem) => semanticToolRoute(problem));
  const reverse = [...samples].reverse().map((problem) => semanticToolRoute(problem)).reverse();
  assert.deepEqual(forward, reverse);
  for (const problem of samples) {
    assert.deepEqual(semanticToolRoute(problem), semanticToolRoute(problem));
  }
  assert.deepEqual(forward.map((route) => route?.id ?? null), [
    "TRANSITION_COUNT",
    null,
    "INDEPENDENCE_POLYNOMIAL_CHAIN",
    null,
    "COUNT_BY_DIGIT_PROPERTY",
    null,
    "ROOK_NUMBERS",
    null,
    "COUNT_AVOIDING_PERMUTATIONS",
    "FINITE_ENUMERATION",
    "MARKOV_EXPECTED_STEPS",
    null,
    "COVER_TIME_COMPLETE_GRAPH",
    null,
    "FINITE_DIFFERENCE_DERIVATIVE",
    null,
    "RICHARDSON_EXTRAPOLATE",
    "FINITE_DIFFERENCE_DERIVATIVE",
  ]);
});
