/* =====================================================================
 * 逐像素调整与滤镜（纯函数，不依赖 DOM，浏览器和 Node 测试共用）
 *
 * 输入输出都是 {width, height, data}（data 为 RGBA 的 Uint8ClampedArray / Uint8Array）。
 * 公式按 W3C Filter Effects 规范里同名 CSS 滤镜的定义逐像素计算，
 * 每个通道最后都 Math.round 再夹到 0..255 —— 同一浏览器内核里结果是确定的。
 *   brightness  c' = c · (1 + v/100)
 *   contrast    c' = (c − 127.5) · (1 + v/100) + 127.5
 *   saturate    3×3 颜色矩阵（s = 1 + v/100）
 *   hue         3×3 颜色矩阵（色相旋转 v 度）
 *   invert      c' = 255 − c
 *   grayscale   Y = 0.2126 R + 0.7152 G + 0.0722 B
 *   blur        三次盒式模糊近似高斯（σ = v 像素，预乘 alpha 防止透明边缘发黑）
 *   sharpen     3×3 卷积核 [0 −k 0; −k 1+4k −k; 0 −k 0]，k = v/50（边缘按最近像素延伸）
 * ===================================================================== */
(function (root) {
  "use strict";

  const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  function makeLike(img) {
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) };
  }

  function perChannel(img, f) {
    const out = makeLike(img), s = img.data, o = out.data;
    for (let i = 0; i < s.length; i += 4) {
      o[i] = clamp255(f(s[i])); o[i + 1] = clamp255(f(s[i + 1])); o[i + 2] = clamp255(f(s[i + 2]));
      o[i + 3] = s[i + 3];
    }
    return out;
  }

  function colorMatrix(img, m) {
    const out = makeLike(img), s = img.data, o = out.data;
    for (let i = 0; i < s.length; i += 4) {
      const r = s[i], g = s[i + 1], b = s[i + 2];
      o[i]     = clamp255(m[0] * r + m[1] * g + m[2] * b);
      o[i + 1] = clamp255(m[3] * r + m[4] * g + m[5] * b);
      o[i + 2] = clamp255(m[6] * r + m[7] * g + m[8] * b);
      o[i + 3] = s[i + 3];
    }
    return out;
  }

  function saturateMatrix(s) {
    return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
            0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
            0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  }

  function hueMatrix(deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), n = Math.sin(a);
    return [0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
            0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140, 0.072 - c * 0.072 - n * 0.283,
            0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072];
  }

  /* 三次盒式模糊的盒宽（Kovesi 的“用 n 个盒子逼近高斯”公式） */
  function boxSizes(sigma, n) {
    const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    const sizes = [];
    for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
    return sizes;
  }

  /* 一维盒式模糊（边缘按最近像素延伸），在 Float64Array 的 4 个通道上原地做 */
  function boxPass(src, dst, W, H, r, horizontal) {
    const len = horizontal ? W : H, lines = horizontal ? H : W;
    const step = horizontal ? 4 : W * 4;
    const norm = 1 / (2 * r + 1);
    for (let line = 0; line < lines; line++) {
      const base = horizontal ? line * W * 4 : line * 4;
      for (let ch = 0; ch < 4; ch++) {
        const at = k => src[base + Math.min(len - 1, Math.max(0, k)) * step + ch];
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += at(k);
        for (let k = 0; k < len; k++) {
          dst[base + k * step + ch] = acc * norm;
          acc += at(k + r + 1) - at(k - r);
        }
      }
    }
  }

  function blur(img, sigma) {
    if (!(sigma > 0)) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
    const W = img.width, H = img.height, s = img.data;
    let a = new Float64Array(s.length), b = new Float64Array(s.length);
    for (let i = 0; i < s.length; i += 4) {           // 预乘 alpha
      const al = s[i + 3] / 255;
      a[i] = s[i] * al; a[i + 1] = s[i + 1] * al; a[i + 2] = s[i + 2] * al; a[i + 3] = s[i + 3];
    }
    for (const w of boxSizes(sigma, 3)) {
      const r = (w - 1) / 2;
      boxPass(a, b, W, H, r, true);
      boxPass(b, a, W, H, r, false);
    }
    const out = makeLike(img), o = out.data;
    for (let i = 0; i < s.length; i += 4) {
      const al = a[i + 3];
      o[i + 3] = clamp255(al);
      if (al > 0.0001) {
        const k = 255 / al;
        o[i] = clamp255(a[i] * k); o[i + 1] = clamp255(a[i + 1] * k); o[i + 2] = clamp255(a[i + 2] * k);
      }
    }
    return out;
  }

  function sharpen(img, amount) {
    const k = amount / 50, W = img.width, H = img.height, s = img.data;
    const out = makeLike(img), o = out.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const l = x > 0 ? i - 4 : i, r = x < W - 1 ? i + 4 : i;          // 边缘按最近像素延伸
        const u = y > 0 ? i - W * 4 : i, d = y < H - 1 ? i + W * 4 : i;
        for (let ch = 0; ch < 3; ch++)
          o[i + ch] = clamp255(s[i + ch] * (1 + 4 * k) - k * (s[l + ch] + s[r + ch] + s[u + ch] + s[d + ch]));
        o[i + 3] = s[i + 3];
      }
    }
    return out;
  }

  /* 统一入口：type 与操作日志里的 filter.type 一一对应 */
  function apply(img, type, value) {
    const v = +value;
    switch (type) {
      case "brightness": { const f = 1 + v / 100; return perChannel(img, c => c * f); }
      case "contrast":   { const f = 1 + v / 100; return perChannel(img, c => (c - 127.5) * f + 127.5); }
      case "saturate":   return colorMatrix(img, saturateMatrix(1 + v / 100));
      case "hue":        return colorMatrix(img, hueMatrix(v));
      case "invert":     return perChannel(img, c => 255 - c);
      case "grayscale":  return colorMatrix(img, [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722]);
      case "blur":       return blur(img, v);
      case "sharpen":    return sharpen(img, v);
      default: throw new Error("未知滤镜 " + type);
    }
  }

  /* 右栏“像素原理”用：每种滤镜的公式说明和（如有）卷积核 */
  function explain(type, value) {
    const v = +value;
    const r2 = x => Math.round(x * 100) / 100;
    switch (type) {
      case "brightness": return { formula: `每个通道 × ${r2(1 + v / 100)}`, kind: "逐点" };
      case "contrast":   return { formula: `(c − 127.5) × ${r2(1 + v / 100)} + 127.5`, kind: "逐点" };
      case "saturate":   return { formula: `3×3 颜色矩阵，饱和度系数 s = ${r2(1 + v / 100)}`, kind: "颜色矩阵",
                                  matrix: saturateMatrix(1 + v / 100).map(r2) };
      case "hue":        return { formula: `3×3 颜色矩阵，色相旋转 ${v}°`, kind: "颜色矩阵", matrix: hueMatrix(v).map(r2) };
      case "invert":     return { formula: "c' = 255 − c", kind: "逐点" };
      case "grayscale":  return { formula: "Y = 0.2126 R + 0.7152 G + 0.0722 B", kind: "逐点" };
      case "blur":       return { formula: `三次盒式模糊近似高斯，σ = ${v} 像素，盒宽 ${boxSizes(Math.max(v, 0.01), 3).join(" / ")}`,
                                  kind: "邻域平均" };
      case "sharpen": {
        const k = r2(v / 50);
        return { formula: `3×3 卷积核，k = ${k}`, kind: "卷积", kernel: [0, -k, 0, -k, r2(1 + 4 * k), -k, 0, -k, 0] };
      }
      default: return { formula: "", kind: "" };
    }
  }

  /* 亮度直方图（64 档），给右栏画图 */
  function histogram(img, bins) {
    bins = bins || 64;
    const h = new Array(bins).fill(0), s = img.data;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i + 3] === 0) continue;
      const y = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2];
      h[Math.min(bins - 1, Math.floor(y / 256 * bins))]++;
    }
    return h;
  }

  root.PixelFilters = { apply, explain, histogram, boxSizes, saturateMatrix, hueMatrix, TYPES:
    ["brightness", "contrast", "saturate", "hue", "blur", "sharpen", "invert", "grayscale"] };
})(typeof window !== "undefined" ? window : globalThis);
