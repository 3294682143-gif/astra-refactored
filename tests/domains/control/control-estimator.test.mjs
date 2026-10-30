import assert from "node:assert/strict";
import test from "node:test";

import {
  generateOscillatorDataset,
  ParameterEstimator,
} from "../../../packages/domain-control/dist/src/parameter-estimator.js";

test("真实参数辨识：最小二乘数值拟合精确恢复振子质量、阻尼与刚度并计算置信区间（非硬编码）", () => {
  // Ground truth: m=1.5, c=0.4, k=2.8
  const dataset = generateOscillatorDataset({
    m: 1.5,
    c: 0.4,
    k: 2.8,
    duration: 30.0,
    dt: 0.01, // fs = 100 Hz
    noiseStd: 0.0005,
    holdoutRatio: 0.2,
  });

  const res = ParameterEstimator.estimate(dataset, { maxHoldoutRmse: 0.05 });

  // 1. Recovered parameters within narrow margin of ground truth
  assert.ok(Math.abs(res.parameters.mass - 1.5) < 0.08, `mass error too large: ${res.parameters.mass}`);
  assert.ok(Math.abs(res.parameters.damping - 0.4) < 0.05, `damping error too large: ${res.parameters.damping}`);
  assert.ok(Math.abs(res.parameters.stiffness - 2.8) < 0.1, `stiffness error too large: ${res.parameters.stiffness}`);

  // 2. Confidence intervals enclose the estimated parameters and are narrow
  assert.ok(res.confidenceIntervals.mass[0] <= res.parameters.mass && res.parameters.mass <= res.confidenceIntervals.mass[1]);
  assert.ok(res.confidenceIntervals.damping[0] <= res.parameters.damping && res.parameters.damping <= res.confidenceIntervals.damping[1]);
  assert.ok(res.confidenceIntervals.stiffness[0] <= res.parameters.stiffness && res.parameters.stiffness <= res.confidenceIntervals.stiffness[1]);

  // 3. No leakage, no aliasing, white residuals, valid holdout RMSE
  assert.equal(res.leakageGuard.leakageDetected, false);
  assert.equal(res.samplingGuard.aliasingDetected, false);
  assert.equal(res.residualDiagnosis.isWhite, true);
  assert.equal(res.residualDiagnosis.diagnosis, "RESIDUAL_WHITE");
  assert.ok(res.holdoutValidation.holdoutRmse < 0.05);
  assert.equal(res.allObligationsMet, true);
});

test("T36 门禁：训练集/验证集物理隔离，检测到验证集样本污染时必须拒绝验收", () => {
  const dataset = generateOscillatorDataset({
    m: 1.5,
    c: 0.4,
    k: 2.8,
    duration: 20.0,
    dt: 0.01,
  });

  // Deliberately contaminate the training set with holdout validation indices
  const contaminatedIndices = [
    ...dataset.trainIndices.slice(0, 500),
    ...dataset.valIndices.slice(0, 50), // T36 violation: 50 holdout validation points leaked into training
  ];

  const res = ParameterEstimator.estimate(dataset, {
    forceContaminatedIndices: contaminatedIndices,
  });

  // T36 Assertion: leakage detected and acceptance rejected
  assert.equal(res.leakageGuard.leakageDetected, true);
  assert.match(res.leakageGuard.verdict, /T36违规/);
  assert.match(res.leakageGuard.verdict, /严禁数据穿越，拒绝验收/);
  assert.equal(res.allObligationsMet, false); // Obligation MUST NOT be closed
});

test("采样率混叠守卫：欠采样 (fs < 10×系统特征带宽) 触发混叠拦截，义务不可关闭", () => {
  // m=1.0, k=100.0 => omega_n = 10 rad/s => f_n = 1.59 Hz => 10 * f_n = 15.9 Hz
  // If dt = 0.2s => fs = 5 Hz < 15.9 Hz, severe undersampling & aliasing!
  const dataset = generateOscillatorDataset({
    m: 1.0,
    c: 0.2,
    k: 100.0,
    duration: 30.0,
    dt: 0.2, // fs = 5 Hz < 15.9 Hz!
  });

  const res = ParameterEstimator.estimate(dataset);

  // Aliasing guard assertion
  assert.equal(res.samplingGuard.aliasingDetected, true);
  assert.match(res.samplingGuard.verdict, /欠采样混叠违规/);
  assert.match(res.samplingGuard.verdict, /义务不可关闭/);
  assert.equal(res.allObligationsMet, false); // Obligation MUST NOT be closed
});

test("残差白性诊断：存在未建模非线性结构时，残差自相关显著，判定'结构欠定'，禁止输出'参数可信'", () => {
  // Generate dataset with substantial unmodeled non-linear cubic stiffness (Duffing effect: +15.0 * x^3)
  const dataset = generateOscillatorDataset({
    m: 1.5,
    c: 0.4,
    k: 2.8,
    duration: 30.0,
    dt: 0.01,
    unmodeledNonlinearStiffness: 25.0, // Significant unmodeled nonlinear dynamic!
  });

  const res = ParameterEstimator.estimate(dataset);

  // Residual whiteness diagnosis assertion
  assert.equal(res.residualDiagnosis.isWhite, false);
  assert.equal(res.residualDiagnosis.diagnosis, "STRUCTURE_UNDERDETERMINED");
  assert.match(res.residualDiagnosis.verdict, /结构欠定/);
  assert.match(res.residualDiagnosis.verdict, /禁止输出"参数可信"/);
  assert.equal(res.allObligationsMet, false);
});
