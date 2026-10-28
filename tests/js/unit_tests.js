// Node unit tests for the DOM-free parts of play/ (pixel filters, tokenizer / quantiser, demo log, config).
// Run: node tests/js/unit_tests.js   -> prints one JSON line {passed, failed, failures:[...]} and exits 1 on failure.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS = path.resolve(__dirname, "..", "..", "play", "js");
const ctx = { console, Math, JSON };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ["config.js", "pixel_filters.js", "oplog_tokens.js", "demo.js"]) {
  let src = fs.readFileSync(path.join(JS, f), "utf8");
  if (f === "config.js") src = src.replace("window.APP_CONFIG", "globalThis.APP_CONFIG");
  vm.runInContext(src, ctx, { filename: f });
}
const { PixelFilters: PF, OpTokens: OT, Demo, APP_CONFIG: CFG } = ctx;

const failures = [];
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg || "assertion failed"); }
function img(w, h, f) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = f(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
  return { width: w, height: h, data: d };
}
const same = (a, b) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
const noise = img(17, 11, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 71) % 256, (x * y * 13) % 256, 255]);

/* ---------------- 逐像素滤镜 ---------------- */
test("identity at value 0: brightness / contrast / saturate / hue / sharpen", () => {
  for (const t of ["brightness", "contrast", "saturate", "hue", "sharpen"]) assert(same(PF.apply(noise, t, 0), noise), t);
});
test("invert twice is identity, alpha untouched", () => {
  const once = PF.apply(noise, "invert", 1);
  assert(once.data[0] === 255 - noise.data[0] && once.data[3] === 255);
  assert(same(PF.apply(once, "invert", 1), noise));
});
test("brightness +50 multiplies by 1.5 and clamps", () => {
  const g = img(2, 1, () => [100, 200, 0, 255]);
  const o = PF.apply(g, "brightness", 50).data;
  assert(o[0] === 150 && o[1] === 255 && o[2] === 0, Array.from(o).join());
});
test("contrast pivots around 127.5", () => {
  const o = PF.apply(img(1, 1, () => [200, 55, 128, 255]), "contrast", 100).data;   // factor 2
  assert(o[0] === 255 && o[1] === 0 && o[2] === 129, Array.from(o).join());
});
test("grayscale uses Rec.709 luma and equal channels", () => {
  const o = PF.apply(img(1, 1, () => [255, 0, 0, 255]), "grayscale", 1).data;
  assert(o[0] === 54 && o[1] === 54 && o[2] === 54, Array.from(o).join());
});
test("saturate -100 gives a gray pixel", () => {
  const o = PF.apply(img(1, 1, () => [200, 40, 90, 255]), "saturate", -100).data;
  assert(o[0] === o[1] && o[1] === o[2], Array.from(o).join());
});
test("hue rotation 360 is (almost) identity", () => {
  const o = PF.apply(noise, "hue", 360);
  assert(o.data.every((v, i) => Math.abs(v - noise.data[i]) <= 1));
});
test("blur keeps a constant image constant and keeps transparency", () => {
  const c = img(30, 20, () => [10, 120, 230, 255]);
  assert(same(PF.apply(c, "blur", 5), c));
  const t = img(20, 20, () => [0, 0, 0, 0]);
  assert(PF.apply(t, "blur", 4).data.every(v => v === 0));
});
test("blur of an edge is monotone and stays within range", () => {
  const e = img(40, 3, x => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const o = PF.apply(e, "blur", 3).data;
  let prev = -1;
  for (let x = 0; x < 40; x++) { const v = o[(40 + x) * 4]; assert(v >= prev, `x=${x}`); prev = v; }
  assert(o[(40 + 19) * 4] > 0 && o[(40 + 19) * 4] < 255);
});
test("box sizes approximate the requested sigma", () => {
  for (const s of [1, 3, 7, 20]) {
    const w = PF.boxSizes(s, 3);
    const v = w.reduce((a, b) => a + (b * b - 1) / 12, 0);
    assert(Math.abs(Math.sqrt(v) - s) < 0.6, `sigma ${s}: ${Math.sqrt(v)}`);
  }
});
test("sharpen leaves a flat area unchanged and kernel sums to 1", () => {
  const c = img(9, 9, () => [80, 80, 80, 255]);
  assert(same(PF.apply(c, "sharpen", 60), c));
  const k = PF.explain("sharpen", 40).kernel;
  assert(Math.abs(k.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});
test("histogram counts only opaque pixels", () => {
  const h = PF.histogram(img(4, 1, x => [255, 255, 255, x < 2 ? 255 : 0]));
  assert(h.reduce((a, b) => a + b, 0) === 2 && h[63] === 2);
});

/* ---------------- token / 量化 ---------------- */
const DOC = { W: 960, H: 640 };
const stroke = { op: "brush_stroke", params: { layerId: 1, points: [[0, 0], [123, 456], [959, 639]], color: "#e53935", size: 9, opacity: 1 } };
test("raw preset changes nothing", () => {
  const q = OT.quantizeOp(stroke, "raw", DOC);
  assert(JSON.stringify(q.params) === JSON.stringify(stroke.params));
});
test("fine preset moves coordinates by at most half a bin", () => {
  const q = OT.quantizeOp(stroke, "fine", DOC);
  q.params.points.forEach(([x, y], i) => {
    assert(Math.abs(x - stroke.params.points[i][0]) <= 960 / 1024 / 2 + 0.5);
    assert(Math.abs(y - stroke.params.points[i][1]) <= 640 / 1024 / 2 + 0.5);
  });
  assert(q.params.color === "#e53935" && q.params.size === 9);
});
test("coarse preset quantises colours to 4 levels per channel", () => {
  const q = OT.quantizeOp(stroke, "coarse", DOC);
  const n = parseInt(q.params.color.slice(1), 16), ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  assert(ch.every(c => [32, 96, 160, 224].includes(c)), q.params.color);
});
test("layer_move deltas keep their sign under quantisation", () => {
  const q = OT.quantizeOp({ op: "layer_move", params: { layerId: 2, dx: -40, dy: 25 } }, "medium", DOC);
  assert(q.params.dx < 0 && q.params.dy > 0 && Math.abs(q.params.dx + 40) <= 4, JSON.stringify(q.params));
});
test("quantizeLog follows crop size", () => {
  const ops = [{ op: "doc_new", params: { width: 960, height: 640, bg: "#fff" } },
               { op: "crop", params: { x: 0, y: 0, w: 100, h: 100 } },
               { op: "fill", params: { layerId: 1, x: 50, y: 50, color: "#000000", tolerance: 0 } }];
  const q = OT.quantizeLog(ops, "coarse");
  // after the crop the document is 100 px wide: bin 32 of 64 -> centre 50.78 -> 51 (on 960 px it would be 53)
  assert(q[2].params.x === 51 && q[2].params.y === 51, JSON.stringify(q[2].params));
});
test("tokenize starts with the op and ends with <eos>", () => {
  for (const key of ["raw", "fine", "medium", "coarse"]) {
    const t = OT.tokenize(stroke, OT.presetByKey(key), DOC);
    assert(t[0] === "<brush_stroke>" && t[t.length - 1] === "<eos>", key);
    assert(t.includes("pts#3"), key);
  }
  assert(OT.tokenize(stroke, OT.presetByKey("medium"), DOC).includes("x:32"));     // 123/960*256 = 32.8
});
test("psnr: identical is Infinity, known MSE is exact", () => {
  const a = new Uint8ClampedArray([10, 10, 10, 255, 20, 20, 20, 255]);
  assert(OT.psnr(a, a).psnr === Infinity);
  const b = new Uint8ClampedArray([12, 10, 10, 255, 20, 20, 20, 255]);      // MSE = 4/6
  const r = OT.psnr(a, b);
  assert(Math.abs(r.psnr - 10 * Math.log10(255 * 255 / (4 / 6))) < 1e-9 && r.changedPixels === 1);
});
test("fingerprint is FNV-1a and order sensitive", () => {
  assert(OT.fingerprint(new Uint8Array([])) === "811c9dc5");
  assert(OT.fingerprint(new Uint8Array([97])) === "e40c292c");                  // FNV-1a("a")
  assert(OT.fingerprint(new Uint8Array([1, 2])) !== OT.fingerprint(new Uint8Array([2, 1])));
});

/* ---------------- 示例日志与配置 ---------------- */
const editorSrc = fs.readFileSync(path.join(JS, "editor.js"), "utf8");
const KNOWN = new Set([...editorSrc.matchAll(/case "([a-z_]+)":/g)].map(m => m[1]));
test("demo log only uses operations the editor implements", () => {
  const { ops, steps } = Demo.build(CFG);
  assert(ops.length === steps.length && ops.length >= 20);
  for (const o of ops) assert(KNOWN.has(o.op), o.op);
  for (const o of Demo.selftestOps()) assert(KNOWN.has(o.op), o.op);
  assert(ops[0].op === "session_start" && ops[0].params.app === CFG.LOG_APP_ID && ops[1].op === "doc_new");
  for (const s of steps) assert(s.title && s.text, "every step has a caption");
});
test("demo log references only layers that exist at that moment", () => {
  let next = 1;
  const ids = new Set();
  for (const { op, params } of Demo.build(CFG).ops) {
    if (op === "doc_new") { ids.clear(); ids.add(next = 1); next = 2; continue; }
    if (params && params.layerId !== undefined) assert(ids.has(params.layerId), `${op} -> layer ${params.layerId}`);
    if (op === "layer_add" || op === "text_add" || op === "layer_duplicate") ids.add(next++);
  }
});
test("config: neutral names, legacy id accepted, generic fonts first", () => {
  const banned = /photo\s*shop|adobe|\bPS\b/i;
  for (const k of ["APP_NAME", "APP_NAME_EN", "TAGLINE", "LOG_APP_ID", "EXPORT_PREFIX", "DEFAULT_TEXT"])
    assert(!banned.test(CFG[k]), k);
  assert(CFG.LEGACY_APP_IDS.includes("WebPS"));
  assert(CFG.FONTS.slice(0, 3).join() === "sans-serif,serif,monospace");
});

process.stdout.write(JSON.stringify({ passed, failed: failures.length, failures }) + "\n");
process.exit(failures.length ? 1 : 0);
