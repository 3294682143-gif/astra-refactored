/**
 * @zygos/domain-scientific-computing - Heat Equation Numerical Solver & Verification.
 *
 * Implements:
 * 1. 1D Heat Conduction PDE: \partial u / \partial t = \alpha \partial^2 u / \partial x^2
 *    with Dirichlet boundary conditions: u(0, t) = 0, u(1, t) = 0
 *    Initial condition: u(x, 0) = \sin(\pi x)
 * 2. Exact analytical reference solution: u_{exact}(x, t) = \sin(\pi x) \exp(-\alpha \pi^2 t)
 * 3. Finite Difference Discretization (Explicit Forward Euler scheme)
 * 4. Richardson Extrapolation & Spatial Convergence Rate (O(\Delta x^2))
 * 5. CFL Stability Guard: r = \alpha \Delta t / (\Delta x)^2 <= 0.5
 * 6. Fault Injections: MISSING_BOUNDARY, CFL_VIOLATION, UNIT_MISMATCH
 */

export interface HeatSimulationParams {
  alpha?: number;       // Thermal diffusivity (default: 0.1)
  length?: number;      // Domain length [0, L] (default: 1.0)
  tFinal?: number;      // Final simulation time (default: 0.2)
  nx?: number;          // Spatial grid count (default: 40)
  dt?: number;          // Time step (default: 0.0001, ensures CFL <= 0.5 for alpha=0.1, dx=1/40)
  fault?: "MISSING_BOUNDARY" | "CFL_VIOLATION" | "UNIT_MISMATCH" | null;
}

export interface GridSolution {
  nx: number;
  dx: number;
  dt: number;
  cfl: number;
  xGrid: number[];
  numericalValues: number[];
  exactValues: number[];
  l2Error: number;
  maxError: number;
}

export interface ConvergenceReport {
  scheme: "forward_euler_finite_difference";
  alpha: number;
  tFinal: number;
  grids: { nx: number; dx: number; l2Error: number; maxError: number; cfl: number }[];
  observedOrder: number;      // Richardson extrapolation empirical order ~ 2.0
  expectedOrder: number;      // Theoretical spatial order = 2.0
  isOrderConsistent: boolean;
  cflDiagnosis: {
    maxCfl: number;
    threshold: number;
    isStable: boolean;
    verdict: string;
  };
  boundaryDiagnosis: {
    dirichletMatched: boolean;
    verdict: string;
  };
  allObligationsMet: boolean;
  candidateVerified: false;   // Strict Invariant I15
}

export class HeatEquationSolver {
  /**
   * Analytical reference solution for 1D diffusion with homogeneous Dirichlet BCs
   * and sinusoidal initial condition.
   */
  static analyticalSolution(x: number, t: number, alpha: number): number {
    return Math.sin(Math.PI * x) * Math.exp(-alpha * Math.PI * Math.PI * t);
  }

  /**
   * Run finite difference solver for a specific spatial grid resolution.
   */
  static solve(params: HeatSimulationParams = {}): GridSolution {
    const alpha = params.alpha ?? 0.1;
    const length = params.length ?? 1.0;
    const tFinal = params.tFinal ?? 0.2;
    const nx = params.nx ?? 40;
    const dx = length / nx;

    // Time step: if not specified or CFL violation requested
    let dt = params.dt ?? 0.0001;
    if (params.fault === "CFL_VIOLATION") {
      dt = 0.01; // Intentionally large dt causing CFL > 0.5
    }

    const cfl = (alpha * dt) / (dx * dx);

    // Initial condition on grid
    const xGrid = new Array(nx + 1);
    const u = new Array(nx + 1);
    for (let i = 0; i <= nx; i++) {
      const x = i * dx;
      xGrid[i] = x;
      u[i] = Math.sin(Math.PI * x);
    }

    // Boundary condition fault check
    const enforceBoundary = params.fault !== "MISSING_BOUNDARY";

    // Time integration
    let t = 0.0;
    const uNext = new Array(nx + 1);

    while (t < tFinal - 1e-12) {
      const currentDt = Math.min(dt, tFinal - t);
      const r = (alpha * currentDt) / (dx * dx);

      // Interior updates
      for (let i = 1; i < nx; i++) {
        uNext[i] = u[i] + r * (u[i + 1] - 2 * u[i] + u[i - 1]);
      }

      // Boundary updates
      if (enforceBoundary) {
        uNext[0] = 0.0;
        uNext[nx] = 0.0;
      } else {
        // Missing boundary fault: left unconstrained, causes drift
        uNext[0] = u[0] + r * (u[1] - u[0]);
        uNext[nx] = u[nx] + r * (u[nx - 1] - u[nx]);
      }

      for (let i = 0; i <= nx; i++) {
        u[i] = uNext[i];
      }

      t += currentDt;
    }

    // Compare with exact analytical solution
    const exactValues = new Array(nx + 1);
    let sumSqErr = 0.0;
    let maxErr = 0.0;

    for (let i = 0; i <= nx; i++) {
      const exact = this.analyticalSolution(xGrid[i], tFinal, alpha);
      exactValues[i] = exact;
      const err = Math.abs(u[i] - exact);
      sumSqErr += err * err;
      if (err > maxErr) maxErr = err;
    }

    const l2Error = Math.sqrt(sumSqErr / (nx + 1));

    return {
      nx,
      dx,
      dt,
      cfl,
      xGrid,
      numericalValues: u,
      exactValues,
      l2Error,
      maxError: maxErr,
    };
  }

  /**
   * Perform Richardson extrapolation over multi-mesh refinement (e.g. nx=20, 40, 80)
   * to strictly verify theoretical O(dx^2) spatial convergence and CFL stability.
   */
  static verifyConvergence(
    baseParams: HeatSimulationParams = {},
    meshCounts: number[] = [20, 40, 80]
  ): ConvergenceReport {
    const alpha = baseParams.alpha ?? 0.1;
    const tFinal = baseParams.tFinal ?? 0.2;

    const gridResults = meshCounts.map((nx) => {
      // Adjust dt proportionally to dx^2 so CFL remains identical and stable
      const dx = 1.0 / nx;
      const targetCfl = 0.16; // Safe CFL < 0.5
      const dt = (targetCfl * dx * dx) / alpha;
      return this.solve({
        ...baseParams,
        nx,
        dt: baseParams.fault === "CFL_VIOLATION" ? 0.01 : dt,
      });
    });

    // Richardson extrapolation empirical order calculation:
    // With refinement ratio r = 2 (e.g. 20 -> 40 -> 80), error e_h / e_{h/2} ~ 2^p => p = log2(e1/e2)
    const e1 = gridResults[0]?.l2Error ?? 1e-4;
    const e2 = gridResults[1]?.l2Error ?? 1e-4;
    const e3 = gridResults[2]?.l2Error ?? 1e-4;

    const ratio1 = e2 > 0 ? e1 / e2 : 1;
    const ratio2 = e3 > 0 ? e2 / e3 : 1;
    const observedOrder = (Math.log2(Math.max(1e-12, ratio1)) + Math.log2(Math.max(1e-12, ratio2))) / 2.0;

    const maxCfl = Math.max(...gridResults.map((g) => g.cfl));
    const isStable = maxCfl <= 0.5 && !gridResults.some((g) => isNaN(g.l2Error) || g.l2Error > 10.0);

    // Boundary consistency check
    const boundaryError = Math.max(
      ...gridResults.map((g) =>
        Math.max(
          Math.abs(g.numericalValues[0] ?? 0),
          Math.abs(g.numericalValues[g.numericalValues.length - 1] ?? 0)
        )
      )
    );
    const dirichletMatched = boundaryError < 1e-6;

    const isOrderConsistent = Math.abs(observedOrder - 2.0) <= 0.25; // 2nd order accuracy within tolerance

    const allObligationsMet =
      isStable && dirichletMatched && isOrderConsistent && baseParams.fault == null;

    return {
      scheme: "forward_euler_finite_difference",
      alpha,
      tFinal,
      grids: gridResults.map((g) => ({
        nx: g.nx,
        dx: g.dx,
        l2Error: g.l2Error,
        maxError: g.maxError,
        cfl: g.cfl,
      })),
      observedOrder,
      expectedOrder: 2.0,
      isOrderConsistent,
      cflDiagnosis: {
        maxCfl,
        threshold: 0.5,
        isStable,
        verdict: isStable
          ? `CFL 条件满足 (max CFL = ${maxCfl.toFixed(4)} <= 0.5)，数值显式格式稳定`
          : `CFL 条件违例 (max CFL = ${maxCfl.toFixed(4)} > 0.5)，显式时间格式数值发散`,
      },
      boundaryDiagnosis: {
        dirichletMatched,
        verdict: dirichletMatched
          ? "Dirichlet 齐次边界条件精确满足 (u(0)=u(L)=0)"
          : "边界条件违例：未满足物理边界约束",
      },
      allObligationsMet,
      candidateVerified: false,
    };
  }
}
