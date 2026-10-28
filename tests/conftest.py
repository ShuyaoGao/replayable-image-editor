# -*- coding: utf-8 -*-
"""Put the repository root on sys.path so tests can import tools/."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
