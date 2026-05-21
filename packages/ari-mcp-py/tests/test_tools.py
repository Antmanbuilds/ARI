# SPDX-License-Identifier: Apache-2.0
"""Tool surface parity tests."""

from ari_mcp.tools import TOOLS


def test_eleven_tools_with_expected_names():
    names = sorted(t.name for t in TOOLS)
    assert names == [
        "get_fmv",
        "get_leaderboard",
        "get_service",
        "get_signed_receipt",
        "is_fair_price",
        "list_services",
        "prepay_verdict",
        "recent_observations",
        "refuse_if_overpriced",
        "subscribe_alert",
        "verify_receipt",
    ]


def test_each_tool_has_title_and_description():
    for t in TOOLS:
        assert len(t.title) > 0, f"{t.name} missing title"
        assert len(t.description) > 20, f"{t.name} description too terse"


def test_each_tool_input_schema_has_properties():
    for t in TOOLS:
        schema = t.input_model.model_json_schema()
        assert "properties" in schema, f"{t.name} schema missing properties"
        assert schema["type"] == "object"
