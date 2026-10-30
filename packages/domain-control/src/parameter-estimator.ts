/**
 * @zygos/domain-control — Forced Damped Oscillator Parameter Estimator & Verifiers.
 *
 * Implements Section 15 of Track160 Execution Plan:
 * 1. Least-squares numerical parameter estimator for:
 *    m * x''(t) + c * x'(t) + k * x(t) = u(t)
 * 2. Train/Validation physical isolation guard (T36)
 * 3. Sampling rate aliasing guard (fs >= 10 * system_bandwidth)
 * 4. Residual whiteness diagnosis (autocorrelation check; non-white -> STRUCTURE_UNDERDETERMINED)
 */

export interface TimeSeriesPoint {
  readonly t: number;
  readonly u: number;
  readonly x: number;
  readonly sampleId: number;
  readonly partition: "train" | "validation";
}

export interface EstimationDataset {
  readonly dt: number;
  readonly points: readonly TimeSeriesPoint[];
  readonly trainIndices: readonly number[];
  readonly valIndices: readonly number[];
}

export interface IdentifiedParameters {
  readonly mass: number;
  readonly damping: number;
  readonly stiffness: number;
}

export interface ConfidenceIntervals {
  readonly mass: readonly [number, number];
  readonly damping: readonly [number, number];
  readonly stiffness: readonly [number, number];
}

export interface SamplingGuardResult {
  readonly fsHz: number;
  readonly systemBandwidthHz: number;
  readonly tenTimesBandwidthHz: number;
  readonly aliasingDetected: boolean;
  readonly verdict: string;
}

export interface LeakageGuardResult {
  readonly trainSamplesCount: number;
  readonly valSamplesCount: number;
  readonly leakageDetected: boolean;
  readonly verdict: string;
}

export interface ResidualDiagnosisResult {
  readonly lag1Autocorrelation: number;
  readonly isWhite: boolean;
  readonly diagnosis: "RESIDUAL_WHITE" | "STRUCTURE_UNDERDETERMINED";
  readonly verdict: string;
}

export interface HoldoutValidationResult {
  readonly holdoutRmse: number;
  readonly threshold: number;
  readonly passed: boolean;
  readonly simulatedTrajectory: readonly number[];
}

export interface ControlIdentificationResult {
  readonly domainId: "control.identification";
  readonly targetSystem: "forced_damped_oscillator";
  readonly parameters: IdentifiedParameters;
  readonly confidenceIntervals: ConfidenceIntervals;
  readonly samplingGuard: SamplingGuardResult;
  readonly leakageGuard: LeakageGuardResult;
  readonly residualDiagnosis: ResidualDiagnosisResult;
  readonly holdoutValidation: HoldoutValidationResult;
  readonly allObligationsMet: boolean;
}

/**
 * Solve a 3x3 linear system A * theta = b via explicit Cramer's rule / adjugate.
 */
function solve3x3(A: number[][], b: number[]): { theta: [number, number, number]; invA: number[][] } {
  const a00 = A[0]![0]!, a01 = A[0]![1]!, a02 = A[0]![2]!;
  const a10 = A[1]![0]!, a11 = A[1]![1]!, a12 = A[1]![2]!;
  const a20 = A[2]![0]!, a21 = A[2]![1]!, a22 = A[2]![2]!;

  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);

  if (Math.abs(det) < 1e-12) {
    throw new Error("Singular normal equation matrix in parameter estimator (insufficient excitation)");
  }

  const invDet = 1.0 / det;
  const c00 = (a11 * a22 - a12 * a21) * invDet;
  const c01 = (a02 * a21 - a01 * a22) * invDet;
  const c02 = (a01 * a12 - a02 * a11) * invDet;

  const c10 = (a12 * a20 - a10 * a22) * invDet;
  const c11 = (a00 * a22 - a02 * a20) * invDet;
  const c12 = (a02 * a10 - a00 * a12) * invDet;

  const c20 = (a10 * a21 - a11 * a20) * invDet;
  const c21 = (a01 * a20 - a00 * a21) * invDet;
  const c22 = (a00 * a11 - a01 * a10) * invDet;

  const invA = [
    [c00, c01, c02],
    [c10, c11, c12],
    [c20, c21, c22],
  ];

  const theta: [number, number, number] = [
    c00 * b[0]! + c01 * b[1]! + c02 * b[2]!,
    c10 * b[0]! + c11 * b[1]! + c12 * b[2]!,
    c20 * b[0]! + c21 * b[1]! + c22 * b[2]!,
  ];

  return { theta, invA };
}

/**
 * Generate synthetic simulation dataset for test and verification.
 */
export function generateOscillatorDataset(options: {
  readonly m: number;
  readonly c: number;
  readonly k: number;
  readonly duration: number;
  readonly dt: number;
  readonly noiseStd?: number;
  readonly unmodeledNonlinearStiffness?: number; // for testing whiteness diagnosis
  readonly holdoutRatio?: number;
}): EstimationDataset {
  const { m, c, k, duration, dt, noiseStd = 0.001, unmodeledNonlinearStiffness = 0.0, holdoutRatio = 0.2 } = options;
  const N = Math.floor(duration / dt);
  const points: TimeSeriesPoint[] = [];

  let x = 0.0;
  let v = 0.0;

  // Simple pseudo-random generator with deterministic seed
  let seed = 42;
  const randn = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    const u1 = Math.max(1e-7, seed / 233280.0);
    seed = (seed * 9301 + 49297) % 233280;
    const u2 = seed / 233280.0;
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  };

  const splitThreshold = Math.floor(N * (1.0 - holdoutRatio));
  const trainIndices: number[] = [];
  const valIndices: number[] = [];

  for (let i = 0; i < N; i++) {
    const t = i * dt;
    // Multi-frequency excitation to ensure persistent excitation
    const u = Math.sin(1.5 * t) + 0.8 * Math.cos(3.2 * t) + 0.5 * Math.sin(0.5 * t);

    const measuredX = x + noiseStd * randn();
    const partition: "train" | "validation" = i < splitThreshold ? "train" : "validation";
    if (partition === "train") {
      trainIndices.push(i);
    } else {
      valIndices.push(i);
    }

    points.push({
      t,
      u,
      x: measuredX,
      sampleId: i,
      partition,
    });

    // RK4 numerical step for ground truth state
    const f = (tState: number, xState: number, vState: number): [number, number] => {
      const uCurrent = Math.sin(1.5 * tState) + 0.8 * Math.cos(3.2 * tState) + 0.5 * Math.sin(0.5 * tState);
      const restoringForce = k * xState + unmodeledNonlinearStiffness * Math.pow(xState, 3);
      const a = (uCurrent - c * vState - restoringForce) / m;
      return [vState, a];
    };

    const [k1x, k1v] = f(t, x, v);
    const [k2x, k2v] = f(t + 0.5 * dt, x + 0.5 * dt * k1x, v + 0.5 * dt * k1v);
    const [k3x, k3v] = f(t + 0.5 * dt, x + 0.5 * dt * k2x, v + 0.5 * dt * k2v);
    const [k4x, k4v] = f(t + dt, x + dt * k3x, v + dt * k3v);

    x += (dt / 6.0) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (dt / 6.0) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }

  return { dt, points, trainIndices, valIndices };
}

/**
 * Core Parameter Estimator & Verifier.
 */
export class ParameterEstimator {
  /**
   * Run full identification pipeline on dataset.
   * If `contaminatedIndices` is provided (for T36 test), it forces use of holdout samples.
   */
  static estimate(
    dataset: EstimationDataset,
    options?: {
      readonly forceContaminatedIndices?: readonly number[];
      readonly maxHoldoutRmse?: number;
    }
  ): ControlIdentificationResult {
    const dt = dataset.dt;
    const fsHz = 1.0 / dt;
    const maxHoldoutRmse = options?.maxHoldoutRmse ?? 0.05;

    // 1. Train / Validation Separation & Leakage Check (T36)
    const activeIndices = options?.forceContaminatedIndices && options.forceContaminatedIndices.length > 0
      ? options.forceContaminatedIndices
      : dataset.trainIndices;

    const valSet = new Set(dataset.valIndices);
    const leakedIndices = activeIndices.filter((idx) => valSet.has(idx));
    const leakageDetected = leakedIndices.length > 0;
    const leakageVerdict = leakageDetected
      ? `T36违规：参数拟合使用了保留验证集样本 (包含验证样本数=${leakedIndices.length})，严禁数据穿越，拒绝验收`
      : `训练/验证集物理隔离严格成立 (训练样本数=${activeIndices.length}, 独立验证样本数=${dataset.valIndices.length})`;

    // 2. Continuous-time Integral Linear Regression on Active Indices
    // Integrating m*x'' + c*x' + k*x = u twice gives:
    // m * (x(t) - x0 - v0*t) + c * (I1_x(t) - x0*t) + k * I2_x(t) = I2_u(t)
    // where I1(f) = \int_0^t f(tau) dtau, I2(f) = \int_0^t I1(f)(tau) dtau.
    // Integration naturally suppresses measurement noise rather than amplifying it.
    const N_pts = dataset.points.length;
    const I1_u = new Float64Array(N_pts);
    const I2_u = new Float64Array(N_pts);
    const I1_x = new Float64Array(N_pts);
    const I2_x = new Float64Array(N_pts);

    for (let i = 1; i < N_pts; i++) {
      const pPrev = dataset.points[i - 1]!;
      const pCurr = dataset.points[i]!;
      I1_u[i] = I1_u[i - 1]! + 0.5 * dt * (pCurr.u + pPrev.u);
      I2_u[i] = I2_u[i - 1]! + 0.5 * dt * (I1_u[i]! + I1_u[i - 1]!);

      I1_x[i] = I1_x[i - 1]! + 0.5 * dt * (pCurr.x + pPrev.x);
      I2_x[i] = I2_x[i - 1]! + 0.5 * dt * (I1_x[i]! + I1_x[i - 1]!);
    }

    const x0 = dataset.points[0]?.x ?? 0.0;
    const v0 = N_pts > 1 ? ((dataset.points[1]?.x ?? 0.0) - x0) / dt : 0.0;

    let A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    let B = [0, 0, 0];

    const residuals: number[] = [];
    const validFitPoints: { phi: [number, number, number]; y: number }[] = [];

    for (const idx of activeIndices) {
      if (idx < 5 || idx >= N_pts) continue;
      const pt = dataset.points[idx]!;
      const t = pt.t;

      const phi0 = pt.x - x0 - v0 * t;
      const phi1 = I1_x[idx]! - x0 * t;
      const phi2 = I2_x[idx]!;
      const y = I2_u[idx]!;

      const phi: [number, number, number] = [phi0, phi1, phi2];
      validFitPoints.push({ phi, y });

      for (let r = 0; r < 3; r++) {
        B[r]! += phi[r]! * y;
        for (let c = 0; c < 3; c++) {
          A[r]![c]! += phi[r]! * phi[c]!;
        }
      }
    }

    if (validFitPoints.length < 5) {
      throw new Error("Insufficient data points for control parameter estimation");
    }

    // Solve for theta = [m, c, k]
    const { theta, invA } = solve3x3(A, B);
    const [rawM, rawC, rawK] = theta;

    // Physical sanity: mass, damping, stiffness
    const m = Math.max(1e-4, rawM);
    const c = Math.max(1e-4, rawC);
    const k = Math.max(1e-4, rawK);

    // Compute residual series & standard errors
    let rss = 0.0;
    for (const pt of validFitPoints) {
      const predY = m * pt.phi[0]! + c * pt.phi[1]! + k * pt.phi[2]!;
      const r = pt.y - predY;
      residuals.push(r);
      rss += r * r;
    }

    const dof = Math.max(1, validFitPoints.length - 3);
    const sigma2 = rss / dof;

    const seM = Math.sqrt(Math.max(1e-8, sigma2 * invA[0]![0]!));
    const seC = Math.sqrt(Math.max(1e-8, sigma2 * invA[1]![1]!));
    const seK = Math.sqrt(Math.max(1e-8, sigma2 * invA[2]![2]!));

    const confidenceIntervals: ConfidenceIntervals = {
      mass: [Math.max(0, m - 1.96 * seM), m + 1.96 * seM],
      damping: [Math.max(0, c - 1.96 * seC), c + 1.96 * seC],
      stiffness: [Math.max(0, k - 1.96 * seK), k + 1.96 * seK],
    };

    // 3. Sampling Rate Aliasing Guard (< 10x Bandwidth)
    const omegaN = Math.sqrt(k / m);
    const systemBandwidthHz = omegaN / (2.0 * Math.PI);
    const tenTimesBandwidthHz = 10.0 * systemBandwidthHz;
    const aliasingDetected = fsHz < tenTimesBandwidthHz;
    const aliasingVerdict = aliasingDetected
      ? `欠采样混叠违规：采样率 fs=${fsHz.toFixed(2)}Hz < 10×系统特征带宽 (10×${systemBandwidthHz.toFixed(2)}Hz = ${tenTimesBandwidthHz.toFixed(2)}Hz)，义务不可关闭`
      : `采样率满足抗混叠准则 (fs=${fsHz.toFixed(2)}Hz >= 10×带宽 ${tenTimesBandwidthHz.toFixed(2)}Hz)`;

    // 4. Holdout Validation Forward Simulation
    const simulatedTrajectory: number[] = [];
    let valRss = 0.0;
    const firstValIdx = dataset.valIndices[0] ?? 0;
    let simX = dataset.points[firstValIdx]?.x ?? 0.0;
    let simV = firstValIdx > 0
      ? ((dataset.points[firstValIdx]?.x ?? 0) - (dataset.points[firstValIdx - 1]?.x ?? 0)) / dt
      : 0.0;

    const valErrors: number[] = [];
    for (const vIdx of dataset.valIndices) {
      const p = dataset.points[vIdx]!;
      simulatedTrajectory.push(simX);
      const err = p.x - simX;
      valErrors.push(err);
      valRss += err * err;

      // RK4 step for forward prediction
      const uVal = p.u;
      const f = (xVal: number, vVal: number): [number, number] => {
        const aVal = (uVal - c * vVal - k * xVal) / m;
        return [vVal, aVal];
      };
      const [k1x, k1v] = f(simX, simV);
      const [k2x, k2v] = f(simX + 0.5 * dt * k1x, simV + 0.5 * dt * k1v);
      const [k3x, k3v] = f(simX + 0.5 * dt * k2x, simV + 0.5 * dt * k2v);
      const [k4x, k4v] = f(simX + dt * k3x, simV + dt * k3v);

      simX += (dt / 6.0) * (k1x + 2 * k2x + 2 * k3x + k4x);
      simV += (dt / 6.0) * (k1v + 2 * k2v + 2 * k3v + k4v);
    }

    const holdoutRmse = dataset.valIndices.length > 0 ? Math.sqrt(valRss / dataset.valIndices.length) : 0.0;
    const rmsePassed = holdoutRmse <= maxHoldoutRmse;

    // 5. Residual Whiteness Diagnosis (Autocorrelation Test on model error differences)
    // Differences of white measurement noise have r1 <= 0.2 (typically negative);
    // Unmodeled structural dynamics produce smooth correlated errors with r1 >> 0.2.
    const de: number[] = [];
    for (let i = 1; i < valErrors.length; i++) {
      de.push(valErrors[i]! - valErrors[i - 1]!);
    }
    let autoCorrNum = 0.0;
    let autoCorrDen = 0.0;
    for (let i = 0; i < de.length; i++) {
      autoCorrDen += de[i]! * de[i]!;
      if (i < de.length - 1) {
        autoCorrNum += de[i]! * de[i + 1]!;
      }
    }
    const lag1Autocorrelation = autoCorrDen > 1e-12 ? autoCorrNum / autoCorrDen : 0.0;
    const isWhite = lag1Autocorrelation < 0.2 && rmsePassed;
    const whitenessDiagnosis = isWhite ? "RESIDUAL_WHITE" : "STRUCTURE_UNDERDETERMINED";
    const whitenessVerdict = isWhite
      ? `残差呈现白噪声特征 (差分自相关 r1=${lag1Autocorrelation.toFixed(3)} < 0.200, RMSE=${holdoutRmse.toFixed(4)})，模型结构与拟合充分`
      : `结构欠定：残差自相关显著 (差分自相关 r1=${lag1Autocorrelation.toFixed(3)} >= 0.200, RMSE=${holdoutRmse.toFixed(4)})，表明存在未建模动态或结构失配，禁止输出"参数可信"`;

    const allObligationsMet =
      !leakageDetected &&
      !aliasingDetected &&
      isWhite &&
      rmsePassed &&
      m > 0 &&
      c > 0 &&
      k > 0;

    return {
      domainId: "control.identification",
      targetSystem: "forced_damped_oscillator",
      parameters: { mass: Number(m.toFixed(4)), damping: Number(c.toFixed(4)), stiffness: Number(k.toFixed(4)) },
      confidenceIntervals: {
        mass: [Number(confidenceIntervals.mass[0].toFixed(4)), Number(confidenceIntervals.mass[1].toFixed(4))],
        damping: [Number(confidenceIntervals.damping[0].toFixed(4)), Number(confidenceIntervals.damping[1].toFixed(4))],
        stiffness: [Number(confidenceIntervals.stiffness[0].toFixed(4)), Number(confidenceIntervals.stiffness[1].toFixed(4))],
      },
      samplingGuard: {
        fsHz: Number(fsHz.toFixed(2)),
        systemBandwidthHz: Number(systemBandwidthHz.toFixed(2)),
        tenTimesBandwidthHz: Number(tenTimesBandwidthHz.toFixed(2)),
        aliasingDetected,
        verdict: aliasingVerdict,
      },
      leakageGuard: {
        trainSamplesCount: activeIndices.length,
        valSamplesCount: dataset.valIndices.length,
        leakageDetected,
        verdict: leakageVerdict,
      },
      residualDiagnosis: {
        lag1Autocorrelation: Number(lag1Autocorrelation.toFixed(4)),
        isWhite,
        diagnosis: whitenessDiagnosis,
        verdict: whitenessVerdict,
      },
      holdoutValidation: {
        holdoutRmse: Number(holdoutRmse.toFixed(4)),
        threshold: maxHoldoutRmse,
        passed: rmsePassed,
        simulatedTrajectory,
      },
      allObligationsMet,
    };
  }
}
