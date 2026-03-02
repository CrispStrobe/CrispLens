'use strict';

/**
 * face-align.js
 *
 * Implements the exact same 5-point similarity transform that InsightFace
 * (Python) uses to produce the 112×112 aligned face crop fed into ArcFace.
 *
 * Python equivalent:
 *   from skimage.transform import SimilarityTransform
 *   tform = SimilarityTransform()
 *   tform.estimate(src_pts, ARC_DST)
 *   warped = warp(img, tform.inverse, output_shape=(112, 112))
 *
 * We use the closed-form least-squares similarity transform (Umeyama-style)
 * and bilinear interpolation — no dependencies beyond math.
 */

// ArcFace 112×112 canonical landmark positions.
// Order: left-eye, right-eye, nose-tip, left-mouth-corner, right-mouth-corner.
const ARC_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Compute the optimal similarity transform (scale + rotation + translation)
 * that maps `src` points → `dst` points in a least-squares sense.
 *
 * Returns { a, b, tx, ty } where the 2×3 forward matrix M is:
 *   [ a  -b  tx ]
 *   [ b   a  ty ]
 *
 * Such that dst ≈ M · [src_x, src_y, 1]ᵀ
 *
 * This is mathematically identical to skimage's SimilarityTransform.estimate().
 */
function similarityTransform(src, dst) {
  const n = src.length;

  // Compute centroids
  let scx = 0, scy = 0, dcx = 0, dcy = 0;
  for (let i = 0; i < n; i++) {
    scx += src[i][0]; scy += src[i][1];
    dcx += dst[i][0]; dcy += dst[i][1];
  }
  scx /= n; scy /= n; dcx /= n; dcy /= n;

  // Demean and compute numerators/denominator for the optimal (a, b)
  // a = scale * cos(theta),  b = scale * sin(theta)
  //
  // Solution from least-squares over all point pairs:
  //   a = Σ(xd_i * xs_i + yd_i * ys_i) / Σ(xs_i² + ys_i²)
  //   b = Σ(xd_i * xs_i - yd_i * ys_i turned around) → see below
  //
  // Using complex number analogy (a+bi) * (xs+ys*i) ≈ (xd+yd*i):
  //   numerator = Σ conj(src_d_i) * dst_d_i
  //             = Σ (xs*xd + ys*yd) + i*(xs*yd - ys*xd)
  let num_a = 0, num_b = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - scx;
    const ys = src[i][1] - scy;
    const xd = dst[i][0] - dcx;
    const yd = dst[i][1] - dcy;
    num_a += xs * xd + ys * yd;
    num_b += xs * yd - ys * xd;
    denom += xs * xs + ys * ys;
  }

  const a  = num_a / denom;
  const b  = num_b / denom;
  const tx = dcx - a * scx + b * scy;
  const ty = dcy - b * scx - a * scy;

  return { a, b, tx, ty };
}

/**
 * Warp `srcBuffer` (raw RGB bytes, H×W×3, row-major) to a 112×112 face crop
 * aligned to the ArcFace template using the inverse of the given similarity
 * transform, with bilinear interpolation.
 *
 * Returns a Buffer of length 112×112×3 (RGB, row-major).
 */
function warpToArcFace(srcBuffer, srcWidth, srcHeight, landmarks) {
  // 1. Compute forward transform: landmarks → ARC_DST
  const { a, b, tx, ty } = similarityTransform(landmarks, ARC_DST);

  // 2. Compute inverse transform: ARC_DST pixel → source pixel
  //    Forward: xd = a*xs - b*ys + tx,  yd = b*xs + a*ys + ty
  //    Inverse: xs = (a*(xd-tx) + b*(yd-ty)) / r²
  //             ys = (-b*(xd-tx) + a*(yd-ty)) / r²
  const r2 = a * a + b * b;
  const ai =  a / r2;
  const bi =  b / r2;
  // Pre-compute constant offset parts:  -a*tx - b*ty  and  b*tx - a*ty
  const ox = -(a * tx + b * ty) / r2;
  const oy =  (b * tx - a * ty) / r2;

  const OUT = 112;
  const out = Buffer.allocUnsafe(OUT * OUT * 3);
  const W   = srcWidth;
  const H   = srcHeight;

  for (let yd = 0; yd < OUT; yd++) {
    for (let xd = 0; xd < OUT; xd++) {
      // Inverse-map output pixel to source image
      const xs = ai * xd + bi * yd + ox;
      const ys = -bi * xd + ai * yd + oy;

      // Bilinear interpolation
      const x0 = Math.floor(xs);
      const y0 = Math.floor(ys);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      const fx = xs - x0;
      const fy = ys - y0;

      // Clamp to image bounds
      const cx0 = Math.max(0, Math.min(W - 1, x0));
      const cx1 = Math.max(0, Math.min(W - 1, x1));
      const cy0 = Math.max(0, Math.min(H - 1, y0));
      const cy1 = Math.max(0, Math.min(H - 1, y1));

      // Bilinear weights
      const w00 = (1 - fx) * (1 - fy);
      const w10 =      fx  * (1 - fy);
      const w01 = (1 - fx) *      fy;
      const w11 =      fx  *      fy;

      // Source pixel indices (row-major RGB)
      const p00 = (cy0 * W + cx0) * 3;
      const p10 = (cy0 * W + cx1) * 3;
      const p01 = (cy1 * W + cx0) * 3;
      const p11 = (cy1 * W + cx1) * 3;

      // Interpolate each channel
      const dstIdx = (yd * OUT + xd) * 3;
      for (let c = 0; c < 3; c++) {
        out[dstIdx + c] = Math.round(
          w00 * srcBuffer[p00 + c] +
          w10 * srcBuffer[p10 + c] +
          w01 * srcBuffer[p01 + c] +
          w11 * srcBuffer[p11 + c]
        );
      }
    }
  }

  return out;
}

module.exports = { similarityTransform, warpToArcFace, ARC_DST };
