/*
 * 仿射拟合（浏览器 / Node 通用模块）
 *
 * 给定 n ≥ 3 对控制点 (x_i, y_i) → (u_i, v_i)，求解六参数仿射变换：
 *     u = a·x + b·y + c
 *     v = d·x + e·y + f
 *
 * 提供两种模式：
 *  1) fitAffine 经典最小二乘：使全部控制点残差平方和最小。
 *  2) fitAffineRobust 稳健模式：按固定顺序枚举有上限的非共线三点候选
 *     （三点恰好确定一个仿射模型），以「内点数量优先、内点平方误差次之」
 *     选出最佳候选，再对全部内点重新做最小二乘拟合，并迭代重分类至稳定。
 *     内点判定基于参考图像素容差 tolerancePx；外点不参与最终 RMSE。
 *     枚举上限保证点对增多时计算量有界，拖动不卡顿。
 *
 * 数值实现：最小二乘先对源点与目标点分别中心化，正规方程退化为两个
 * 2×2 线性方程组（平移量由质心回代），避免大坐标下的数值病态。
 *
 * 近共线判定：点集协方差矩阵的最小/最大特征值之比小于
 * COLLINEAR_RATIO 时视为近共线（含全部重合），拒绝拟合。
 *
 * 留出验证：两种拟合的结果均附带 validation 字段（leaveOneOutValidation），
 * 对每个参与拟合的点，移除后用其余参与点重新最小二乘拟合，再预测该留出点
 * 的目标位置并计算误差；参与点不足 4 个或留出后点集近共线时该点标记
 * 「无法验证」，汇总仅统计可验证点。稳健模式的参与集为最终内点，外点不参与。
 *
 * RGBA 像素变换（transformRGBA，可独立调用）：将源 RGBA 像素数组按拟合矩阵
 * （源 → 输出坐标系）变换到指定尺寸的输出画布。对每个输出像素，其像素中心
 * (i+0.5, j+0.5) 经逆仿射映射回源图连续坐标取样，以四邻像素做双线性插值；
 * 越界邻点视为透明黑；颜色先乘 alpha 再插值、输出时还原，alpha 为零时
 * RGB 归零；各通道四舍五入到 0~255。矩阵含非有限值或线性部分行列式绝对值
 * ≤ MIN_MATRIX_DET（1e-12）时拒绝（checkExportMatrix / invertMatrix）。
 *
 * 差异区域检测（buildDifferenceMask / groupDiffRegions / findDifferenceRegions，
 * 可独立调用，纯像素计算、不依赖 DOM）：比较参考图与按拟合矩阵重采样后的
 * 校准扫描图，仅统计双方 alpha 均 ≥ DIFF_ALPHA_MIN（128）的像素，任一 RGB
 * 通道差值的绝对值超过色差阈值（0~255，严格大于）即标为差异像素；再对差异
 * 掩码做八邻域连通分组，过滤像素数小于最小面积的区域，剩余区域按面积降序
 * 输出边框、像素数与坐标范围，并给出每像素区域编号标签 labels（供点击命中
 * 与重算时的区域交并比匹配 matchDiffRegions 使用）。
 *
 * 人工复核继承（matchDiffRegions，可独立调用，纯像素计算）：参数（色差阈值、
 * 最小面积）或控制点引发重算后，新老区域一律以区域内实际差异像素计算交并比
 * （IoU = 交集像素 / 并集像素）；仅当 IoU ≥ REVIEW_MATCH_MIN_IOU（0.5）且
 * 双方互为唯一重叠区域（该老区域只与这一个新区域相交、反之亦然）时才配为
 * 同一区域。绝不按排序编号沿用。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Affine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_POINTS = 3;
  // 近共线阈值：λmin/λmax < 1e-4，即点集垂直方向展宽不足主方向的 1%
  const COLLINEAR_RATIO = 1e-4;
  // 稳健模式：枚举三点候选（及扫描三元组）的上限，保证计算量有界
  const MAX_CANDIDATES = 256;
  // 稳健模式：内点重拟合后重新分类的最大迭代次数（实测通常 1~2 次即稳定）
  const MAX_REFINE_ITERS = 16;
  // 稳健模式默认参考图像素容差
  const DEFAULT_TOLERANCE_PX = 2;
  // 像素变换/导出可用性的矩阵阈值：线性部分行列式 |a·e − b·d| 下限
  const MIN_MATRIX_DET = 1e-12;
  // 差异区域：双方 alpha 均不低于该值的像素才参与逐像素比较
  const DIFF_ALPHA_MIN = 128;
  // 差异区域默认色差值（任一 RGB 通道差值绝对值严格大于该值即标为差异）
  const DEFAULT_DIFF_THRESHOLD = 32;
  // 差异区域默认最小面积（像素数小于该值的连通区域被过滤）
  const DEFAULT_DIFF_MIN_AREA = 20;
  // 人工复核继承：新老区域实际差异像素交并比（IoU）不低于该值才允许继承
  const REVIEW_MATCH_MIN_IOU = 0.5;

  class FitError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'FitError';
      this.code = code;
    }
  }

  function centroid(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
  }

  /**
   * 评估点集共线程度。
   * @returns {{degenerate: boolean, ratio: number}} ratio 为 λmin/λmax
   */
  function collinearity(points) {
    const c = centroid(points);
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
      const dx = p.x - c.x, dy = p.y - c.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const trace = sxx + syy;
    if (trace <= 0) return { degenerate: true, ratio: 0 }; // 所有点重合
    let det = sxx * syy - sxy * sxy;
    if (det < 0) det = 0; // 浮点误差兜底
    const disc = Math.sqrt(Math.max(trace * trace - 4 * det, 0));
    const lMax = (trace + disc) / 2;
    const lMin = (trace - disc) / 2;
    const ratio = lMax > 0 ? lMin / lMax : 0;
    return { degenerate: ratio < COLLINEAR_RATIO, ratio };
  }

  function validate(src, dst) {
    if (!Array.isArray(src) || !Array.isArray(dst) || src.length !== dst.length) {
      throw new FitError('BAD_INPUT', '源点与目标点必须为等长数组');
    }
    if (src.length < MIN_POINTS) {
      throw new FitError('TOO_FEW_POINTS', `至少需要 ${MIN_POINTS} 对控制点`);
    }
    for (const p of src.concat(dst)) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new FitError('BAD_INPUT', '控制点坐标必须为有限数字');
      }
    }
  }

  /**
   * 最小二乘求解（不做校验）：调用方需保证至少 3 对点且两侧均非共线。
   */
  function solveAffine(src, dst) {
    const n = src.length;
    const cs = centroid(src), cd = centroid(dst);
    let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    for (let i = 0; i < n; i++) {
      const dx = src[i].x - cs.x, dy = src[i].y - cs.y;
      const du = dst[i].x - cd.x, dv = dst[i].y - cd.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      sxu += dx * du; syu += dy * du;
      sxv += dx * dv; syv += dy * dv;
    }
    const D = sxx * syy - sxy * sxy; // 非共线检查已保证 D > 0

    const a = (sxu * syy - syu * sxy) / D;
    const b = (syu * sxx - sxu * sxy) / D;
    const d = (sxv * syy - syv * sxy) / D;
    const e = (syv * sxx - sxv * sxy) / D;
    const c = cd.x - a * cs.x - b * cs.y;
    const f = cd.y - d * cs.x - e * cs.y;
    return { a, b, c, d, e, f };
  }

  function residualsOf(matrix, src, dst) {
    return src.map((p, i) => {
      const u = matrix.a * p.x + matrix.b * p.y + matrix.c;
      const v = matrix.d * p.x + matrix.e * p.y + matrix.f;
      return Math.hypot(u - dst[i].x, v - dst[i].y);
    });
  }

  /**
   * 仿射最小二乘拟合（经典模式，使用全部控制点）。
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @returns {{matrix:{a,b,c,d,e,f}, residuals:number[], rmse:number, maxIndex:number, pointCount:number, inliers:boolean[], validation:object}}
   *          validation 为逐点留出验证结果（见 leaveOneOutValidation）
   * @throws {FitError} code ∈ TOO_FEW_POINTS | COLLINEAR_SRC | COLLINEAR_DST | BAD_INPUT
   */
  function fitAffine(src, dst) {
    validate(src, dst);
    const n = src.length;

    if (collinearity(src).degenerate) {
      throw new FitError('COLLINEAR_SRC', '扫描图控制点过于接近共线（或重合），无法求解仿射变换，请调整点位分布');
    }
    if (collinearity(dst).degenerate) {
      throw new FitError('COLLINEAR_DST', '参考图控制点过于接近共线（或重合），无法求解仿射变换，请调整点位分布');
    }

    const matrix = solveAffine(src, dst);
    const residuals = residualsOf(matrix, src, dst);
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
    let maxIndex = 0;
    residuals.forEach((r, i) => { if (r > residuals[maxIndex]) maxIndex = i; });

    return {
      matrix,
      residuals,
      rmse,
      maxIndex,
      pointCount: n,
      inliers: new Array(n).fill(true),
      validation: leaveOneOutValidation(src, dst, null)
    };
  }

  /**
   * 稳健仿射拟合（RANSAC-lite）。
   *
   * 按 (i,j,k) 字典序枚举至多 maxCandidates 个三元组，仅评估两侧均非共线
   * 的候选；以三点精确解作为候选模型，统计参考图像素容差内的内点：
   *   内点数更多者胜；内点数相同则内点平方误差和更小者胜（首个最优点保留）。
   * 选定模型后，对内点重新做最小二乘拟合，并按新模型重新分类，迭代至
   * 内点集合稳定。最终残差对所有点给出，RMSE 仅统计内点。
   *
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @param {{tolerancePx?:number, maxCandidates?:number, maxIterations?:number}} [options]
   * @returns {{matrix, residuals:number[], rmse:number, maxIndex:number, pointCount:number,
   *            inliers:boolean[], inlierCount:number, outlierCount:number,
   *            tolerancePx:number, candidatesEvaluated:number, inlierSse:number,
   *            refined:boolean, validation:object}}
   *          validation 为逐点留出验证结果（仅内点参与，外点 excluded）
   * @throws {FitError} code ∈ TOO_FEW_POINTS | BAD_INPUT |
   *                    NO_NONCOLLINEAR_TRIPLET | NO_NONCOLLINEAR_INLIERS
   */
  function fitAffineRobust(src, dst, options) {
    validate(src, dst);
    const n = src.length;
    const opts = options || {};
    const maxCandidates = Math.max(1, Math.floor(opts.maxCandidates || MAX_CANDIDATES));
    const maxIterations = Math.max(1, Math.floor(opts.maxIterations || MAX_REFINE_ITERS));
    const tolerancePx = opts.tolerancePx === undefined ? DEFAULT_TOLERANCE_PX : opts.tolerancePx;
    if (!Number.isFinite(tolerancePx) || tolerancePx < 0) {
      throw new FitError('BAD_INPUT', '参考图像素容差必须为不小于 0 的有限数字');
    }
    // 与坐标尺度相关的浮点容差（tol=0 时三点自身仍可判为内点）
    let scaleMax = 1;
    for (const p of dst) {
      const m = Math.max(Math.abs(p.x), Math.abs(p.y));
      if (m > scaleMax) scaleMax = m;
    }
    const eps = 1e-9 * scaleMax;
    const isInlier = (r) => r <= tolerancePx + eps;

    // ---- 有上限地枚举非共线三点候选（固定字典序，保证结果可复现）----
    let best = null; // { matrix, inliers:boolean[], count, sse }
    let evaluated = 0;
    let scanned = 0;
    let triSrcDegenerate = false;
    let triDstDegenerate = false;
    let hitScanLimit = false;

    outer:
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        for (let k = j + 1; k < n; k++) {
          if (scanned >= maxCandidates) { hitScanLimit = true; break outer; }
          scanned++;
          const s3 = [src[i], src[j], src[k]];
          const d3 = [dst[i], dst[j], dst[k]];
          if (collinearity(s3).degenerate) { triSrcDegenerate = true; continue; }
          if (collinearity(d3).degenerate) { triDstDegenerate = true; continue; }

          const matrix = solveAffine(s3, d3);
          const residuals = residualsOf(matrix, src, dst);
          const inliers = new Array(n).fill(false);
          let count = 0, sse = 0;
          for (let t = 0; t < n; t++) {
            if (isInlier(residuals[t])) { inliers[t] = true; count++; sse += residuals[t] * residuals[t]; }
          }
          evaluated++;
          // 内点数量优先、内点平方误差次之；枚举按固定顺序，平局保留首个
          if (!best || count > best.count || (count === best.count && sse < best.sse)) {
            best = { matrix, inliers, count, sse };
          }
        }
      }
    }

    if (!best) {
      let message;
      if (!hitScanLimit) {
        message = triSrcDegenerate && !triDstDegenerate
          ? '扫描图中找不到三对非共线控制点，无法求解仿射变换，请调整点位分布'
          : triDstDegenerate && !triSrcDegenerate
            ? '参考图中找不到三对非共线控制点，无法求解仿射变换，请调整点位分布'
            : '找不到三对非共线控制点（点位重合或近共线），无法求解仿射变换，请调整点位分布';
      } else {
        message = '已评估的控制点三元组均近共线或重合，找不到可用的非共线三点，请调整点位分布';
      }
      throw new FitError('NO_NONCOLLINEAR_TRIPLET', message);
    }

    // ---- 对内点重新最小二乘拟合，并迭代重分类至稳定 ----
    let inliers = best.inliers;
    let matrix = best.matrix;
    let refined = false;
    for (let iter = 0; iter < maxIterations; iter++) {
      const idx = [];
      for (let t = 0; t < n; t++) if (inliers[t]) idx.push(t);
      const inSrc = idx.map((t) => src[t]);
      const inDst = idx.map((t) => dst[t]);
      if (idx.length >= MIN_POINTS &&
          !collinearity(inSrc).degenerate && !collinearity(inDst).degenerate) {
        matrix = solveAffine(inSrc, inDst);
        refined = true;
      }
      // 否则保留上一步的模型（best 至少含 3 个非共线内点）

      const residuals = residualsOf(matrix, src, dst);
      const next = new Array(n).fill(false);
      let changed = false;
      for (let t = 0; t < n; t++) {
        next[t] = isInlier(residuals[t]);
        if (next[t] !== inliers[t]) changed = true;
      }
      inliers = next;
      if (!changed) break;
    }

    const inlierIdx = [];
    for (let t = 0; t < n; t++) if (inliers[t]) inlierIdx.push(t);
    if (inlierIdx.length < MIN_POINTS) {
      // 正常不会发生（容差只增不减时内点只会更稳定），保留点对并禁用导出
      throw new FitError('NO_NONCOLLINEAR_INLIERS', '容差内的非共线内点不足 3 对，无法得到稳健模型，请放宽像素容差或调整点位');
    }
    if (collinearity(inlierIdx.map((t) => src[t])).degenerate ||
        collinearity(inlierIdx.map((t) => dst[t])).degenerate) {
      throw new FitError('NO_NONCOLLINEAR_INLIERS', '容差内的内点近共线（或重合），无法求解仿射变换，请放宽像素容差或调整点位分布');
    }

    // ---- 最终模型与统计（RMSE 仅统计内点；maxIndex 为内点中残差最大者）----
    const residuals = residualsOf(matrix, src, dst);
    let sse = 0, maxIndex = -1;
    for (const t of inlierIdx) {
      sse += residuals[t] * residuals[t];
      if (maxIndex === -1 || residuals[t] > residuals[maxIndex]) maxIndex = t;
    }
    const rmse = Math.sqrt(sse / inlierIdx.length);

    return {
      matrix,
      residuals,
      rmse,
      maxIndex,
      pointCount: n,
      inliers,
      inlierCount: inlierIdx.length,
      outlierCount: n - inlierIdx.length,
      tolerancePx,
      candidatesEvaluated: evaluated,
      inlierSse: sse,
      refined,
      validation: leaveOneOutValidation(src, dst, inliers)
    };
  }

  /**
   * 逐点留出验证（leave-one-out）。
   *
   * 对每个参与拟合的点 i：将其移除，用其余参与点重新做最小二乘仿射拟合，
   * 再预测留出点的目标位置并计算误差（目标坐标系的像素距离）。
   * 参与点不足 4 个（留出后不足 3 个）或某次留出后的点集近共线时，该点
   * 标记为「无法验证」（error 为 null，绝不用原拟合残差充数）；汇总仅统计
   * 可验证点的 RMSE / 最大误差，零个可验证点时汇总字段为 null（不可用）。
   *
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @param {boolean[]|null} [inliers] 参与拟合的点；缺省表示全部参与。
   *        稳健模式传入最终内点数组，外点状态为 'excluded'（不参与）。
   * @returns {{points:Array<{index:number,participates:boolean,status:string,error:number|null}>,
   *            participantCount:number, verifiableCount:number,
   *            rmse:number|null, maxError:number|null, maxIndex:number}}
   *          status ∈ 'ok' | 'unverifiable' | 'excluded'
   */
  function leaveOneOutValidation(src, dst, inliers) {
    const n = src.length;
    const participates = inliers ? inliers.map(Boolean) : new Array(n).fill(true);
    const participantCount = participates.reduce((s, v) => s + (v ? 1 : 0), 0);
    const enough = participantCount >= MIN_POINTS + 1; // 留出后仍需 ≥3 个参与点

    const points = [];
    let sse = 0, verifiableCount = 0, maxError = -1, maxIndex = -1;
    for (let i = 0; i < n; i++) {
      if (!participates[i]) {
        points.push({ index: i, participates: false, status: 'excluded', error: null });
        continue;
      }
      if (!enough) {
        points.push({ index: i, participates: true, status: 'unverifiable', error: null });
        continue;
      }
      const s2 = [], d2 = [];
      for (let j = 0; j < n; j++) {
        if (j !== i && participates[j]) { s2.push(src[j]); d2.push(dst[j]); }
      }
      // 留出后任一侧近共线（或重合）则无法可靠重拟合，该点无法验证
      if (collinearity(s2).degenerate || collinearity(d2).degenerate) {
        points.push({ index: i, participates: true, status: 'unverifiable', error: null });
        continue;
      }
      const m = solveAffine(s2, d2);
      const pred = applyMatrix(m, src[i]);
      const err = Math.hypot(pred.x - dst[i].x, pred.y - dst[i].y);
      points.push({ index: i, participates: true, status: 'ok', error: err });
      sse += err * err;
      verifiableCount++;
      if (err > maxError) { maxError = err; maxIndex = i; }
    }

    return {
      points,
      participantCount,
      verifiableCount,
      rmse: verifiableCount > 0 ? Math.sqrt(sse / verifiableCount) : null,
      maxError: verifiableCount > 0 ? maxError : null,
      maxIndex
    };
  }

  /** 对单个点应用六参数矩阵 */
  function applyMatrix(m, p) {
    return { x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f };
  }

  /**
   * 校验矩阵是否可用于像素变换/导出：六参数均为有限值，且线性部分
   * 行列式 |a·e − b·d| > MIN_MATRIX_DET（1e-12），否则不可逆。
   * @param {{a,b,c,d,e,f}} m
   * @returns {{ok:true, det:number} | {ok:false, reason:string}} reason 为中文原因
   */
  function checkExportMatrix(m) {
    if (!m) return { ok: false, reason: '拟合矩阵缺失' };
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
      if (!Number.isFinite(m[k])) {
        return { ok: false, reason: '拟合矩阵含非有限值，无法求逆做像素变换' };
      }
    }
    const det = m.a * m.e - m.b * m.d;
    if (!Number.isFinite(det) || Math.abs(det) <= MIN_MATRIX_DET) {
      return { ok: false, reason: '拟合矩阵线性部分行列式绝对值 ≤ 1e-12，不可逆，无法做像素变换' };
    }
    return { ok: true, det };
  }

  /**
   * 求六参数仿射矩阵的逆（先经 checkExportMatrix 校验）。
   * 正向 u = a·x + b·y + c，v = d·x + e·y + f 的逆映射为：
   *   x = ( e·(u−c) − b·(v−f)) / det
   *   y = (−d·(u−c) + a·(v−f)) / det
   * @throws {FitError} code = BAD_MATRIX（非有限值或行列式绝对值 ≤ 1e-12）
   */
  function invertMatrix(m) {
    const chk = checkExportMatrix(m);
    if (!chk.ok) throw new FitError('BAD_MATRIX', chk.reason);
    const det = chk.det;
    return {
      a: m.e / det,
      b: -m.b / det,
      c: (m.b * m.f - m.e * m.c) / det,
      d: -m.d / det,
      e: m.a / det,
      f: (m.d * m.c - m.a * m.f) / det
    };
  }

  /** 通道四舍五入并钳制到 0~255 */
  function clampRound(v) {
    const r = Math.round(v);
    return r < 0 ? 0 : r > 255 ? 255 : r;
  }

  /**
   * RGBA 像素变换（可独立调用，纯像素计算，不依赖 DOM/Canvas）。
   *
   * 将源 RGBA 像素数组按拟合矩阵 matrix（源 → 输出坐标系）重采样到
   * outW × outH 的输出画布：对每个输出像素 (i, j)，取其像素中心
   * (i+0.5, j+0.5)，经逆仿射映射回源图连续坐标，以四邻像素做双线性插值
   * （源像素中心同样位于 (x+0.5, y+0.5)）。规则：
   *   - 越界邻点视为透明黑 (0,0,0,0)，不参与贡献；
   *   - 颜色先乘 alpha（预乘）再插值，输出时除以插值后的 alpha 还原；
   *   - 插值后 alpha 为零时 RGB 归零；
   *   - 各通道四舍五入到 0~255。
   *
   * @param {Uint8Array|Uint8ClampedArray} srcData 源 RGBA 数据（长度 srcW·srcH·4）
   * @param {number} srcW 源图宽（正整数）
   * @param {number} srcH 源图高（正整数）
   * @param {{a,b,c,d,e,f}} matrix 正向仿射矩阵（源 → 输出坐标系）
   * @param {number} outW 输出宽（正整数）
   * @param {number} outH 输出高（正整数）
   * @returns {Uint8ClampedArray} 输出 RGBA 数据（长度 outW·outH·4）
   * @throws {FitError} code ∈ BAD_INPUT | BAD_MATRIX
   */
  function transformRGBA(srcData, srcW, srcH, matrix, outW, outH) {
    if (!srcData || !Number.isInteger(srcW) || !Number.isInteger(srcH) ||
        srcW <= 0 || srcH <= 0 || srcData.length !== srcW * srcH * 4) {
      throw new FitError('BAD_INPUT', '源像素数据缺失或长度与源图宽高不符');
    }
    if (!Number.isInteger(outW) || !Number.isInteger(outH) || outW <= 0 || outH <= 0) {
      throw new FitError('BAD_INPUT', '输出宽高必须为正整数');
    }
    const inv = invertMatrix(matrix); // 含非有限值 / 行列式校验

    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let j = 0; j < outH; j++) {
      // 输出像素中心 (i+0.5, j+0.5) 经逆仿射映射回源图连续坐标
      const baseX = inv.b * (j + 0.5) + inv.c;
      const baseY = inv.e * (j + 0.5) + inv.f;
      for (let i = 0; i < outW; i++) {
        const sx = inv.a * (i + 0.5) + baseX;
        const sy = inv.d * (i + 0.5) + baseY;
        // 源像素中心位于 (x+0.5, y+0.5)：换算到像素索引空间取四邻
        const fx = sx - 0.5, fy = sy - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        // 双线性插值（颜色预乘 alpha；越界邻点为透明黑，不贡献）
        let r = 0, g = 0, b = 0, alpha = 0;
        for (let dy = 0; dy <= 1; dy++) {
          const yy = y0 + dy;
          const wy = dy === 0 ? 1 - ty : ty;
          if (wy === 0) continue;
          for (let dx = 0; dx <= 1; dx++) {
            const xx = x0 + dx;
            const w = wy * (dx === 0 ? 1 - tx : tx);
            if (w === 0) continue;
            if (xx < 0 || xx >= srcW || yy < 0 || yy >= srcH) continue; // 透明黑
            const idx = (yy * srcW + xx) * 4;
            const sa = srcData[idx + 3] / 255;
            r += w * srcData[idx] * sa;
            g += w * srcData[idx + 1] * sa;
            b += w * srcData[idx + 2] * sa;
            alpha += w * srcData[idx + 3];
          }
        }
        const o = (j * outW + i) * 4;
        if (alpha <= 0) {
          // alpha 为零时 RGB 归零（透明黑）
          out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
        } else {
          // 输出时还原预乘：除以插值后的 alpha
          const sa = alpha / 255;
          out[o] = clampRound(r / sa);
          out[o + 1] = clampRound(g / sa);
          out[o + 2] = clampRound(b / sa);
          out[o + 3] = clampRound(alpha);
        }
      }
    }
    return out;
  }

  /**
   * 构建差异掩码（可独立调用，纯像素计算）。
   *
   * 逐像素比较参考图 refData 与校准扫描图 cmpData（二者必须同为 w × h 的
   * RGBA 缓冲，cmpData 通常由 transformRGBA 重采样得到）：
   *   - 仅当双方 alpha 均 ≥ DIFF_ALPHA_MIN（128）时该像素参与统计；
   *   - 参与像素任一 RGB 通道差值的绝对值严格大于 colorThreshold（0~255）
   *     时标为差异（掩码字节为 1，否则为 0）；
   *   - 其余像素掩码为 0。
   *
   * @param {Uint8Array|Uint8ClampedArray} refData 参考图 RGBA 数据
   * @param {Uint8Array|Uint8ClampedArray} cmpData 校准扫描图 RGBA 数据（同尺寸）
   * @param {number} w 宽（正整数）
   * @param {number} h 高（正整数）
   * @param {number} [colorThreshold=DEFAULT_DIFF_THRESHOLD] 色差阈值（0~255 有限数）
   * @returns {{mask:Uint8Array, compared:number, diffCount:number,
   *            width:number, height:number, colorThreshold:number}}
   *          mask 每像素 1 字节；compared 为双方 alpha 均达标的参与统计像素数
   * @throws {FitError} code = BAD_INPUT
   */
  function buildDifferenceMask(refData, cmpData, w, h, colorThreshold) {
    if (!refData || !cmpData || !Number.isInteger(w) || !Number.isInteger(h) ||
        w <= 0 || h <= 0 ||
        refData.length !== w * h * 4 || cmpData.length !== w * h * 4) {
      throw new FitError('BAD_INPUT', '差异比较的两张 RGBA 图像数据缺失或尺寸不一致');
    }
    const t = colorThreshold === undefined ? DEFAULT_DIFF_THRESHOLD : colorThreshold;
    if (!Number.isFinite(t) || t < 0 || t > 255) {
      throw new FitError('BAD_INPUT', '色差阈值必须为 0~255 的有限数字');
    }
    const n = w * h;
    const mask = new Uint8Array(n);
    let compared = 0, diffCount = 0;
    for (let p = 0; p < n; p++) {
      const o = p * 4;
      // 仅统计双方 alpha 均不低于 128 的像素
      if (refData[o + 3] < DIFF_ALPHA_MIN || cmpData[o + 3] < DIFF_ALPHA_MIN) continue;
      compared++;
      // 任一 RGB 通道差值超过阈值（严格大于）即标为差异
      if (Math.abs(refData[o] - cmpData[o]) > t ||
          Math.abs(refData[o + 1] - cmpData[o + 1]) > t ||
          Math.abs(refData[o + 2] - cmpData[o + 2]) > t) {
        mask[p] = 1;
        diffCount++;
      }
    }
    return { mask, compared, diffCount, width: w, height: h, colorThreshold: t };
  }

  /**
   * 对差异掩码做八邻域连通分组（可独立调用，纯像素计算）。
   *
   * 以八邻域（含对角）连通的掩码像素归为同一区域（迭代式泛洪，避免大图爆栈）；
   * 像素数 < minArea 的区域被过滤（minArea 为非负整数，0 表示不过滤）。
   * 剩余区域按面积降序输出（面积相同按扫描到的先后排序，结果可复现），并输出
   * 每像素区域编号标签 labels（长度 w·h 的 Uint32Array）：保留区域内像素为该区域
   * 的 1 起编号（与 regions[].index 一致，即按面积排序后的编号），其余像素（含
   * 被最小面积过滤的散点）为 0，供画布点击命中与 matchDiffRegions 的 IoU 匹配使用。
   * 注意：掩码 mask 在处理过程中会被就地置 0（labels 另行保留分组结果）。
   *
   * @param {Uint8Array} mask buildDifferenceMask 输出的每像素 1 字节掩码（会被清空）
   * @param {number} w 宽
   * @param {number} h 高
   * @param {number} [minArea=DEFAULT_DIFF_MIN_AREA] 最小面积（像素数小于该值的区域过滤）
   * @returns {{regions:Array<{index:number, pixelCount:number,
   *            minX:number, minY:number, maxX:number, maxY:number,
   *            bounds:{x:number,y:number,width:number,height:number}}>,
   *            labels:Uint32Array,
   *            totalDiffPixels:number, keptPixelCount:number,
   *            filteredCount:number, minArea:number}}
   *          坐标均为参考图像素坐标（闭区间），bounds.x/y 为左上角、width/height 为边长
   * @throws {FitError} code = BAD_INPUT
   */
  function groupDiffRegions(mask, w, h, minArea) {
    if (!mask || !Number.isInteger(w) || !Number.isInteger(h) ||
        w <= 0 || h <= 0 || mask.length !== w * h) {
      throw new FitError('BAD_INPUT', '差异掩码缺失或长度与宽高不符');
    }
    const area = minArea === undefined ? DEFAULT_DIFF_MIN_AREA : minArea;
    if (!Number.isFinite(area) || area < 0 || !Number.isInteger(area)) {
      throw new FitError('BAD_INPUT', '最小面积必须为不小于 0 的整数');
    }

    const found = [];
    const labels = new Uint32Array(w * h); // 先按扫描顺序暂存组件编号，排序后重标为区域编号
    let totalDiffPixels = 0;
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const seed = y * w + x;
        if (!mask[seed]) continue;
        // 八邻域迭代泛洪：掩码就地清零，组件像素在 labels 中暂记扫描顺序编号
        mask[seed] = 0;
        stack.length = 0;
        stack.push(seed);
        const floodId = found.length + 1;
        let pixelCount = 0;
        let minX = x, minY = y, maxX = x, maxY = y;
        while (stack.length) {
          const p = stack.pop();
          const px = p % w, py = (p - px) / w;
          labels[p] = floodId;
          pixelCount++;
          totalDiffPixels++;
          if (px < minX) minX = px; else if (px > maxX) maxX = px;
          if (py < minY) minY = py; else if (py > maxY) maxY = py;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = py + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = px + dx;
              if (nx < 0 || nx >= w) continue;
              const q = ny * w + nx;
              if (mask[q]) { mask[q] = 0; stack.push(q); }
            }
          }
        }
        found.push({ floodId, pixelCount, minX, minY, maxX, maxY });
      }
    }
    // 按面积降序（同面积保留扫描顺序，结果可复现）
    found.sort((r1, r2) => r2.pixelCount - r1.pixelCount);

    // 扫描顺序组件编号 → 最终区域编号（1 起，按面积排序）；被过滤组件重标为 0
    const relabel = new Uint32Array(found.length + 1);
    let keptPixelCount = 0;
    found.forEach((r, i) => {
      if (r.pixelCount >= area) {
        relabel[r.floodId] = i + 1;
        keptPixelCount += r.pixelCount;
      }
    });
    for (let p = 0; p < labels.length; p++) {
      const id = labels[p];
      if (id) labels[p] = relabel[id];
    }
    const regions = found
      .filter((r) => r.pixelCount >= area)
      .map((r) => ({
        index: relabel[r.floodId], // 1 起编号，按面积排序
        pixelCount: r.pixelCount,
        minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: r.maxY,
        // 边框：左上角 + 边长（坐标闭区间，width = maxX − minX + 1）
        bounds: {
          x: r.minX, y: r.minY,
          width: r.maxX - r.minX + 1, height: r.maxY - r.minY + 1
        }
      }));
    return {
      regions,
      labels,
      totalDiffPixels,
      keptPixelCount,
      filteredCount: totalDiffPixels - keptPixelCount,
      minArea: area
    };
  }

  /**
   * 一步完成「差异掩码 + 八邻域分组 + 最小面积过滤」的便捷函数。
   * 语义与参数同 buildDifferenceMask / groupDiffRegions（输出含每像素区域
   * 编号标签 labels，供点击命中与 matchDiffRegions 的 IoU 匹配使用）。
   * @throws {FitError} code = BAD_INPUT
   */
  function findDifferenceRegions(refData, cmpData, w, h, colorThreshold, minArea) {
    const m = buildDifferenceMask(refData, cmpData, w, h, colorThreshold);
    const g = groupDiffRegions(m.mask, w, h, minArea);
    return {
      regions: g.regions,
      labels: g.labels,
      compared: m.compared,
      diffCount: m.diffCount,
      totalDiffPixels: g.totalDiffPixels,
      keptPixelCount: g.keptPixelCount,
      filteredCount: g.filteredCount,
      width: w,
      height: h,
      colorThreshold: m.colorThreshold,
      minArea: g.minArea
    };
  }

  /**
   * 以区域实际差异像素计算新老差异区域的交并比（IoU）匹配（可独立调用，纯像素
   * 计算，不依赖 DOM/Canvas）。用于色差阈值、最小面积或控制点引发重算后决定
   * 人工复核结论能否继承——绝不按排序编号沿用。
   *
   * 匹配条件（必须同时满足）：
   *   1. 新老区域在同一 w × h 标签图上的实际像素交集非空，
   *      IoU = 交集像素数 / 并集像素数 ≥ minIou（默认 REVIEW_MATCH_MIN_IOU = 0.5）；
   *   2. 该老区域只与这一个新区域有像素重叠（新区域侧唯一）；
   *   3. 该新区域也只与这一个老区域有像素重叠（老区域侧唯一），即双方互为
   *      唯一重叠区域。
   * 任一不满足则不配对：该新区域视为未复核，老区域的结论不被继承。
   *
   * 标签图由 groupDiffRegions 输出：像素值为区域的 1 起编号（按面积排序），
   * 不属于任何保留区域的像素为 0；新老标签图必须同尺寸（通常对应同一参考图）。
   *
   * @param {Uint32Array|Uint8Array} oldLabels 重算前每像素区域编号（0 = 非区域）
   * @param {Uint32Array|Uint8Array} newLabels 重算后每像素区域编号（0 = 非区域）
   * @param {number} w 宽（正整数）
   * @param {number} h 高（正整数）
   * @param {number} [minIou=REVIEW_MATCH_MIN_IOU] 允许继承的最小 IoU（0~1）
   * @returns {{matches:Array<{oldIndex:number,newIndex:number,intersection:number,
   *            union:number,iou:number}>,
   *            newOverlapCounts:Int32Array, oldOverlapCounts:Int32Array}}
   *          matches 按新区域编号升序；两个计数数组下标为区域编号（0 位恒为 0），
   *          元素值表示该区域与另一侧多少个不同区域有像素重叠
   * @throws {FitError} code = BAD_INPUT
   */
  function matchDiffRegions(oldLabels, newLabels, w, h, minIou) {
    if (!oldLabels || !newLabels || !Number.isInteger(w) || !Number.isInteger(h) ||
        w <= 0 || h <= 0 ||
        oldLabels.length !== w * h || newLabels.length !== w * h) {
      throw new FitError('BAD_INPUT', '区域匹配的两张标签图缺失或长度与宽高不符');
    }
    const threshold = minIou === undefined ? REVIEW_MATCH_MIN_IOU : minIou;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new FitError('BAD_INPUT', '最小交并比必须为 0~1 的数字');
    }

    let oldMax = 0, newMax = 0;
    for (let p = 0; p < w * h; p++) {
      const o = oldLabels[p], n = newLabels[p];
      if (o > oldMax) oldMax = o;
      if (n > newMax) newMax = n;
    }
    // oldOverlapCounts[o]：与老区域 o 有像素重叠的不同新区域个数；newOverlapCounts 反之
    const oldOverlapCounts = new Int32Array(oldMax + 1);
    const newOverlapCounts = new Int32Array(newMax + 1);
    // 仅记录实际发生的 (old,new) 重叠对及其交集像素数，避免按编号平方分配内存
    const pairKeys = new Map(); // 键 (old,new) → 在 pairs 中的下标
    const pairs = [];           // {o, n, inter}
    for (let p = 0; p < w * h; p++) {
      const o = oldLabels[p], n = newLabels[p];
      if (!o || !n) continue;
      const key = o * (newMax + 1) + n;
      let idx = pairKeys.get(key);
      if (idx === undefined) {
        idx = pairs.length;
        pairKeys.set(key, idx);
        pairs.push({ o, n, inter: 0 });
        oldOverlapCounts[o]++;
        newOverlapCounts[n]++;
      }
      pairs[idx].inter++;
    }

    const areaOf = (labels, max) => {
      const a = new Int32Array(max + 1);
      for (let p = 0; p < labels.length; p++) {
        const v = labels[p];
        if (v) a[v]++;
      }
      return a;
    };
    const oldArea = areaOf(oldLabels, oldMax);
    const newArea = areaOf(newLabels, newMax);

    const matches = [];
    for (const pr of pairs) {
      // IoU 按双方区域内实际差异像素计算：交集 / 并集
      const union = oldArea[pr.o] + newArea[pr.n] - pr.inter;
      const iou = union > 0 ? pr.inter / union : 0;
      if (iou >= threshold &&
          oldOverlapCounts[pr.o] === 1 && newOverlapCounts[pr.n] === 1) {
        matches.push({ oldIndex: pr.o, newIndex: pr.n, intersection: pr.inter, union, iou });
      }
    }
    matches.sort((m1, m2) => m1.newIndex - m2.newIndex);
    return { matches, newOverlapCounts, oldOverlapCounts };
  }

  return {
    fitAffine,
    fitAffineRobust,
    leaveOneOutValidation,
    applyMatrix,
    collinearity,
    checkExportMatrix,
    invertMatrix,
    transformRGBA,
    buildDifferenceMask,
    groupDiffRegions,
    findDifferenceRegions,
    matchDiffRegions,
    FitError,
    MIN_POINTS,
    COLLINEAR_RATIO,
    MAX_CANDIDATES,
    MAX_REFINE_ITERS,
    DEFAULT_TOLERANCE_PX,
    MIN_MATRIX_DET,
    DIFF_ALPHA_MIN,
    DEFAULT_DIFF_THRESHOLD,
    DEFAULT_DIFF_MIN_AREA,
    REVIEW_MATCH_MIN_IOU
  };
});
