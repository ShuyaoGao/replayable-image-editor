# -*- coding: utf-8 -*-
"""Static checks on play/: it must run from file:// (double-click), offline, with neutral names."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAY = ROOT / "play"
INDEX = PLAY / "index.html"


def play_text_files():
    return [p for p in PLAY.rglob("*") if p.is_file() and p.suffix in {".html", ".js", ".css"}]


def test_index_uses_only_plain_local_scripts_and_styles():
    html = INDEX.read_text(encoding="utf-8")
    assert 'type="module"' not in html and "type='module'" not in html
    srcs = re.findall(r'<script[^>]*\ssrc="([^"]+)"', html)
    hrefs = re.findall(r'<link[^>]*\shref="([^"]+)"', html)
    assert srcs, "no scripts found"
    for ref in srcs + hrefs:
        assert not re.match(r"^(https?:)?//", ref), f"external reference {ref}"
        assert (PLAY / ref).is_file(), f"missing file {ref}"


def test_no_network_module_or_service_worker_apis():
    banned = [r"\bfetch\s*\(", r"XMLHttpRequest", r"\bimport\s*\(", r"^\s*import\s", r"serviceWorker",
              r"WebSocket", r"navigator\.sendBeacon", r"https?://"]
    for p in play_text_files():
        text = p.read_text(encoding="utf-8")
        if p.name == "credits.js":          # data only (repository / Pages address shown as text), never loaded
            text = re.sub(r'"(REPO_URL|PAGES_URL)": "[^"]*"', "", text)
        for pat in banned:
            assert not re.search(pat, text, re.M), f"{p.relative_to(ROOT)} matches {pat}"


def test_no_third_party_trademark_on_the_page():
    """The neutral name lives in play/js/config.js; the old internal id survives only as a legacy log id."""
    allowed = {("js/config.js", "WebPS"), ("js/editor.js", "WebPS")}
    for p in play_text_files():
        rel = p.relative_to(PLAY).as_posix()
        text = p.read_text(encoding="utf-8")
        assert not re.search(r"photo\s*shop|adobe", text, re.I), rel
        for m in re.finditer(r"WebPS|\bPS\b", text):
            assert (rel, m.group(0)) in allowed, f"{rel}: {m.group(0)}"
    cfg = (PLAY / "js" / "config.js").read_text(encoding="utf-8")
    assert 'LEGACY_APP_IDS: ["WebPS"]' in cfg


def test_credits_js_matches_credits_json():
    credits = json.loads((ROOT / "credits.json").read_text(encoding="utf-8"))
    js = (PLAY / "js" / "credits.js").read_text(encoding="utf-8")
    payload = json.loads(js.split("window.CREDITS = ", 1)[1].rstrip().rstrip(";"))
    assert payload == {k: v for k, v in credits.items() if not k.startswith("_")}
    for key in ("AUTHOR", "AUTHOR_EMAIL", "UNIVERSITY_EN", "UNIVERSITY_KO", "SERIES_NAME_ZH", "REPO_NAME"):
        assert payload.get(key), key
    assert payload["AUTHOR_EMAIL"] == "gaoshuyao.mk@gmail.com" and payload["PAGES_URL"].endswith("/" + payload["REPO_NAME"] + "/")


def test_page_has_required_shell_elements():
    html = INDEX.read_text(encoding="utf-8")
    for needle in ['data-mode="watch"', 'data-mode="edit"', 'data-mode="practice"', 'id="help-btn"',
                   'id="exit-btn"', 'id="bigscreen"', 'id="footer"', 'id="dlg-help"', 'id="ended"',
                   'id="quant-presets"', 'id="speed-presets"', 'id="tasks"',
                   # 手机竖屏：☰ 菜单、四个大按钮、「看日志」全屏面板的「返回」、横屏提示、触屏说明图解
                   'id="menu-btn"', 'id="menu"', 'id="menu-exit"', 'id="mob-actions"', 'id="mob-log"', 'id="sheet-close"',
                   'id="rotate-hint"', 'class="help-touch"', 'class="help-kbd"', 'viewport-fit=cover']:
        assert needle in html, needle
    assert "所有计算都已结束，可以直接关闭这个标签页" in html
    css = (PLAY / "css" / "app.css").read_text(encoding="utf-8")
    for needle in ["body.touchp", "100dvh", "touch-action: none", "safe-area-inset", "body.touchl", "#sheet-close"]:
        assert needle in css, needle


def test_canvas_uses_pointer_events_with_cancel_and_blur_reset():
    js = (PLAY / "js" / "editor.js").read_text(encoding="utf-8")
    for needle in ['"pointerdown"', '"pointermove"', '"pointerup"', '"pointercancel"', '"blur"', "activePointer"]:
        assert needle in js, needle
    assert "touchstart" not in js and "mousedown" not in js


def test_release_zip_has_root_index_and_play(tmp_path):
    from tools import build
    out, size, n = build.make_zip(build.load_credits(), out_dir=tmp_path)
    import zipfile
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "index.html" in names and "play/index.html" in names and "play/js/app.js" in names
        root = z.read("index.html").decode("utf-8")
        assert 'content="0; url=play/index.html"' in root and 'href="play/index.html"' in root
        assert "{{" not in root
        for n_ in names:
            assert n_.isascii(), n_
    assert out.name.isascii() and size <= 15 * 1024 * 1024 and n == len(names)


def test_publish_root_files():
    """Only in the published repository (tools/templates/ exists): .nojekyll and the root redirect page."""
    import pytest
    if not (ROOT / "tools" / "templates").is_dir():
        pytest.skip("internal checkout: root index.html / .nojekyll are rendered into publish/")
    assert (ROOT / ".nojekyll").is_file() and (ROOT / ".nojekyll").stat().st_size == 0
    root = (ROOT / "index.html").read_text(encoding="utf-8")
    assert 'content="0; url=play/index.html"' in root and "{{" not in root
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "gaoshuyao.mk@gmail.com" in readme and "AI 教学演示案例 / AI Teaching Demos" in readme.splitlines()[0]
    assert "gaoshuyao.mk@gmail.com" in (ROOT / "CITATION.cff").read_text(encoding="utf-8")
    assert "Contact: gaoshuyao.mk@gmail.com" in (ROOT / "LICENSE-docs").read_text(encoding="utf-8")


def test_demo_jsonl_example_matches_page_demo():
    """docs/examples/demo_ops.jsonl is exported from play/js/demo.js by tools/build.py."""
    p = ROOT / "docs" / "examples" / "demo_ops.jsonl"
    lines = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert lines[0]["op"] == "session_start" and lines[0]["params"]["app"] == "replayable-image-editor"
    assert lines[1]["op"] == "doc_new"
    demo_src = (PLAY / "js" / "demo.js").read_text(encoding="utf-8")
    assert len(lines) == len(re.findall(r'^\s*add\("', demo_src, re.M))
