# SPDX-License-Identifier: Apache-2.0
"""Canonicalization parity tests · must match tools/ari-verify-py vectors."""

from __future__ import annotations

import pytest

from ari_mcp.canonical import jcs, compose_signing_input, SIGNED_HEADER_NAMES


def test_object_keys_sorted():
    assert jcs({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_nested():
    assert jcs({"x": [3, 1, 2], "y": {"b": False, "a": True}}) == '{"x":[3,1,2],"y":{"a":true,"b":false}}'


def test_strings_escape_control_chars():
    assert jcs("\b\t\n\f\r\"\\") == r'"\b\t\n\f\r\"\\"'


def test_unicode_passthrough():
    # Non-control codepoints stay literal (RFC 8785 §3.2.2.1).
    assert jcs("héllo😀") == '"héllo😀"'


def test_large_integer_serialized_as_string():
    n = 2**53  # MAX_SAFE_INTEGER + 1
    assert jcs(n) == '"9007199254740992"'
    assert jcs(2**53 - 1) == "9007199254740991"
    assert jcs(-(2**53)) == '"-9007199254740992"'


def test_compose_signing_input_appends_only_present_headers():
    body = '{"a":1}'
    out = compose_signing_input(
        body,
        {
            "License": "BUSL-1.1",
            "Content-Type": "application/json; charset=utf-8",
            "Ari-Signed-At": "2026-04-25T00:00:00Z",
            "Ari-Key-Id": "ari-deadbeef00",
            "Ari-Receipt-Id": "01HZ",
        },
    )
    assert out == (
        '{"a":1}'
        "\nLicense: BUSL-1.1"
        "\nContent-Type: application/json; charset=utf-8"
        "\nAri-Signed-At: 2026-04-25T00:00:00Z"
        "\nAri-Key-Id: ari-deadbeef00"
        "\nAri-Receipt-Id: 01HZ"
    )


def test_compose_signing_input_skips_missing_headers():
    body = '{"a":1}'
    out = compose_signing_input(body, {"License": "BUSL-1.1", "Ari-Key-Id": None})
    assert out == '{"a":1}\nLicense: BUSL-1.1'


def test_signed_header_names_order_is_locked():
    # Task #437 · canonical order updated to mirror the server's
    # SIGNED_HEADER_NAMES (artifacts/api-server/src/lib/canonical.ts),
    # which now includes the optional sixth header Ari-Schedule-Proof.
    assert SIGNED_HEADER_NAMES == (
        "License",
        "Content-Type",
        "Ari-Signed-At",
        "Ari-Key-Id",
        "Ari-Receipt-Id",
        "Ari-Schedule-Proof",
        # Task #489 / #535 · v3 signed-preamble fields (confidence-tiered
        # verdicts). Optional · absent on non-fair-price routes.
        "Ari-Confidence",
        "Ari-Fmv-Source",
    )


def test_nan_rejected():
    with pytest.raises(ValueError):
        jcs(float("nan"))
