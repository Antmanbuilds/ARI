# SPDX-License-Identifier: Apache-2.0
"""Regression gate for task #545.

Previously ``ari_mcp/__init__.py`` set ``__version__ = "0.1.3"`` as a
hand-edited literal · it drifted from ``pyproject.toml`` (already at
0.2.0) and would have made the first smoke after PyPI upload print the
wrong version. This test fails if ``__version__`` is out of sync with
``pyproject.toml``.
"""

from __future__ import annotations

import re
from pathlib import Path

import ari_mcp
from ari_mcp.client import _USER_AGENT


def _pyproject_version() -> str:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    m = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
    assert m, "could not find `version = \"...\"` in pyproject.toml"
    return m.group(1)


def test_dunder_version_matches_pyproject() -> None:
    if ari_mcp.__version__ == "0.0.0+dev":
        # Editable checkout · package not installed. Skip rather than
        # assert · CI installs the package and exercises the real path.
        import pytest

        pytest.skip("ari-mcp-server not installed (editable checkout)")
    assert ari_mcp.__version__ == _pyproject_version(), (
        "ari_mcp.__version__ drifted from pyproject.toml · the value "
        "is sourced from importlib.metadata, so reinstall the package "
        "(pip install -e .) after bumping pyproject.toml"
    )


def test_user_agent_embeds_version() -> None:
    assert _USER_AGENT == f"ari-mcp/{ari_mcp.__version__} (python)"
