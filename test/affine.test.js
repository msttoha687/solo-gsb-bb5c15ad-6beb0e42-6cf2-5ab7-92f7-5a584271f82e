/* affine.js 单元测试：node test/affine.test.js */
'use strict';

const assert = require('assert');
const Affine = require('../public/js/affine.js');

const TRUE_M = { a: 1.02, b: 0.01, c: 15, d: -0.005, e: 0.98, f: -20 };
const SRC = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 },
  { x: 100, y: 100 }, { x: 50, y: 80 }, { x: 200, y: 30 }
];

function apply(m, p) {
  return { x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f };
}

// 1. 无噪声：精确还原六参数
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(SRC, dst);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1e-9, `参数 ${k} 偏差过大: ${r.matrix[k]}`);
  }
  assert.ok(r.rmse < 1e-9, '无噪声时 RMSE 应接近 0');
  console.log('✓ 无噪声 6 点精确还原矩阵');
}

// 2. 恰好 3 点：精确解，残差为 0
{
  const src = SRC.slice(0, 3);
  const dst = src.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(src, dst);
  assert.ok(r.rmse < 1e-9);
  assert.deepStrictEqual(r.residuals.every((v) => v < 1e-9), true);
  console.log('✓ 3 点精确拟合');
}

// 3. 含噪声：最小二乘逼近真值，残差量级与噪声一致
{
  const noise = 0.5;
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const dst = SRC.map((p) => {
    const q = apply(TRUE_M, p);
    return { x: q.x + rand() * 2 * noise, y: q.y + rand() * 2 * noise };
  });
  const r = Affine.fitAffine(SRC, dst);
  // 旋转/缩放参数无量纲，容差取噪声/点距量级；平移参数单位为 px，容差取噪声量级
  for (const k of ['a', 'b', 'd', 'e']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 0.02, `含噪拟合 ${k} 偏差过大`);
  }
  for (const k of ['c', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1.5, `含噪拟合 ${k} 偏差过大`);
  }
  assert.ok(r.rmse > 0 && r.rmse < 2, 'RMSE 应在噪声量级内');
  assert.strictEqual(r.maxIndex, r.residuals.indexOf(Math.max(...r.residuals)));
  console.log('✓ 含噪最小二乘逼近，maxIndex 正确');
}

// 4. 点数不足：拒绝
{
  assert.throws(() => Affine.fitAffine(SRC.slice(0, 2), SRC.slice(0, 2)), /至少需要 3 对/);
  console.log('✓ 少于 3 点抛出 TOO_FEW_POINTS');
}

// 5. 源点共线：拒绝
{
  const collinear = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 }];
  const dst = collinear.map((p) => apply(TRUE_M, p));
  assert.throws(() => Affine.fitAffine(collinear, dst), (e) => e.code === 'COLLINEAR_SRC');
  console.log('✓ 源点共线抛出 COLLINEAR_SRC');
}

// 6. 源点近共线（1000px 基线、0.1px 垂直偏移）：拒绝
{
  const nearCol = [{ x: 0, y: 0 }, { x: 500, y: 0.1 }, { x: 1000, y: 0 }, { x: 250, y: -0.1 }];
  const dst = nearCol.map((p) => apply(TRUE_M, p));
  assert.throws(() => Affine.fitAffine(nearCol, dst), (e) => e.code === 'COLLINEAR_SRC');
  console.log('✓ 源点近共线被拒绝');
}

// 7. 目标点共线：拒绝
{
  const dstCol = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }, { x: 150, y: 150 }];
  assert.throws(() => Affine.fitAffine(SRC.slice(0, 4), dstCol), (e) => e.code === 'COLLINEAR_DST');
  console.log('✓ 目标点共线抛出 COLLINEAR_DST');
}

// 8. 点全部重合：拒绝
{
  const same = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
  assert.throws(() => Affine.fitAffine(same, same), (e) => e.code === 'COLLINEAR_SRC');
  console.log('✓ 点重合被拒绝');
}

// 9. 非法输入：拒绝
{
  const good3 = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  const bad3 = [{ x: 0, y: 0 }, { x: 10 }, { x: 0, y: 10 }];
  assert.throws(() => Affine.fitAffine(good3, bad3), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffine('x', []), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffine(good3, good3.slice(0, 2)), (e) => e.code === 'BAD_INPUT');
  console.log('✓ 非法输入抛出 BAD_INPUT');
}

// 10. 大坐标（扫描仪高分辨率量级）数值稳定
{
  const big = SRC.map((p) => ({ x: p.x * 10 + 5000, y: p.y * 10 + 8000 }));
  const dst = big.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(big, dst);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1e-6, `大坐标下 ${k} 偏差过大`);
  }
  console.log('✓ 大坐标数值稳定');
}

// ---------- 稳健模式 fitAffineRobust ----------

// 11. 无噪声：全部点为内点，精确还原
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 2 });
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(r.matrix[k] - TRUE_M[k]) < 1e-9, `稳健拟合参数 ${k} 偏差过大`);
  }
  assert.strictEqual(r.inlierCount, SRC.length);
  assert.strictEqual(r.outlierCount, 0);
  assert.deepStrictEqual(r.inliers, SRC.map(() => true));
  assert.ok(r.rmse < 1e-9);
  assert.ok(r.candidatesEvaluated >= 1);
  console.log('✓ 稳健模式无噪声：全内点精确还原');
}

// 12. 含一个粗大外点：外点被剔除，内点 RMSE 接近 0
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  dst[5] = { x: 9999, y: -9999 }; // 粗大外点
  const r = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 2 });
  assert.strictEqual(r.inlierCount, 5);
  assert.strictEqual(r.outlierCount, 1);
  assert.strictEqual(r.inliers[5], false);
  assert.ok(r.rmse < 1e-9, '内点应精确拟合，RMSE≈0');
  assert.ok(r.maxIndex !== 5, 'maxIndex 不应为外点');
  assert.ok(r.maxIndex >= 0, '至少存在一个内点用于 maxIndex');
  // 外点残差仍给出
  assert.ok(r.residuals[5] > 1000, '外点残差应仍被计算');
  console.log('✓ 稳健模式剔除粗大外点并精确拟合内点');
}

// 13. 对比经典模式：同一外点会拖偏 LS，稳健模式结果明显更优
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  dst[2] = { x: dst[2].x + 40, y: dst[2].y + 40 };
  const ls = Affine.fitAffine(SRC, dst);
  const rb = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 2 });
  assert.ok(rb.inliers[2] === false);
  assert.ok(rb.rmse < ls.rmse * 0.5, `稳健 RMSE 应远小于 LS: ${rb.rmse} vs ${ls.rmse}`);
  console.log('✓ 稳健模式避免外点拖偏（RMSE 显著小于最小二乘）');
}

// 14. 容差影响：噪声 1px 时，tol=0 判多数为外点（候选自身除外），tol=3 全为内点
{
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const dst = SRC.map((p) => {
    const q = apply(TRUE_M, p);
    return { x: q.x + rand() * 2, y: q.y + rand() * 2 }; // ±1px 噪声
  });
  const tight = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 0.001 });
  const loose = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 3 });
  assert.ok(tight.inlierCount >= 3 && tight.inlierCount < SRC.length, '紧容差下至少有候选三点、且非全内点');
  assert.strictEqual(loose.inlierCount, SRC.length, '宽容差下全部为内点');
  console.log('✓ 像素容差收紧/放宽正确改变内外点划分');
}

// 15. 全部共线：稳健模式抛出 NO_NONCOLLINEAR_TRIPLET
{
  const collinear = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 300 }];
  const dst = collinear.map((p) => apply(TRUE_M, p));
  assert.throws(() => Affine.fitAffineRobust(collinear, dst, { tolerancePx: 2 }),
    (e) => e.code === 'NO_NONCOLLINEAR_TRIPLET');
  console.log('✓ 稳健模式全共线抛出 NO_NONCOLLINEAR_TRIPLET');
}

// 16. 恰好 3 个非共线点：精确解，全部内点
{
  const src = SRC.slice(0, 3);
  const dst = src.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffineRobust(src, dst, { tolerancePx: 0 });
  assert.strictEqual(r.inlierCount, 3);
  assert.ok(r.rmse < 1e-9, 'tol=0 时三点自身残差为 0，应全部内点');
  console.log('✓ 稳健模式 3 点（tol=0）精确解');
}

// 17. 少于 3 点 / 非法容差 / 非法输入
{
  assert.throws(() => Affine.fitAffineRobust(SRC.slice(0, 2), SRC.slice(0, 2)), /至少需要 3 对/);
  assert.throws(() => Affine.fitAffineRobust(SRC, SRC, { tolerancePx: -1 }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.fitAffineRobust('x', []), (e) => e.code === 'BAD_INPUT');
  console.log('✓ 稳健模式参数校验（TOO_FEW_POINTS / BAD_INPUT）');
}

// 18. 候选上限：仅评估至多 MAX_CANDIDATES 个非共线候选，且固定顺序结果可复现
{
  // 8 个点共 C(8,3)=56 个三元组，全部评估
  const n8 = SRC.concat([{ x: 200, y: 200 }, { x: 20, y: 160 }]);
  const dst8 = n8.map((p) => apply(TRUE_M, p));
  const r1 = Affine.fitAffineRobust(n8, dst8, { tolerancePx: 2 });
  const r2 = Affine.fitAffineRobust(n8, dst8, { tolerancePx: 2 });
  assert.strictEqual(r1.candidatesEvaluated, r2.candidatesEvaluated);
  assert.strictEqual(r1.matrix.a, r2.matrix.a);
  assert.ok(r1.candidatesEvaluated <= Affine.MAX_CANDIDATES);
  // 上限取 1：只评估字典序首个三元组 (0,1,2)
  const rOne = Affine.fitAffineRobust(n8, dst8, { tolerancePx: 2, maxCandidates: 1 });
  assert.strictEqual(rOne.candidatesEvaluated, 1);
  console.log('✓ 稳健模式候选有上限且固定顺序可复现');
}

// 19. 大量点（50 个，C(50,3)=19600）：计算量被上限约束，结果仍正确
{
  let seed = 99;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const bigSrc = [];
  for (let i = 0; i < 50; i++) bigSrc.push({ x: 200 * rand() + 10, y: 200 * rand() + 10 });
  const bigDst = bigSrc.map((p) => apply(TRUE_M, p));
  bigDst[49] = { x: 0, y: 0 }; // 外点
  const t0 = Date.now();
  const r = Affine.fitAffineRobust(bigSrc, bigDst, { tolerancePx: 2 });
  const ms = Date.now() - t0;
  assert.ok(r.candidatesEvaluated <= Affine.MAX_CANDIDATES, '扫描三元组数受上限约束');
  assert.strictEqual(r.inliers[49], false);
  assert.ok(r.rmse < 1e-9);
  assert.ok(ms < 500, `50 点稳健拟合应快速完成，实际 ${ms}ms`);
  console.log(`✓ 50 点稳健拟合有界且快速（${ms}ms，评估 ${r.candidatesEvaluated} 候选）`);
}

// ---------- 逐点留出验证 leaveOneOutValidation ----------

// 20. 无噪声 6 点：全部可验证，留出误差 ≈ 0
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(SRC, dst);
  const v = r.validation;
  assert.strictEqual(v.participantCount, 6);
  assert.strictEqual(v.verifiableCount, 6);
  assert.strictEqual(v.points.length, 6);
  assert.ok(v.points.every((p) => p.status === 'ok' && p.participates));
  assert.ok(v.rmse < 1e-9, `无噪声时留出验证 RMSE 应接近 0，实际 ${v.rmse}`);
  assert.ok(v.maxError < 1e-9);
  assert.ok(v.maxIndex >= 0 && v.maxIndex < 6);
  console.log('✓ 留出验证：无噪声 6 点全部可验证且误差≈0');
}

// 21. 留出误差与「手动移除该点后重拟合」的结果一致（非拿原残差充数）
{
  let seed = 5;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const dst = SRC.map((p) => {
    const q = apply(TRUE_M, p);
    return { x: q.x + rand(), y: q.y + rand() };
  });
  const r = Affine.fitAffine(SRC, dst);
  const v = r.validation;
  for (let i = 0; i < SRC.length; i++) {
    const s2 = SRC.filter((_, j) => j !== i);
    const d2 = dst.filter((_, j) => j !== i);
    const m = Affine.fitAffine(s2, d2).matrix; // 手动留出重拟合
    const pred = Affine.applyMatrix(m, SRC[i]);
    const expect = Math.hypot(pred.x - dst[i].x, pred.y - dst[i].y);
    assert.ok(Math.abs(v.points[i].error - expect) < 1e-9,
      `点 ${i} 留出误差应与手动重拟合一致: ${v.points[i].error} vs ${expect}`);
  }
  // 含噪时留出误差不等于原拟合残差（OLS 留出残差 ≥ 训练残差）
  assert.ok(v.rmse > r.rmse, '含噪时留出验证 RMSE 应大于原拟合 RMSE');
  assert.ok(v.points.some((p, i) => Math.abs(p.error - r.residuals[i]) > 1e-12),
    '留出误差不得照抄原拟合残差');
  console.log('✓ 留出验证：与手动重拟合一致，且不照抄原拟合残差');
}

// 22. 参与点不足 4 个（恰好 3 点）：全部无法验证，汇总不可用
{
  const src = SRC.slice(0, 3);
  const dst = src.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(src, dst);
  const v = r.validation;
  assert.strictEqual(v.participantCount, 3);
  assert.strictEqual(v.verifiableCount, 0);
  assert.ok(v.points.every((p) => p.status === 'unverifiable' && p.error === null));
  assert.strictEqual(v.rmse, null);
  assert.strictEqual(v.maxError, null);
  assert.strictEqual(v.maxIndex, -1);
  console.log('✓ 留出验证：3 个参与点时全部无法验证，汇总为 null');
}

// 23. 某次留出后点集近共线：该点无法验证，其余正常
{
  // 三点共线 + 一点离线：移除离线点后剩余三点共线
  const src = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 150, y: 400 }];
  const dst = src.map((p) => apply(TRUE_M, p));
  const r = Affine.fitAffine(src, dst);
  const v = r.validation;
  assert.strictEqual(v.points[3].status, 'unverifiable', '移除离线点后剩余点共线，应无法验证');
  assert.strictEqual(v.points[3].error, null);
  for (let i = 0; i < 3; i++) assert.strictEqual(v.points[i].status, 'ok');
  assert.strictEqual(v.verifiableCount, 3);
  assert.ok(v.rmse !== null && v.rmse < 1e-9);
  assert.ok(v.maxIndex >= 0 && v.maxIndex < 3, '最差点应在可验证点中');
  console.log('✓ 留出验证：留出后近共线的点标记无法验证，汇总仅统计可验证点');
}

// 24. 稳健模式：仅内点参与留出验证，外点 excluded
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  dst[5] = { x: 9999, y: -9999 }; // 粗大外点
  const r = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 2 });
  const v = r.validation;
  assert.strictEqual(v.participantCount, 5);
  assert.strictEqual(v.verifiableCount, 5);
  assert.strictEqual(v.points[5].status, 'excluded');
  assert.strictEqual(v.points[5].participates, false);
  assert.strictEqual(v.points[5].error, null);
  assert.ok(v.points.slice(0, 5).every((p) => p.status === 'ok'));
  assert.ok(v.rmse < 1e-9);
  assert.ok(v.maxIndex !== 5, '最差验证点不应是外点');
  console.log('✓ 留出验证：稳健模式仅内点参与，外点 excluded');
}

// 25. 稳健模式内点恰好 3 个：内点全部无法验证，外点仍 excluded，汇总不可用
{
  const src = SRC.slice(0, 4);
  const dst = src.map((p) => apply(TRUE_M, p));
  dst[3] = { x: 9999, y: 9999 }; // 外点，仅剩 3 个内点
  const r = Affine.fitAffineRobust(src, dst, { tolerancePx: 2 });
  assert.strictEqual(r.inlierCount, 3);
  const v = r.validation;
  assert.strictEqual(v.participantCount, 3);
  assert.strictEqual(v.verifiableCount, 0);
  assert.strictEqual(v.points[3].status, 'excluded');
  assert.ok(v.points.slice(0, 3).every((p) => p.status === 'unverifiable'));
  assert.strictEqual(v.rmse, null);
  assert.strictEqual(v.maxError, null);
  assert.strictEqual(v.maxIndex, -1);
  console.log('✓ 留出验证：稳健模式内点不足 4 个时汇总不可用');
}

// 26. 直接调用 leaveOneOutValidation：inliers 参数与缺省行为
{
  const dst = SRC.map((p) => apply(TRUE_M, p));
  const inliers = [true, true, true, true, false, false];
  const v = Affine.leaveOneOutValidation(SRC, dst, inliers);
  assert.strictEqual(v.participantCount, 4);
  assert.strictEqual(v.verifiableCount, 4);
  assert.strictEqual(v.points[4].status, 'excluded');
  assert.strictEqual(v.points[5].status, 'excluded');
  assert.ok(v.points.slice(0, 4).every((p) => p.status === 'ok'));
  // 缺省 inliers：全部参与
  const vAll = Affine.leaveOneOutValidation(SRC, dst);
  assert.strictEqual(vAll.participantCount, SRC.length);
  console.log('✓ 留出验证：leaveOneOutValidation 可独立调用，inliers 参数生效');
}

// ---------- RGBA 像素变换 transformRGBA / checkExportMatrix ----------

const IDENTITY = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };

// 27. 恒等矩阵：像素中心对齐，输出与输入逐像素一致
{
  const src = new Uint8ClampedArray([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 0, 128
  ]);
  const out = Affine.transformRGBA(src, 2, 2, IDENTITY, 2, 2);
  assert.ok(out instanceof Uint8ClampedArray);
  assert.strictEqual(out.length, 2 * 2 * 4);
  assert.deepStrictEqual(Array.from(out), Array.from(src));
  console.log('✓ transformRGBA 恒等矩阵逐像素还原（像素中心 (i+0.5, j+0.5) 对齐）');
}

// 28. 整数平移：c=1 时输出第 i 列 = 源第 i−1 列，第 0 列越界为透明黑
{
  const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]); // 3×1 红绿蓝
  const out = Affine.transformRGBA(src, 3, 1, { ...IDENTITY, c: 1 }, 3, 1);
  assert.deepStrictEqual(Array.from(out.slice(0, 4)), [0, 0, 0, 0], '越界邻点应为透明黑');
  assert.deepStrictEqual(Array.from(out.slice(4, 8)), [255, 0, 0, 255]);
  assert.deepStrictEqual(Array.from(out.slice(8, 12)), [0, 255, 0, 255]);
  console.log('✓ transformRGBA 逆仿射取样：平移后越界邻点为透明黑');
}

// 29. 双线性插值：颜色先乘 alpha 再插值、输出时还原（半透明边界不串色）
{
  // 源 2×1：不透明红 + 全透明（RGB 为杂值）；在两像素中心中点取样
  const src = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0]);
  const out = Affine.transformRGBA(src, 2, 1, { ...IDENTITY, c: -0.5 }, 1, 1);
  // 预乘：r = 0.5·255·1 + 0.5·(0·0) = 127.5，alpha = 127.5 → 还原 r = 255，alpha = round(127.5) = 128
  assert.deepStrictEqual(Array.from(out), [255, 0, 0, 128],
    '颜色须先乘 alpha 再插值、输出时还原（未预乘会得到 r=128）');
  console.log('✓ transformRGBA 预乘 alpha 插值并还原（透明像素不串色）');
}

// 30. alpha 为零时 RGB 归零
{
  const src = new Uint8ClampedArray([10, 20, 30, 0]); // 1×1 全透明但 RGB 非零
  const out = Affine.transformRGBA(src, 1, 1, IDENTITY, 1, 1);
  assert.deepStrictEqual(Array.from(out), [0, 0, 0, 0], 'alpha 为零时 RGB 必须归零');
  console.log('✓ transformRGBA alpha 为零时 RGB 归零');
}

// 31. 通道四舍五入到 0~255（0.5 → 1，而非银行家舍入的 0）
{
  const src = new Uint8ClampedArray([1, 0, 0, 255, 0, 0, 0, 255]); // 2×1：r=1 与 r=0
  const out = Affine.transformRGBA(src, 2, 1, { ...IDENTITY, c: -0.5 }, 1, 1);
  assert.strictEqual(out[0], 1, '0.5 应四舍五入为 1');
  assert.strictEqual(out[3], 255);
  console.log('✓ transformRGBA 通道四舍五入到 0~255');
}

// 32. 放大 2 倍：边缘覆盖不足时与透明黑混合，内部精确还原
{
  // 源 2×2 均匀灰 (100,100,100,255) → 输出 4×4
  const src = new Uint8ClampedArray(2 * 2 * 4);
  for (let k = 0; k < 4; k++) { src[k * 4] = 100; src[k * 4 + 1] = 100; src[k * 4 + 2] = 100; src[k * 4 + 3] = 255; }
  const out = Affine.transformRGBA(src, 2, 2, { a: 2, b: 0, c: 0, d: 0, e: 2, f: 0 }, 4, 4);
  // 角像素 (0,0)：中心 (0.5,0.5) 逆映射到 (0.25,0.25)，仅 0.75×0.75 覆盖源像素
  const corner = [100, 100, 100, Math.round(0.75 * 0.75 * 255)];
  assert.deepStrictEqual(Array.from(out.slice(0, 4)), corner, '边缘应与透明黑按覆盖率混合');
  // 中心像素 (1,1)：中心 (1.5,1.5) 逆映射到 (0.75,0.75)，完全落在源内
  const center = Array.from(out.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4));
  assert.deepStrictEqual(center, [100, 100, 100, 255], '完全覆盖区域应精确还原');
  console.log('✓ transformRGBA 放大采样：边缘与透明黑混合、内部精确');
}

// 33. 非法矩阵拒绝：非有限值 / 行列式绝对值 ≤ 1e-12
{
  const src = new Uint8ClampedArray(4);
  assert.throws(() => Affine.transformRGBA(src, 1, 1, { ...IDENTITY, a: NaN }, 1, 1),
    (e) => e.code === 'BAD_MATRIX' && /非有限值/.test(e.message));
  assert.throws(() => Affine.transformRGBA(src, 1, 1, { ...IDENTITY, c: Infinity }, 1, 1),
    (e) => e.code === 'BAD_MATRIX');
  // 奇异矩阵：det = 0
  assert.throws(() => Affine.transformRGBA(src, 1, 1, { a: 1, b: 1, c: 0, d: 1, e: 1, f: 0 }, 1, 1),
    (e) => e.code === 'BAD_MATRIX' && /行列式/.test(e.message));
  // det = 1e-13 ≤ 1e-12：拒绝；det = 1e-11 > 1e-12：允许
  assert.throws(() => Affine.transformRGBA(src, 1, 1, { a: 1e-13, b: 0, c: 0, d: 0, e: 1, f: 0 }, 1, 1),
    (e) => e.code === 'BAD_MATRIX');
  const ok = Affine.transformRGBA(src, 1, 1, { a: 1e-11, b: 0, c: 0, d: 0, e: 1, f: 0 }, 1, 1);
  assert.strictEqual(ok.length, 4);
  // 非法像素数据 / 输出尺寸
  assert.throws(() => Affine.transformRGBA(null, 1, 1, IDENTITY, 1, 1), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.transformRGBA(src, 2, 1, IDENTITY, 1, 1), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.transformRGBA(src, 1, 1, IDENTITY, 0, 1), (e) => e.code === 'BAD_INPUT');
  console.log('✓ transformRGBA 拒绝非有限值 / 近奇异矩阵 / 非法输入');
}

// 34. checkExportMatrix：导出前校验（不抛异常，返回原因）
{
  assert.strictEqual(Affine.checkExportMatrix(IDENTITY).ok, true);
  assert.strictEqual(Affine.checkExportMatrix(TRUE_M).ok, true);
  const nan = Affine.checkExportMatrix({ ...IDENTITY, e: NaN });
  assert.strictEqual(nan.ok, false);
  assert.ok(/非有限值/.test(nan.reason));
  const singular = Affine.checkExportMatrix({ a: 2, b: 1, c: 0, d: 4, e: 2, f: 0 }); // det = 0
  assert.strictEqual(singular.ok, false);
  assert.ok(/行列式/.test(singular.reason));
  const tiny = Affine.checkExportMatrix({ a: 1e-12, b: 0, c: 0, d: 0, e: 1, f: 0 }); // det = 1e-12 ≤ 阈值
  assert.strictEqual(tiny.ok, false);
  assert.strictEqual(Affine.checkExportMatrix(null).ok, false);
  console.log('✓ checkExportMatrix 校验非有限值与行列式阈值并给出原因');
}

// 35. invertMatrix：逆矩阵与正向矩阵复合为恒等
{
  const inv = Affine.invertMatrix(TRUE_M);
  const p = { x: 123.4, y: -56.7 };
  const q = apply(TRUE_M, p);
  const back = Affine.applyMatrix(inv, q);
  assert.ok(Math.hypot(back.x - p.x, back.y - p.y) < 1e-9, '逆映射应还原原坐标');
  assert.throws(() => Affine.invertMatrix({ a: 1, b: 1, c: 0, d: 1, e: 1, f: 0 }),
    (e) => e.code === 'BAD_MATRIX');
  console.log('✓ invertMatrix 逆映射正确，奇异矩阵抛 BAD_MATRIX');
}

// ---------- 差异区域 buildDifferenceMask / groupDiffRegions / findDifferenceRegions ----------

// 构造 w×h 不透明灰底 RGBA（rgb=base），可再覆盖指定像素
function solidImage(w, h, rgb) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
  }
  return data;
}
const setPx = (data, w, x, y, rgba) => {
  const o = (y * w + x) * 4;
  data[o] = rgba[0]; data[o + 1] = rgba[1]; data[o + 2] = rgba[2]; data[o + 3] = rgba[3];
};

// 36. buildDifferenceMask：相同图像零差异；任一通道超阈值标差异；阈值严格大于
{
  const w = 4, h = 2;
  const a = solidImage(w, h, [200, 100, 50]);
  const same = solidImage(w, h, [200, 100, 50]);
  let m = Affine.buildDifferenceMask(a, same, w, h, 32);
  assert.strictEqual(m.compared, w * h);
  assert.strictEqual(m.diffCount, 0);
  assert.strictEqual(m.colorThreshold, 32);
  // R 通道差值恰好 32：严格大于才标差异 → 无差异
  const b32 = solidImage(w, h, [200, 100, 50]);
  b32[0] = 232;
  m = Affine.buildDifferenceMask(a, b32, w, h, 32);
  assert.strictEqual(m.diffCount, 0, '差值等于阈值不应标为差异');
  // R 通道差值 33：标差异
  const b33 = solidImage(w, h, [200, 100, 50]);
  b33[0] = 233;
  m = Affine.buildDifferenceMask(a, b33, w, h, 32);
  assert.strictEqual(m.diffCount, 1);
  assert.strictEqual(m.mask[0], 1);
  // 仅 B 通道超阈值也标差异
  const bB = solidImage(w, h, [200, 100, 50]);
  bB[(1 * w + 1) * 4 + 2] = 0; // B 50 → 0，差 50
  m = Affine.buildDifferenceMask(a, bB, w, h, 32);
  assert.strictEqual(m.mask[1 * w + 1], 1);
  console.log('✓ buildDifferenceMask：任一通道严格超阈值即差异，等阈值不算');
}

// 37. alpha 门槛：双方 alpha 均 ≥ 128 才参与统计
{
  const w = 3, h = 1;
  const ref = solidImage(w, h, [0, 0, 0]);
  const cmp = solidImage(w, h, [255, 255, 255]); // 每像素 RGB 差 255
  cmp[3] = 127;        // 像素 0：cmp alpha 127 → 不参与
  ref[7] = 128;        // 像素 1：ref alpha 128（cmp 255）→ 参与且差异
  cmp[11] = 128;       // 像素 2：双方 128/128 → 参与且差异
  const m = Affine.buildDifferenceMask(ref, cmp, w, h, 0);
  assert.strictEqual(m.compared, 2, '仅双方 alpha 均 ≥ 128 的像素参与');
  assert.strictEqual(m.diffCount, 2);
  assert.strictEqual(m.mask[0], 0);
  assert.strictEqual(m.mask[1], 1);
  assert.strictEqual(m.mask[2], 1);
  console.log('✓ buildDifferenceMask：仅统计双方 alpha 均不低于 128 的像素');
}

// 38. groupDiffRegions：八邻域（对角）连通分组 + 边框与面积
{
  const w = 5, h = 5;
  const mask = new Uint8Array(w * h);
  // 区域 A：(0,0) 与 (1,1) 仅对角相邻 → 八邻域下同一区域
  mask[0] = 1; mask[1 * w + 1] = 1;
  // 区域 B：矩形 (3..4, 3..4)，4 像素
  mask[3 * w + 3] = 1; mask[3 * w + 4] = 1; mask[4 * w + 3] = 1; mask[4 * w + 4] = 1;
  const g = Affine.groupDiffRegions(mask, w, h, 1);
  assert.strictEqual(g.regions.length, 2);
  assert.strictEqual(g.totalDiffPixels, 6);
  // 按面积降序：B 在前
  assert.strictEqual(g.regions[0].pixelCount, 4);
  assert.deepStrictEqual(g.regions[0].bounds, { x: 3, y: 3, width: 2, height: 2 });
  assert.strictEqual(g.regions[0].minX, 3); assert.strictEqual(g.regions[0].maxY, 4);
  assert.strictEqual(g.regions[0].index, 1);
  const a = g.regions[1];
  assert.strictEqual(a.pixelCount, 2);
  assert.deepStrictEqual(a.bounds, { x: 0, y: 0, width: 2, height: 2 });
  console.log('✓ groupDiffRegions：八邻域对角连通、按面积降序、边框正确');
}

// 39. 最小面积过滤与掩码就地清空
{
  const w = 4, h = 4;
  const mask = new Uint8Array(w * h);
  mask[0 * w + 3] = 1;                       // 孤立像素（与下方区域八邻域不相邻）
  mask[2 * w + 0] = 1; mask[2 * w + 1] = 1; // 2 像素区域
  let g = Affine.groupDiffRegions(mask.slice(), w, h, 2);
  assert.strictEqual(g.regions.length, 1, '1 像素区域应被 minArea=2 过滤');
  assert.strictEqual(g.regions[0].pixelCount, 2);
  assert.strictEqual(g.filteredCount, 1);
  g = Affine.groupDiffRegions(mask.slice(), w, h, 0); // 0 表示不过滤
  assert.strictEqual(g.regions.length, 2);
  assert.strictEqual(g.minArea, 0);
  // 掩码被处理过程就地清空
  const consumed = mask.slice();
  Affine.groupDiffRegions(consumed, w, h, 1);
  assert.strictEqual(consumed.every((v) => v === 0), true);
  console.log('✓ groupDiffRegions：最小面积过滤、0 不过滤、掩码就地清空');
}

// 40. findDifferenceRegions：端到端，面积相同时保留扫描顺序（结果可复现）
{
  const w = 6, h = 3;
  const ref = solidImage(w, h, [255, 255, 255]);
  const cmp = solidImage(w, h, [255, 255, 255]);
  setPx(cmp, w, 0, 0, [0, 0, 0, 255]);   // 左上单像素
  setPx(cmp, w, 5, 2, [0, 0, 0, 255]);   // 右下单像素
  const r = Affine.findDifferenceRegions(ref, cmp, w, h, 10, 1);
  assert.strictEqual(r.diffCount, 2);
  assert.strictEqual(r.regions.length, 2);
  assert.strictEqual(r.regions[0].minX, 0, '同面积按扫描顺序，左上在前');
  assert.strictEqual(r.regions[1].minX, 5);
  assert.strictEqual(r.width, w); assert.strictEqual(r.height, h);
  assert.strictEqual(r.colorThreshold, 10); assert.strictEqual(r.minArea, 1);
  console.log('✓ findDifferenceRegions：端到端分组排序，默认阈值/面积可覆盖');
}

// 41. 非法参数拒绝
{
  const ref = solidImage(2, 2, [0, 0, 0]);
  const cmp = solidImage(2, 2, [255, 255, 255]);
  assert.throws(() => Affine.buildDifferenceMask(ref, cmp, 2, 1, 32), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.buildDifferenceMask(ref, cmp, 2, 2, -1), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.buildDifferenceMask(ref, cmp, 2, 2, 256), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.buildDifferenceMask(null, cmp, 2, 2, 32), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.groupDiffRegions(new Uint8Array(4), 2, 2, -1), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.groupDiffRegions(new Uint8Array(4), 2, 2, 1.5), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => Affine.groupDiffRegions(new Uint8Array(3), 2, 2, 1), (e) => e.code === 'BAD_INPUT');
  console.log('✓ 差异区域：尺寸不符 / 阈值越界 / 非法面积抛 BAD_INPUT');
}

// 42. 常量默认值
{
  assert.strictEqual(Affine.DIFF_ALPHA_MIN, 128);
  assert.strictEqual(Affine.DEFAULT_DIFF_THRESHOLD, 32);
  assert.strictEqual(Affine.DEFAULT_DIFF_MIN_AREA, 20);
  console.log('✓ 差异区域常量：ALPHA_MIN=128 / 默认阈值 32 / 默认最小面积 20');
}

console.log('\n全部测试通过 ✔');
