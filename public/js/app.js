/* global Affine */
/*
 * 前端主逻辑：
 *  - 上传参考图 / 扫描图（FileReader 本地读取，不上传服务器）
 *  - 两图成对点击标注控制点（任意一图先点均可，自动配对）
 *  - 拖动微调、右键删除、列表删除；任何变化立即重算仿射拟合
 *  - 可切换「稳健模式」：按参考图像素容差以内点数量优先枚举三点候选，
 *    再对内点重新最小二乘拟合；外点在双图标记与残差表中区分显示，
 *    不计入 RMSE。容差调整、点位编辑/删除均同步重算。
 *  - 叠加预览与两种 JSON 导出共用同一最终矩阵，导出记录内/外点身份
 *  - 「导出校准扫描图」：用点击时的扫描图与最终拟合矩阵（两种模式均可），
 *    经 Affine.transformRGBA 逆仿射重采样（四邻双线性插值、预乘 alpha、
 *    越界透明黑），下载与参考图原始宽高一致、仅含变换后扫描图的 PNG；
 *    图像缺失 / 拟合无效 / 矩阵含非有限值 / 行列式 |det| ≤ 1e-12 时禁用并说明原因。
 *    像素处理全部在浏览器本地完成，图像不上传服务器。
 *  - 残差实时列表，内点最大残差橙色高亮、外点红色标识；近共线拒绝并提示
 *  - 逐点留出验证（复用 affine.js 的 leaveOneOutValidation，与 /api/fit 输出一致）：
 *    残差表「留出验证」列显示每个参与点的留出误差；参与点不足 4 个或留出后
 *    点集近共线显示「无法验证」，稳健模式外点显示「不参与」；状态栏与拟合面板
 *    汇总可验证点的 RMSE / 最大误差（零个可验证点时显示不可用），最差点橙色标出。
 *    点位增删/拖动、模式与容差变化均实时重算。
 *  - 「差异区域」视图：两图已加载且当前拟合矩阵通过导出校验（checkExportMatrix）
 *    时，复用校准扫描图的 RGBA 重采样结果（Affine.transformRGBA）与参考图逐像素
 *    比较；仅统计双方 alpha 均 ≥ 128 的像素，任一 RGB 通道差值超过可调色差阈值
 *    即标为差异，差异掩码做八邻域连通分组并过滤小于可调最小面积的区域，按面积
 *    排序展示边框、像素数与参考图坐标范围。阈值 / 最小面积 / 点位 / 拟合模式或
 *    容差变化后去抖重算；条件失效（缺图、拟合无效、矩阵不可导出、参数非法）时
 *    清空旧标记并说明原因。全部像素处理在浏览器本地完成，图像不上传服务器。
 *  - 差异区域「人工复核」：点击表格行或差异画布内的差异像素选中区域，标为
 *    「缺陷」或「可接受」并填写备注；表格与画布同步展示结论。色差阈值、最小
 *    面积或控制点引发重算时，以区域实际差异像素集合计算新旧区域交并比
 *    （Affine.matchRegionsByIoU），仅当 IoU ≥ 0.5 且双方互为唯一重叠区域时
 *    继承旧结论（区域分裂/合并/重叠不足不继承），其余新区域显示「未复核」，
 *    绝不按排序编号沿用。可导出含参考图坐标范围、像素数、结论与备注的复核
 *    JSON。更换任一图片（含载入示例）时清空全部复核记录。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  const state = {
    refImg: null,            // 参考图 HTMLImageElement
    scanImg: null,           // 扫描图 HTMLImageElement
    points: [],              // 已完成配对 {id, ref:{x,y}, scan:{x,y}}
    pending: { ref: null, scan: null }, // 进行中的半对点
    nextId: 1,
    fit: null,               // 拟合结果（含 matrix/residuals/inliers 等）
    fitError: null,          // 近共线等错误提示（中文）
    robust: false,           // 是否启用稳健模式
    tolerancePx: Affine.DEFAULT_TOLERANCE_PX, // 稳健模式参考图像素容差
    dragging: null,          // {id, which:'ref'|'scan'}
    opacity: 0.5,
    // 差异区域视图
    diffThreshold: Affine.DEFAULT_DIFF_THRESHOLD, // 色差阈值（任一 RGB 通道差值严格大于即差异）
    diffMinArea: Affine.DEFAULT_DIFF_MIN_AREA,     // 最小面积（小于该像素数的连通区域被过滤）
    diffTimer: null,         // 去抖句柄（拖动点位时合并重算）
    diffCache: null,         // {key, width, height, refData, calibratedData}
    diffResult: null,        // 最近一次 findDifferenceRegions 结果（条件失效时为 null）
    // 人工复核：当前结果各区域下标的复核记录（随每次重算按实际差异像素 IoU 重建）
    diffReviews: null,       // Map<newIndex, {verdict:'defect'|'accept', note, pixels, region, reviewedAt}>
    diffSelectedIndex: null  // 当前选中区域在 diffResult.regions 中的下标（null 未选中）
  };

  const HIT_RADIUS_CSS = 12;   // 命中半径（CSS 像素）
  const COLOR_INLIER = '#22c55e';   // 内点：绿
  const COLOR_OUTLIER = '#ef4444';  // 外点：红（虚线）
  const COLOR_MAX = '#f59e0b';      // 内点中最大残差：橙
  const COLOR_PENDING = '#eab308';
  const DIFF_DEBOUNCE_MS = 80;      // 差异重算去抖（拖动时合并）
  const COLOR_DIFF = '#ef4444';     // 差异像素：红
  const COLOR_DIFF_BOX = '#f59e0b'; // 未复核保留区域边框：橙
  const COLOR_REVIEW_DEFECT = '#ef4444';  // 复核「缺陷」区域边框：红
  const COLOR_REVIEW_ACCEPT = '#22c55e';  // 复核「可接受」区域边框：绿
  const COLOR_DIFF_SELECTED = '#38bdf8';  // 当前选中区域边框：青
  const DIFF_MASK_ALPHA = 0.55;     // 差异掩码叠加不透明度
  const DIFF_MAX_TABLE_ROWS = 200;  // 区域表最多列出的行数
  const VERDICT_DEFECT = 'defect';
  const VERDICT_ACCEPT = 'accept';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const refCanvas = $('refCanvas');
  const scanCanvas = $('scanCanvas');
  const overlayCanvas = $('overlayCanvas');
  const statusEl = $('status');
  const fitPanelEl = $('fitPanel');
  const ptTableBody = $('ptTable').querySelector('tbody');
  const ptCountEl = $('ptCount');
  const opacityInput = $('opacity');
  const opacityVal = $('opacityVal');
  const btnExportMatrix = $('btnExportMatrix');
  const btnExportResiduals = $('btnExportResiduals');
  const btnExportImage = $('btnExportImage');
  const exportImgHint = $('exportImgHint');
  const btnClear = $('btnClear');
  const robustModeInput = $('robustMode');
  const toleranceInput = $('tolerance');
  const tolLabel = $('tolLabel');
  const diffCanvas = $('diffCanvas');
  const diffStatsEl = $('diffStats');
  const diffHintEl = $('diffHint');
  const diffTableBody = $('diffTable').querySelector('tbody');
  const diffThresholdInput = $('diffThreshold');
  const diffMinAreaInput = $('diffMinArea');
  const btnExportReviews = $('btnExportReviews');
  const reviewPanel = $('reviewPanel');
  const reviewRegionIndexEl = $('reviewRegionIndex');
  const reviewRegionMetaEl = $('reviewRegionMeta');
  const reviewNoteInput = $('reviewNote');
  const btnReviewDefect = $('btnReviewDefect');
  const btnReviewAccept = $('btnReviewAccept');
  const btnReviewClear = $('btnReviewClear');

  // ---------- 图像加载 ----------
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('无法解析图像文件'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(input, which) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      if (which === 'ref') state.refImg = img; else state.scanImg = img;
      clearReviews(); // 更换任一图片：旧差异区域与复核结论全部失效
      clearPoints(); // 图像更换后旧坐标失效，清空控制点
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // ---------- 坐标换算 ----------
  function eventToCanvas(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height)
    };
  }

  // CSS 像素 → 画布像素的缩放系数（保证标记视觉大小一致）
  function canvasScale(canvas) {
    const r = canvas.getBoundingClientRect();
    return r.width > 0 ? canvas.width / r.width : 1;
  }

  // ---------- 拟合 ----------
  // 判断第 i 对控制点是否为内点（经典模式下所有点都是内点）
  function isInlier(i) {
    return !state.fit || !state.fit.inliers || state.fit.inliers[i];
  }

  function recompute() {
    state.fit = null;
    state.fitError = null;
    if (state.points.length >= Affine.MIN_POINTS) {
      try {
        const src = state.points.map((p) => p.scan); // 源：扫描图
        const dst = state.points.map((p) => p.ref);  // 目标：参考图
        state.fit = state.robust
          ? Affine.fitAffineRobust(src, dst, { tolerancePx: state.tolerancePx })
          : Affine.fitAffine(src, dst);
      } catch (err) {
        state.fitError = err.message || String(err);
      }
    }
    render();
    // 拟合矩阵可能变化（点位拖动/增删、模式、容差），差异结果跟随重算
    scheduleDiffUpdate();
  }

  // ---------- 控制点操作 ----------
  function clearPoints() {
    state.points = [];
    state.pending = { ref: null, scan: null };
    state.dragging = null;
    recompute();
  }

  function deletePoint(id) {
    state.points = state.points.filter((p) => p.id !== id);
    recompute();
  }

  function hitTest(canvas, which, pos) {
    const tol = HIT_RADIUS_CSS * canvasScale(canvas);
    // 后添加的点优先命中（视觉上在上层）
    for (let i = state.points.length - 1; i >= 0; i--) {
      const q = state.points[i][which];
      if (Math.hypot(q.x - pos.x, q.y - pos.y) <= tol) return state.points[i];
    }
    return null;
  }

  function placePoint(which, pos) {
    state.pending[which] = pos;
    if (state.pending.ref && state.pending.scan) {
      state.points.push({
        id: state.nextId++,
        ref: state.pending.ref,
        scan: state.pending.scan
      });
      state.pending = { ref: null, scan: null };
      recompute();
    } else {
      render();
    }
  }

  // ---------- 画布事件 ----------
  function bindCanvas(canvas, which) {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const img = which === 'ref' ? state.refImg : state.scanImg;
      if (!img) return;
      const pos = eventToCanvas(canvas, e);
      const hit = hitTest(canvas, which, pos);
      if (hit) {
        state.dragging = { id: hit.id, which };
        e.preventDefault();
      } else {
        placePoint(which, pos);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!state.dragging || state.dragging.which !== which) return;
      const pos = eventToCanvas(canvas, e);
      const pt = state.points.find((p) => p.id === state.dragging.id);
      if (!pt) return;
      pt[which] = {
        x: Math.min(Math.max(pos.x, 0), canvas.width),
        y: Math.min(Math.max(pos.y, 0), canvas.height)
      };
      recompute(); // 拖动中实时重算
    });

    window.addEventListener('mouseup', () => { state.dragging = null; });

    canvas.addEventListener('contextmenu', (e) => {
      const img = which === 'ref' ? state.refImg : state.scanImg;
      if (!img) return;
      const pos = eventToCanvas(canvas, e);
      const hit = hitTest(canvas, which, pos);
      if (hit) {
        e.preventDefault();
        deletePoint(hit.id);
      }
    });
  }

  // ---------- 绘制 ----------
  function drawPlaceholder(canvas, text) {
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#64748b';
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  function drawMarker(ctx, p, label, color, scale, opts) {
    opts = opts || {};
    const r = 9 * scale;
    ctx.save();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (opts.dashed) ctx.setLineDash([4 * scale, 3 * scale]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 内点最大残差：额外一圈橙色高亮环
    if (opts.ring) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 中心十字
    ctx.beginPath();
    ctx.moveTo(p.x - r * 0.55, p.y); ctx.lineTo(p.x + r * 0.55, p.y);
    ctx.moveTo(p.x, p.y - r * 0.55); ctx.lineTo(p.x, p.y + r * 0.55);
    ctx.stroke();
    // 序号标签
    ctx.font = `bold ${12 * scale}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, p.x + r + 2 * scale, p.y - 2 * scale);
    ctx.fillText(label, p.x + r + 2 * scale, p.y - 2 * scale);
    ctx.restore();
  }

  // 第 i 对点的标记样式：外点红色虚线；内点中最大残差橙色加环；其余绿色
  function markerStyle(i) {
    const f = state.fit;
    if (f && f.inliers && !f.inliers[i]) {
      return { color: COLOR_OUTLIER, dashed: true, ring: false };
    }
    if (f && i === f.maxIndex) {
      return { color: COLOR_MAX, dashed: false, ring: true };
    }
    return { color: COLOR_INLIER, dashed: false, ring: false };
  }

  function drawImageCanvas(canvas, img, which) {
    if (!img) {
      drawPlaceholder(canvas, which === 'ref' ? '请先上传参考图' : '请先上传扫描图');
      return;
    }
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const scale = canvasScale(canvas);

    state.points.forEach((pt, i) => {
      const s = markerStyle(i);
      drawMarker(ctx, pt[which], String(i + 1), s.color, scale, { dashed: s.dashed, ring: s.ring });
    });
    const pending = state.pending[which];
    if (pending) drawMarker(ctx, pending, '?', COLOR_PENDING, scale, { dashed: true });
  }

  function drawOverlay() {
    if (!state.refImg) {
      drawPlaceholder(overlayCanvas, '上传参考图后此处显示叠加预览');
      return;
    }
    const img = state.refImg;
    if (overlayCanvas.width !== img.naturalWidth || overlayCanvas.height !== img.naturalHeight) {
      overlayCanvas.width = img.naturalWidth;
      overlayCanvas.height = img.naturalHeight;
    }
    const ctx = overlayCanvas.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(img, 0, 0);

    if (state.scanImg && state.fit) {
      const m = state.fit.matrix;
      // canvas 变换矩阵 [a c e; b d f] ↔ u=a·x+b·y+c, v=d·x+e·y+f
      ctx.setTransform(m.a, m.d, m.b, m.e, m.c, m.f);
      ctx.globalAlpha = state.opacity;
      ctx.drawImage(state.scanImg, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    const scale = canvasScale(overlayCanvas);
    state.points.forEach((pt, i) => {
      const s = markerStyle(i);
      drawMarker(ctx, pt.ref, String(i + 1), s.color, scale, { dashed: s.dashed, ring: s.ring });
    });
  }

  // ---------- 面板渲染 ----------
  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (kind || 'info');
  }

  function fmt(v, digits) {
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }

  // 留出验证汇总文案：仅统计可验证点；零个可验证点时显示不可用
  function looSummary() {
    const v = state.fit && state.fit.validation;
    if (!v) return '';
    if (v.verifiableCount === 0) return '留出验证：不可用（无可验证点）';
    return `留出验证 RMSE = ${fmt(v.rmse, 3)} px（${v.verifiableCount} 点可验证）· ` +
      `最差 #${v.maxIndex + 1}（${fmt(v.maxError, 3)} px）`;
  }

  function renderStatus() {
    const n = state.points.length;
    if (!state.refImg || !state.scanImg) {
      setStatus('请上传参考图与扫描图（或点击“载入示例图像”），然后在两图上成对点击控制点。', 'info');
      return;
    }
    if (state.pending.ref || state.pending.scan) {
      const wait = state.pending.ref ? '扫描图' : '参考图';
      setStatus(`已记录半对点，请在${wait}上点击对应位置完成配对（Esc 取消）。`, 'info');
      return;
    }
    if (n < Affine.MIN_POINTS) {
      setStatus(`已有 ${n} 对控制点，至少还需 ${Affine.MIN_POINTS - n} 对才能拟合。`, 'info');
      return;
    }
    if (state.fitError) {
      // 找不到至少三对非共线内点时：保留点对，说明原因（导出按钮随后禁用）
      setStatus('无法拟合：' + state.fitError, 'error');
      return;
    }
    const f = state.fit;
    if (state.robust) {
      setStatus(
        `稳健拟合成功 · 内点 ${f.inlierCount} 对 / 外点 ${f.outlierCount} 对` +
        `（容差 ${fmt(f.tolerancePx, 2)} px，评估 ${f.candidatesEvaluated} 个三点候选）· ` +
        `内点 RMSE = ${fmt(f.rmse, 3)} px · 外点已在图与表中红色标出，不计入 RMSE`,
        'ok'
      );
    } else {
      setStatus(
        `拟合成功 · ${f.pointCount} 对点 · RMSE = ${fmt(f.rmse, 3)} px · ` +
        `最大残差点：#${f.maxIndex + 1}（${fmt(f.residuals[f.maxIndex], 3)} px，已橙色标出）`,
        'ok'
      );
    }
    const loo = looSummary();
    if (loo) statusEl.textContent += ' · ' + loo;
  }

  function renderFitPanel() {
    if (!state.fit) {
      fitPanelEl.innerHTML = state.fitError
        ? `<p class="err">${state.fitError}</p>`
        : '<p class="muted">满足条件后此处显示六参数矩阵。</p>';
      return;
    }
    const m = state.fit.matrix;
    const rows = ['a', 'b', 'c', 'd', 'e', 'f']
      .map((k) => `<div class="mrow"><span>${k}</span><code>${Number(m[k]).toPrecision(8)}</code></div>`)
      .join('');
    let extra;
    if (state.robust) {
      extra =
        `<p class="muted">稳健模式：像素容差 ${fmt(state.fit.tolerancePx, 2)} px · ` +
        `内点 ${state.fit.inlierCount} / 共 ${state.fit.pointCount} 对（外点 ${state.fit.outlierCount} 对不参与拟合与 RMSE）</p>`;
    } else {
      extra = '<p class="muted">经典最小二乘：全部控制点参与拟合</p>';
    }
    fitPanelEl.innerHTML =
      `<div class="matrix">${rows}</div>` +
      `<p class="muted">u = a·x + b·y + c<br>v = d·x + e·y + f（扫描图 → 参考图）</p>` +
      extra +
      `<p>${state.robust ? '内点 RMSE' : 'RMSE'}：<strong>${fmt(state.fit.rmse, 4)}</strong> px</p>` +
      looPanelHtml(state.fit.validation);
  }

  // 拟合面板中的逐点留出验证小结（与 /api/fit 的 validation 字段同源）
  function looPanelHtml(v) {
    if (!v) return '';
    if (v.verifiableCount === 0) {
      return '<p class="muted">逐点留出验证：<strong>不可用</strong>' +
        '（参与点不足 4 个或留出后近共线）</p>';
    }
    return `<p class="muted">逐点留出验证（移除该点后重拟合预测）：</p>` +
      `<p>验证 RMSE：<strong>${fmt(v.rmse, 4)}</strong> px · ` +
      `最大验证误差：<strong>${fmt(v.maxError, 4)}</strong> px（#${v.maxIndex + 1}）<br>` +
      `可验证点 ${v.verifiableCount} / 参与点 ${v.participantCount}` +
      (v.participantCount - v.verifiableCount > 0 ? '，其余为无法验证' : '') +
      (v.points.some((p) => p.status === 'excluded')
        ? `，外点 ${v.points.filter((p) => p.status === 'excluded').length} 个不参与`
        : '') +
      `</p>`;
  }

  // 残差表「留出验证」单元格：参与点显示留出重拟合后的预测误差；
  // 无法验证（参与点不足 4 个或留出后近共线）/ 外点不参与均显式标注，绝不拿残差充数
  function looCell(i) {
    const v = state.fit && state.fit.validation;
    if (!v || !v.points[i]) return '<td class="loo-na">—</td>';
    const p = v.points[i];
    if (p.status === 'excluded') return '<td class="loo-na">不参与</td>';
    if (p.status === 'unverifiable') return '<td class="loo-na">无法验证</td>';
    const maxCls = i === v.maxIndex ? ' class="loo-max"' : '';
    return `<td${maxCls}>${fmt(p.error, 3)}</td>`;
  }

  function renderTable() {
    ptCountEl.textContent = state.points.length ? `（${state.points.length} 对）` : '';
    ptTableBody.innerHTML = state.points.map((pt, i) => {
      const r = state.fit ? fmt(state.fit.residuals[i], 3) : '—';
      let cls = '';
      let verdict = '';
      if (state.fit && state.fit.inliers) {
        if (!state.fit.inliers[i]) {
          cls = ' class="out-row"';
          verdict = '<span class="badge out">外点</span>';
        } else {
          verdict = '<span class="badge in">内点</span>';
          if (i === state.fit.maxIndex) cls = ' class="max-row"';
        }
      } else if (state.fit && i === state.fit.maxIndex) {
        cls = ' class="max-row"';
      }
      return `<tr${cls}>
        <td>${i + 1}</td>
        <td>${fmt(pt.scan.x, 1)}, ${fmt(pt.scan.y, 1)}</td>
        <td>${fmt(pt.ref.x, 1)}, ${fmt(pt.ref.y, 1)}</td>
        <td>${r}</td>
        ${looCell(i)}
        <td>${verdict}</td>
        <td><button class="del" data-id="${pt.id}" title="删除该点">✕</button></td>
      </tr>`;
    }).join('');
  }

  // 导出校准扫描图的前置条件；不满足时给出中文原因（禁用提示 + 点击兜底）
  function exportImageReadiness() {
    if (!state.refImg || !state.scanImg) {
      return { ok: false, reason: '图像缺失，请先上传参考图与扫描图' };
    }
    if (state.fitError) {
      return { ok: false, reason: '拟合无效：' + state.fitError };
    }
    if (!state.fit) {
      return { ok: false, reason: `拟合无效：控制点不足 ${Affine.MIN_POINTS} 对` };
    }
    const chk = Affine.checkExportMatrix(state.fit.matrix);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    return { ok: true };
  }

  function renderButtons() {
    const hasFit = !!state.fit;
    btnExportMatrix.disabled = !hasFit;
    btnExportResiduals.disabled = !hasFit;
    btnClear.disabled = state.points.length === 0 && !state.pending.ref && !state.pending.scan;
    // 导出校准扫描图：随重算结果实时启用/禁用，禁用时说明原因
    const ready = exportImageReadiness();
    btnExportImage.disabled = !ready.ok;
    btnExportImage.title = ready.ok
      ? '下载与参考图同尺寸的 PNG：仅含按最终矩阵变换后的扫描图（逆仿射 + 双线性插值，本地处理）'
      : ready.reason;
    exportImgHint.textContent = ready.ok ? '' : '暂不可导出校准扫描图：' + ready.reason;
  }

  function render() {
    drawImageCanvas(refCanvas, state.refImg, 'ref');
    drawImageCanvas(scanCanvas, state.scanImg, 'scan');
    drawOverlay();
    renderStatus();
    renderFitPanel();
    renderTable();
    renderButtons();
  }

  // ---------- 导出 ----------
  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function exportMatrix() {
    if (!state.fit) return;
    const m = state.fit.matrix;
    const f = state.fit;
    downloadJSON('affine-matrix.json', {
      description: '仿射变换六参数：u = a·x + b·y + c，v = d·x + e·y + f（扫描图坐标 → 参考图坐标）',
      mode: state.robust ? 'robust' : 'leastSquares',
      matrix: m,
      matrixRowMajor: [[m.a, m.b, m.c], [m.d, m.e, m.f], [0, 0, 1]],
      rmse: f.rmse,
      rmseScope: state.robust ? 'inliers' : 'all',
      pointCount: f.pointCount,
      ...(state.robust ? {
        tolerancePx: f.tolerancePx,
        inlierCount: f.inlierCount,
        outlierCount: f.outlierCount
      } : {}),
      looValidation: looSummaryForExport(f.validation),
      exportedAt: new Date().toISOString()
    });
  }

  // 留出验证汇总（导出用）：零个可验证点时各统计量为 null
  function looSummaryForExport(v) {
    if (!v) return null;
    return {
      participantCount: v.participantCount,
      verifiableCount: v.verifiableCount,
      rmse: v.rmse,
      maxError: v.maxError,
      maxIndex: v.maxIndex >= 0 ? v.maxIndex + 1 : null // 1 起编号；不可用时为 null
    };
  }

  function exportResiduals() {
    if (!state.fit) return;
    const f = state.fit;
    const loo = f.validation;
    downloadJSON('residuals.json', {
      mode: state.robust ? 'robust' : 'leastSquares',
      rmse: f.rmse,
      rmseScope: state.robust ? 'inliers' : 'all',
      ...(state.robust ? { tolerancePx: f.tolerancePx } : {}),
      inlierCount: state.robust ? f.inlierCount : f.pointCount,
      outlierCount: state.robust ? f.outlierCount : 0,
      maxResidualIndex: f.maxIndex + 1,
      looValidation: looSummaryForExport(loo),
      points: state.points.map((pt, i) => ({
        id: i + 1,
        scan: pt.scan,
        ref: pt.ref,
        residualPx: f.residuals[i],
        isInlier: isInlier(i),
        isMaxResidual: i === f.maxIndex,
        // 逐点留出验证：'ok' 带误差；'unverifiable' 无法验证；'excluded' 外点不参与
        looStatus: loo ? loo.points[i].status : 'unverifiable',
        looErrorPx: loo ? loo.points[i].error : null
      })),
      exportedAt: new Date().toISOString()
    });
  }

  // 导出校准扫描图：与参考图原始宽高一致的 PNG，仅含按最终矩阵变换后的
  // 扫描图（无参考底图、无标记、无预览透明度）；像素处理全部在浏览器本地完成
  function exportCalibratedImage() {
    const ready = exportImageReadiness();
    if (!ready.ok) { // 按钮禁用时的兜底（如键盘触发）
      setStatus('无法导出校准扫描图：' + ready.reason, 'error');
      return;
    }
    try {
      // 点击时重新读取当前扫描图像素（本地 canvas，不上传服务器）
      const sw = state.scanImg.naturalWidth;
      const sh = state.scanImg.naturalHeight;
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = sw;
      srcCanvas.height = sh;
      const sctx = srcCanvas.getContext('2d');
      sctx.drawImage(state.scanImg, 0, 0);
      const srcData = sctx.getImageData(0, 0, sw, sh).data;

      // 输出尺寸 = 参考图原始宽高；逆仿射重采样（四邻双线性插值）
      const outW = state.refImg.naturalWidth;
      const outH = state.refImg.naturalHeight;
      const pixels = Affine.transformRGBA(srcData, sw, sh, state.fit.matrix, outW, outH);

      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      outCanvas.getContext('2d').putImageData(new ImageData(pixels, outW, outH), 0, 0);
      outCanvas.toBlob((blob) => {
        if (!blob) {
          setStatus('导出校准扫描图失败：浏览器未能生成 PNG。', 'error');
          return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'calibrated-scan.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        setStatus(
          `已导出校准扫描图 calibrated-scan.png（${outW}×${outH} PNG，` +
          `仅含按最终矩阵变换后的扫描图，模式：${state.robust ? '稳健' : '经典最小二乘'}）。`,
          'ok'
        );
      }, 'image/png');
    } catch (err) {
      setStatus('无法导出校准扫描图：' + (err.message || String(err)), 'error');
    }
  }

  // ---------- 差异区域视图 ----------
  // 差异视图的前置条件与「导出校准扫描图」一致：两图已加载、拟合有效且矩阵
  // 可导出（六参数有限且线性部分行列式 |det| > 1e-12）
  function diffReadiness() {
    return exportImageReadiness();
  }

  // 差异参数校验：色差阈值 0~255；最小面积为不小于 0 的整数
  function diffParams() {
    const t = parseFloat(diffThresholdInput.value);
    if (!Number.isFinite(t) || t < 0 || t > 255) {
      return { ok: false, reason: '色差阈值必须为 0~255 的数字（任一 RGB 通道差值严格大于该值才标为差异）' };
    }
    const a = parseFloat(diffMinAreaInput.value);
    if (!Number.isFinite(a) || a < 0 || !Number.isInteger(a)) {
      return { ok: false, reason: '最小面积必须为不小于 0 的整数（像素，0 表示不过滤）' };
    }
    return { ok: true, threshold: t, minArea: a };
  }

  // 拟合（矩阵）/ 图像可能变化时去抖重算，避免拖动点位时逐像素重采样卡顿
  function scheduleDiffUpdate() {
    if (state.diffTimer !== null) clearTimeout(state.diffTimer);
    state.diffTimer = setTimeout(runDiffUpdate, DIFF_DEBOUNCE_MS);
  }

  // 将图像绘制到本地离屏 canvas 读取 RGBA（不上传服务器）
  function readImageRGBA(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }

  // 缓存参考图像素与校准扫描图重采样结果：仅当两图或矩阵变化时才重新重采样；
  // 只调色差阈值 / 最小面积时复用同一结果
  function ensureDiffCache(w, h) {
    const m = state.fit.matrix;
    const key = [w, h, m.a, m.b, m.c, m.d, m.e, m.f].join('|');
    // 换图后即使尺寸与矩阵相同也必须重新读取像素（以图像对象为身份）
    if (state.diffCache && state.diffCache.key === key &&
        state.diffCache.refImg === state.refImg && state.diffCache.scanImg === state.scanImg) {
      return state.diffCache;
    }
    const refData = readImageRGBA(state.refImg);
    const sw = state.scanImg.naturalWidth, sh = state.scanImg.naturalHeight;
    const scanData = readImageRGBA(state.scanImg);
    // 复用导出校准扫描图的同一套逆仿射重采样（双线性插值、预乘 alpha、越界透明黑）
    const calibratedData = Affine.transformRGBA(scanData, sw, sh, m, w, h);
    state.diffCache = {
      key, width: w, height: h, refImg: state.refImg, scanImg: state.scanImg,
      refData, calibratedData
    };
    return state.diffCache;
  }

  // 条件失效 / 参数非法时清空旧标记并说明原因。
  // 注意：保留 state.diffReviews —— 条件恢复后的重算仍按实际差异像素 IoU 继承；
  // 复核记录只在「更换任一图片」时由 clearReviews() 显式清空。
  function clearDiff(reason) {
    if (state.diffTimer !== null) {
      clearTimeout(state.diffTimer);
      state.diffTimer = null;
    }
    state.diffResult = null;
    state.diffCache = null;
    state.diffSelectedIndex = null;
    diffStatsEl.textContent = '';
    diffTableBody.innerHTML = '';
    diffHintEl.textContent = reason ? '差异区域暂不可用：' + reason : '';
    btnExportReviews.disabled = true;
    drawDiffView();
    renderReviewPanel();
  }

  // 更换任一图片（含载入示例）时清空全部人工复核记录
  function clearReviews() {
    state.diffReviews = null;
    state.diffSelectedIndex = null;
  }

  // 重算后按区域「实际差异像素」交并比继承复核结论：
  // 仅 IoU ≥ 0.5 且双方互为唯一达标重叠区域时继承（matchRegionsByIoU），
  // 分裂/合并/重叠不足的新区域一律无结论（未复核），绝不按排序编号沿用。
  // oldReviews 中每条记录自带旧区域的实际差异像素，因此条件短暂失效
  //（参数非法等）期间结论仍保留，待下一次有效重算时再匹配或丢弃。
  function inheritReviews(oldReviews, newRegions) {
    const next = new Map();
    let nextSelected = null;
    if (oldReviews && oldReviews.size > 0) {
      // 旧匹配单元：已复核区域的实际差异像素与坐标（存于复核记录中）
      const oldUnits = [];
      const oldKeys = []; // 与 oldUnits 对齐的旧 Map 键（旧结果下标）
      oldReviews.forEach((rev, key) => {
        if (rev && Array.isArray(rev.pixels) && rev.region) {
          oldKeys.push(key);
          oldUnits.push({
            minX: rev.region.minX, minY: rev.region.minY,
            maxX: rev.region.maxX, maxY: rev.region.maxY,
            pixelCount: rev.region.pixelCount,
            pixels: rev.pixels
          });
        }
      });
      const matched = Affine.matchRegionsByIoU(oldUnits, newRegions, Affine.REVIEW_MIN_IOU);
      const pairByOldPos = new Map(matched.pairs.map((p) => [p.oldIndex, p]));
      oldUnits.forEach((unit, pos) => {
        const pair = pairByOldPos.get(pos);
        if (!pair) return; // 旧区域无唯一达标新区域：结论丢弃
        const n = pair.newIndex;
        const reg = newRegions[n];
        const rev = oldReviews.get(oldKeys[pos]);
        next.set(n, {
          verdict: rev.verdict,
          note: rev.note,
          reviewedAt: rev.reviewedAt,
          pixels: reg.pixels, // 像素集合更新为新区域实际差异像素
          region: regionSnapshot(reg)
        });
        if (state.diffSelectedIndex === oldKeys[pos]) nextSelected = n;
      });
    }
    return { reviews: next, selectedIndex: nextSelected };
  }

  // 可序列化的区域摘要（导出/记录用）
  function regionSnapshot(reg) {
    return {
      index: reg.index,
      pixelCount: reg.pixelCount,
      minX: reg.minX, minY: reg.minY, maxX: reg.maxX, maxY: reg.maxY,
      bounds: { x: reg.bounds.x, y: reg.bounds.y, width: reg.bounds.width, height: reg.bounds.height }
    };
  }

  function runDiffUpdate() {
    state.diffTimer = null;
    const ready = diffReadiness();
    if (!ready.ok) { // 缺图 / 拟合无效 / 矩阵不可导出：清空旧标记并说明原因
      clearDiff(ready.reason);
      return;
    }
    const params = diffParams();
    if (!params.ok) { // 参数非法：同样清空，避免展示与输入不符的旧结果
      clearDiff(params.reason);
      return;
    }
    try {
      const w = state.refImg.naturalWidth;
      const h = state.refImg.naturalHeight;
      const cache = ensureDiffCache(w, h);
      const built = Affine.buildDifferenceMask(
        cache.refData, cache.calibratedData, w, h, params.threshold
      );
      // 分组会就地清空掩码，先据此生成红色差异覆盖层（离屏 canvas）
      const overlay = makeMaskOverlay(built.mask, w, h);
      // collectPixels：保留每个区域的实际差异像素，供重算后 IoU 继承与画布命中
      const oldReviews = state.diffReviews;
      const grouped = Affine.groupDiffRegions(built.mask, w, h, params.minArea, { collectPixels: true });
      const inherited = inheritReviews(oldReviews, grouped.regions);
      state.diffReviews = inherited.reviews;
      state.diffSelectedIndex = inherited.selectedIndex;
      state.diffResult = {
        width: w,
        height: h,
        compared: built.compared,
        diffCount: built.diffCount,
        regions: grouped.regions,
        totalDiffPixels: grouped.totalDiffPixels,
        keptPixelCount: grouped.keptPixelCount,
        filteredCount: grouped.filteredCount,
        threshold: built.colorThreshold,
        minArea: grouped.minArea,
        overlay
      };
      diffHintEl.textContent = '';
      btnExportReviews.disabled = false;
      drawDiffView();
      renderDiffStats();
      renderDiffTable();
      renderReviewPanel();
    } catch (err) {
      clearDiff(err.message || String(err));
    }
  }

  // 差异掩码 → 红色不透明覆盖层（绘制到差异视图时再调透明度）
  function makeMaskOverlay(mask, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < mask.length; p++) {
      if (mask[p]) {
        const o = p * 4;
        px[o] = 239; px[o + 1] = 68; px[o + 2] = 68; px[o + 3] = 255;
      }
    }
    c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
    return c;
  }

  function drawDiffPlaceholder(text) {
    drawPlaceholder(diffCanvas, text);
  }

  // 区域边框颜色：未复核橙 · 缺陷红 · 可接受绿；当前选中区域再覆一圈青色粗框
  function regionBoxColor(reg, idx) {
    const rev = state.diffReviews && state.diffReviews.get(idx);
    if (!rev) return COLOR_DIFF_BOX;
    return rev.verdict === VERDICT_DEFECT ? COLOR_REVIEW_DEFECT : COLOR_REVIEW_ACCEPT;
  }

  function drawDiffView() {
    const r = state.diffResult;
    if (!r) {
      drawDiffPlaceholder('满足条件后此处显示差异区域');
      return;
    }
    if (diffCanvas.width !== r.width || diffCanvas.height !== r.height) {
      diffCanvas.width = r.width;
      diffCanvas.height = r.height;
    }
    const ctx = diffCanvas.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 底图：参考图；再半透明叠加红色差异掩码
    ctx.drawImage(state.refImg, 0, 0);
    ctx.globalAlpha = DIFF_MASK_ALPHA;
    ctx.drawImage(r.overlay, 0, 0);
    ctx.globalAlpha = 1;

    // 保留区域边框（颜色随复核结论），面积最大的若干区域标注序号（与表格一致）
    const scale = canvasScale(diffCanvas);
    const labelEvery = r.regions.length > 60 ? Math.ceil(r.regions.length / 24) : 1;
    r.regions.forEach((reg, idx) => {
      const b = reg.bounds;
      const selected = idx === state.diffSelectedIndex;
      ctx.lineWidth = (selected ? 4 : 2) * scale;
      ctx.strokeStyle = selected ? COLOR_DIFF_SELECTED : regionBoxColor(reg, idx);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      if (selected) {
        // 选中区域额外内框，突出可复核目标
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeRect(b.x + 3 * scale, b.y + 3 * scale,
          Math.max(b.width - 6 * scale, 1), Math.max(b.height - 6 * scale, 1));
      }
      if (reg.index <= 24 && (reg.index - 1) % labelEvery === 0) {
        ctx.font = `bold ${12 * scale}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(String(reg.index), b.x + 3 * scale, b.y - 2 * scale);
        ctx.fillStyle = selected ? COLOR_DIFF_SELECTED : regionBoxColor(reg, idx);
        ctx.fillText(String(reg.index), b.x + 3 * scale, b.y - 2 * scale);
      }
    });
  }

  // HTML 转义（备注为用户输入，渲染到 innerHTML 前必须转义）
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function reviewCounts() {
    const reviews = state.diffReviews;
    let defect = 0, accept = 0;
    if (reviews) {
      reviews.forEach((rev) => {
        if (rev.verdict === VERDICT_DEFECT) defect++;
        else if (rev.verdict === VERDICT_ACCEPT) accept++;
      });
    }
    return { defect, accept, total: defect + accept };
  }

  function renderDiffStats() {
    const r = state.diffResult;
    if (!r) { diffStatsEl.textContent = ''; return; }
    const pct = r.compared > 0 ? (r.diffCount / r.compared * 100) : 0;
    let base;
    if (r.diffCount === 0) {
      base = `参与比较 ${r.compared} 像素（双方 alpha ≥ ${Affine.DIFF_ALPHA_MIN}）· ` +
        `色差阈值 ${r.threshold}：未发现差异像素。`;
    } else {
      base = `参与比较 ${r.compared} 像素（双方 alpha ≥ ${Affine.DIFF_ALPHA_MIN}）· ` +
        `差异像素 ${r.diffCount}（${fmt(pct, 2)}%）· ` +
        `保留区域 ${r.regions.length} 个、共 ${r.keptPixelCount} 像素` +
        `（最小面积 ${r.minArea}，过滤散点 ${r.filteredCount} 像素）· 色差阈值 ${r.threshold}`;
    }
    // 人工复核进度：已复核 X / 区域总数（缺陷 D · 可接受 A）
    if (r.regions.length > 0) {
      const c = reviewCounts();
      base += ` · 已复核 ${c.total}/${r.regions.length}` +
        (c.total > 0 ? `（缺陷 ${c.defect} · 可接受 ${c.accept}）` : '');
    }
    diffStatsEl.textContent = base;
  }

  function verdictBadge(rev) {
    if (!rev) return '<span class="badge rev-none">未复核</span>';
    return rev.verdict === VERDICT_DEFECT
      ? '<span class="badge rev-defect">缺陷</span>'
      : '<span class="badge rev-accept">可接受</span>';
  }

  function renderDiffTable() {
    const r = state.diffResult;
    if (!r) { diffTableBody.innerHTML = ''; return; }
    if (r.regions.length === 0) {
      diffTableBody.innerHTML =
        `<tr><td colspan="6" class="diff-empty">未发现面积 ≥ ${r.minArea} 像素的差异区域` +
        `（差异像素共 ${r.diffCount}，均被最小面积过滤）。</td></tr>`;
      return;
    }
    const shown = r.regions.slice(0, DIFF_MAX_TABLE_ROWS);
    diffTableBody.innerHTML = shown.map((g, listIdx) => {
      const idx = listIdx; // slice(0, N) 时列表下标即结果下标
      const b = g.bounds;
      const rev = state.diffReviews && state.diffReviews.get(idx);
      const sel = idx === state.diffSelectedIndex ? ' selected' : '';
      return `<tr class="diff-row${sel}" data-index="${idx}">
        <td>${g.index}</td>
        <td>${g.pixelCount}</td>
        <td>(${b.x}, ${b.y}, ${b.width}×${b.height})</td>
        <td>x ${g.minX}–${g.maxX} · y ${g.minY}–${g.maxY}</td>
        <td>${verdictBadge(rev)}</td>
        <td class="cell-note" title="${escapeHtml(rev ? rev.note : '')}">${escapeHtml(rev ? rev.note : '')}</td>
      </tr>`;
    }).join('') + (r.regions.length > DIFF_MAX_TABLE_ROWS
      ? `<tr><td colspan="6" class="diff-empty">其余 ${r.regions.length - DIFF_MAX_TABLE_ROWS} 个区域已省略（按面积排序，可在画布中点击复核）</td></tr>`
      : '');
  }

  // ---------- 差异区域人工复核 ----------
  function selectedRegion() {
    if (!state.diffResult || state.diffSelectedIndex === null) return null;
    return state.diffResult.regions[state.diffSelectedIndex] || null;
  }

  function selectedReview() {
    if (!state.diffReviews || state.diffSelectedIndex === null) return null;
    return state.diffReviews.get(state.diffSelectedIndex) || null;
  }

  // 选中区域：点击表格行或画布内差异像素后调用（idx 为 diffResult.regions 下标）；
  // 传 null 取消选中（点击画布空白处）
  function selectRegion(idx) {
    state.diffSelectedIndex = idx;
    drawDiffView();
    renderDiffTable();
    renderReviewPanel();
  }

  // 画布点击：找到包含该差异像素的区域（八邻域分组 → 该像素所属保留区域）；
  // 点在红底差异像素外（或落在被最小面积过滤的散点上）则取消选中
  function hitTestDiffRegion(pos) {
    const r = state.diffResult;
    if (!r) return null;
    const x = Math.floor(pos.x), y = Math.floor(pos.y);
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
    const p = y * r.width + x;
    for (let i = 0; i < r.regions.length; i++) {
      const reg = r.regions[i];
      if (x < reg.minX || x > reg.maxX || y < reg.minY || y > reg.maxY) continue;
      // pixels 已按线性索引升序：二分判定该像素是否属于此区域
      const arr = reg.pixels;
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] === p) return i;
        if (arr[mid] < p) lo = mid + 1; else hi = mid - 1;
      }
    }
    return null;
  }

  function ensureReviewMap() {
    if (!state.diffReviews) state.diffReviews = new Map();
    return state.diffReviews;
  }

  // 为当前选中区域记录复核结论（verdict 为 null 表示清除复核）
  function applyVerdict(verdict) {
    const reg = selectedRegion();
    if (!reg) return;
    const reviews = ensureReviewMap();
    if (verdict === null) {
      reviews.delete(state.diffSelectedIndex);
    } else {
      const prev = reviews.get(state.diffSelectedIndex);
      reviews.set(state.diffSelectedIndex, {
        verdict,
        note: prev ? prev.note : '',
        // 继承来的结论保留首次复核时间；本次新判定取当前时间
        reviewedAt: prev ? prev.reviewedAt : new Date().toISOString(),
        pixels: reg.pixels,
        region: regionSnapshot(reg)
      });
    }
    drawDiffView();
    renderDiffTable();
    renderDiffStats();
    renderReviewPanel();
  }

  // 更新当前选中区域备注（未复核时输入框禁用，不会进入）。
  // 整体重绘表格以同步备注列，并在文本框仍聚焦时还原光标位置，避免输入跳动失焦。
  function updateReviewNote(note) {
    const reg = selectedRegion();
    if (!reg || !state.diffReviews) return;
    const rev = state.diffReviews.get(state.diffSelectedIndex);
    if (!rev) return;
    rev.note = note;
    const ta = reviewNoteInput;
    const hadFocus = document.activeElement === ta;
    const caret = ta.selectionStart;
    renderDiffTable();
    if (hadFocus) {
      ta.focus();
      try { ta.setSelectionRange(caret, caret); } catch (err) { /* 部分桩无此方法 */ }
    }
  }

  function renderReviewPanel() {
    const reg = selectedRegion();
    if (!reg) {
      reviewPanel.hidden = true;
      return;
    }
    reviewPanel.hidden = false;
    const rev = selectedReview();
    reviewRegionIndexEl.textContent = '#' + reg.index;
    reviewRegionMetaEl.textContent =
      `${reg.pixelCount} 像素 · x ${reg.minX}–${reg.maxX} · y ${reg.minY}–${reg.maxY}` +
      ` · 边框 (${reg.bounds.x}, ${reg.bounds.y}, ${reg.bounds.width}×${reg.bounds.height})`;
    btnReviewDefect.classList.toggle('active-defect', !!(rev && rev.verdict === VERDICT_DEFECT));
    btnReviewAccept.classList.toggle('active-accept', !!(rev && rev.verdict === VERDICT_ACCEPT));
    reviewNoteInput.disabled = !rev;
    // 仅当框内文本与记录不一致时回写，避免输入过程中光标跳动
    if (rev && reviewNoteInput.value !== rev.note) reviewNoteInput.value = rev.note;
    if (!rev && reviewNoteInput.value !== '') reviewNoteInput.value = '';
    reviewNoteInput.placeholder = rev
      ? '填写备注（可留空）'
      : '先选择「缺陷」或「可接受」，再填写备注（可留空）';
  }

  // 导出复核 JSON：全部保留区域（未复核 verdict=null），含参考图坐标范围、
  // 像素数、结论与备注；另附检测参数与汇总计数
  function exportReviews() {
    const r = state.diffResult;
    if (!r) return;
    const counts = reviewCounts();
    const regions = r.regions.map((reg, idx) => {
      const rev = state.diffReviews && state.diffReviews.get(idx);
      return {
        index: reg.index,
        pixelCount: reg.pixelCount,
        bounds: { x: reg.bounds.x, y: reg.bounds.y, width: reg.bounds.width, height: reg.bounds.height },
        // 参考图坐标范围（闭区间，像素坐标）
        refCoordinateRange: { minX: reg.minX, minY: reg.minY, maxX: reg.maxX, maxY: reg.maxY },
        // 复核结论：'defect' 缺陷 / 'acceptable' 可接受 / null 未复核
        verdict: rev ? (rev.verdict === VERDICT_DEFECT ? 'defect' : 'acceptable') : null,
        note: rev ? rev.note : '',
        reviewedAt: rev ? rev.reviewedAt : null
      };
    });
    downloadJSON('diff-reviews.json', {
      description: '差异区域人工复核结果：坐标均为参考图像素坐标（范围为闭区间）',
      colorThreshold: r.threshold,
      minArea: r.minArea,
      width: r.width,
      height: r.height,
      comparedPixels: r.compared,
      diffPixels: r.diffCount,
      keptRegionCount: r.regions.length,
      keptPixelCount: r.keptPixelCount,
      filteredPixels: r.filteredCount,
      review: {
        reviewedCount: counts.total,
        defectCount: counts.defect,
        acceptableCount: counts.accept,
        unreviewedCount: r.regions.length - counts.total,
        // 继承规则：重算后仅当新旧区域实际差异像素 IoU ≥ 0.5 且互为唯一重叠区域时继承结论
        inheritMinIoU: Affine.REVIEW_MIN_IOU
      },
      regions,
      exportedAt: new Date().toISOString()
    });
  }

  // ---------- 示例图像 ----------
  function drawSampleContent(g, w, h) {
    g.fillStyle = '#f8fafc';
    g.fillRect(0, 0, w, h);
    // 网格
    g.strokeStyle = '#cbd5e1';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // 套色十字（便于点击的标记）
    const crosses = [[90, 90], [w - 90, 110], [120, h - 100], [w - 130, h - 90], [w / 2, h / 2 - 40], [w / 2 + 160, 90]];
    crosses.forEach(([cx, cy], i) => {
      g.strokeStyle = ['#dc2626', '#2563eb', '#059669', '#7c3aed', '#ea580c', '#0891b2'][i % 6];
      g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, 14, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.moveTo(cx - 22, cy); g.lineTo(cx + 22, cy);
      g.moveTo(cx, cy - 22); g.lineTo(cx, cy + 22);
      g.stroke();
    });
    g.fillStyle = '#334155';
    g.font = 'bold 28px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('REGISTRATION SAMPLE · 套色校准示例', 30, h - 30);
  }

  function loadSampleImages() {
    const w = 960, h = 640;
    const c1 = document.createElement('canvas');
    c1.width = w; c1.height = h;
    drawSampleContent(c1.getContext('2d'), w, h);

    // 模拟扫描偏移：旋转 + 缩放 + 平移
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g2 = c2.getContext('2d');
    g2.fillStyle = '#ffffff';
    g2.fillRect(0, 0, w, h);
    g2.setTransform(0.9962, 0.0119, -0.0105, 0.9974, 17.5, -11.2);
    g2.drawImage(c1, 0, 0);

    const refImg = new Image();
    const scanImg = new Image();
    let loaded = 0;
    const done = () => {
      loaded += 1;
      if (loaded < 2) return;
      state.refImg = refImg;
      state.scanImg = scanImg;
      clearReviews(); // 载入示例同样视为更换图片，清空全部复核记录
      clearPoints();
    };
    refImg.onload = done;
    scanImg.onload = done;
    refImg.src = c1.toDataURL('image/png');
    scanImg.src = c2.toDataURL('image/png');
  }

  // ---------- 事件绑定 ----------
  function init() {
    $('refFile').addEventListener('change', (e) => handleFile(e.target, 'ref'));
    $('scanFile').addEventListener('change', (e) => handleFile(e.target, 'scan'));
    $('btnSample').addEventListener('click', loadSampleImages);
    btnClear.addEventListener('click', clearPoints);
    btnExportMatrix.addEventListener('click', exportMatrix);
    btnExportResiduals.addEventListener('click', exportResiduals);
    btnExportImage.addEventListener('click', exportCalibratedImage);

    opacityInput.addEventListener('input', () => {
      state.opacity = parseFloat(opacityInput.value);
      opacityVal.textContent = Math.round(state.opacity * 100) + '%';
      drawOverlay();
    });

    // 稳健模式开关：切换后立即重算，并同步容差输入的可用状态
    robustModeInput.addEventListener('change', () => {
      state.robust = !!robustModeInput.checked;
      toleranceInput.disabled = !state.robust;
      recompute();
    });

    // 像素容差：编辑（input）即时同步重算；非法值给出提示并禁用导出
    toleranceInput.addEventListener('input', () => {
      const v = parseFloat(toleranceInput.value);
      if (!Number.isFinite(v) || v < 0) {
        state.tolerancePx = NaN;
        state.fit = null;
        state.fitError = '像素容差必须为不小于 0 的数字（参考图像素）。';
        render();
        // 拟合矩阵失效：差异条件同步失效，清空旧标记并说明原因
        scheduleDiffUpdate();
        return;
      }
      state.tolerancePx = v;
      recompute();
    });

    // 差异区域参数：阈值 / 最小面积变化后去抖重算（重采样结果缓存，仅重算掩码）
    diffThresholdInput.addEventListener('input', () => {
      state.diffThreshold = parseFloat(diffThresholdInput.value);
      scheduleDiffUpdate();
    });
    diffMinAreaInput.addEventListener('input', () => {
      state.diffMinArea = parseFloat(diffMinAreaInput.value);
      scheduleDiffUpdate();
    });

    ptTableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button.del');
      if (btn) deletePoint(Number(btn.dataset.id));
    });

    // 差异区域人工复核：表格行点击选中（按 data-index，绝不依赖排序编号做结论继承）
    diffTableBody.addEventListener('click', (e) => {
      const row = e.target.closest('tr.diff-row');
      if (!row || !state.diffResult) return;
      const idx = Number(row.dataset.index);
      if (Number.isInteger(idx) && idx >= 0 && idx < state.diffResult.regions.length) {
        selectRegion(state.diffSelectedIndex === idx ? null : idx);
      }
    });

    // 画布点击差异像素 → 选中所属区域；点击空白 → 取消选中
    diffCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.diffResult) return;
      const pos = eventToCanvas(diffCanvas, e);
      selectRegion(hitTestDiffRegion(pos));
    });

    btnReviewDefect.addEventListener('click', () => applyVerdict(VERDICT_DEFECT));
    btnReviewAccept.addEventListener('click', () => applyVerdict(VERDICT_ACCEPT));
    btnReviewClear.addEventListener('click', () => applyVerdict(null));
    reviewNoteInput.addEventListener('input', () => updateReviewNote(reviewNoteInput.value));
    btnExportReviews.addEventListener('click', exportReviews);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (state.pending.ref || state.pending.scan)) {
        state.pending = { ref: null, scan: null };
        render();
      }
    });

    bindCanvas(refCanvas, 'ref');
    bindCanvas(scanCanvas, 'scan');
    render();
    // 差异视图初始为不可用状态（缺图），说明原因；之后由去抖更新驱动
    clearDiff(diffReadiness().reason);
  }

  init();
})();
