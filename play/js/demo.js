/* =====================================================================
 * 示例日志：一张完全由程序画出的风景（渐变天空、太阳、山丘、云、飞鸟、文字），
 * 不使用任何照片。每条操作配一句中文说明，给「看回放」模式用。
 * 返回的 ops 与用户手动操作产生的日志格式完全相同（可导出、可导入回放）。
 * ===================================================================== */
(function (root) {
  "use strict";

  function build(cfg) {
    const appId = (cfg && cfg.LOG_APP_ID) || "replayable-image-editor";
    const steps = [];
    const add = (op, params, title, text) => steps.push({ op: { op, params }, title, text });

    add("session_start", { app: appId, version: 1, width: 960, height: 640 },
      "会话头", "日志的第一行：哪个程序、什么版本、画布多大。它本身不改变画面。");
    add("doc_new", { width: 960, height: 640, bg: "#ffffff" },
      "新建文档", "960×640 白色画布，同时清空图层和撤销历史——这就是回放的“起点”。");
    add("tool_select", { tool: "gradient" },
      "选择渐变工具", "选工具也被记录下来：它不改像素（灰色），但对“学人怎么修图”是有用的上下文。");
    add("gradient", { layerId: 1, x0: 480, y0: 0, x1: 480, y1: 640, c0: "#2f6fd6", c1: "#ffd8a8" },
      "线性渐变 → 天空", "只记两个端点和两种颜色，就能还原整片天空：参数比像素小得多。");
    add("shape", { layerId: 1, kind: "ellipse", x0: 640, y0: 90, x1: 780, y1: 230, doFill: true, doStroke: false,
      fill: "#ffcf3f", stroke: "#ffffff", lineWidth: 4 },
      "画椭圆 → 太阳", "形状 = 种类 + 外接框两个角 + 填充色。坐标都是文档像素坐标。");
    add("layer_add", {},
      "新建图层 2", "山丘画在单独的图层上，后面可以单独调整它而不影响天空。图层编号由执行器按顺序分配，保证回放一致。");
    add("shape", { layerId: 2, kind: "ellipse", x0: -160, y0: 430, x1: 620, y1: 980, doFill: true, doStroke: false,
      fill: "#3f8f4a", stroke: "#ffffff", lineWidth: 4 },
      "大椭圆 → 左边的山", "椭圆的一部分画到了画布外面，只有画布里的部分会留下。");
    add("shape", { layerId: 2, kind: "ellipse", x0: 380, y0: 470, x1: 1150, y1: 1020, doFill: true, doStroke: false,
      fill: "#2c6e3a", stroke: "#ffffff", lineWidth: 4 },
      "大椭圆 → 右边的山", "同一个图层上再画一个颜色更深的椭圆。");
    add("fill", { layerId: 2, x: 120, y: 600, color: "#58b368", tolerance: 16 },
      "油漆桶 → 给左边的山换颜色", "洪水填充：从点击处出发，把颜色相近（容差 16 以内）且连通的像素都换掉；右边那座山颜色差得多，不受影响。");
    add("layer_add", {},
      "新建图层 3", "云和飞鸟放在第三个图层。");
    add("tool_select", { tool: "brush" }, "选择画笔", "又一条上下文信号。");
    add("brush_stroke", { layerId: 3, points: [[140, 150], [180, 136], [230, 138], [280, 150], [320, 156]],
      color: "#ffffff", size: 46, opacity: 0.9 },
      "粗白笔画 → 云", "一笔 = 一串坐标点 + 颜色 + 粗细 + 不透明度。点越多 token 越多，这是训练数据里最长的部分。");
    add("brush_stroke", { layerId: 3, points: [[430, 205], [470, 192], [515, 196], [550, 206]],
      color: "#ffffff", size: 34, opacity: 0.85 },
      "再一朵云", "第二笔。");
    add("filter", { layerId: 3, type: "blur", value: 7 },
      "高斯模糊 → 云边变柔", "整个图层做模糊：三次盒式模糊近似高斯（σ = 7 像素）。右栏「像素原理」显示前后直方图。");
    add("brush_stroke", { layerId: 3, points: [[560, 150], [574, 140], [588, 150], [602, 140], [616, 150]],
      color: "#263238", size: 4, opacity: 1 },
      "细黑笔画 → 飞鸟", "模糊之后再画，所以飞鸟是清晰的——操作的先后顺序决定结果。");
    add("layer_blend", { layerId: 3, mode: "screen" },
      "混合模式：滤色", "图层属性也是操作：滤色让云叠在天空上更亮、更透。");
    add("select_ellipse", { x: 600, y: 60, w: 220, h: 200 },
      "椭圆选区 → 圈住太阳", "选区本身不改像素，但会限制后面的绘制和调整只在选区里生效。");
    add("filter", { layerId: 1, type: "brightness", value: 35 },
      "亮度 +35（只在选区内）", "每个通道 × 1.35，只作用在选区里：太阳周围亮起来一圈。");
    add("deselect", {}, "取消选区", "Ctrl+D。");
    add("filter", { layerId: 1, type: "saturate", value: 30 },
      "饱和度 +30（整个天空）", "3×3 颜色矩阵：让颜色更“艳”。右栏能看到矩阵的 9 个数。");
    add("filter", { layerId: 2, type: "sharpen", value: 40 },
      "锐化 40 → 山的边缘", "3×3 卷积核：中心加权、减去上下左右邻居，边缘对比变强。");
    add("tool_select", { tool: "text" }, "选择文字工具", "上下文信号。");
    add("text_add", { x: 40, y: 560, text: "可回放的风景", size: 44, color: "#ffffff", font: "sans-serif" },
      "加文字", "文字会自动新建一个图层（图层 4）。用通用字体 sans-serif，换电脑时字形可能略有不同。");
    add("layer_move", { layerId: 4, dx: 12, dy: -8 },
      "移动文字图层", "记录的是位移 (dx, dy)，不是新位置。");
    add("eraser_stroke", { layerId: 2, points: [[870, 600], [930, 560]], size: 36, opacity: 1 },
      "橡皮擦 → 擦掉一块山", "擦掉的地方露出下面的天空。");
    add("undo", {}, "撤销", "撤销也被记录：模型能学到“试了一下又后悔”的行为。");
    add("redo", {}, "重做", "重做同样是一条操作。");
    add("layer_opacity", { layerId: 4, opacity: 0.9 },
      "文字不透明度 90%", "最后一步。整段日志就是这张图的“配方”：右栏可以重置并回放，验证指纹一致。");

    return { ops: steps.map(s => s.op), steps };
  }

  /* 原内部版本自检页用的 20 条覆盖性操作（字体改成通用的 sans-serif） */
  function selftestOps() {
    return [
      { op: "brush_stroke", params: { layerId: 1, points: [[100, 100], [300, 160], [420, 120], [500, 200]], color: "#e53935", size: 18, opacity: 1 } },
      { op: "brush_stroke", params: { layerId: 1, points: [[120, 300], [200, 280]], color: "#3f51b5", size: 40, opacity: 0.5 } },
      { op: "layer_add", params: {} },
      { op: "shape", params: { layerId: 2, kind: "rect", x0: 150, y0: 200, x1: 400, y1: 330, doFill: true, doStroke: true, fill: "#2196f3", stroke: "#ffffff", lineWidth: 5 } },
      { op: "shape", params: { layerId: 2, kind: "ellipse", x0: 430, y0: 210, x1: 560, y1: 320, doFill: true, doStroke: false, fill: "#ffc107", stroke: "#000000", lineWidth: 2 } },
      { op: "select_rect", params: { x: 200, y: 240, w: 260, h: 160 } },
      { op: "filter", params: { layerId: 1, type: "hue", value: 90 } },
      { op: "deselect", params: {} },
      { op: "gradient", params: { layerId: 2, x0: 500, y0: 100, x1: 800, y1: 400, c0: "#ff9800", c1: "#9c27b0" } },
      { op: "fill", params: { layerId: 2, x: 700, y: 520, color: "#4caf50", tolerance: 32 } },
      { op: "text_add", params: { x: 520, y: 470, text: "回放自检", size: 42, color: "#102027", font: "sans-serif" } },
      { op: "transform", params: { layerId: 3, scale: 90, rotate: -8, flipH: false, flipV: false } },
      { op: "eraser_stroke", params: { layerId: 2, points: [[600, 200], [680, 260]], size: 30, opacity: 1 } },
      { op: "layer_opacity", params: { layerId: 2, opacity: 0.85 } },
      { op: "select_ellipse", params: { x: 80, y: 380, w: 240, h: 180 } },
      { op: "filter", params: { layerId: 1, type: "blur", value: 6 } },
      { op: "deselect", params: {} },
      { op: "undo", params: {} },
      { op: "redo", params: {} },
      { op: "layer_move", params: { layerId: 2, dx: 14, dy: -9 } },
    ];
  }

  root.Demo = { build, selftestOps };
})(typeof window !== "undefined" ? window : globalThis);
