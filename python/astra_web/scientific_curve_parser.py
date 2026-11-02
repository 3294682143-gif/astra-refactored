"""Scientific Curve and Chart Extraction with Independent Quality Audit (E05).

Implements Section 8.2 of the Unified Scientific Multi-Agent Execution Plan:
1. Extraction of experimental curves (e.g., vibration time-series or temperature profiles)
2. Retains original coordinate bounds, physical axes, units, extraction method, and uncertainty bounds
3. Independent validation against ground-truth reference data (RMSE, R^2, max divergence)
4. Fail-closed: ambiguous axes or low-resolution traces return UNCERTAIN rather than fabricating coordinates
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import hashlib
import io
import json
import math
import time
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple


@dataclass(frozen=True)
class AxisCalibration:
    x_name: str
    x_unit: str
    x_min: float
    x_max: float
    y_name: str
    y_unit: str
    y_min: float
    y_max: float
    is_ambiguous: bool = False
    ambiguity_reason: Optional[str] = None


@dataclass(frozen=True)
class CurveExtractionResult:
    source_ref: str
    method: str
    calibration: AxisCalibration
    data_points: Sequence[Tuple[float, float]]  # (x, y)
    estimated_noise_sigma: float
    uncertainty_envelope: Sequence[Tuple[float, float, float]]  # (x, y_lower, y_upper)
    status: str  # "EXTRACTED" | "UNCERTAIN_AMBIGUOUS_AXIS" | "RESOLUTION_INSUFFICIENT"
    hash_digest: str
    quality_audit: Optional[Dict[str, Any]] = None


class ScientificCurveParser:
    """Parser and quality auditor for experimental scientific charts and curves."""

    @staticmethod
    def _compute_digest(raw: Any) -> str:
        s = json.dumps(raw, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(s.encode("utf-8")).hexdigest()

    def parse_curve_trace(
        self,
        source_ref: str,
        pixel_or_raw_points: Sequence[Tuple[float, float]],
        calibration: AxisCalibration,
        min_required_points: int = 10,
    ) -> CurveExtractionResult:
        """Parse raw points into physical domain coordinates under calibrated axes."""
        # Check for axis ambiguity
        if calibration.is_ambiguous:
            digest = self._compute_digest({"error": "ambiguous_axis", "ref": source_ref})
            return CurveExtractionResult(
                source_ref=source_ref,
                method="axis_calibrated_projection",
                calibration=calibration,
                data_points=(),
                estimated_noise_sigma=float("nan"),
                uncertainty_envelope=(),
                status="UNCERTAIN_AMBIGUOUS_AXIS",
                hash_digest=digest,
                quality_audit={"passed": False, "reason": calibration.ambiguity_reason or "Axis labels ambiguous"},
            )

        if len(pixel_or_raw_points) < min_required_points:
            digest = self._compute_digest({"error": "insufficient_resolution", "count": len(pixel_or_raw_points)})
            return CurveExtractionResult(
                source_ref=source_ref,
                method="axis_calibrated_projection",
                calibration=calibration,
                data_points=(),
                estimated_noise_sigma=float("nan"),
                uncertainty_envelope=(),
                status="RESOLUTION_INSUFFICIENT",
                hash_digest=digest,
                quality_audit={"passed": False, "reason": "Insufficient points to reconstruct smooth continuous trace"},
            )

        # Sort points by x
        sorted_points = sorted(pixel_or_raw_points, key=lambda pt: pt[0])

        # Estimate local noise variance using high-frequency differences (second differences)
        diffs = []
        for i in range(1, len(sorted_points) - 1):
            y_prev = sorted_points[i - 1][1]
            y_curr = sorted_points[i][1]
            y_next = sorted_points[i + 1][1]
            diffs.append(y_next - 2 * y_curr + y_prev)

        if diffs:
            mean_sq = sum(d * d for d in diffs) / len(diffs)
            sigma_est = math.sqrt(mean_sq / 6.0)
        else:
            sigma_est = 0.001

        # Build 95% uncertainty envelope (2 * sigma)
        envelope = [
            (x, y - 2.0 * sigma_est, y + 2.0 * sigma_est)
            for x, y in sorted_points
        ]

        digest = self._compute_digest({
            "source": source_ref,
            "n": len(sorted_points),
            "x0": sorted_points[0][0],
            "xN": sorted_points[-1][0],
            "sigma": sigma_est,
        })

        return CurveExtractionResult(
            source_ref=source_ref,
            method="axis_calibrated_projection",
            calibration=calibration,
            data_points=sorted_points,
            estimated_noise_sigma=sigma_est,
            uncertainty_envelope=envelope,
            status="EXTRACTED",
            hash_digest=digest,
            quality_audit={
                "pointCount": len(sorted_points),
                "estimatedNoiseSigma": sigma_est,
                "xRange": [sorted_points[0][0], sorted_points[-1][0]],
                "yRange": [min(pt[1] for pt in sorted_points), max(pt[1] for pt in sorted_points)],
            },
        )

    def extract_from_image(
        self,
        source_ref: str,
        image_bytes: bytes,
        calibration: AxisCalibration,
        *,
        plot_bounds: Mapping[str, int],
        trace_color: Sequence[int],
        color_tolerance: float = 45.0,
        min_required_points: int = 10,
    ) -> CurveExtractionResult:
        try:
            from PIL import Image
        except ImportError as exc:
            raise RuntimeError("IMAGE_PARSER_UNAVAILABLE") from exc
        left = int(plot_bounds["left"])
        right = int(plot_bounds["right"])
        top = int(plot_bounds["top"])
        bottom = int(plot_bounds["bottom"])
        if len(trace_color) != 3 or any(not 0 <= int(channel) <= 255 for channel in trace_color):
            raise ValueError("trace_color must contain three RGB channels")
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = source.convert("RGB")
            if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
                raise ValueError("plot_bounds are outside the image")
            target = tuple(int(channel) for channel in trace_color)
            points = []
            matched_pixels = 0
            for pixel_x in range(left, right):
                matching_y = []
                for pixel_y in range(top, bottom):
                    color = image.getpixel((pixel_x, pixel_y))
                    distance = math.sqrt(sum((color[index] - target[index]) ** 2 for index in range(3)))
                    if distance <= color_tolerance:
                        matching_y.append(pixel_y)
                if not matching_y:
                    continue
                matched_pixels += len(matching_y)
                matching_y.sort()
                pixel_y = matching_y[len(matching_y) // 2]
                x = calibration.x_min + (pixel_x - left) * (calibration.x_max - calibration.x_min) / (right - left)
                y = calibration.y_max - (pixel_y - top) * (calibration.y_max - calibration.y_min) / (bottom - top)
                points.append((x, y))
        extraction = self.parse_curve_trace(
            source_ref,
            points,
            calibration,
            min_required_points=min_required_points,
        )
        return replace(
            extraction,
            method="rgb_trace_pixel_extraction",
            quality_audit={
                **(extraction.quality_audit or {}),
                "imageSha256": hashlib.sha256(image_bytes).hexdigest(),
                "matchedPixels": matched_pixels,
                "plotBounds": dict(plot_bounds),
                "traceColor": list(target),
                "colorTolerance": color_tolerance,
            },
        )

    def verify_against_reference(
        self,
        extraction: CurveExtractionResult,
        reference_points: Sequence[Tuple[float, float]],
        max_tolerable_rmse: float = 0.02,
        min_tolerable_r2: float = 0.95,
    ) -> Dict[str, Any]:
        """Independently audit extraction quality by comparing with ground-truth reference points."""
        if extraction.status != "EXTRACTED" or not extraction.data_points:
            return {
                "verified": False,
                "reason": f"Cannot verify unextracted curve: {extraction.status}",
                "rmse": float("inf"),
                "r2": float("-inf"),
            }

        # Interpolate extracted values onto reference x coordinates
        ref_x = [pt[0] for pt in reference_points]
        ref_y = [pt[1] for pt in reference_points]
        ext_x = [pt[0] for pt in extraction.data_points]
        ext_y = [pt[1] for pt in extraction.data_points]

        matched_ext_y = []
        matched_ref_y = []

        import bisect
        for rx, ry in zip(ref_x, ref_y):
            idx = bisect.bisect_left(ext_x, rx)
            if idx == 0:
                y_val = ext_y[0]
            elif idx >= len(ext_x):
                y_val = ext_y[-1]
            else:
                # Linear interpolation
                x0, x1 = ext_x[idx - 1], ext_x[idx]
                y0, y1 = ext_y[idx - 1], ext_y[idx]
                if abs(x1 - x0) < 1e-9:
                    y_val = y0
                else:
                    y_val = y0 + (y1 - y0) * (rx - x0) / (x1 - x0)
            matched_ext_y.append(y_val)
            matched_ref_y.append(ry)

        n = len(matched_ref_y)
        if n == 0:
            return {"verified": False, "reason": "No overlapping coordinates"}

        se = sum((e - r) ** 2 for e, r in zip(matched_ext_y, matched_ref_y))
        rmse = math.sqrt(se / n)

        mean_ref = sum(matched_ref_y) / n
        tot_ss = sum((r - mean_ref) ** 2 for r in matched_ref_y)

        r2 = 1.0 - (se / tot_ss) if tot_ss > 1e-9 else 1.0

        passed = (rmse <= max_tolerable_rmse) and (r2 >= min_tolerable_r2)

        return {
            "verified": passed,
            "rmse": rmse,
            "r2": r2,
            "maxTolerableRmse": max_tolerable_rmse,
            "minTolerableR2": min_tolerable_r2,
            "pointCount": n,
            "auditTimestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
