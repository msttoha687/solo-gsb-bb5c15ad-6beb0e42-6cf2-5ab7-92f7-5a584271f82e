/*
 * Express 服务：
 *  - 托管 public/ 下的前端静态资源
 *  - GET  /api/health  健康检查
 *  - POST /api/fit     仿射拟合（与前端共用 public/js/affine.js）
 *                      请求体: { "src": [{x,y}...], "dst": [{x,y}...],
 *                                "robust"?: boolean, "tolerancePx"?: number }（≥3 对）
 *                      robust=true 时采用稳健模式（内点重拟合 + 外点剔除）
 *                      成功: 200 { ok:true, mode, matrix, residuals, rmse,
 *                                  maxIndex, pointCount, inliers, validation, ... }
 *                      validation 为逐点留出验证（稳健模式仅内点参与，外点 excluded）
 *                      失败: 400 参数非法 / 422 点数不足、近共线或无可用非共线三点
 */
'use strict';

const path = require('path');
const express = require('express');
const Affine = require('./public/js/affine.js');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/fit', (req, res) => {
  const { src, dst, robust, tolerancePx } = req.body || {};
  try {
    const result = robust
      ? Affine.fitAffineRobust(src, dst, {
        tolerancePx: tolerancePx === undefined ? Affine.DEFAULT_TOLERANCE_PX : tolerancePx
      })
      : Affine.fitAffine(src, dst);
    res.json({ ok: true, mode: robust ? 'robust' : 'leastSquares', ...result });
  } catch (err) {
    const status = err.code === 'BAD_INPUT' ? 400 : 422;
    res.status(status).json({
      ok: false,
      error: err.code || 'FIT_ERROR',
      message: err.message || '拟合失败'
    });
  }
});

// 未知 API 路径返回 JSON 404
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'NOT_FOUND', message: '接口不存在' });
});

app.listen(PORT, () => {
  console.log(`套色偏移校准工具已启动: http://localhost:${PORT}`);
});
