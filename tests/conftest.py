"""Test configuration.

Puts the package root on sys.path so tests import the same way the app does
(`from health import rules`), without needing an installed package.
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
