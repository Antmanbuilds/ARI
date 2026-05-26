# SPDX-License-Identifier: Apache-2.0
"""MCP server for ARI (Agentic Rate Indicators)."""

from ._version import __version__
from .client import AriClient, AriHttpError, AriReceiptError
from .verify import VerifyResult, verify_receipt
from .canonical import jcs, compose_signing_input, SIGNED_HEADER_NAMES
from .tools import TOOLS
__all__ = [
    "AriClient",
    "AriHttpError",
    "AriReceiptError",
    "VerifyResult",
    "verify_receipt",
    "jcs",
    "compose_signing_input",
    "SIGNED_HEADER_NAMES",
    "TOOLS",
    "__version__",
]
