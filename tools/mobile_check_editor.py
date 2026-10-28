# -*- coding: utf-8 -*-
"""Phone / desktop acceptance of play/index.html (six device sizes, DevTools-protocol emulation).

    python -m tools.mobile_check_editor                 # -> results/mobile_check.json + docs/img/04-mobile-edit-390x844.png
    python -m tools.mobile_check_editor --out DIR       # keep all six screenshots + the raw report in DIR
    python -m tools.mobile_check_editor --no-write      # only check (used by RUN_BROWSER=1 pytest)

Playwright drives the locally installed Microsoft Edge (channel "msedge", nothing is downloaded) and emulates
390x844, 414x896, 360x780 (DPR 3) and 768x1024 (DPR 2) with touch, plus 1920x1080 and 1366x768 desktop.
Window-size tricks are not used: a headless Edge window cannot be narrower than ~500 px, which fakes overflow.

Every size: no horizontal overflow, no JS error (page error / console.error), one screenshot. Scenario on top:
  * first-open help closes with a tap; on touch sizes it shows the touch diagram and hides the keyboard list;
  * "watch" mode: the right column is on the page below the canvas (touch) / beside it (desktop);
  * "practice" and "edit" modes: the whole page does not scroll (operation modes are one 100dvh screen);
  * one brush stroke drawn with an emulated touch sequence (touch sizes) or the mouse (desktop):
    the operation log grows by exactly one `brush_stroke` and the canvas fingerprint changes;
  * the log panel opens full-screen with "看日志" and closes with "返回" (touch); the menu opens the help overlay.

The generic runner is tools/mobile_check.py (Edge lock so only one Edge runs on the machine, free-memory wait,
device emulation, screenshots); pip install playwright, nothing is downloaded (channel="msedge").
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "play" / "index.html"
RESULT = ROOT / "results" / "mobile_check.json"
README_SHOT = ROOT / "docs" / "img" / "04-mobile-edit-390x844.png"
README_SHOT_SOURCE = "m390x844"          # the size whose final state (edit mode, one stroke drawn) goes into README


# ---------------------------------------------------------------- helpers run inside the page
JS_STATE = """() => ({
  touchp: document.body.classList.contains('touchp'),
  mode: document.body.className.match(/m-(watch|edit|practice)/) ? RegExp.$1 : null,
  sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
  iw: innerWidth, ih: innerHeight, scrollY: window.scrollY,
  logLen: OpLog.ops.length, lastOp: OpLog.ops.length ? OpLog.ops[OpLog.ops.length - 1].op : null,
  fp: Editor.fingerprint(),
  helpOpen: document.getElementById('dlg-help').classList.contains('show'),
  sheet: document.body.classList.contains('sheet-log'),
  menuHidden: document.getElementById('menu').hidden,
  tasks: document.querySelectorAll('#tasks li').length,
})"""
JS_RECT = """sel => { const r = document.querySelector(sel).getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; }"""
JS_VISIBLE = """sel => { const n = document.querySelector(sel); if (!n) return false; const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; }"""
JS_DOC_RECT = """() => { const r = document.getElementById('viewport').getBoundingClientRect();
  return { x: r.left + View.x, y: r.top + View.y, w: Doc.W * View.z, h: Doc.H * View.z }; }"""


def touch_drag(page, points, step_ms=40):
    """Emulated single-finger drag through the DevTools protocol (Input.dispatchTouchEvent -> pointer events).
    ~40 ms per point = a real drawing motion (about half a second). A much faster swipe is treated by the browser
    as a fling, and the next tap is then consumed to stop that fling instead of producing a click."""
    cdp = page.context.new_cdp_session(page)
    try:
        x, y = points[0]
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for x, y in points[1:]:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
            page.wait_for_timeout(step_ms)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    finally:
        cdp.detach()


def mouse_drag(page, points, step_ms=25):
    page.mouse.move(*points[0])
    page.mouse.down()
    for x, y in points[1:]:
        page.mouse.move(x, y)
        page.wait_for_timeout(step_ms)
    page.mouse.up()


def stroke_points(rect, n=14):
    """A gentle wave across the middle of the document rectangle (screen coordinates)."""
    x0, x1 = rect["x"] + rect["w"] * 0.15, rect["x"] + rect["w"] * 0.85
    ym = rect["y"] + rect["h"] * 0.55
    return [(x0 + (x1 - x0) * i / (n - 1), ym + rect["h"] * 0.12 * (1 if i % 2 else -1) * (i % 3) / 2) for i in range(n)]


def scenario(page, size) -> list[str]:
    fails: list[str] = []
    mobile = size["kind"] == "mobile"

    def press(sel, timeout=5000):
        """Tap (touch sizes) / click (desktop); a miss is recorded as a failure instead of aborting the scenario."""
        try:
            (page.tap if mobile else page.click)(sel, timeout=timeout)
            return True
        except Exception as e:  # noqa: BLE001
            fails.append("点不到 %s：%s" % (sel, str(e).splitlines()[0]))
            return False

    st = page.evaluate(JS_STATE)

    # 0) first-open help overlay
    if not st["helpOpen"]:
        fails.append("首次打开没有弹出操作说明")
    else:
        if mobile:
            if not page.evaluate(JS_VISIBLE, ".help-touch"):
                fails.append("触屏说明图解没有显示")
            if page.evaluate(JS_VISIBLE, ".help-kbd"):
                fails.append("触屏设备仍显示键盘快捷键列表")
            r = page.evaluate(JS_RECT, "#help-close")
            if r["bottom"] > st["ih"] + 1 or r["h"] < 44:
                fails.append("「开始」按钮不在视口底部或触控区 < 44px：%s" % r)
        press("#help-close")
        page.wait_for_timeout(200)
    st = page.evaluate(JS_STATE)
    if st["helpOpen"]:
        fails.append("操作说明没有关闭")
    if mobile != st["touchp"]:
        fails.append("body.touchp=%s 但尺寸类型是 %s" % (st["touchp"], size["kind"]))

    # 1) watch mode (default): right column present; on touch it sits below the canvas and the page scrolls to it
    if st["mode"] != "watch":
        fails.append("默认模式不是看回放：%s" % st["mode"])
    if not page.evaluate(JS_VISIBLE, "#rightcol"):
        fails.append("看回放模式右栏不可见")
    if mobile:
        vr, rr = page.evaluate(JS_RECT, "#viewport"), page.evaluate(JS_RECT, "#rightcol")
        if not (rr["y"] >= vr["bottom"] - 1):
            fails.append("看回放：右栏没有排在画布下方 viewport.bottom=%s rightcol.top=%s" % (vr["bottom"], rr["y"]))
        if vr["w"] < size["w"] - 24:
            fails.append("看回放：画布区没有占满宽度 %s / %s" % (vr["w"], size["w"]))

    # 2) practice mode: one screen, no page scroll, 7 tasks
    press('#modes button[data-mode="practice"]')
    page.wait_for_timeout(600)
    st = page.evaluate(JS_STATE)
    if st["mode"] != "practice":
        fails.append("没有切到练习模式")
    if st["sh"] > st["ih"] + 1:
        fails.append("练习模式整页还能滚动 scrollHeight=%d innerHeight=%d" % (st["sh"], st["ih"]))
    if st["tasks"] != 7:
        fails.append("练习任务数 %d != 7" % st["tasks"])

    # 3) edit mode: one screen; draw one stroke with touch / mouse
    press('#modes button[data-mode="edit"]')
    page.wait_for_timeout(600)
    st = page.evaluate(JS_STATE)
    if st["mode"] != "edit":
        fails.append("没有切到我来修图")
    if st["sh"] > st["ih"] + 1:
        fails.append("我来修图整页还能滚动 scrollHeight=%d innerHeight=%d" % (st["sh"], st["ih"]))
    if mobile and page.evaluate(JS_VISIBLE, "#rightcol"):
        fails.append("手机操作模式下右栏没有收起")
    if mobile:
        for sel in ("#mob-undo", "#mob-redo", "#mob-export", "#mob-log", "#menu-btn", '#toolbar button[data-tool="brush"]'):
            r = page.evaluate(JS_RECT, sel)
            if r["h"] < 44 or r["w"] < 44:
                fails.append("触控区 < 44px：%s %dx%d" % (sel, r["w"], r["h"]))
            if r["bottom"] > st["ih"] + 1 or r["y"] < 0:
                fails.append("按钮不在视口内：%s %s" % (sel, r))
    press('#toolbar button[data-tool="brush"]')
    page.wait_for_timeout(100)
    doc = page.evaluate(JS_DOC_RECT)
    vp = page.evaluate(JS_RECT, "#viewport")
    if mobile and doc["w"] < vp["w"] - 40:
        fails.append("手机：画板没有占满宽度 doc.w=%.0f viewport.w=%.0f" % (doc["w"], vp["w"]))
    if doc["h"] < 100 or doc["w"] < 150:
        fails.append("画板太小：%s" % doc)
    before = page.evaluate(JS_STATE)
    pts = stroke_points(doc)
    (touch_drag if mobile else mouse_drag)(page, pts)
    page.wait_for_timeout(500)
    after = page.evaluate(JS_STATE)
    if after["logLen"] != before["logLen"] + 1 or after["lastOp"] != "brush_stroke":
        fails.append("画一笔后日志没有恰好多一条 brush_stroke：%d -> %d (%s)" % (before["logLen"], after["logLen"], after["lastOp"]))
    if after["fp"] == before["fp"]:
        fails.append("画一笔后画布指纹没有变化")
    if after["sh"] > after["ih"] + 1 or after["scrollY"] > 0:
        fails.append("画一笔后页面发生了滚动 scrollY=%s" % after["scrollY"])

    # 4) log panel open / close (touch: full-screen sheet; desktop: always visible)
    if mobile:
        press("#mob-log")
        page.wait_for_timeout(250)
        st = page.evaluate(JS_STATE)
        if not st["sheet"] or not page.evaluate(JS_VISIBLE, "#rightcol") or not page.evaluate(JS_VISIBLE, "#sheet-close"):
            fails.append("「看日志」没有全屏打开右栏")
        else:
            rr = page.evaluate(JS_RECT, "#rightcol")
            if rr["right"] > size["w"] + 1 or rr["bottom"] > st["ih"] + 1:
                fails.append("日志面板超出视口：%s" % rr)
        press("#sheet-close")
        page.wait_for_timeout(250)
        st = page.evaluate(JS_STATE)
        if st["sheet"] or page.evaluate(JS_VISIBLE, "#rightcol"):
            fails.append("「返回」没有关闭日志面板")
        # 5) menu -> help overlay -> close
        press("#menu-btn")
        page.wait_for_timeout(150)
        if page.evaluate(JS_STATE)["menuHidden"]:
            fails.append("☰ 菜单没有打开")
        press("#menu-help")
        page.wait_for_timeout(200)
        st = page.evaluate(JS_STATE)
        if not st["helpOpen"] or not st["menuHidden"]:
            fails.append("菜单里的「操作说明」没有打开说明（或菜单没有收起）")
        press("#help-close")
        page.wait_for_timeout(150)
    else:
        if not page.evaluate(JS_VISIBLE, "#rightcol"):
            fails.append("电脑：右栏不可见")
        if page.evaluate(JS_VISIBLE, "#menu-btn") or page.evaluate(JS_VISIBLE, "#mob-actions"):
            fails.append("电脑：手机专用的 ☰ / 大按钮不该显示")
    st = page.evaluate(JS_STATE)
    if st["sh"] > st["ih"] + 1:
        fails.append("结束时整页还能滚动 scrollHeight=%d innerHeight=%d" % (st["sh"], st["ih"]))
    return fails


def browser_version():
    try:
        from tools.browser_check import browser_version as bv, find_browser
        exe = find_browser()
        return {"name": Path(exe).stem if exe else "msedge", "version": bv(exe) if exe else None}
    except Exception:
        return {"name": "msedge", "version": None}


def write_outputs(report, out_dir: Path):
    rec = {
        "_note": "Generated by tools/mobile_check_editor.py: Playwright + locally installed Edge, DevTools-protocol device "
                 "emulation (size, DPR, mobile viewport, touch). Each size: no horizontal overflow, no JS error, plus the "
                 "scenario assertions listed in the script (one-screen operation modes, one touch/mouse brush stroke adds "
                 "exactly one brush_stroke and changes the canvas fingerprint, log panel opens and closes, menu/help).",
        "browser": browser_version(),
        "page": "play/index.html",
        "ok": report["ok"],
        "sizes": [{**{k: v for k, v in s.items() if k != "screenshot"}, "screenshot": Path(s["screenshot"]).name}
                  for s in report["sizes"]],
    }
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    src = out_dir / (README_SHOT_SOURCE + ".png")
    if src.exists():
        README_SHOT.parent.mkdir(parents=True, exist_ok=True)
        try:
            from PIL import Image
            im = Image.open(src)
            im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)     # DPR 3 -> half size keeps the repo small
            im.save(README_SHOT, "PNG", optimize=True)
        except Exception:
            shutil.copyfile(src, README_SHOT)
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="directory for the six screenshots and the raw report (default: a temporary directory)")
    ap.add_argument("--no-write", action="store_true", help="do not touch results/ and docs/img/")
    args = ap.parse_args(argv)
    from tools.mobile_check import run
    import tempfile
    out_dir = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="rie_mobile_"))
    report = run(str(INDEX), out_dir, scenario=scenario, settle_ms=1800)
    for s in report["sizes"]:
        print("%-11s %4dx%-4d DPR %s  %s" % (s["name"], s["w"], s["h"], s["dpr"], "PASS" if not s["fails"] else "FAIL: " + " | ".join(s["fails"])))
    print("summary:", "all %d sizes pass" % len(report["sizes"]) if report["ok"] else "FAILED")
    if not args.no_write:
        write_outputs(report, out_dir)
        print("wrote", RESULT.relative_to(ROOT).as_posix(), "and", README_SHOT.relative_to(ROOT).as_posix())
    if not args.out:
        shutil.rmtree(out_dir, ignore_errors=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
