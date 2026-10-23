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
