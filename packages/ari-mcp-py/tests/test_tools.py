# SPDX-License-Identifier: Apache-2.0
"""Tool surface parity tests."""

from ari_mcp.tools import TOOLS


def test_twenty_tools_with_expected_names():
    names = sorted(t.name for t in TOOLS)
    assert names == [
        "category_benchmark",
        "detect_anomaly",
        "find_substitutes",
        "get_fmv",
        "get_leaderboard",
        "get_service",
        "get_signed_receipt",
        "historical_fmv",
        "is_fair_price",
        "is_fair_price_batch",
        "list_services",
        "mcp_health_ping",
        "prepay_verdict",
        "prepay_verdict_batch",
        "recent_observations",
        "refuse_if_overpriced",
        "smart_route",
        "subscribe_alert",
        "verify_receipt",
        "why",
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
