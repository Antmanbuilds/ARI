# SPDX-License-Identifier: Apache-2.0
"""Single source of truth for the installed package version.

Reads from installed package metadata via :func:`importlib.metadata.version`
so the value can never drift from ``pyproject.toml`` (regression gate
for task #545 · the old ``__init__.py`` had a hand-edited literal
``__version__ = "0.1.3"`` that would have made the first smoke after
PyPI upload print the wrong version).

Lives in a tiny side-module so :mod:`ari_mcp.client` can import
``__version__`` for the HTTP User-Agent string without creating an
import cycle through ``ari_mcp/__init__.py``.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

try:
    __version__: str = version("ari-mcp-server")
except PackageNotFoundError:
    # Editable / source-only checkouts (not installed via pip). Use a
    # clearly-not-real value so any test or smoke that compares against
    # a real release version fails loudly rather than silently passing.
    __version__ = "0.0.0+dev"
