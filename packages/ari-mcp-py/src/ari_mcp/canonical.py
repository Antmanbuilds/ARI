# SPDX-License-Identifier: Apache-2.0
"""ARI canonicalization profile (`ari-receipts/v1`) · Python mirror.

Byte-for-byte equivalent to ``tools/ari-verify-py/src/ari_verify/canonical.py``
and the Node package's ``canonical.ts``. JCS / RFC 8785 with the ARI profile
extensions documented at /api/v1/spec/canonicalization.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Mapping, Sequence

SIGNED_HEADER_NAMES: Sequence[str] = (
    "License",
    "Content-Type",
    "Ari-Signed-At",
    "Ari-Key-Id",
    "Ari-Receipt-Id",
)

_MAX_SAFE_INTEGER = (1 << 53) - 1

RECEIPT_SIGNING_INPUT_PREFIX_V2 = "ari-receipts-v1\n"
RECEIPT_SPEC_HEADER_V1 = "ari-receipts/v1"
RECEIPT_SPEC_HEADER_V2 = "ari-receipts-v2"

_COMBINING_MARK_RE = re.compile(r"[\u0300-\u036f]")


def _nfc_guard(s: str) -> None:
    nfc = unicodedata.normalize("NFC", s)
    if nfc != s:
        raise ValueError(
            "JCS: string is not in Unicode NFC normalization form (ari-receipts-v2 requires NFC)"
        )
    if _COMBINING_MARK_RE.search(nfc):
        raise ValueError(
            "JCS: string contains combining marks (U+0300-U+036F) that survive NFC normalization"
        )


def _escape_string(s: str) -> str:
    _nfc_guard(s)
    out = ['"']
    for ch in s:
        c = ord(ch)
        if c == 0x22:
            out.append('\\"')
        elif c == 0x5C:
            out.append("\\\\")
        elif c == 0x08:
            out.append("\\b")
        elif c == 0x09:
            out.append("\\t")
        elif c == 0x0A:
            out.append("\\n")
        elif c == 0x0C:
            out.append("\\f")
        elif c == 0x0D:
            out.append("\\r")
        elif c < 0x20:
            out.append(f"\\u{c:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _serialize_number(n: float | int) -> str:
    if isinstance(n, bool):
        # bool is a subclass of int; surface as JSON true/false instead of 1/0.
        return "true" if n else "false"
    if isinstance(n, int):
        if abs(n) > _MAX_SAFE_INTEGER:
            return _escape_string(str(n))
        return str(n)
    if not (n == n) or n in (float("inf"), float("-inf")):
        raise ValueError("JCS: NaN and Infinity are not representable")
    # ECMA-262 ToString equivalent for floats · Python's repr matches for
    # the values the API actually emits (no scientific oddities).
    return json.dumps(n)


def jcs(value: Any) -> str:
    """Serialize ``value`` as canonical bytes per the `ari-receipts/v1` profile."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _escape_string(value)
    if isinstance(value, (int, float)):
        return _serialize_number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, Mapping):
        items = [(k, v) for k, v in value.items() if v is not None or True]
        # Preserve null members; only drop keys explicitly absent (not in dict).
        items = sorted(items, key=lambda kv: kv[0])
        return "{" + ",".join(f"{_escape_string(k)}:{jcs(v)}" for k, v in items) + "}"
    raise TypeError(f"JCS: cannot serialize value of type {type(value).__name__}")


def compose_signing_input(
    canonical_payload: str, headers: Mapping[str, str | None]
) -> str:
    """Append the fixed-order signed-header preamble to ``canonical_payload``."""
    out = canonical_payload
    lower = {k.lower(): v for k, v in headers.items()}
    for name in SIGNED_HEADER_NAMES:
        v = lower.get(name.lower())
        if v is None:
            continue
        out += "\n" + name + ": " + str(v)
    return out


def compose_signing_input_v2(
    canonical_payload: str, headers: Mapping[str, str | None]
) -> str:
    return RECEIPT_SIGNING_INPUT_PREFIX_V2 + compose_signing_input(canonical_payload, headers)
