# -*- coding: utf-8 -*-
"""Open play/index.html in the locally installed Microsoft Edge (headless, through Playwright), run the page's
built-in self-test at 1920x1080 and 1366x768, write results/result.json, optionally take the README screenshots.

    python -m tools.browser_check                     # self-test, both sizes -> results/result.json
    python -m tools.browser_check --shots docs/img    # also write the README screenshots

Needs `pip install playwright`; no browser is downloaded: Playwright launches the installed Edge
(channel="msedge"). Edge 155+ exits immediately when started bare with --headless --dump-dom, which is why this
script drives it through the DevTools protocol instead. The EdgeLock from tools/mobile_check.py makes sure only
one Edge runs on the machine at a time and at least --min-free-mb of memory is free before launching.

The self-test (play/js/app.js `selftest()`) replays the 20-operation coverage log and the built-in demo log,
checks pixel-identical replay, quantised replay PSNR at 4 presets, legacy log ids, selection-limited per-pixel
filters, all three modes, help, big-screen mode, no horizontal overflow and no JS errors; the JSON result is read
back from <pre id="selftest">.
"""

import argparse
import contextlib
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "play" / "index.html"
RESULT = ROOT / "results" / "result.json"
SIZES = [(1920, 1080), (1366, 768)]
CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]
SHOTS = [
    ("01-watch-1920x1080.png", (1920, 1080), "shot=watch&steps=21"),
    ("02-quant-1920x1080.png", (1920, 1080), "shot=quant"),
    ("03-practice-1366x768.png", (1366, 768), "shot=practice"),
]


def find_browser():
    """Path of the installed Edge (only used to read its file version; the launch goes through Playwright)."""
    env = os.environ.get("BROWSER_EXE")
    if env and Path(env).exists():
        return env
    for c in CANDIDATES:
        if Path(c).exists():
            return c
    return None


def browser_version(exe):
    if exe and sys.platform == "win32":
        try:
            r = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-Item '{exe}').VersionInfo.ProductVersion"],
                               capture_output=True, text=True, timeout=20)
            return r.stdout.strip() or None
        except Exception:
            return None
    return None


def free_mb():
    if sys.platform != "win32":
        return None

    class MS(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullAvailPhys // (1024 * 1024)


def wait_for_memory(min_mb, max_wait_s):
    t0 = time.time()
    while True:
        f = free_mb()
        if f is None or f >= min_mb:
            return f
        if time.time() - t0 > max_wait_s:
            raise SystemExit(f"free memory {f} MB < {min_mb} MB after waiting {max_wait_s}s: browser check NOT run")
        print(f"  free memory {f} MB < {min_mb} MB, waiting...", flush=True)
        time.sleep(20)


def edge_lock():
    """The machine-wide Edge lock from tools/mobile_check.py (one Edge at a time, free-memory wait)."""
    try:
        from tools.mobile_check import EdgeLock
        return EdgeLock()
    except Exception:
        return contextlib.nullcontext()


def new_page(browser, size):
    ctx = browser.new_context(viewport={"width": size[0], "height": size[1]}, device_scale_factor=1,
                              is_mobile=False, has_touch=False, locale="zh-CN")
    page = ctx.new_page()
    return ctx, page


def selftest(browser, size):
    ctx, page = new_page(browser, size)
    try:
        page.goto(INDEX.as_uri() + "?selftest=1")
        page.wait_for_function("document.title.startsWith('SELFTEST')", timeout=180_000)
        text = page.evaluate("document.getElementById('selftest').textContent")
        return json.loads(text) if text and text.strip() else {"ok": False, "errors": ["self-test result not found"]}
    finally:
        ctx.close()


def screenshot(browser, size, query, path):
    ctx, page = new_page(browser, size)
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        page.goto(INDEX.as_uri() + "?" + query + "&nohelp=1")
        page.wait_for_function("document.body.dataset.shot === 'ready'", timeout=60_000)
        page.wait_for_timeout(300)
        page.screenshot(path=str(path), full_page=False)
    finally:
        ctx.close()
    return path.exists() and path.stat().st_size > 0


def write_result(results, version):
    r = results.get("1920x1080") or next(iter(results.values()))
    demo, st = r.get("steps", {}).get("demo", {}), r.get("steps", {}).get("selftest_ops", {})
    out = {
        "_note": "Generated by tools/browser_check.py from the page's built-in self-test (?selftest=1), run in the locally "
                 "installed Microsoft Edge through Playwright. Fingerprints are FNV-1a hashes of the flattened canvas; "
                 "they are stable within one browser engine and may differ across engines / font sets.",
        "browser": {"name": "msedge", "version": version},
        "selftest_ops": st,
        "demo": demo,
        "legacy_log": r.get("steps", {}).get("legacy_log"),
        "filter_selection": r.get("steps", {}).get("filter_selection"),
        "runs": {k: {"ok": v.get("ok"), "errors": v.get("errors"), "ms": v.get("ms"), "layout": v.get("layout")}
                 for k, v in results.items()},
    }
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return RESULT


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="directory for screenshots")
    ap.add_argument("--no-result", action="store_true", help="do not rewrite results/result.json")
    ap.add_argument("--min-free-mb", type=int, default=1500)
    ap.add_argument("--max-wait", type=int, default=900, help="seconds to wait for free memory")
    args = ap.parse_args(argv)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed (pip install playwright): browser check NOT run")
        return 2
    results, ok = {}, True
    with edge_lock(), sync_playwright() as p:
        f = wait_for_memory(args.min_free_mb, args.max_wait)
        print(f"free memory: {f} MB; launching the installed Edge through Playwright", flush=True)
        browser = p.chromium.launch(channel="msedge", headless=True)
        try:
            version = browser.version or browser_version(find_browser())
            print("browser: msedge", version)
            for size in SIZES:
                r = selftest(browser, size)
                results[f"{size[0]}x{size[1]}"] = r
                good = bool(r.get("ok")) and not r.get("errors")
                ok = ok and good
                print(f"[{size[0]}x{size[1]}] {'PASS' if good else 'FAIL'}: {json.dumps(r, ensure_ascii=False)[:1500]}", flush=True)
            if not args.no_result:
                print("wrote", write_result(results, version).relative_to(ROOT).as_posix())
            if args.shots:
                d = Path(args.shots)
                if not d.is_absolute():
                    d = ROOT / d
                for name, size, q in SHOTS:
                    done = screenshot(browser, size, q, d / name)
                    print(f"  screenshot {name}: {'ok' if done else 'FAILED'}", flush=True)
                    ok = ok and done
        finally:
            browser.close()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
