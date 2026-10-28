# -*- coding: utf-8 -*-
"""results/mobile_check.json (written by tools/mobile_check_editor.py: six device sizes through DevTools emulation)
and, optionally (RUN_BROWSER=1), a fresh run of that acceptance with the locally installed Edge."""
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RESULT = ROOT / "results" / "mobile_check.json"
EXPECTED = {"m390x844": ("mobile", 390, 844, 3), "m414x896": ("mobile", 414, 896, 3), "m360x780": ("mobile", 360, 780, 3),
            "t768x1024": ("mobile", 768, 1024, 2), "d1920x1080": ("desktop", 1920, 1080, 1), "d1366x768": ("desktop", 1366, 768, 1)}


def test_mobile_check_json_all_six_sizes_pass():
    r = json.loads(RESULT.read_text(encoding="utf-8"))
    assert r["ok"] is True
    sizes = {s["name"]: s for s in r["sizes"]}
    assert set(sizes) == set(EXPECTED)
    for name, (kind, w, h, dpr) in EXPECTED.items():
        s = sizes[name]
        assert (s["kind"], s["w"], s["h"], s["dpr"]) == (kind, w, h, dpr), name
        assert s["fails"] == [], f"{name}: {s['fails']}"
        assert s["dims"]["sw"] <= w + 1 and s["dims"]["iw"] <= w + 1, f"{name}: horizontal overflow {s['dims']}"
    assert r["browser"]["name"]


def test_readme_mobile_screenshot_exists_and_is_referenced():
    shot = ROOT / "docs" / "img" / "04-mobile-edit-390x844.png"
    assert shot.is_file() and shot.stat().st_size > 10_000
    readme = ROOT / "README.md" if (ROOT / "tools" / "templates").is_dir() else ROOT / "tools" / "publish_templates" / "README.md.tmpl"
    assert "docs/img/04-mobile-edit-390x844.png" in readme.read_text(encoding="utf-8")


@pytest.mark.skipif(os.environ.get("RUN_BROWSER") != "1", reason="set RUN_BROWSER=1 to start the local Edge")
def test_live_acceptance_all_sizes():
    from tools import mobile_check_editor
    assert mobile_check_editor.main(["--no-write"]) == 0
