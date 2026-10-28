/* =====================================================================
 * 页面外壳：模式标签、看回放（自动演示）、练习清单、右栏可视化、悬停动画提示、
 * 操作说明、大屏模式、退出、页脚署名、自检（?selftest=1）与截图状态（?shot=…）
 * ===================================================================== */
(function () {
  "use strict";

  const CFG = window.APP_CONFIG;
  const CR = window.CREDITS || {};
  const QS = new URLSearchParams(location.search);
  const AppAbort = new AbortController();
  const ON = { signal: AppAbort.signal };
  const el = id => document.getElementById(id);

  /* ---------- 收集 JS 报错（自检用） ---------- */
  const errors = [];
  window.addEventListener("error", e => errors.push(String(e.message || e)), ON);
  window.addEventListener("unhandledrejection", e => errors.push("unhandled: " + String(e.reason && e.reason.message || e.reason)), ON);
  const origErr = console.error.bind(console);
  console.error = (...a) => { errors.push(a.map(String).join(" ")); origErr(...a); };

  /* ---------- 常量 ---------- */
  const OP_CN = {
    session_start: "会话头", doc_new: "新建文档", image_open: "打开图片", crop: "裁剪",
    layer_add: "新建图层", layer_delete: "删除图层", layer_duplicate: "复制图层", layer_merge_down: "向下合并",
    layer_reorder: "调整图层顺序", layer_visible: "显示 / 隐藏图层", layer_opacity: "图层不透明度",
    layer_blend: "混合模式", layer_rename: "图层改名", layer_select: "选中图层", layer_move: "移动图层",
    brush_stroke: "画笔", eraser_stroke: "橡皮擦", fill: "油漆桶", gradient: "渐变", shape: "形状", text_add: "文字",
    select_rect: "矩形选区", select_ellipse: "椭圆选区", deselect: "取消选区", filter: "调整 / 滤镜",
    transform: "变换图层", undo: "撤销", redo: "重做", tool_select: "选工具", view_zoom: "缩放视图",
    view_pan: "平移视图", eyedropper: "吸管取色",
  };
  const FILTER_CN = { brightness: "亮度", contrast: "对比度", saturate: "饱和度", hue: "色相旋转", blur: "高斯模糊",
                      sharpen: "锐化", invert: "反相", grayscale: "去色" };
  const SPEEDS = [
    { key: "explain", name: "逐条讲解", delay: 1900, anim: 1000, desc: "每条停约 2 秒，适合边讲边看" },
    { key: "normal",  name: "正常",     delay: 700,  anim: 500,  desc: "默认速度" },
    { key: "fast",    name: "快速",     delay: 150,  anim: 160,  desc: "快速过一遍" },
    { key: "instant", name: "瞬间",     delay: 0,    anim: 0,    desc: "不等待，直接出结果" },
  ];
  const TASKS = [   // ttext：触屏（手机竖屏）上显示的说法
    { key: "brush",       text: "用画笔（B）画一笔",                       ttext: "选画笔 🖌，在画布上画一笔" },
    { key: "layer_shape", text: "图层栏 ＋ 新建图层，再画一个形状（U）",     ttext: "图层栏 ＋ 新建图层，再用 ⬛ 画一个形状" },
    { key: "sel_filter",  text: "拉选区（M），用「图像」菜单只调选区内",     ttext: "用 ▭ 拉选区，再用「图像」菜单只调选区内" },
    { key: "undo_redo",   text: "撤销（Ctrl+Z）再重做（Ctrl+Y）",            ttext: "点「撤销」再点「重做」" },
    { key: "verify",      text: "右栏「回放校验」点 ①，指纹一致",            ttext: "「看日志」→「回放校验」点 ①，指纹一致" },
    { key: "quant",       text: "量化换「粗 64」，点 ②，看 PSNR",            ttext: "量化换「粗 64」，点 ②，看 PSNR" },
    { key: "export",      text: "导出操作日志（.jsonl）",                    ttext: "点「导出」保存操作日志（.jsonl）" },
  ];
  const isTouchP = () => document.body.classList.contains("touchp");

  const S = {
    mode: null, quant: "raw", speed: "normal", demoPromise: null, demoSteps: null, demoN: 0,
    practiceBase: 0, practiceLayers: new Set(), done: new Set(), qres: {}, stopped: false,
    tipTimer: null, tipKind: null, tipT0: 0, ro: null,
  };
  const speed = () => SPEEDS.find(s => s.key === S.speed);
  const busy = () => Replay.playing;

  /* =====================================================================
   * 右栏：当前操作 → JSON + token
   * ===================================================================== */
  function opLabel(op) {
    let s = OP_CN[op.op] || op.op;
    if (op.op === "filter" && op.params) s += "：" + (FILTER_CN[op.params.type] || op.params.type);
    return s;
  }
  function showOp(op) {
    if (!op) return;
    const shown = JSON.parse(JSON.stringify(op, (k, v) =>
      (k === "dataURL" && typeof v === "string" && v.length > 80 ? v.slice(0, 48) + `…（共 ${v.length} 字符）` : v)));
    el("op-json").textContent = JSON.stringify(shown, null, 1).replace(/\n\s*(\d+|-\d+)(,?)\n\s*(\d+|-\d+)/g, " $1$2 $3");
    el("op-cn").textContent = opLabel(op) + (Ops.NONDESTRUCTIVE.has(op.op) ? "（上下文信号，不改像素）" : "");
    S.lastOp = op;
    renderTokens();
  }
  function renderTokens() {
    const op = S.lastOp;
    const preset = OpTokens.presetByKey(S.quant);
    el("quant-desc").textContent = preset.desc;
    if (!op) return;
    const toks = OpTokens.tokenize(op, preset, Editor.docSize());
    el("tok-count").textContent = toks.length;
    el("tokens").innerHTML = toks.map((t, i) => {
      let c = "tok";
      if (i === 0) c += " op";
      else if (t === "<eos>") c += " end";
      else if (/^(x|y|x0|y0|x1|y1|w|h|dx|dy)[:=]/.test(t)) c += " c";
      else if (/rgb:/.test(t)) c += " col";
      return `<span class="${c}">${t.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]))}</span>`;
    }).join("");
  }

  /* ---------- 右栏标签 ---------- */
  function setRTab(key) {
    document.querySelectorAll("[data-rtab]").forEach(b => b.classList.toggle("on", b.dataset.rtab === key));
    document.querySelectorAll(".rpane").forEach(p => p.classList.toggle("on", p.id === "rpane-" + key));
    el("rtab-hint").textContent = { log: "最新的一条在最下面", verify: "状态 = 回放(日志)", pixel: "调整与滤镜是怎么算的" }[key];
  }

  /* ---------- 像素原理：直方图 + 公式 / 矩阵 / 卷积核 ---------- */
  function showPixel(type, value, before, after) {
    const ex = PixelFilters.explain(type, value);
    el("px-title").innerHTML = `<b>${FILTER_CN[type] || type}</b>（${ex.kind}）：参数 value = ${value}`;
    el("px-formula").textContent = ex.formula;
    const grid = ex.kernel || ex.matrix;
    el("px-matrix").innerHTML = grid
      ? `<div class="legend">${ex.kernel ? "卷积核（作用在每个像素和它的上下左右邻居上）" : "颜色矩阵（新 RGB = 矩阵 × 旧 RGB）"}</div>` +
        `<div class="matrix">${grid.map(v => `<span class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${(+v).toFixed(2)}</span>`).join("")}</div>`
      : "";
    const c = el("hist"), g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    if (!before || !after) return;
    const hb = PixelFilters.histogram(before), ha = PixelFilters.histogram(after);
    const mx = Math.max(1, ...hb, ...ha), n = hb.length, bw = c.width / n;
    for (const [h, col, off] of [[hb, "rgba(138,148,160,.75)", 0], [ha, "rgba(255,207,90,.75)", bw / 2]]) {
      g.fillStyle = col;
      h.forEach((v, i) => { const hh = (v / mx) * (c.height - 10); g.fillRect(i * bw + off, c.height - hh, bw / 2, hh); });
    }
  }

  /* ---------- 回放校验 / 量化 ---------- */
  function drawThumb(canvasId, img, diffWith) {
    const c = el(canvasId), g = c.getContext("2d");
    g.fillStyle = "#111"; g.fillRect(0, 0, c.width, c.height);
    if (!img) return;
    const t = document.createElement("canvas");
    t.width = img.width; t.height = img.height;
    const tg = t.getContext("2d");
    if (diffWith) {
      const d = tg.createImageData(img.width, img.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.min(255, 8 * Math.max(Math.abs(img.data[i] - diffWith.data[i]),
          Math.abs(img.data[i + 1] - diffWith.data[i + 1]), Math.abs(img.data[i + 2] - diffWith.data[i + 2])));
        d.data[i] = v; d.data[i + 1] = v; d.data[i + 2] = v; d.data[i + 3] = 255;
      }
      tg.putImageData(d, 0, 0);
    } else tg.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const sc = Math.min(c.width / img.width, c.height / img.height);
    g.drawImage(t, (c.width - img.width * sc) / 2, (c.height - img.height * sc) / 2, img.width * sc, img.height * sc);
  }
  const fmtPsnr = p => (p === Infinity ? "∞（逐像素一致）" : p == null ? "—" : p.toFixed(2) + " dB");

  async function doVerify() {
    if (busy()) return null;
    const out = el("verify-out");
    out.className = "out"; out.textContent = "回放中…";
    const r = await Editor.verify();
    out.className = "out " + (r.same ? "ok" : "bad");
    out.textContent = `${r.n} 条日志 · 回放前指纹 ${r.fp1} · 回放后 ${r.fp2} · ${r.same ? "一致 ✓" : "不一致 ✗"}（${r.ms} ms）`;
    drawThumb("th-orig", Editor.flattenData());
    return r;
  }
  async function doQuant(presetKey) {
    if (busy()) return null;
    const key = presetKey || S.quant;
    const preset = OpTokens.presetByKey(key);
    const out = el("quant-out");
    out.className = "out"; out.textContent = "量化回放中…";
    const r = await Editor.quantTest(key);
    S.qres[key] = { psnr: r.psnr, changed: r.changedPixels, total: r.totalPixels };
    out.className = "out " + (r.restored ? "ok" : "bad");
    out.textContent = `「${preset.name}」PSNR ${fmtPsnr(r.psnr)} · 有差异的像素 ${r.changedPixels} / ${r.totalPixels}` +
      ` · 画布已按原日志还原${r.restored ? " ✓" : "（指纹不一致 ✗）"}`;
    el("th-quant-cap").textContent = `量化日志回放（${preset.name}）`;
    drawThumb("th-orig", r.orig); drawThumb("th-quant", r.quant); drawThumb("th-diff", r.quant, r.orig);
    renderQuantTable();
    return r;
  }
  function renderQuantTable() {
    el("quant-table").querySelector("tbody").innerHTML = OpTokens.PRESETS.map(p => {
      const r = S.qres[p.key];
      return `<tr class="${p.key === S.quant ? "on" : ""}"><td>${p.name}</td><td class="num">${p.bins || "不量化"}</td>` +
        `<td class="num">${p.levels}</td><td class="num">${r ? fmtPsnr(r.psnr) : "—"}</td>` +
        `<td class="num">${r ? `${r.changed}（${(100 * r.changed / r.total).toFixed(1)}%）` : "—"}</td></tr>`;
    }).join("");
  }

  /* ---------- 预设档位按钮 ---------- */
  function buildSeg(id, list, cur, onPick) {
    const box = el(id);
    box.innerHTML = list.map(p => `<button data-k="${p.key}" title="${p.desc}">${p.name}</button>`).join("");
    const mark = k => box.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.k === k));
    box.querySelectorAll("button").forEach(b => b.addEventListener("click", () => { mark(b.dataset.k); onPick(b.dataset.k); }, ON));
    mark(cur);
    return mark;
  }

  /* =====================================================================
   * 看回放：自动演示（光标动画 + 每步说明）
   * ===================================================================== */
  const cursor = () => el("demo-cursor");
  function placeCursor(x, y) {
    const c = cursor();
    c.style.display = "block";
    c.style.left = (View.x + x * View.z) + "px";
    c.style.top = (View.y + y * View.z) + "px";
  }
  function hideCursor() { cursor().style.display = "none"; cursor().classList.remove("press"); UI.preview = null; }

  /* 播放一条操作之前的“手势”动画：只在 overlay 上画预览，不改图层 */
  async function animateOp(op, ms) {
    if (!ms) return;
    const p = op.params || {};
    const path = [];
    let draw = null;
    if (op.op === "brush_stroke" || op.op === "eraser_stroke") {
      path.push(...p.points);
      draw = k => {
        const pp = new Path2D(); const n = Math.max(1, Math.round(k * (p.points.length - 1)));
        pp.moveTo(p.points[0][0], p.points[0][1]);
        for (let i = 1; i <= n; i++) pp.lineTo(p.points[i][0], p.points[i][1]);
        return pp;
      };
    } else if (op.op === "shape" || op.op === "gradient") {
      path.push([p.x0, p.y0], [p.x1, p.y1]);
      draw = k => {
        const x1 = p.x0 + (p.x1 - p.x0) * k, y1 = p.y0 + (p.y1 - p.y0) * k, pp = new Path2D();
        if (op.op === "gradient" || p.kind === "line") { pp.moveTo(p.x0, p.y0); pp.lineTo(x1, y1); }
        else if (p.kind === "ellipse") pp.ellipse((p.x0 + x1) / 2, (p.y0 + y1) / 2, Math.abs(x1 - p.x0) / 2 + 0.1, Math.abs(y1 - p.y0) / 2 + 0.1, 0, 0, Math.PI * 2);
        else pp.rect(Math.min(p.x0, x1), Math.min(p.y0, y1), Math.abs(x1 - p.x0), Math.abs(y1 - p.y0));
        return pp;
      };
    } else if (op.op === "select_rect" || op.op === "select_ellipse") {
      path.push([p.x, p.y], [p.x + p.w, p.y + p.h]);
      draw = k => selPath({ kind: op.op === "select_ellipse" ? "ellipse" : "rect", x: p.x, y: p.y, w: p.w * k + 0.1, h: p.h * k + 0.1 });
    } else if (op.op === "fill" || op.op === "text_add") {
      path.push([p.x, p.y]);
    } else if (op.op === "layer_move") {
      path.push([480, 320], [480 + p.dx * 3, 320 + p.dy * 3]);
    } else return;
    const t0 = performance.now();
    cursor().classList.add("press");
    while (!S.stopped && !Replay._stop) {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const seg = k * (path.length - 1), i = Math.floor(seg), f = seg - i;
      const a = path[Math.min(i, path.length - 1)], b = path[Math.min(i + 1, path.length - 1)];
      placeCursor(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      if (draw) UI.preview = draw(k);
      if (k >= 1) break;
      await new Promise(r => requestAnimationFrame(r));
    }
    UI.preview = null;
    cursor().classList.remove("press");
  }

  function setCaption(i) {
    const st = S.demoSteps && S.demoSteps[i];
    if (!st) return;
    el("cap-title").textContent = `第 ${i + 1} 步 · ${st.title}`;
    el("cap-text").textContent = st.text;
    el("pl-count").textContent = `${i + 1} / ${S.demoN}`;
    el("pl-bar").style.width = (100 * (i + 1) / S.demoN) + "%";
  }
  function setPlayLabel() {
    el("pl-play").textContent = !S.demoPromise ? "▶ 再播一遍" : Replay.paused ? "▶ 继续" : "⏸ 暂停";
  }

  async function runDemo() {
    await stopDemo();
    const { ops, steps } = Demo.build(CFG);
    S.demoSteps = steps; S.demoN = ops.length; S.qres = {}; renderQuantTable();
    setRTab("log");
    el("cap-title").textContent = "准备开始"; el("cap-text").textContent = "示例图完全由程序画出，没有使用任何照片。";
    el("pl-count").textContent = `0 / ${S.demoN}`; el("pl-bar").style.width = "0%";
    const run = (async () => {
      const res = await Editor.loadLog(ops, {
        mask: false, silent: true,
        delay: () => speed().delay,
        onBefore: async (o, i) => { setCaption(i); await animateOp(o, speed().anim); hideCursor(); },
        onAfter: async (o, i, before) => {
          showOp(o);
          if (o.op === "filter" && before) {
            showPixel(o.params.type, o.params.value, before, Editor.layerData(o.params.layerId));
            setRTab("pixel");
          } else if (!el("rpane-pixel").classList.contains("on") || o.op !== "filter") {
            if (i > 0 && steps[i - 1] && steps[i - 1].op.op === "filter") setRTab("log");
          }
        },
      });
      hideCursor();
      if (!res.stopped && !S.stopped) {
        el("cap-title").textContent = "演示结束 · 回放校验";
        el("cap-text").textContent = "右栏正在做两件事：① 清空画布、按日志从头回放，比较指纹；② 把日志量化成「粗 64」档再回放，算 PSNR。" +
          "接着可以切到「我来修图」在这张图上继续，或者到「练习」做任务。";
        setRTab("verify");
        await doVerify();
        if (!S.stopped) await doQuant(S.quant === "raw" ? "coarse" : S.quant);
      }
      return res;
    })();
    S.demoPromise = run;
    setPlayLabel();
    try { await run; } finally { if (S.demoPromise === run) S.demoPromise = null; setPlayLabel(); }
  }
  async function stopDemo() {
    const p = S.demoPromise;
    if (p) { Replay.stop(); try { await p; } catch (e) { /* 已停止 */ } }
    S.demoPromise = null;
    hideCursor();
  }

  /* =====================================================================
   * 练习：任务清单（按日志和事件自动打勾）
   * ===================================================================== */
  function renderTasks() {
    const firstOpen = TASKS.findIndex(t => !S.done.has(t.key));
    const touch = isTouchP();
    el("tasks").innerHTML = TASKS.map((t, i) =>
      `<li class="${S.done.has(t.key) ? "done" : i === firstOpen ? "next" : ""}">${touch ? t.ttext : t.text}</li>`).join("");
    el("task-progress").textContent = `${S.done.size} / ${TASKS.length}`;
    if (S.done.size === TASKS.length) toast("练习全部完成 🎉 你的操作日志已经是一份可回放的训练样本");
  }
  function tick(key) {
    if (S.mode !== "practice" || S.done.has(key)) return;
    S.done.add(key); renderTasks();
  }
  function checkPracticeLog() {
    if (S.mode !== "practice") return;
    const ops = OpLog.ops.slice(S.practiceBase);
    if (ops.some(o => o.op === "brush_stroke")) tick("brush");
    const added = ops.some(o => o.op === "layer_add" || o.op === "layer_duplicate");
    if (added && ops.some(o => o.op === "shape" && !S.practiceLayers.has(o.params.layerId))) tick("layer_shape");
    const u = ops.findIndex(o => o.op === "undo");
    if (u >= 0 && ops.slice(u + 1).some(o => o.op === "redo")) tick("undo_redo");
  }
  async function startPractice() {
    await stopDemo();
    const { ops } = Demo.build(CFG);
    await Editor.loadLog(ops, { delay: 0, mask: false, silent: true });
    S.practiceBase = OpLog.ops.length;
    S.practiceLayers = new Set(Doc.layers.map(l => l.id));
    S.done = new Set();
    renderTasks();
    showOp(OpLog.ops[OpLog.ops.length - 1]);
  }

  /* =====================================================================
   * 模式切换（只在顶部标签一处）
   * ===================================================================== */
  function markMode(mode) {
    document.querySelectorAll("#modes button").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
    document.querySelectorAll(".dockpane").forEach(p => p.classList.toggle("on", p.id === "dock-" + mode));
    for (const m of ["watch", "edit", "practice"]) {       // body.m-<模式>：手机竖屏的布局靠它区分观看 / 操作
      document.body.classList.toggle("m-" + m, m === mode);
      document.documentElement.classList.toggle("m-" + m, m === mode);
    }
    closeSheet(); closeMenu();
  }
  async function setMode(mode) {
    if (S.mode === mode && mode !== "watch") return;
    S.mode = mode;
    markMode(mode);
    const locked = mode === "watch";
    Editor.locked = locked;
    document.body.classList.toggle("locked", locked);
    if (mode === "watch") await runDemo();
    else if (mode === "practice") { Editor.locked = false; await startPractice(); }
    else { await stopDemo(); Editor.locked = false; }
  }

  /* =====================================================================
   * 悬停提示：小动画演示怎么操作
   * ===================================================================== */
  const TIPS = {
    move: ["移动 (V)", "按住当前图层拖动。日志记的是位移 dx、dy。"],
    "select-rect": ["矩形选区 (M)", "按住拖出一个框。之后的绘制和调整只在框里生效。"],
    "select-ellipse": ["椭圆选区", "按住拖出椭圆。Ctrl+D 取消选区。"],
    brush: ["画笔 (B)", "按住拖动画线。一笔 = 一串坐标点；[ ] 调粗细。"],
    eraser: ["橡皮擦 (E)", "按住拖动，擦成透明，露出下面的图层。"],
    fill: ["油漆桶 (G)", "单击：把颜色相近且连通的一片换成前景色。"],
    gradient: ["渐变", "按住从起点拖到终点：前景色 → 背景色。"],
    shape: ["形状 (U)", "按住拖出矩形 / 椭圆 / 直线（选项条里切换）。"],
    text: ["文字 (T)", "先在选项条输入内容，再单击画布放置。"],
    eyedropper: ["吸管 (I)", "单击画布，把那一点的颜色设为前景色。"],
    crop: ["裁剪 (C)", "拖出裁剪框，再点选项条里的“应用裁剪”。"],
    hand: ["抓手", "拖动平移视图；任何工具下按住空格也能平移。"],
  };
  function drawTip(kind, t) {
    const c = el("tip-anim"), g = c.getContext("2d"), W = c.width, H = c.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#f4f4f4"; g.fillRect(0, 0, W, H);
    const k = Math.min(1, t / 0.7);
    const cur = (x, y, down) => {
      g.save(); g.fillStyle = down ? "rgba(255,180,0,.9)" : "rgba(79,143,247,.9)";
      g.strokeStyle = "#fff"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, down ? 5 : 7, 0, 7); g.fill(); g.stroke(); g.restore();
    };
    const dash = () => { g.setLineDash([4, 3]); g.strokeStyle = "#222"; g.lineWidth = 1.2; };
    const x0 = 30, y0 = 22, x1 = 138, y1 = 80, xs = x0 + (x1 - x0) * k, ys = y0 + (y1 - y0) * k;
    switch (kind) {
      case "move": {
        const dx = 40 * k; g.fillStyle = "#4f8ff7"; g.fillRect(30 + dx, 30, 50, 36); cur(55 + dx, 48, k < 1); break;
      }
      case "select-rect": case "crop": {
        if (kind === "crop" && k >= 1) { g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, 0, W, H); g.clearRect(x0, y0, x1 - x0, y1 - y0);
          g.fillStyle = "#f4f4f4"; g.fillRect(x0, y0, x1 - x0, y1 - y0); }
        g.save(); dash(); g.strokeRect(x0, y0, xs - x0, ys - y0); g.restore(); cur(xs, ys, k < 1); break;
      }
      case "select-ellipse": {
        g.save(); dash(); g.beginPath(); g.ellipse((x0 + xs) / 2, (y0 + ys) / 2, Math.abs(xs - x0) / 2 + .1, Math.abs(ys - y0) / 2 + .1, 0, 0, 7); g.stroke(); g.restore();
        cur(xs, ys, k < 1); break;
      }
      case "brush": case "eraser": {
        if (kind === "eraser") { g.fillStyle = "#e53935"; g.fillRect(20, 40, 128, 22); }
        g.save(); g.strokeStyle = kind === "eraser" ? "#f4f4f4" : "#e53935"; g.lineWidth = kind === "eraser" ? 16 : 6;
        g.lineCap = "round"; g.beginPath();
        const n = 40, m = Math.round(n * k); let px = 20, py = 50;
        for (let i = 0; i <= m; i++) { px = 20 + 128 * i / n; py = 50 + 18 * Math.sin(i / n * 6.3); i ? g.lineTo(px, py) : g.moveTo(px, py); }
        g.stroke(); g.restore(); cur(px, py, k < 1); break;
      }
      case "fill": {
        g.strokeStyle = "#333"; g.lineWidth = 2; g.strokeRect(36, 20, 96, 60);
        if (t > 0.45) { g.fillStyle = "#4caf50"; g.fillRect(37, 21, 94, 58); }
        cur(84, 50, t > 0.35 && t < 0.55); break;
      }
      case "gradient": {
        if (k >= 1) { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, "#e53935"); gr.addColorStop(1, "#ffffff");
          g.fillStyle = gr; g.fillRect(0, 0, W, H); }
        g.strokeStyle = "#222"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y0); g.lineTo(xs, ys); g.stroke(); cur(xs, ys, k < 1); break;
      }
      case "shape": {
        g.fillStyle = "#e53935"; g.fillRect(x0, y0, xs - x0, ys - y0); cur(xs, ys, k < 1); break;
      }
      case "text": {
        if (t > 0.45) { g.fillStyle = "#e53935"; g.font = "bold 26px sans-serif"; g.textBaseline = "top"; g.fillText("你好 Aa", 40, 36); }
        cur(40, 36, t > 0.35 && t < 0.55); break;
      }
      case "eyedropper": {
        ["#e53935", "#43a047", "#1e88e5"].forEach((col, i) => { g.fillStyle = col; g.fillRect(16 + i * 48, 18, 40, 40); });
        g.fillStyle = t > 0.5 ? "#43a047" : "#999"; g.fillRect(64, 70, 40, 20); g.strokeStyle = "#222"; g.strokeRect(64, 70, 40, 20);
        cur(84, 38, t > 0.4 && t < 0.6); break;
      }
      case "hand": {
        const dx = 30 * k; g.strokeStyle = "#bbb";
        for (let x = -40; x < W + 40; x += 20) { g.beginPath(); g.moveTo(x + dx, 0); g.lineTo(x + dx, H); g.stroke(); }
        g.fillStyle = "#4f8ff7"; g.fillRect(50 + dx, 30, 40, 40); cur(84 + dx, 50, k < 1); break;
      }
    }
  }
  function showTip(btn) {
    const kind = btn.dataset.tip, info = TIPS[kind];
    if (!info || isTouchP()) return;      // 触屏：点一下会触发 mouseenter，提示会留在屏上，所以不显示悬停动画
    const tip = el("tip"), r = btn.getBoundingClientRect();
    el("tip-title").textContent = info[0]; el("tip-text").textContent = info[1];
    tip.style.display = "block";
    tip.style.left = (r.right + 8) + "px";
    tip.style.top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, r.top - 20)) + "px";
    S.tipKind = kind; S.tipT0 = performance.now();
    const loop = () => {
      if (S.tipKind !== kind || S.stopped) return;
      drawTip(kind, ((performance.now() - S.tipT0) % 2200) / 2200);
      S.tipTimer = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(S.tipTimer);
    loop();
  }
  function hideTip() { S.tipKind = null; cancelAnimationFrame(S.tipTimer); el("tip").style.display = "none"; }

  /* =====================================================================
   * 说明 / 大屏 / 退出 / 页脚
   * ===================================================================== */
  const HELP_KEY = "replayable-image-editor.help-seen";
  function openHelp() {
    el("dlg-help").classList.add("show");
    if ((S.mode === null || S.mode === "watch") && !Replay.paused) {     // 看说明时自动演示先停住
      Replay.paused = true; S.helpPaused = true; setPlayLabel();
    }
  }
  function closeHelp() {
    if (S.helpPaused) { S.helpPaused = false; Replay.paused = false; setPlayLabel(); }
    el("dlg-help").classList.remove("show");
    try { localStorage.setItem(HELP_KEY, "1"); } catch (e) { /* file:// 下可能不可用 */ }
  }
  function exitApp() {
    if (S.stopped) return;
    S.stopped = true;
    hideTip(); closeMenu(); closeSheet();
    Replay.stop();
    Editor.stop();
    if (S.ro) S.ro.disconnect();
    AppAbort.abort();
    S.demoSteps = null; S.qres = {};
    document.querySelectorAll("canvas").forEach(c => { c.width = c.height = 0; });
    try { window.close(); } catch (e) { /* 浏览器不允许 */ }
    setTimeout(() => {
      document.getElementById("layout").remove();
      for (const id of ["menu", "menu-btn", "sheet-close", "rotate-hint"]) { const n = el(id); if (n) n.remove(); }
      el("ended").classList.add("show");
      document.title = "已停止运行";
    }, 120);
  }
  function fillFooter() {   // 页脚只放纯文字署名 + 许可证（含作者有意公开的联系邮箱）
    const parts = [];
    if (CR.AUTHOR) parts.push("作者 " + CR.AUTHOR + (CR.AUTHOR_EMAIL ? `（${CR.AUTHOR_EMAIL}）` : ""));
    if (CR.UNIVERSITY_EN) parts.push(CR.UNIVERSITY_EN);
    if (CR.UNIVERSITY_KO) parts.push(CR.UNIVERSITY_KO);
    parts.push("代码 MIT · 文档 CC BY 4.0");
    if (CR.SERIES_NAME_ZH) parts.push(`${CR.SERIES_NAME_ZH}${CR.SERIES_NAME_EN ? " / " + CR.SERIES_NAME_EN : ""} 系列`);
    el("footer").textContent = parts.join(" · ");
  }

  /* =====================================================================
   * 手机竖屏：触屏 + 宽度 ≤ 980px + 竖屏 → html/body.touchp；横屏的手机 / 平板 → body.touchl（操作模式提示竖屏）
   * 头部只留标题 · 模式标签 · ☰；右栏在操作模式下收起，「看日志」全屏展开（body.sheet-log），「返回」关闭
   * ===================================================================== */
  // 触屏判断：主输入是粗指针（手指）或不能悬停。只看 maxTouchPoints 不行：带触摸屏的笔记本也 > 0，却该用电脑布局
  const mq = q => !!(window.matchMedia && matchMedia(q).matches);
  const hasTouch = () => navigator.maxTouchPoints > 0 && (mq("(pointer: coarse)") || mq("(hover: none)"));
  function updateTouchLayout() {
    const w = window.innerWidth, h = window.innerHeight, touch = hasTouch();
    const portrait = touch && w <= 980 && h >= w;
    const landscape = touch && !portrait && w > h && h <= 980 && w <= 1366;
    for (const root of [document.documentElement, document.body]) root.classList.toggle("touchp", portrait);
    document.body.classList.toggle("touchl", landscape);
    if (!portrait) { closeSheet(); closeMenu(); }
    if (S.mode === "practice") renderTasks();
  }
  function openSheet() { if (!isTouchP()) return; document.body.classList.add("sheet-log"); }
  function closeSheet() { document.body.classList.remove("sheet-log"); }
  function openMenu() { el("menu").hidden = false; el("menu-btn").setAttribute("aria-expanded", "true"); }
  function closeMenu() { const m = el("menu"); if (m && !m.hidden) { m.hidden = true; el("menu-btn").setAttribute("aria-expanded", "false"); } }
  function bindTouchUI() {
    el("menu-btn").addEventListener("click", e => { e.stopPropagation(); el("menu").hidden ? openMenu() : closeMenu(); }, ON);
    document.addEventListener("click", e => { if (!el("menu").contains(e.target)) closeMenu(); }, ON);
    el("menu-log").addEventListener("click", () => {
      closeMenu();
      if (S.mode === "watch") el("rightcol").scrollIntoView({ behavior: "smooth", block: "start" });
      else openSheet();
    }, ON);
    el("menu-export").addEventListener("click", () => { closeMenu(); OpLog.exportJSONL(); }, ON);
    el("menu-import").addEventListener("click", () => { closeMenu(); el("file-replay").click(); }, ON);
    el("menu-help").addEventListener("click", () => { closeMenu(); openHelp(); }, ON);
    el("menu-exit").addEventListener("click", () => { closeMenu(); exitApp(); }, ON);
    el("mob-undo").addEventListener("click", () => Ops.run({ op: "undo", params: {} }), ON);
    el("mob-redo").addEventListener("click", () => Ops.run({ op: "redo", params: {} }), ON);
    el("mob-export").addEventListener("click", () => OpLog.exportJSONL(), ON);
    el("mob-log").addEventListener("click", openSheet, ON);
    el("sheet-close").addEventListener("click", closeSheet, ON);
    el("rot-ok").addEventListener("click", () => document.body.classList.add("rot-ok"), ON);
    // 防误触：操作区内禁止长按菜单；窗口失焦时收起菜单
    el("viewport").addEventListener("contextmenu", e => e.preventDefault(), ON);
    window.addEventListener("blur", closeMenu, ON);
    let rt = null;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (!S.stopped) updateTouchLayout(); }, 80); };
    window.addEventListener("resize", onResize, ON);
    window.addEventListener("orientationchange", onResize, ON);
    updateTouchLayout();
  }

  /* =====================================================================
   * 编辑器事件 → 右栏
   * ===================================================================== */
  Editor.on("op", ({ op, before }) => {
    showOp(op);
    S.qres = {}; renderQuantTable();
    if (op.op === "filter" && before) {
      showPixel(op.params.type, op.params.value, before, Editor.layerData(op.params.layerId));
      setRTab("pixel");
      if (S.mode === "practice" && Doc.selection) tick("sel_filter");
    }
    checkPracticeLog();
  });
  Editor.on("adjust-preview", d => { showPixel(d.type, d.value, d.before, d.after); setRTab("pixel"); });
  Editor.on("log", ops => {
    el("log-n").textContent = ops.length;
    el("log-nd").textContent = ops.filter(o => !Ops.NONDESTRUCTIVE.has(o.op)).length;
  });
  Editor.on("verified", r => { if (r.same) tick("verify"); });
  Editor.on("quantized", r => { if (r.preset !== "raw" && r.restored) tick("quant"); });
  Editor.on("exported", () => tick("export"));
  Editor.on("loaded", () => { const last = OpLog.ops[OpLog.ops.length - 1]; if (last && !S.demoPromise) showOp(last); });

  /* =====================================================================
   * 自检（?selftest=1）：无头浏览器读取 <pre id="selftest"> 里的 JSON
   * ===================================================================== */
  function layoutCheck(tag) {
    const de = document.documentElement, vw = window.innerWidth, vh = window.innerHeight;
    const rect = id => el(id).getBoundingClientRect();
    const L = rect("leftcol"), R = rect("rightcol"), V = rect("viewport"), F = rect("footer"), T = rect("topbar");
    return { tag, vw, vh, hOverflow: de.scrollWidth - vw, vOverflow: de.scrollHeight - vh,
             leftBottom: Math.round(L.bottom), rightBottom: Math.round(R.bottom), footerBottom: Math.round(F.bottom),
             viewportW: Math.round(V.width), viewportH: Math.round(V.height),
             topbarOverflow: el("topbar").scrollWidth - Math.round(T.width),
             ok: de.scrollWidth <= vw && L.bottom <= vh + 1 && R.bottom <= vh + 1 && F.bottom <= vh + 1 &&
                 V.height >= 240 && V.width >= 300 && el("topbar").scrollWidth <= Math.round(T.width) + 1 };
  }
  async function selftest() {
    const out = { ok: false, ua: navigator.userAgent, steps: {}, layout: [], errors };
    const t0 = performance.now();
    try {
      // 1) 原自检：20 条覆盖性操作 → 指纹 → 重置并回放 → 指纹一致
      await setMode("edit");
      await OpLog.restart(960, 640, "#ffffff");
      for (const o of Demo.selftestOps()) await Ops.run(o);
      const v1 = await Editor.verify();
      out.steps.selftest_ops = { user_ops: Demo.selftestOps().length, log_len: v1.n, fp: v1.fp1, replay_fp: v1.fp2, same: v1.same };

      // 2) 示例日志：瞬间载入 → 回放一致 → 四个量化档位的 PSNR
      const demo = Demo.build(CFG);
      await Editor.loadLog(demo.ops, { delay: 0, mask: false, silent: true });
      const v2 = await Editor.verify();
      const quant = {};
      for (const p of OpTokens.PRESETS) {
        const r = await Editor.quantTest(p.key);
        quant[p.key] = { name: p.name, bins: p.bins, levels: p.levels,
                         psnr: r.psnr === Infinity ? "inf" : +r.psnr.toFixed(4), changed_pixels: r.changedPixels,
                         total_pixels: r.totalPixels, restored: r.restored };
      }
      const tokCounts = demo.ops.map(o => OpTokens.tokenize(o, OpTokens.presetByKey("medium"), { W: 960, H: 640 }).length);
      out.steps.demo = { ops: demo.ops.length, pixel_ops: demo.ops.filter(o => !Ops.NONDESTRUCTIVE.has(o.op)).length,
                         fp: v2.fp1, replay_fp: v2.fp2, same: v2.same, quant,
                         tokens_medium_total: tokCounts.reduce((a, b) => a + b, 0) };

      // 3) 旧版本标识（CFG.LEGACY_APP_IDS）的日志仍能导入
      const legacyText = [{ op: "session_start", params: { app: CFG.LEGACY_APP_IDS[0], version: 1, width: 960, height: 640 } },
        { op: "doc_new", params: { width: 960, height: 640, bg: "#ffffff" } }].map(o => JSON.stringify(o)).join("\n");
      const lp = Editor.parseLog(legacyText);
      out.steps.legacy_log = { accepted: !lp.error, legacy: !!lp.legacy, warn: lp.warn };

      // 4) 逐像素滤镜在选区内生效、选区外不变
      await OpLog.restart(200, 100, "#808080");
      await Ops.run({ op: "select_rect", params: { x: 0, y: 0, w: 100, h: 100 } });
      await Ops.run({ op: "filter", params: { layerId: 1, type: "brightness", value: 50 } });
      const d = Editor.layerData(1).data, px = (x, y) => d[(y * 200 + x) * 4];
      out.steps.filter_selection = { inside: px(20, 50), outside: px(180, 50), ok: px(20, 50) === 192 && px(180, 50) === 128 };

      // 5) 三个模式 + 说明 + 大屏，各做一次布局检查
      await setMode("practice");
      out.layout.push(layoutCheck("practice"));
      await setMode("edit");
      openHelp(); out.steps.help_open = el("dlg-help").classList.contains("show"); closeHelp();
      showTip(document.querySelector('[data-tip="brush"]')); drawTip("select-rect", 0.5); hideTip();
      out.layout.push(layoutCheck("edit"));
      el("bigscreen").click(); await new Promise(r => setTimeout(r, 30));
      out.layout.push(layoutCheck("edit+big"));
      el("bigscreen").click();
      S.speed = "instant";
      await setMode("watch");
      out.layout.push(layoutCheck("watch"));
      out.steps.watch_finished = { caption: el("cap-title").textContent, verify: el("verify-out").textContent };

      out.ok = v1.same && v2.same && quant.raw.psnr === "inf" && quant.coarse.psnr !== "inf" &&
               Object.values(quant).every(q => q.restored) && out.steps.legacy_log.accepted &&
               out.steps.legacy_log.legacy && out.steps.filter_selection.ok && out.layout.every(l => l.ok);
    } catch (e) {
      errors.push("selftest exception: " + (e && e.stack || e));
    }
    out.ms = Math.round(performance.now() - t0);
    out.ok = out.ok && errors.length === 0;
    el("selftest").textContent = JSON.stringify(out);
    document.title = out.ok ? "SELFTEST PASS" : "SELFTEST FAIL";
  }

  /* ---------- 截图状态（?shot=watch&steps=N / quant / practice），给 README 用 ---------- */
  async function shot(kind) {
    S.speed = "instant";
    if (kind === "watch") {
      const n = +(QS.get("steps") || 14);
      const { ops, steps } = Demo.build(CFG);
      S.demoSteps = steps; S.demoN = ops.length;
      S.mode = "watch";
      markMode("watch");
      Editor.locked = true; document.body.classList.add("locked");
      await Editor.loadLog(ops.slice(0, n - 1), { delay: 0, mask: false, silent: true });
      const last = ops[n - 1], before = Editor.wantsBefore(last) ? Editor.snapshotFor(last) : null;
      await Editor.replayInstant([last]);
      OpLog.ops.push({ seq: n - 1, t: 0, op: last.op, params: last.params }); OpLog.seq = n; OpLog.refresh();
      render(); UI.refreshLayers();
      setCaption(n - 1); showOp(last);
      if (before) { showPixel(last.params.type, last.params.value, before, Editor.layerData(last.params.layerId)); setRTab("pixel"); }
      el("pl-play").textContent = "▶ 继续";
    } else if (kind === "quant") {
      await setMode("edit");
      const { ops } = Demo.build(CFG);
      await Editor.loadLog(ops, { delay: 0, mask: false, silent: true });
      showOp(ops[ops.length - 1]);
      for (const p of ["raw", "fine", "medium", "coarse"]) { S.quant = p; await doQuant(p); }
      markQuant("coarse"); renderTokens(); setRTab("verify");
    } else if (kind === "practice") {
      await setMode("practice");
      await Ops.run({ op: "brush_stroke", params: { layerId: Doc.activeId, points: [[300, 300], [360, 330], [420, 300]], color: "#e53935", size: 14, opacity: 1 } });
      await Ops.run({ op: "layer_add", params: {} });
      await Ops.run({ op: "shape", params: { layerId: Doc.activeId, kind: "rect", x0: 80, y0: 80, x1: 220, y1: 180, doFill: true, doStroke: false, fill: "#ff9800", stroke: "#ffffff", lineWidth: 4 } });
      setRTab("log");
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.body.dataset.shot = "ready";          // tools/browser_check.py 等这个标记再截图
  }

  /* =====================================================================
   * 启动
   * ===================================================================== */
  let markQuant = () => {};
  async function boot() {
    document.title = CFG.APP_NAME;
    el("app-name").textContent = CFG.APP_NAME;
    el("app-tagline").textContent = CFG.TAGLINE;
    fillFooter();
    bindTouchUI();                 // 先判断手机竖屏，再启动编辑器（画布适应宽度）
    await Editor.boot();

    document.querySelectorAll("#modes button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode), ON));
    document.querySelectorAll("[data-rtab]").forEach(b => b.addEventListener("click", () => setRTab(b.dataset.rtab), ON));
    buildSeg("speed-presets", SPEEDS, S.speed, k => { S.speed = k; });
    markQuant = buildSeg("quant-presets", OpTokens.PRESETS, S.quant, k => { S.quant = k; renderTokens(); renderQuantTable(); });
    renderQuantTable(); renderTokens();

    el("pl-play").addEventListener("click", () => {
      if (!S.demoPromise) { runDemo(); return; }
      Replay.paused = !Replay.paused; setPlayLabel();
    }, ON);
    el("pl-step").addEventListener("click", () => {
      if (!S.demoPromise) return;
      Replay.paused = true; Replay.step(); setPlayLabel();
    }, ON);
    el("pl-restart").addEventListener("click", () => runDemo(), ON);
    el("btn-verify").addEventListener("click", doVerify, ON);
    el("btn-quant").addEventListener("click", () => doQuant(), ON);
    el("task-reset").addEventListener("click", startPractice, ON);
    el("help-btn").addEventListener("click", openHelp, ON);
    el("help-close").addEventListener("click", closeHelp, ON);
    el("exit-btn").addEventListener("click", exitApp, ON);
    el("bigscreen").addEventListener("change", e => document.body.classList.toggle("big", e.target.checked), ON);
    document.querySelectorAll("[data-tip]").forEach(b => {
      b.addEventListener("mouseenter", () => showTip(b), ON);
      b.addEventListener("mouseleave", hideTip, ON);
    });
    document.addEventListener("keydown", e => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || e.ctrlKey || e.metaKey) return;
      if (e.code === "KeyH") { e.preventDefault(); el("dlg-help").classList.contains("show") ? closeHelp() : openHelp(); }
      if (e.code === "Escape") { closeHelp(); UI.closeDlg(); closeSheet(); closeMenu(); }
      if (e.code === "Space" && S.mode === "watch" && S.demoPromise) { e.preventDefault(); Replay.paused = !Replay.paused; setPlayLabel(); }
    }, ON);
    // 两栏宽度变化（大屏模式、窗口缩放）时，画布跟着适应
    let rt = null;
    S.ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (!S.stopped) UI.zoomFit(); }, 60); });
    S.ro.observe(el("viewport"));

    if (QS.has("selftest")) return selftest();
    if (QS.has("shot")) return shot(QS.get("shot"));
    let seen = false;
    try { seen = localStorage.getItem(HELP_KEY) === "1"; } catch (e) { /* 忽略 */ }
    if (!seen && !QS.has("nohelp")) openHelp();
    await setMode("watch");
  }
  boot();
})();
