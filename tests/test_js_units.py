# -*- coding: utf-8 -*-
"""Runs tests/js/unit_tests.js (pixel filters, token quantiser, demo log, config) under Node.js."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_js_unit_tests_pass():
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    r = subprocess.run(["node", str(ROOT / "tests" / "js" / "unit_tests.js")], capture_output=True,
                       text=True, encoding="utf-8", env=env, timeout=120)
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert r.returncode == 0 and out["failed"] == 0, out["failures"]
    assert out["passed"] >= 20
