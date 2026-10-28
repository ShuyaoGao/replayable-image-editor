/* =====================================================================
 * 操作日志 → token 序列；量化 / 反量化；PSNR；画布指纹
 * （纯函数，不依赖 DOM，浏览器和 Node 测试共用）
 *
 * 量化档位只作用于“坐标”和“颜色”两类参数（这是 token 化时最占词表的部分）：
 *   坐标：按文档宽 / 高归一化到 [0,1]，切成 bins 档，取档中心还原；
 *   颜色：每个通道切成 levels 档，取档中心还原。
 * 其他参数（图层号、笔刷大小、不透明度、滤镜数值……）原样保留。
 * ===================================================================== */
(function (root) {
  "use strict";

  const PRESETS = [
    { key: "raw",    name: "原始",   bins: 0,    levels: 256, desc: "不量化：坐标和颜色原样进 token，回放与原图逐像素一致" },
    { key: "fine",   name: "细 1024", bins: 1024, levels: 256, desc: "坐标切成 1024 档（仿 Pix2Seq），颜色不量化" },
    { key: "medium", name: "中 256",  bins: 256,  levels: 16,  desc: "坐标 256 档，颜色每通道 16 档（12 bit）" },
    { key: "coarse", name: "粗 64",   bins: 64,   levels: 4,   desc: "坐标 64 档，颜色每通道 4 档（6 bit）：词表最小，误差最大" },
  ];
  const presetByKey = k => PRESETS.find(p => p.key === k) || PRESETS[0];

  /* ---------- 坐标 / 颜色的量化 ---------- */
  function qCoord(v, size, bins) {               // 返回档号
    const b = Math.floor((v / size) * bins);
    return Math.max(0, Math.min(bins - 1, b));
  }
  const dqCoord = (b, size, bins) => Math.round(((b + 0.5) / bins) * size);

  function qColor(hex, levels) {                 // 返回 [r,g,b] 的档号
    const n = parseInt(String(hex).slice(1, 7), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return ch.map(c => Math.min(levels - 1, Math.floor(c * levels / 256)));
  }
  function dqColor(q, levels) {
    const c = q.map(b => levels >= 256 ? b : Math.min(255, Math.round((b + 0.5) * 256 / levels - 0.5)));
    return "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
  }
  const isHex = s => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);

  /* 每种操作里哪些字段是坐标（x 方向 / y 方向 / 位移）、哪些是颜色 */
  const FIELDS = {
    fill:           { x: ["x"], y: ["y"], color: ["color"] },
    gradient:       { x: ["x0", "x1"], y: ["y0", "y1"], color: ["c0", "c1"] },
    shape:          { x: ["x0", "x1"], y: ["y0", "y1"], color: ["fill", "stroke"] },
    text_add:       { x: ["x"], y: ["y"], color: ["color"] },
    select_rect:    { x: ["x", "w"], y: ["y", "h"] },
    select_ellipse: { x: ["x", "w"], y: ["y", "h"] },
    crop:           { x: ["x", "w"], y: ["y", "h"] },
    layer_move:     { dx: ["dx"], dy: ["dy"] },
    brush_stroke:   { points: true, color: ["color"] },
    eraser_stroke:  { points: true },
  };

  /* 把一条操作按档位量化再还原（返回新对象，不改原对象）；doc = {W,H} 为执行到这一条时的文档尺寸 */
  function quantizeOp(op, preset, doc) {
    const p = typeof preset === "string" ? presetByKey(preset) : preset;
    const f = FIELDS[op.op];
    const params = JSON.parse(JSON.stringify(op.params || {}));
    if (!f || (!p.bins && p.levels >= 256)) return { op: op.op, params };
    const W = doc.W, H = doc.H;
    if (p.bins) {
      for (const k of f.x || []) if (typeof params[k] === "number") params[k] = dqCoord(qCoord(params[k], W, p.bins), W, p.bins);
      for (const k of f.y || []) if (typeof params[k] === "number") params[k] = dqCoord(qCoord(params[k], H, p.bins), H, p.bins);
      for (const k of f.dx || []) if (typeof params[k] === "number")
        params[k] = dqCoord(qCoord(params[k] + W, 2 * W, p.bins), 2 * W, p.bins) - W;
      for (const k of f.dy || []) if (typeof params[k] === "number")
        params[k] = dqCoord(qCoord(params[k] + H, 2 * H, p.bins), 2 * H, p.bins) - H;
      if (f.points && Array.isArray(params.points))
        params.points = params.points.map(([x, y]) => [dqCoord(qCoord(x, W, p.bins), W, p.bins),
                                                        dqCoord(qCoord(y, H, p.bins), H, p.bins)]);
    }
    if (p.levels < 256)
      for (const k of f.color || []) if (isHex(params[k])) params[k] = dqColor(qColor(params[k], p.levels), p.levels);
    return { op: op.op, params };
  }

  /* 按顺序量化整条日志：跟踪 doc_new / crop 带来的文档尺寸变化。
     （打开图片会改变尺寸但日志里不记尺寸，所以编辑器回放时改为“执行到哪条就按当时的 Doc 尺寸量化”。） */
  function quantizeLog(ops, preset, startDoc) {
    let doc = { W: startDoc ? startDoc.W : 960, H: startDoc ? startDoc.H : 640 };
    return ops.map(o => {
      if (o.op === "doc_new") doc = { W: o.params.width, H: o.params.height };
      const q = quantizeOp(o, preset, doc);
      if (o.op === "crop") doc = { W: o.params.w, H: o.params.h };
      return q;
    });
  }

  /* ---------- token 化（给人看的预览，不是训练代码） ---------- */
  function tokenize(op, preset, doc) {
    const p = typeof preset === "string" ? presetByKey(preset) : preset;
    const f = FIELDS[op.op] || {};
    const prm = op.params || {};
    const out = [`<${op.op}>`];
    const coordTok = (axis, v, size) => p.bins ? `${axis}:${qCoord(v, size, p.bins)}` : `${axis}=${v}`;
    const colorTok = hex => {
      if (!isHex(hex)) return `color=${hex}`;
      if (p.levels >= 256) return `rgb:${hex.slice(1).toLowerCase()}`;
      return `rgb:${qColor(hex, p.levels).join(".")}`;
    };
    for (const [k, v] of Object.entries(prm)) {
      if (k === "points" && Array.isArray(v)) {
        out.push(`pts#${v.length}`);
        for (const [x, y] of v.slice(0, 6)) { out.push(coordTok("x", x, doc.W)); out.push(coordTok("y", y, doc.H)); }
        if (v.length > 6) out.push(`…+${(v.length - 6) * 2}`);
      } else if ((f.x || []).includes(k)) out.push(coordTok(k, v, doc.W));
      else if ((f.y || []).includes(k)) out.push(coordTok(k, v, doc.H));
      else if ((f.color || []).includes(k)) out.push(`${k}→` + colorTok(v));
      else if (k === "dataURL") out.push(`<图片 ${Math.round(String(v).length / 1024)} KB，交给图像编码器>`);
      else out.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
    out.push("<eos>");
    return out;
  }

  /* ---------- 画质：PSNR（RGB 三通道，dB）---------- */
  function psnr(a, b) {
    if (a.length !== b.length) return { psnr: null, mse: null, maxDiff: null, sizeMismatch: true };
    let se = 0, n = 0, maxDiff = 0, changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      let px = 0;
      for (let c = 0; c < 3; c++) {
        const d = a[i + c] - b[i + c];
        se += d * d; n++;
        if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d);
        if (d) px = 1;
      }
      changed += px;
    }
    const mse = se / n;
    return { psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse), mse, maxDiff,
             changedPixels: changed, totalPixels: a.length / 4 };
  }

  /* ---------- 画布指纹：FNV-1a 32 位，8 位十六进制 ---------- */
  function fingerprint(data) {
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      h ^= data[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  root.OpTokens = { PRESETS, presetByKey, quantizeOp, quantizeLog, tokenize, psnr, fingerprint,
                    qCoord, dqCoord, qColor, dqColor, FIELDS };
})(typeof window !== "undefined" ? window : globalThis);
