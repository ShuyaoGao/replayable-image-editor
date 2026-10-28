# -*- coding: utf-8 -*-
"""results/result.json (written by tools/browser_check.py from the page's self-test) and,
optionally (RUN_BROWSER=1), a fresh headless Edge / Chrome run of that self-test."""
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RESULT = ROOT / "results" / "result.json"


def test_result_json_records_a_passing_selftest():
    r = json.loads(RESULT.read_text(encoding="utf-8"))
    assert r["selftest_ops"]["same"] is True and r["selftest_ops"]["user_ops"] == 20
    demo = r["demo"]
    assert demo["same"] is True and demo["fp"] == demo["replay_fp"]
    q = demo["quant"]
    assert q["raw"]["psnr"] == "inf" and q["raw"]["changed_pixels"] == 0
    assert all(q[k]["restored"] for k in q)
    # coarser presets lose more: PSNR must not increase from fine -> medium -> coarse
    assert q["fine"]["psnr"] >= q["medium"]["psnr"] >= q["coarse"]["psnr"]
    assert r["legacy_log"]["accepted"] and r["legacy_log"]["legacy"]
    assert r["filter_selection"]["ok"]
    for size, run in r["runs"].items():
        assert run["ok"] and not run["errors"], size
        assert all(layout["ok"] and layout["hOverflow"] <= 0 for layout in run["layout"]), size


@pytest.mark.skipif(os.environ.get("RUN_BROWSER") != "1", reason="set RUN_BROWSER=1 to start a headless browser")
def test_browser_selftest_both_sizes():
    from tools import browser_check
    assert browser_check.main(["--no-result"]) == 0
