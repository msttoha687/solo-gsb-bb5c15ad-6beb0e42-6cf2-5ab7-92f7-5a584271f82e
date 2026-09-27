/*
 * /api/fit 留出验证一致性测试：node test/api.test.js
 * 启动临时服务器（独立端口），验证接口返回的 validation 与
 * 前端直接调用 public/js/affine.js 的结果完全一致（同一份代码），
 * 并覆盖稳健模式外点 excluded、参与点不足 4 个不可用等场景。
 */
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const Affine = require('../public/js/affine.js');

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;

const SRC = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 },
  { x: 100, y: 100 }, { x: 50, y: 80 }, { x: 200, y: 30 }
];
const M = { a: 1.02, b: 0.01, c: 15, d: -0.005, e: 0.98, f: -20 };
const apply = (p) => ({ x: M.a * p.x + M.b * p.y + M.c, y: M.d * p.x + M.e * p.y + M.f });

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) return resolve();
      } catch (_) { /* 尚未就绪 */ }
      if (Date.now() > deadline) return reject(new Error('服务器启动超时'));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function postFit(body) {
  const r = await fetch(`${BASE}/api/fit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json() };
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  try {
    await waitForServer(10000);

    // 1. 经典模式：接口 validation 与本地 fitAffine 完全一致
    {
      const dst = SRC.map(apply);
      dst[2] = { x: dst[2].x + 1.5, y: dst[2].y - 1 }; // 少量扰动，让留出误差非零
      const { status, json } = await postFit({ src: SRC, dst });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.mode, 'leastSquares');
      const local = Affine.fitAffine(SRC, dst);
      assert.deepStrictEqual(json.validation, local.validation,
        '接口与页面的留出验证结果必须一致（同一份 affine.js）');
      assert.strictEqual(json.validation.verifiableCount, 6);
      assert.ok(json.validation.rmse > 0);
      assert.ok(json.validation.points.every((p) => p.status === 'ok'));
      console.log('✓ /api/fit 经典模式：validation 与本地计算一致（6 点可验证）');
    }

    // 2. 稳健模式：外点 excluded，接口与本地 fitAffineRobust 一致
    {
      const dst = SRC.map(apply);
      dst[5] = { x: 9999, y: -9999 }; // 粗大外点
      const { status, json } = await postFit({ src: SRC, dst, robust: true, tolerancePx: 2 });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.mode, 'robust');
      const local = Affine.fitAffineRobust(SRC, dst, { tolerancePx: 2 });
      assert.deepStrictEqual(json.validation, local.validation);
      assert.strictEqual(json.validation.participantCount, 5);
      assert.strictEqual(json.validation.verifiableCount, 5);
      assert.strictEqual(json.validation.points[5].status, 'excluded');
      assert.strictEqual(json.validation.points[5].error, null);
      console.log('✓ /api/fit 稳健模式：外点 excluded，validation 与本地一致');
    }

    // 3. 恰好 3 点：参与点不足 4 个，全部无法验证，汇总为 null
    {
      const src = SRC.slice(0, 3);
      const dst = src.map(apply);
      const { status, json } = await postFit({ src, dst });
      assert.strictEqual(status, 200);
      assert.strictEqual(json.validation.verifiableCount, 0);
      assert.strictEqual(json.validation.rmse, null);
      assert.strictEqual(json.validation.maxError, null);
      assert.strictEqual(json.validation.maxIndex, -1);
      assert.ok(json.validation.points.every((p) => p.status === 'unverifiable' && p.error === null));
      console.log('✓ /api/fit 3 点：留出验证不可用（unverifiable，汇总为 null）');
    }

    // 4. 留出后近共线：对应点 unverifiable，接口与本地一致
    {
      const src = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, { x: 150, y: 400 }];
      const dst = src.map(apply);
      const { status, json } = await postFit({ src, dst });
      assert.strictEqual(status, 200);
      const local = Affine.fitAffine(src, dst);
      assert.deepStrictEqual(json.validation, local.validation);
      assert.strictEqual(json.validation.points[3].status, 'unverifiable');
      assert.strictEqual(json.validation.verifiableCount, 3);
      console.log('✓ /api/fit 留出后近共线：该点无法验证，汇总仅统计可验证点');
    }

    // 5. 错误场景不受影响：点数不足 422，非法输入 400
    {
      const few = await postFit({ src: SRC.slice(0, 2), dst: SRC.slice(0, 2) });
      assert.strictEqual(few.status, 422);
      assert.strictEqual(few.json.ok, false);
      const bad = await postFit({ src: 'x', dst: [] });
      assert.strictEqual(bad.status, 400);
      console.log('✓ /api/fit 错误场景状态码保持 422 / 400');
    }

    console.log('\nAPI 留出验证一致性测试全部通过 ✔');
  } finally {
    server.kill();
  }
})().catch((err) => {
  console.error('API 测试失败:', err);
  process.exit(1);
});
