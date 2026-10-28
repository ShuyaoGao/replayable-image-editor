/* =====================================================================
 * 可回放图像编辑器 —— 引擎（由本项目早期内部版本改写：逐像素滤镜、名称集中到 config.js、
 *                          回放速度 / 量化回放 / 事件钩子 / 退出时释放资源）
 *
 * 核心设计："状态 = 初始文档 + 操作序列的确定性回放"
 *   - 一切修改都通过 Ops.run(op) 进入：执行 + 记录 + 历史快照
 *   - 回放时同一执行器逐条重放 → 像素级还原（Transformer 训练数据的前提）
 *   - 操作日志为 JSONL，每行一个 {seq, t, op, params}
 * ===================================================================== */
"use strict";

const CFG = window.APP_CONFIG;
const EditorAbort = new AbortController();
const SIG = { signal: EditorAbort.signal };
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = err ? "show err" : "show";
  clearTimeout(toast._h);
  toast._h = setTimeout(() => (t.className = ""), 2200);
}

/* =====================================================================
 * 文档与图层
 * ===================================================================== */
const Doc = {
  W: 960, H: 640,
  layers: [],        // 底 → 顶
  activeId: null,
  nextId: 1,
  selection: null,   // {kind:'rect'|'ellipse', x,y,w,h} 文档坐标
};
const CanvasReg = new Map();   // id -> {canvas, ctx}（撤销栈存活期间保留）

function regCanvas(id, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  CanvasReg.set(id, { canvas, ctx });
  return CanvasReg.get(id);
}

function makeLayer(name, fill) {
  const id = Doc.nextId++;
  const { canvas, ctx } = regCanvas(id, Doc.W, Doc.H);
  if (fill && fill !== "transparent") {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, Doc.W, Doc.H);
  }
  const layer = { id, name: name || `图层 ${id}`, canvas, ctx,
                  visible: true, opacity: 1, blend: "source-over", ox: 0, oy: 0 };
  return layer;
}
const getLayer = id => Doc.layers.find(l => l.id === id);
const layerIndex = id => Doc.layers.findIndex(l => l.id === id);
const activeLayer = () => getLayer(Doc.activeId);

/* =====================================================================
 * 视图（缩放/平移）与渲染
 * ===================================================================== */
const View = { z: 1, x: 60, y: 40 };
const stage = $("stage"), sctx = stage.getContext("2d");
const overlay = $("overlay"), octx = overlay.getContext("2d");
const viewport = $("viewport");

const checker = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const x = c.getContext("2d");
  x.fillStyle = "#b9b9b9"; x.fillRect(0, 0, 16, 16);
  x.fillStyle = "#969696"; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return c;
})();

function resizeStage() {
  stage.width = overlay.width = viewport.clientWidth;
  stage.height = overlay.height = viewport.clientHeight;
}
window.addEventListener("resize", () => { resizeStage(); render(); }, SIG);

function render() {
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.fillStyle = "#161616";
  sctx.fillRect(0, 0, stage.width, stage.height);
  sctx.setTransform(View.z, 0, 0, View.z, View.x, View.y);
  sctx.imageSmoothingEnabled = View.z < 1;
  // 棋盘格（透明底）
  sctx.save();
  sctx.beginPath(); sctx.rect(0, 0, Doc.W, Doc.H); sctx.clip();
  sctx.fillStyle = sctx.createPattern(checker, "repeat");
  sctx.fillRect(0, 0, Doc.W, Doc.H);
  for (const l of Doc.layers) {
    if (!l.visible) continue;
    sctx.globalAlpha = l.opacity;
    sctx.globalCompositeOperation = l.blend;
    sctx.drawImage(l.canvas, l.ox, l.oy);
  }
  sctx.restore();
  sctx.globalAlpha = 1; sctx.globalCompositeOperation = "source-over";
  sctx.strokeStyle = "#000"; sctx.lineWidth = 1 / View.z;
  sctx.strokeRect(-0.5 / View.z, -0.5 / View.z, Doc.W + 1 / View.z, Doc.H + 1 / View.z);
  $("doc-info").textContent = `${Doc.W} × ${Doc.H}  ·  ${(View.z * 100).toFixed(0)}%`;
}

/* 选区蚂蚁线 + 工具预览 */
function drawOverlay(time) {
  if (Editor.stopped) return;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.setTransform(View.z, 0, 0, View.z, View.x, View.y);
  const sel = Doc.selection;
  const ants = (path) => {
    octx.save();
    octx.lineWidth = 1.2 / View.z;
    octx.setLineDash([5 / View.z, 4 / View.z]);
    octx.strokeStyle = "#000"; octx.lineDashOffset = -(time / 60) % 18; octx.stroke(path);
    octx.strokeStyle = "#fff"; octx.lineDashOffset = -(time / 60) % 18 + 4.5 / View.z; octx.stroke(path);
    octx.restore();
  };
  if (sel) ants(selPath(sel));
  if (UI.preview) ants(UI.preview);          // 拖拽中的选区/形状/裁剪框
  requestAnimationFrame(drawOverlay);
}
function selPath(sel) {
  const p = new Path2D();
  if (sel.kind === "ellipse")
    p.ellipse(sel.x + sel.w / 2, sel.y + sel.h / 2, Math.abs(sel.w / 2), Math.abs(sel.h / 2), 0, 0, Math.PI * 2);
  else p.rect(sel.x, sel.y, sel.w, sel.h);
  return p;
}
function clipSelection(ctx, layer) {
  if (!Doc.selection) return;
  const s = { ...Doc.selection, x: Doc.selection.x - layer.ox, y: Doc.selection.y - layer.oy };
  ctx.beginPath();
  if (s.kind === "ellipse")
    ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
  else ctx.rect(s.x, s.y, s.w, s.h);
  ctx.clip();
}

/* =====================================================================
 * 操作日志（训练数据）
 * ===================================================================== */
const OpLog = {
  ops: [], seq: 0, t0: Date.now(),
  add(op) {
    this.ops.push({ seq: this.seq++, t: Date.now() - this.t0, op: op.op, params: op.params });
    this.refresh();
  },
  refresh() {
    $("rec-count").textContent = this.ops.length;
    const list = $("oplist");
    if (!list) return;
    const esc = t => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    list.innerHTML = this.ops.slice(-150).map(o => {
      let p = JSON.stringify(o.params);
      if (p.length > 90) p = p.slice(0, 90) + "…";
      const nd = Ops.NONDESTRUCTIVE.has(o.op) ? " nd" : "";
      return `<div class="${nd}">#${o.seq} <span class="opname">${o.op}</span> ${esc(p)}</div>`;
    }).join("");
    list.scrollTop = 1e9;
    Editor.emit("log", this.ops);
  },
  exportJSONL() {
    if (!this.ops.length) return toast("日志为空", true);
    const text = this.ops.map(o => JSON.stringify(o)).join("\n");
    const blob = new Blob([text], { type: "application/jsonl" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${CFG.EXPORT_PREFIX}_ops_${Date.now()}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`已导出 ${this.ops.length} 条操作`);
    Editor.emit("exported", this.ops.length);
  },
  /* 重新开始一段日志：会话头 + 新建文档。日志永远从 doc_new 开始，保证“状态 = 回放(日志)” */
  async restart(width, height, bg) {
    this.ops = []; this.seq = 0; this.t0 = Date.now();
    const W = width || 960, H = height || 640, BG = bg || "#ffffff";
    this.add({ op: "session_start", params: { app: CFG.LOG_APP_ID, version: CFG.LOG_VERSION, width: W, height: H } });
    await Ops.apply({ op: "doc_new", params: { width: W, height: H, bg: BG } });
    this.add({ op: "doc_new", params: { width: W, height: H, bg: BG } });
    render(); UI.refreshLayers();
  },
  clear() {
    if (!confirm("清空日志并新建空白画布？\n（“状态 = 回放日志”，所以清空日志也就清空了画布）")) return;
    this.restart(Doc.W, Doc.H, "#ffffff");
  },
};

/* =====================================================================
 * 历史（撤销/重做）—— 快照式
 * ===================================================================== */
const History = {
  undoStack: [], redoStack: [], CAP: 25,
  capture(touchedIds, full = false) {
    const ids = full ? Doc.layers.map(l => l.id) : touchedIds.filter(id => getLayer(id));
    const bitmaps = {};
    for (const id of ids) {
      const l = getLayer(id);
      bitmaps[id] = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
    }
    return {
      W: Doc.W, H: Doc.H, activeId: Doc.activeId, nextId: Doc.nextId,
      selection: Doc.selection ? { ...Doc.selection } : null,
      meta: Doc.layers.map(l => ({ id: l.id, name: l.name, visible: l.visible,
                                   opacity: l.opacity, blend: l.blend, ox: l.ox, oy: l.oy })),
      bitmaps,
    };
  },
  restore(s) {
    Doc.W = s.W; Doc.H = s.H;
    Doc.layers = s.meta.map(m => {
      let reg = CanvasReg.get(m.id);
      if (!reg) reg = regCanvas(m.id, s.W, s.H);
      if (reg.canvas.width !== s.W || reg.canvas.height !== s.H) {
        const keep = s.bitmaps[m.id];
        reg.canvas.width = s.W; reg.canvas.height = s.H;
        if (!keep) { /* 尺寸变化但无快照（不应发生：裁剪走全量） */ }
      }
      return { ...m, canvas: reg.canvas, ctx: reg.ctx };
    });
    for (const [id, img] of Object.entries(s.bitmaps)) {
      const l = getLayer(+id);
      if (l) l.ctx.putImageData(img, 0, 0);
    }
    Doc.activeId = s.activeId; Doc.nextId = s.nextId;
    Doc.selection = s.selection ? { ...s.selection } : null;
    render(); UI.refreshLayers();
  },
  push(touchedIds, full = false) {
    this.undoStack.push(this.capture(touchedIds, full));
    if (this.undoStack.length > this.CAP) this.undoStack.shift();
    this.redoStack = [];
  },
  undo() {
    const s = this.undoStack.pop();
    if (!s) return toast("没有可撤销的操作", true);
    this.redoStack.push(this.capture([], true));
    this.restore(s);
  },
  redo() {
    const s = this.redoStack.pop();
    if (!s) return toast("没有可重做的操作", true);
    this.undoStack.push(this.capture([], true));
    this.restore(s);
  },
};

/* =====================================================================
 * 绘制原语（执行器与回放共用 —— 保证确定性）
 * ===================================================================== */
function drawStroke(layer, params, erase) {
  const { points, color, size, opacity } = params;
  const c = layer.ctx;
  c.save();
  clipSelection(c, layer);
  c.globalCompositeOperation = erase ? "destination-out" : "source-over";
  c.globalAlpha = opacity;
  c.strokeStyle = color || "#000";
  c.lineWidth = size; c.lineCap = "round"; c.lineJoin = "round";
  c.beginPath();
  const ox = layer.ox, oy = layer.oy;
  c.moveTo(points[0][0] - ox, points[0][1] - oy);
  if (points.length === 1) c.lineTo(points[0][0] - ox + 0.01, points[0][1] - oy);
  for (let i = 1; i < points.length; i++) c.lineTo(points[i][0] - ox, points[i][1] - oy);
  c.stroke();
  c.restore();
}

function drawShape(layer, p) {
  const c = layer.ctx;
  c.save();
  clipSelection(c, layer);
  const x0 = p.x0 - layer.ox, y0 = p.y0 - layer.oy, x1 = p.x1 - layer.ox, y1 = p.y1 - layer.oy;
  c.lineWidth = p.lineWidth; c.strokeStyle = p.stroke || "#000"; c.fillStyle = p.fill || "#000";
  c.beginPath();
  if (p.kind === "line") { c.moveTo(x0, y0); c.lineTo(x1, y1); }
  else if (p.kind === "ellipse")
    c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  else c.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (p.kind !== "line" && p.doFill) c.fill();
  if (p.doStroke || p.kind === "line") c.stroke();
  c.restore();
}

function hexToRgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function floodFill(layer, p) {
  const { canvas, ctx } = layer;
  const sx = Math.round(p.x - layer.ox), sy = Math.round(p.y - layer.oy);
  if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) return;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data, W = canvas.width, H = canvas.height;
  const idx = (x, y) => (y * W + x) * 4;
  const i0 = idx(sx, sy);
  const target = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  const repl = hexToRgba(p.color);
  const tol2 = p.tolerance * p.tolerance * 4;
  const dist2 = i => {
    const dr = d[i] - target[0], dg = d[i + 1] - target[1],
          db = d[i + 2] - target[2], da = d[i + 3] - target[3];
    return dr * dr + dg * dg + db * db + da * da;
  };
  if (dist2(i0) > 0 && target.join() === repl.join()) return;
  // 选区掩码
  let mask = null;
  if (Doc.selection) {
    const mc = document.createElement("canvas");
    mc.width = W; mc.height = H;
    const mx = mc.getContext("2d");
    mx.translate(-layer.ox, -layer.oy);
    mx.fillStyle = "#fff"; mx.fill(selPath(Doc.selection));
    mask = mx.getImageData(0, 0, W, H).data;
    if (!mask[i0 + 3]) return;     // 起点不在选区内
  }
  const visited = new Uint8Array(W * H);
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const pi = y * W + x;
    if (visited[pi]) continue;
    visited[pi] = 1;
    const i = pi * 4;
    if (mask && !mask[i + 3]) continue;
    if (dist2(i) > tol2) continue;
    d[i] = repl[0]; d[i + 1] = repl[1]; d[i + 2] = repl[2]; d[i + 3] = repl[3];
    if (x > 0) stack.push([x - 1, y]);
    if (x < W - 1) stack.push([x + 1, y]);
    if (y > 0) stack.push([x, y - 1]);
    if (y < H - 1) stack.push([x, y + 1]);
  }
  ctx.putImageData(img, 0, 0);
}

/* 逐像素滤镜（替代原来的 ctx.filter：Safari 等浏览器对 ctx.filter 支持不一，且无法展示公式） */
function applyPixelFilter(layer, type, value) {
  const W = layer.canvas.width, H = layer.canvas.height;
  const src = layer.ctx.getImageData(0, 0, W, H);
  const res = PixelFilters.apply(src, type, value);
  const out = layer.ctx.createImageData(W, H);
  out.data.set(res.data);
  if (!Doc.selection) { layer.ctx.putImageData(out, 0, 0); return; }
  const tmp = document.createElement("canvas");             // 只在选区内生效
  tmp.width = W; tmp.height = H;
  tmp.getContext("2d").putImageData(out, 0, 0);
  const c = layer.ctx;
  c.save();
  clipSelection(c, layer);
  c.clearRect(0, 0, W, H);
  c.drawImage(tmp, 0, 0);
  c.restore();
}

function loadImage(dataURL) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = dataURL;
  });
}

/* =====================================================================
 * 操作执行器 —— 唯一修改入口（UI 与回放共用）
 * ===================================================================== */
const Ops = {
  NONDESTRUCTIVE: new Set(["tool_select", "view_zoom", "view_pan", "eyedropper",
                           "layer_select", "session_start"]),

  async apply(o) {
    const p = o.params || {};
    switch (o.op) {
      /* ---------- 文档 ---------- */
      case "session_start": break;          // 会话头（app 标识可能是新名或旧版本的 "WebPS"）
      case "doc_new": {
        Doc.W = p.width; Doc.H = p.height;
        Doc.layers = []; Doc.nextId = 1; Doc.selection = null;
        CanvasReg.clear();
        const bg = makeLayer("背景", p.bg === "transparent" ? null : p.bg);
        Doc.layers.push(bg); Doc.activeId = bg.id;
        History.undoStack = []; History.redoStack = [];
        UI.zoomFit();
        break;
      }
      case "image_open": {
        const img = await loadImage(p.dataURL);
        if (p.asLayer) {
          History.push([], false);
          const l = makeLayer(`图片 ${Doc.nextId}`);
          const sc = Math.min(1, Doc.W / img.width, Doc.H / img.height);  // 等比缩放进文档
          l.ctx.drawImage(img, 0, 0, img.width * sc, img.height * sc);
          Doc.layers.push(l); Doc.activeId = l.id;
        } else {
          Doc.W = img.width; Doc.H = img.height;
          Doc.layers = []; Doc.nextId = 1; Doc.selection = null;
          CanvasReg.clear();
          const l = makeLayer("背景");
          l.ctx.drawImage(img, 0, 0);
          Doc.layers.push(l); Doc.activeId = l.id;
          History.undoStack = []; History.redoStack = [];
          UI.zoomFit();
        }
        break;
      }
      case "crop": {
        History.push([], true);
        const { x, y, w, h } = p;
        for (const l of Doc.layers) {
          const tmp = document.createElement("canvas");
          tmp.width = w; tmp.height = h;
          tmp.getContext("2d").drawImage(l.canvas, l.ox - x, l.oy - y);
          l.canvas.width = w; l.canvas.height = h;
          l.ctx.drawImage(tmp, 0, 0);
          l.ox = 0; l.oy = 0;
        }
        Doc.W = w; Doc.H = h; Doc.selection = null;
        UI.zoomFit();
        break;
      }
      /* ---------- 图层 ---------- */
      case "layer_add": {
        History.push([], false);
        const l = makeLayer(p.name);
        const i = layerIndex(Doc.activeId);
        Doc.layers.splice(i + 1, 0, l);
        Doc.activeId = l.id;
        break;
      }
      case "layer_delete": {
        if (Doc.layers.length <= 1) { toast("至少保留一个图层", true); return false; }
        History.push([p.layerId], false);
        const i = layerIndex(p.layerId);
        Doc.layers.splice(i, 1);
        Doc.activeId = Doc.layers[Math.max(0, i - 1)].id;
        break;
      }
      case "layer_duplicate": {
        History.push([], false);
        const src = getLayer(p.layerId); if (!src) return false;
        const l = makeLayer(src.name + " 副本");
        l.ctx.drawImage(src.canvas, 0, 0);
        l.visible = src.visible; l.opacity = src.opacity; l.blend = src.blend;
        l.ox = src.ox; l.oy = src.oy;
        Doc.layers.splice(layerIndex(p.layerId) + 1, 0, l);
        Doc.activeId = l.id;
        break;
      }
      case "layer_merge_down": {
        const i = layerIndex(p.layerId);
        if (i <= 0) { toast("已是最底层，无法向下合并", true); return false; }
        const top = Doc.layers[i], bot = Doc.layers[i - 1];
        History.push([top.id, bot.id], false);
        bot.ctx.save();
        bot.ctx.globalAlpha = top.opacity;
        bot.ctx.globalCompositeOperation = top.blend;
        bot.ctx.drawImage(top.canvas, top.ox - bot.ox, top.oy - bot.oy);
        bot.ctx.restore();
        Doc.layers.splice(i, 1);
        Doc.activeId = bot.id;
        break;
      }
      case "layer_reorder": {
        const i = layerIndex(p.layerId), j = i + p.dir;
        if (j < 0 || j >= Doc.layers.length) return false;
        History.push([], false);
        [Doc.layers[i], Doc.layers[j]] = [Doc.layers[j], Doc.layers[i]];
        break;
      }
      case "layer_visible": { History.push([], false); getLayer(p.layerId).visible = p.visible; break; }
      case "layer_opacity": { History.push([], false); getLayer(p.layerId).opacity = p.opacity; break; }
      case "layer_blend":   { History.push([], false); getLayer(p.layerId).blend = p.mode; break; }
      case "layer_rename":  { History.push([], false); getLayer(p.layerId).name = p.name; break; }
      case "layer_select":  { Doc.activeId = p.layerId; break; }
      case "layer_move": {
        History.push([], false);
        const l = getLayer(p.layerId);
        l.ox += p.dx; l.oy += p.dy;
        break;
      }
      /* ---------- 绘制 ---------- */
      case "brush_stroke": {
        const l = getLayer(p.layerId); if (!l) return false;
        History.push([l.id]); drawStroke(l, p, false); break;
      }
      case "eraser_stroke": {
        const l = getLayer(p.layerId); if (!l) return false;
        History.push([l.id]); drawStroke(l, p, true); break;
      }
      case "fill": {
        const l = getLayer(p.layerId); if (!l) return false;
        History.push([l.id]); floodFill(l, p); break;
      }
      case "gradient": {
        const l = getLayer(p.layerId); if (!l) return false;
        History.push([l.id]);
        const c = l.ctx;
        c.save();
        clipSelection(c, l);
        const g = c.createLinearGradient(p.x0 - l.ox, p.y0 - l.oy, p.x1 - l.ox, p.y1 - l.oy);
        g.addColorStop(0, p.c0); g.addColorStop(1, p.c1);
        c.fillStyle = g;
        c.fillRect(0, 0, l.canvas.width, l.canvas.height);
        c.restore();
        break;
      }
      case "shape": {
        const l = getLayer(p.layerId); if (!l) return false;
        History.push([l.id]); drawShape(l, p); break;
      }
      case "text_add": {
        History.push([], false);
        const l = makeLayer(`文字: ${p.text.slice(0, 8)}`);
        l.ctx.fillStyle = p.color;
        l.ctx.font = `${p.size}px "${p.font}"`;
        l.ctx.textBaseline = "top";
        l.ctx.fillText(p.text, p.x, p.y);
        Doc.layers.push(l); Doc.activeId = l.id;
        break;
      }
      /* ---------- 选区 ---------- */
      case "select_rect":    { History.push([], false); Doc.selection = { kind: "rect", ...p }; break; }
      case "select_ellipse": { History.push([], false); Doc.selection = { kind: "ellipse", x: p.x, y: p.y, w: p.w, h: p.h }; break; }
      case "deselect":       { History.push([], false); Doc.selection = null; break; }
      /* ---------- 调整 ---------- */
      case "filter": {
        const l = getLayer(p.layerId); if (!l) return false;
        if (!PixelFilters.TYPES.includes(p.type)) return false;
        History.push([l.id]);
        applyPixelFilter(l, p.type, p.value);
        break;
      }
      case "transform": {
        const l = getLayer(p.layerId); if (!l) return false;
        History.push([l.id]);
        const W = l.canvas.width, H = l.canvas.height;
        const tmp = document.createElement("canvas");
        tmp.width = W; tmp.height = H;
        tmp.getContext("2d").drawImage(l.canvas, 0, 0);
        const c = l.ctx;
        c.clearRect(0, 0, W, H);
        c.save();
        c.translate(W / 2, H / 2);
        c.rotate(p.rotate * Math.PI / 180);
        c.scale(p.scale / 100 * (p.flipH ? -1 : 1), p.scale / 100 * (p.flipV ? -1 : 1));
        c.drawImage(tmp, -W / 2, -H / 2);
        c.restore();
        break;
      }
      /* ---------- 历史 ---------- */
      case "undo": History.undo(); break;
      case "redo": History.redo(); break;
      /* ---------- 非破坏性（记录上下文用） ---------- */
      case "tool_select": UI.setTool(p.tool, true); break;
      case "view_zoom": View.z = p.z; View.x = p.x; View.y = p.y; break;
      case "view_pan": View.x += p.dx; View.y += p.dy; break;
      case "eyedropper": UI.setFg(p.result); break;
      default: console.warn("未知操作", o); return false;
    }
    return true;
  },

  async run(op) {
    if (Replay.playing || Editor.locked) return false;     // 回放 / 演示期间禁止 UI 修改
    const before = Editor.wantsBefore(op) ? Editor.snapshotFor(op) : null;
    const ok = await this.apply(op);
    if (ok !== false) OpLog.add(op);
    render(); UI.refreshLayers();
    if (ok !== false) Editor.emit("op", { op, before, source: "user" });
    return ok;
  },
};

/* =====================================================================
 * 回放
 * ===================================================================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const Replay = {
  playing: false, _stop: false, paused: false, _step: false,
  /* 依次执行 ops（只执行、不记录日志）。
     opts: delay(ms 或 op=>ms)、onBefore(op,i)（可 await，用来播放光标动画）、onAfter(op,i,before,ok)、
           quantize（量化档位：执行前按当时的文档尺寸量化坐标 / 颜色）、mask（是否盖上“回放中”遮罩）、render */
  async start(ops, opts = {}) {
    if (this.playing) return { done: 0, stopped: true, executed: [] };
    this.playing = true; this._stop = false; this._step = false;
    const mask = opts.mask !== false;
    if (mask) $("replay-mask").style.display = "flex";
    const executed = [];
    let i = 0;
    for (const o0 of ops) {
      if (this._stop || Editor.stopped) break;
      while (this.paused && !this._stop && !this._step && !Editor.stopped) await sleep(50);
      if (this._stop || Editor.stopped) break;
      this._step = false;
      const o = opts.quantize ? OpTokens.quantizeOp(o0, opts.quantize, { W: Doc.W, H: Doc.H }) : o0;
      if (mask) $("replay-prog").textContent = `${i + 1}/${ops.length}`;
      if (opts.onBefore) await opts.onBefore(o, i);
      if (this._stop || Editor.stopped) break;
      const before = opts.onAfter && Editor.wantsBefore(o) ? Editor.snapshotFor(o) : null;
      const ok = await Ops.apply(o);
      executed.push(o0);
      if (opts.render !== false) { render(); UI.refreshLayers(); }
      if (opts.onAfter) await opts.onAfter(o, i, before, ok);
      i++;
      const d = typeof opts.delay === "function" ? opts.delay(o) : (opts.delay ?? (o.op.startsWith("view_") ? 10 : 60));
      if (d > 0) await sleep(d);
    }
    if (mask) $("replay-mask").style.display = "none";
    const stopped = this._stop || Editor.stopped;
    this.playing = false; this.paused = false;
    render(); UI.refreshLayers();
    return { done: i, stopped, executed };
  },
  stop() { this._stop = true; this.paused = false; },
  step() { this._step = true; },
};

/* =====================================================================
 * 工具
 * ===================================================================== */
function docPos(e) {
  const r = viewport.getBoundingClientRect();
  return [Math.round((e.clientX - r.left - View.x) / View.z),
          Math.round((e.clientY - r.top - View.y) / View.z)];
}

const Tools = {
  current: "brush",

  move: {
    down(e, pos) { this.start = pos; this.l = activeLayer(); this.o = [this.l.ox, this.l.oy]; },
    move(e, pos) {
      if (!this.start) return;
      this.l.ox = this.o[0] + pos[0] - this.start[0];
      this.l.oy = this.o[1] + pos[1] - this.start[1];
      render();
    },
    up(e, pos) {
      if (!this.start) return;
      const dx = pos[0] - this.start[0], dy = pos[1] - this.start[1];
      this.l.ox = this.o[0]; this.l.oy = this.o[1];   // 还原后经执行器正式生效
      if (dx || dy) Ops.run({ op: "layer_move", params: { layerId: this.l.id, dx, dy } });
      this.start = null;
    },
  },

  brush: {
    down(e, pos) {
      this.l = activeLayer();
      this.snap = this.l.ctx.getImageData(0, 0, this.l.canvas.width, this.l.canvas.height);
      this.pts = [pos];
      this.paint();
    },
    move(e, pos) {
      if (!this.pts) return;
      const last = this.pts[this.pts.length - 1];
      if (Math.abs(pos[0] - last[0]) + Math.abs(pos[1] - last[1]) < 2) return;
      this.pts.push(pos);
      this.paint();
    },
    paint() {
      this.l.ctx.putImageData(this.snap, 0, 0);
      drawStroke(this.l, this.params(), this.erase);
      render();
    },
    params() {
      return { layerId: this.l.id, points: this.pts, color: UI.fg(),
               size: +$("opt-size").value, opacity: +$("opt-opacity").value / 100 };
    },
    up() {
      if (!this.pts) return;
      this.l.ctx.putImageData(this.snap, 0, 0);     // 还原，由执行器正式绘制
      Ops.run({ op: this.erase ? "eraser_stroke" : "brush_stroke", params: this.params() });
      this.pts = null; this.snap = null;
    },
    erase: false,
  },

  fill: {
    down(e, pos) {
      Ops.run({ op: "fill", params: { layerId: Doc.activeId, x: pos[0], y: pos[1],
                color: UI.fg(), tolerance: +$("opt-tol").value } });
    },
    move() {}, up() {},
  },

  gradient: {
    down(e, pos) { this.start = pos; },
    move(e, pos) {
      if (!this.start) return;
      const p = new Path2D();
      p.moveTo(this.start[0], this.start[1]); p.lineTo(pos[0], pos[1]);
      UI.preview = p;
    },
    up(e, pos) {
      if (!this.start) return;
      UI.preview = null;
      if (Math.abs(pos[0] - this.start[0]) + Math.abs(pos[1] - this.start[1]) > 3)
        Ops.run({ op: "gradient", params: { layerId: Doc.activeId,
                  x0: this.start[0], y0: this.start[1], x1: pos[0], y1: pos[1],
                  c0: UI.fg(), c1: UI.bg() } });
      this.start = null;
    },
  },

  shape: {
    down(e, pos) { this.start = pos; },
    move(e, pos) {
      if (!this.start) return;
      const kind = $("opt-shape-kind").value;
      const p = new Path2D();
      if (kind === "line") { p.moveTo(this.start[0], this.start[1]); p.lineTo(pos[0], pos[1]); }
      else if (kind === "ellipse")
        p.ellipse((this.start[0] + pos[0]) / 2, (this.start[1] + pos[1]) / 2,
                  Math.abs(pos[0] - this.start[0]) / 2, Math.abs(pos[1] - this.start[1]) / 2, 0, 0, Math.PI * 2);
      else p.rect(Math.min(this.start[0], pos[0]), Math.min(this.start[1], pos[1]),
                  Math.abs(pos[0] - this.start[0]), Math.abs(pos[1] - this.start[1]));
      UI.preview = p;
    },
    up(e, pos) {
      if (!this.start) return;
      UI.preview = null;
      if (Math.abs(pos[0] - this.start[0]) + Math.abs(pos[1] - this.start[1]) > 2)
        Ops.run({ op: "shape", params: { layerId: Doc.activeId, kind: $("opt-shape-kind").value,
                  x0: this.start[0], y0: this.start[1], x1: pos[0], y1: pos[1],
                  doFill: $("opt-shape-fill").checked, doStroke: $("opt-shape-stroke").checked,
                  fill: UI.fg(), stroke: UI.bg(), lineWidth: +$("opt-shape-width").value } });
      this.start = null;
    },
  },

  text: {
    down(e, pos) {
      const text = $("opt-text").value.trim();
      if (!text) return toast("请先在上方选项条输入文字内容", true);
      Ops.run({ op: "text_add", params: { x: pos[0], y: pos[1], text,
                size: +$("opt-text-size").value, color: UI.fg(),
                font: $("opt-text-font").value } });
    },
    move() {}, up() {},
  },

  eyedropper: {
    down(e, pos) {
      const [x, y] = pos;
      if (x < 0 || y < 0 || x >= Doc.W || y >= Doc.H) return;
      const tmp = document.createElement("canvas");
      tmp.width = 1; tmp.height = 1;
      const tc = tmp.getContext("2d");
      for (const l of Doc.layers) {
        if (!l.visible) continue;
        tc.globalAlpha = l.opacity;
        tc.globalCompositeOperation = l.blend;
        tc.drawImage(l.canvas, l.ox - x, l.oy - y);
      }
      const d = tc.getImageData(0, 0, 1, 1).data;
      const hex = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
      Ops.run({ op: "eyedropper", params: { x, y, result: hex } });
      toast("拾取颜色 " + hex);
    },
    move() {}, up() {},
  },

  "select-rect": {
    down(e, pos) { this.start = pos; },
    move(e, pos) {
      if (!this.start) return;
      UI.preview = selPath({ kind: this.kind, x: Math.min(this.start[0], pos[0]),
        y: Math.min(this.start[1], pos[1]),
        w: Math.abs(pos[0] - this.start[0]), h: Math.abs(pos[1] - this.start[1]) });
    },
    up(e, pos) {
      if (!this.start) return;
      UI.preview = null;
      const x = Math.min(this.start[0], pos[0]), y = Math.min(this.start[1], pos[1]);
      const w = Math.abs(pos[0] - this.start[0]), h = Math.abs(pos[1] - this.start[1]);
      if (w > 2 && h > 2)
        Ops.run({ op: this.kind === "ellipse" ? "select_ellipse" : "select_rect",
                  params: { x, y, w, h } });
      else Ops.run({ op: "deselect", params: {} });
      this.start = null;
    },
    kind: "rect",
  },

  crop: {
    down(e, pos) { this.start = pos; },
    move(e, pos) {
      if (!this.start) return;
      this.rect = { x: Math.min(this.start[0], pos[0]), y: Math.min(this.start[1], pos[1]),
                    w: Math.abs(pos[0] - this.start[0]), h: Math.abs(pos[1] - this.start[1]) };
      UI.preview = selPath({ kind: "rect", ...this.rect });
    },
    up() { this.start = null; },
    apply() {
      if (!this.rect || this.rect.w < 4 || this.rect.h < 4) return toast("请先拖出裁剪框", true);
      const r = this.rect;
      this.rect = null; UI.preview = null;
      Ops.run({ op: "crop", params: { x: Math.max(0, r.x), y: Math.max(0, r.y),
                w: Math.min(r.w, Doc.W), h: Math.min(r.h, Doc.H) } });
    },
    cancel() { this.rect = null; UI.preview = null; toast("已取消裁剪"); },
  },

  hand: {
    down(e, pos) { this.sx = e.clientX; this.sy = e.clientY; this.ox = View.x; this.oy = View.y; },
    move(e) {
      if (this.sx === undefined || this.sx === null) return;
      View.x = this.ox + e.clientX - this.sx;
      View.y = this.oy + e.clientY - this.sy;
      render();
    },
    up(e) {
      if (this.sx === undefined || this.sx === null) return;
      const dx = View.x - this.ox, dy = View.y - this.oy;
      if (dx || dy) OpLog.add({ op: "view_pan", params: { dx, dy } });
      this.sx = null;
    },
  },
};
Tools.eraser = Object.create(Tools.brush);
Tools.eraser.erase = true;
Tools["select-ellipse"] = Object.create(Tools["select-rect"]);
Tools["select-ellipse"].kind = "ellipse";

/* =====================================================================
 * UI 胶水
 * ===================================================================== */
const UI = {
  preview: null,
  fg: () => $("fg-color").value,
  bg: () => $("bg-color").value,
  setFg(hex) { $("fg-color").value = hex; },

  setTool(name, silent) {
    Tools.current = name;
    document.querySelectorAll("#toolbar button[data-tool]").forEach(b =>
      b.classList.toggle("active", b.dataset.tool === name));
    document.querySelectorAll("#optionsbar .opt").forEach(o => o.classList.remove("show"));
    document.querySelectorAll(".opt-" + name).forEach(o => o.classList.add("show"));
    const tips = { move: "拖动以移动当前图层", "select-rect": "拖拽框选矩形选区（选区会限制绘制范围）",
      "select-ellipse": "拖拽框选椭圆选区", gradient: "按住拖拽：前景色 → 背景色 线性渐变",
      eyedropper: "点击画布拾取颜色到前景色", hand: "拖动平移视图（或按住空格）" };
    $("opt-tip").textContent = tips[name] || "";
    if (!silent) Ops.run({ op: "tool_select", params: { tool: name } });
  },

  refreshLayers() {
    const box = $("layers");
    box.innerHTML = "";
    [...Doc.layers].reverse().forEach(l => {
      const item = document.createElement("div");
      item.className = "layer-item" + (l.id === Doc.activeId ? " active" : "");
      const eye = document.createElement("span");
      eye.className = "eye"; eye.textContent = l.visible ? "👁" : "—";
      eye.onclick = ev => { ev.stopPropagation();
        Ops.run({ op: "layer_visible", params: { layerId: l.id, visible: !l.visible } }); };
      const th = document.createElement("canvas");
      th.width = 44; th.height = 30;
      const sc = Math.min(44 / l.canvas.width, 30 / l.canvas.height);
      th.getContext("2d").drawImage(l.canvas, (44 - l.canvas.width * sc) / 2,
        (30 - l.canvas.height * sc) / 2, l.canvas.width * sc, l.canvas.height * sc);
      const nm = document.createElement("span");
      nm.className = "lname"; nm.textContent = l.name;
      nm.ondblclick = () => {
        const name = prompt("图层名称", l.name);
        if (name) Ops.run({ op: "layer_rename", params: { layerId: l.id, name } });
      };
      item.append(eye, th, nm);
      item.onclick = () => { if (l.id !== Doc.activeId)
        Ops.run({ op: "layer_select", params: { layerId: l.id } }); };
      box.appendChild(item);
    });
    const al = activeLayer();
    if (al) {
      $("layer-opacity").value = Math.round(al.opacity * 100);
      $("layer-blend").value = al.blend;
    }
  },

  /* ---------- 视图 ---------- */
  zoomBy(f, cx, cy) {
    const z = clamp(View.z * f, 0.05, 16);
    cx = cx ?? viewport.clientWidth / 2;
    cy = cy ?? viewport.clientHeight / 2;
    View.x = cx - (cx - View.x) * (z / View.z);
    View.y = cy - (cy - View.y) * (z / View.z);
    View.z = z;
    OpLog.add({ op: "view_zoom", params: { z: +z.toFixed(3), x: Math.round(View.x), y: Math.round(View.y) } });
    render();
  },
  zoomTo(z) { View.z = z; View.x = 60; View.y = 40;
    OpLog.add({ op: "view_zoom", params: { z, x: View.x, y: View.y } }); render(); },
  zoomFit() {
    resizeStage();
    const pad = document.body.classList.contains("touchp") ? 12 : 80;   // 手机竖屏：画板占满宽度
    const z = Math.min((viewport.clientWidth - pad) / Doc.W,
                       (viewport.clientHeight - pad) / Doc.H, 4);
    View.z = clamp(z, 0.05, 4);
    View.x = (viewport.clientWidth - Doc.W * View.z) / 2;
    View.y = (viewport.clientHeight - Doc.H * View.z) / 2;
    render();
  },

  /* ---------- 对话框 ---------- */
  showNewDoc() { $("dlg-new").classList.add("show"); },
  closeDlg() { document.querySelectorAll(".dlg-mask").forEach(d => d.classList.remove("show")); },
  confirmNewDoc() {
    this.closeDlg();
    Ops.run({ op: "doc_new", params: { width: clamp(+$("new-w").value, 16, 4096),
              height: clamp(+$("new-h").value, 16, 4096), bg: $("new-bg").value } });
  },

  ADJ: {
    brightness: { title: "亮度", min: -100, max: 100, val: 0, label: "亮度" },
    contrast:   { title: "对比度", min: -100, max: 100, val: 0, label: "对比度" },
    saturate:   { title: "饱和度", min: -100, max: 100, val: 0, label: "饱和度" },
    hue:        { title: "色相旋转", min: -180, max: 180, val: 0, label: "角度" },
    blur:       { title: "高斯模糊", min: 0, max: 40, val: 4, label: "半径(px)" },
    sharpen:    { title: "锐化", min: 0, max: 100, val: 30, label: "强度" },
  },
  showAdjust(type) {
    const l = activeLayer(); if (!l) return;
    const cfg = this.ADJ[type];
    this._adjType = type;
    this._adjSnap = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
    $("adj-title").textContent = cfg.title;
    $("adj-label").textContent = cfg.label;
    const r = $("adj-range");
    r.min = cfg.min; r.max = cfg.max; r.value = cfg.val;
    $("adj-v").textContent = cfg.val;
    this._adjPreview(cfg.val);
    $("dlg-adjust").classList.add("show");
  },
  _adjPreview(v) {
    const l = activeLayer();
    l.ctx.putImageData(this._adjSnap, 0, 0);
    if (+v !== 0 || this._adjType === "blur" || this._adjType === "sharpen")
      applyPixelFilter(l, this._adjType, +v);           // 直接用底层函数预览（不入历史/日志）
    render();
    Editor.emit("adjust-preview", { type: this._adjType, value: +v, before: this._adjSnap,
      after: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height) });
  },
  cancelAdjust() {
    activeLayer().ctx.putImageData(this._adjSnap, 0, 0);
    this._adjSnap = null; this.closeDlg(); render();
  },
  confirmAdjust() {
    const v = +$("adj-range").value;
    activeLayer().ctx.putImageData(this._adjSnap, 0, 0);   // 还原，由执行器正式生效
    this._adjSnap = null; this.closeDlg();
    Ops.run({ op: "filter", params: { layerId: Doc.activeId, type: this._adjType, value: v } });
  },

  showTransform() {
    $("tf-scale").value = 100; $("tf-rotate").value = 0;
    $("tf-scale-v").textContent = 100; $("tf-rotate-v").textContent = 0;
    $("tf-fliph").checked = $("tf-flipv").checked = false;
    $("dlg-transform").classList.add("show");
  },
  cancelTransform() { this.closeDlg(); },
  confirmTransform() {
    this.closeDlg();
    Ops.run({ op: "transform", params: { layerId: Doc.activeId,
      scale: +$("tf-scale").value, rotate: +$("tf-rotate").value,
      flipH: $("tf-fliph").checked, flipV: $("tf-flipv").checked } });
  },

  /* ---------- 导出 ---------- */
  flatten(white) {
    const c = document.createElement("canvas");
    c.width = Doc.W; c.height = Doc.H;
    const x = c.getContext("2d");
    if (white) { x.fillStyle = "#fff"; x.fillRect(0, 0, Doc.W, Doc.H); }
    for (const l of Doc.layers) {
      if (!l.visible) continue;
      x.globalAlpha = l.opacity;
      x.globalCompositeOperation = l.blend;
      x.drawImage(l.canvas, l.ox, l.oy);
    }
    return c;
  },
  exportPNG() {
    const a = document.createElement("a");
    a.href = this.flatten(false).toDataURL("image/png");
    a.download = `${CFG.EXPORT_PREFIX}_export.png`; a.click();
  },
  exportJPG() {
    const a = document.createElement("a");
    a.href = this.flatten(true).toDataURL("image/jpeg", 0.92);
    a.download = `${CFG.EXPORT_PREFIX}_export.jpg`; a.click();
  },
};

/* =====================================================================
 * 事件绑定
 * ===================================================================== */
function bindEvents() {
  // 菜单开合
  document.querySelectorAll("#menubar .menu").forEach(m => {
    m.addEventListener("click", e => {
      const open = m.classList.contains("open");
      document.querySelectorAll("#menubar .menu").forEach(x => x.classList.remove("open"));
      if (!open) m.classList.add("open");
      e.stopPropagation();
    });
  });
  document.addEventListener("click", () =>
    document.querySelectorAll("#menubar .menu").forEach(x => x.classList.remove("open")), SIG);

  // 工具栏
  document.querySelectorAll("#toolbar button[data-tool]").forEach(b =>
    b.addEventListener("click", () => UI.setTool(b.dataset.tool)));

  // 选项条数值显示
  for (const [id, out] of [["opt-size", "opt-size-v"], ["opt-opacity", "opt-opacity-v"],
                           ["opt-tol", "opt-tol-v"]])
    $(id).addEventListener("input", () => $(out).textContent = $(id).value);
  $("adj-range").addEventListener("input", () => {
    $("adj-v").textContent = $("adj-range").value;
    UI._adjPreview(+$("adj-range").value);
  });
  $("tf-scale").addEventListener("input", () => $("tf-scale-v").textContent = $("tf-scale").value);
  $("tf-rotate").addEventListener("input", () => $("tf-rotate-v").textContent = $("tf-rotate").value);

  // 图层控制
  $("layer-opacity").addEventListener("change", () =>
    Ops.run({ op: "layer_opacity", params: { layerId: Doc.activeId,
              opacity: +$("layer-opacity").value / 100 } }));
  $("layer-blend").addEventListener("change", () =>
    Ops.run({ op: "layer_blend", params: { layerId: Doc.activeId, mode: $("layer-blend").value } }));

  // 画布指针：Pointer Events，鼠标、手指、触控笔都能画。只跟踪第一个按下的指针（第二根手指忽略），
  // pointercancel / 窗口失焦时按抬起处理，保证不会留下画到一半的状态。
  let spacePan = false, panState = null, activePointer = null, lastEv = null;
  viewport.addEventListener("pointerdown", e => {
    if (Replay.playing || Editor.locked) return;
    if (activePointer !== null) return;                       // 已有一根手指 / 一个按键在操作
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    activePointer = e.pointerId; lastEv = e;
    try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* 某些浏览器对已抬起的指针会抛错 */ }
    if (spacePan || e.button === 1) {
      panState = { sx: e.clientX, sy: e.clientY, ox: View.x, oy: View.y };
      return;
    }
    Tools[Tools.current].down(e, docPos(e));
  });
  viewport.addEventListener("pointermove", e => {
    if (Replay.playing || Editor.locked) return;
    if (activePointer !== null && e.pointerId !== activePointer) return;
    if (activePointer !== null) lastEv = e;
    if (panState) {
      View.x = panState.ox + e.clientX - panState.sx;
      View.y = panState.oy + e.clientY - panState.sy;
      render();
      return;
    }
    Tools[Tools.current].move(e, docPos(e));
  });
  const finish = e => {
    if (activePointer !== null && e && e.pointerId !== undefined && e.pointerId !== activePointer) return;
    const ev = (e && e.clientX !== undefined) ? e : lastEv;
    activePointer = null; lastEv = null;
    if (panState) {
      OpLog.add({ op: "view_pan", params: { dx: View.x - panState.ox, dy: View.y - panState.oy } });
      panState = null;
      return;
    }
    if (ev) Tools[Tools.current].up(ev, docPos(ev));
  };
  viewport.addEventListener("pointerup", finish);
  viewport.addEventListener("pointercancel", finish);
  viewport.addEventListener("pointerleave", e => {
    if (activePointer === null && e.buttons === 0 && !panState) Tools[Tools.current].up && Tools[Tools.current].up(e, docPos(e));
  });
  window.addEventListener("blur", () => { if (activePointer !== null) finish(null); }, SIG);

  // 滚轮缩放
  viewport.addEventListener("wheel", e => {
    e.preventDefault();
    if (Replay.playing || Editor.locked) return;
    const r = viewport.getBoundingClientRect();
    UI.zoomBy(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false, signal: EditorAbort.signal });

  // 键盘
  document.addEventListener("keydown", e => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || Replay.playing || Editor.locked) return;
    if (e.code === "Space") { spacePan = true; e.preventDefault(); }
    if (e.ctrlKey && e.code === "KeyZ") { e.preventDefault();
      Ops.run({ op: e.shiftKey ? "redo" : "undo", params: {} }); }
    if (e.ctrlKey && e.code === "KeyY") { e.preventDefault(); Ops.run({ op: "redo", params: {} }); }
    if (e.ctrlKey && e.code === "KeyD") { e.preventDefault(); Ops.run({ op: "deselect", params: {} }); }
    const keys = { KeyV: "move", KeyM: "select-rect", KeyB: "brush", KeyE: "eraser",
                   KeyG: "fill", KeyT: "text", KeyI: "eyedropper", KeyC: "crop",
                   KeyU: "shape" };          // H 键留给“操作说明”；抓手用按钮或按住空格
    if (!e.ctrlKey && keys[e.code]) UI.setTool(keys[e.code]);
    if (e.code === "BracketLeft") { $("opt-size").value = +$("opt-size").value - 2;
      $("opt-size-v").textContent = $("opt-size").value; }
    if (e.code === "BracketRight") { $("opt-size").value = +$("opt-size").value + 2;
      $("opt-size-v").textContent = $("opt-size").value; }
  }, SIG);
  document.addEventListener("keyup", e => { if (e.code === "Space") spacePan = false; }, SIG);

  // 文件
  $("file-open").addEventListener("change", e => loadFileAsOp(e, false));
  $("file-place").addEventListener("change", e => loadFileAsOp(e, true));
  $("file-replay").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const parsed = Editor.parseLog(await f.text());
    if (parsed.error) return toast(parsed.error, true);
    if (parsed.warn) toast(parsed.warn, true);
    const ops = parsed.ops;
    if (!confirm(`日志包含 ${ops.length} 条操作。\n回放会重置当前画布，确认继续？`)) return;
    await Editor.loadLog(ops, { delay: o => (o.op.startsWith("view_") ? 10 : 60) });
  }, SIG);
}

function loadFileAsOp(e, asLayer) {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () =>
    Ops.run({ op: "image_open", params: { dataURL: reader.result, asLayer } });
  reader.readAsDataURL(f);
}

/* =====================================================================
 * 对外接口（页面外壳 app.js 通过它驱动编辑器）
 * ===================================================================== */
const Editor = {
  stopped: false, locked: false, _ls: {},
  on(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); },
  emit(ev, data) { for (const fn of this._ls[ev] || []) { try { fn(data); } catch (err) { console.error(err); } } },

  /* 哪些操作需要记下“执行前”的图层像素（右栏画直方图对比用） */
  wantsBefore: op => !!op && op.op === "filter",
  snapshotFor(op) {
    const l = getLayer((op && op.params && op.params.layerId) ?? Doc.activeId);
    return l ? l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height) : null;
  },
  layerData(id) {
    const l = getLayer(id ?? Doc.activeId);
    return l ? l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height) : null;
  },
  flattenData() {
    const c = UI.flatten(true);
    return c.getContext("2d").getImageData(0, 0, c.width, c.height);
  },
  fingerprint() { return OpTokens.fingerprint(this.flattenData().data); },
  docSize: () => ({ W: Doc.W, H: Doc.H }),

  /* 解析 JSONL 日志：接受新标识和旧版本标识（CFG.LEGACY_APP_IDS） */
  parseLog(text) {
    let ops;
    try { ops = String(text).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)); }
    catch (err) { return { error: "不是有效的 JSONL 日志：" + err.message }; }
    if (!ops.length) return { error: "日志是空的" };
    const head = ops.find(o => o.op === "session_start");
    const known = [CFG.LOG_APP_ID, ...CFG.LEGACY_APP_IDS];
    let warn = null, legacy = false;
    if (head && head.params && head.params.app) {
      if (!known.includes(head.params.app)) warn = `日志来自未知程序 “${head.params.app}”，仍尝试回放`;
      legacy = CFG.LEGACY_APP_IDS.includes(head.params.app);
    }
    if (!ops.some(o => o.op === "doc_new" || (o.op === "image_open" && !(o.params || {}).asLayer)))
      return { error: "日志里没有 doc_new / 打开图片，无法从头回放" };
    return { ops, warn, legacy, app: head && head.params ? head.params.app : null };
  },

  /* 不动画、不记录地把 ops 全部执行一遍（量化档位可选） */
  async replayInstant(ops, quantize) {
    return Replay.start(ops, { delay: 0, mask: false, render: false, quantize: quantize || null });
  },

  /* 把一段日志载入为当前会话：逐条回放（可带动画钩子），结束后它就是当前日志 */
  async loadLog(ops, opts = {}) {
    OpLog.ops = []; OpLog.seq = 0; OpLog.refresh();
    const res = await Replay.start(ops, opts);
    OpLog.ops = res.executed.map((o, i) => ({ seq: i, t: o.t ?? 0, op: o.op, params: o.params }));
    OpLog.seq = OpLog.ops.length;
    OpLog.t0 = Date.now() - (OpLog.ops.length ? OpLog.ops[OpLog.ops.length - 1].t : 0);
    OpLog.refresh();
    this.emit("loaded", res);
    if (!opts.silent) toast(res.stopped ? `回放已停止（执行了 ${res.done} 条）` : "回放完成 ✔");
    return res;
  },

  /* 一致性校验：记下当前画布指纹 → 重置并按日志回放 → 再算指纹 */
  async verify() {
    const ops = OpLog.ops.map(o => ({ op: o.op, params: o.params }));
    const fp1 = this.fingerprint();
    const t0 = performance.now();
    await this.replayInstant(ops);
    const fp2 = this.fingerprint();
    const r = { n: ops.length, fp1, fp2, same: fp1 === fp2, ms: Math.round(performance.now() - t0) };
    this.emit("verified", r);
    return r;
  },

  /* 量化后回放：原图 vs 量化日志回放出来的图，算 PSNR；最后按原日志回放还原画布 */
  async quantTest(presetKey) {
    const ops = OpLog.ops.map(o => ({ op: o.op, params: o.params }));
    const orig = this.flattenData();
    const fp1 = OpTokens.fingerprint(orig.data);
    const t0 = performance.now();
    await this.replayInstant(ops, presetKey);
    const quant = this.flattenData();
    const q = OpTokens.psnr(orig.data, quant.data);
    await this.replayInstant(ops);
    const fp2 = this.fingerprint();
    const r = { preset: presetKey, n: ops.length, ...q, restored: fp1 === fp2, orig, quant,
                ms: Math.round(performance.now() - t0) };
    this.emit("quantized", r);
    return r;
  },

  async boot() {
    resizeStage();
    bindEvents();
    const sel = $("opt-text-font");
    if (sel) sel.innerHTML = CFG.FONTS.map(f => `<option>${f}</option>`).join("");
    const txt = $("opt-text");
    if (txt) txt.value = CFG.DEFAULT_TEXT;
    await OpLog.restart(960, 640, "#ffffff");
    UI.setTool("brush", true);
    render(); UI.refreshLayers();
    requestAnimationFrame(drawOverlay);
  },

  /* 退出：停掉循环 / 定时器 / 监听，释放画布与快照 */
  stop() {
    this.stopped = true;
    Replay.stop();
    EditorAbort.abort();
    clearTimeout(toast._h);
    History.undoStack = []; History.redoStack = [];
    for (const { canvas } of CanvasReg.values()) { canvas.width = canvas.height = 0; }
    CanvasReg.clear();
    Doc.layers = [];
    OpLog.ops = [];
    stage.width = stage.height = overlay.width = overlay.height = 0;
  },
};
window.Editor = Editor;
