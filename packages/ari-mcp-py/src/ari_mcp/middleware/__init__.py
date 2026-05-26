# SPDX-License-Identifier: Apache-2.0
"""Reference middleware for `ARI-Verdict-Id` header (task #308 · phase 3 item 5)."""

from .verdict_header import (
    ARI_VERDICT_HEADER_SPEC_URL,
    VerdictMeta,
    set_verdict,
    verdict_header,
)

__all__ = [
    "ARI_VERDICT_HEADER_SPEC_URL",
    "VerdictMeta",
    "set_verdict",
    "verdict_header",
]
