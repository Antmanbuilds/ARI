# SPDX-License-Identifier: Apache-2.0
"""Task #444 · deprecated aliases must still validate and route to canonical fields."""

from __future__ import annotations

from typing import Any

import pytest

from ari_mcp.tools import (
    ForRequestIdInput,
    PrepayVerdictInput,
    SubscribeAlertInput,
    TOOLS,
)


class _FakeResp:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.receipt_id = "01HZTESTRECEIPT"
        self.signed_at = "2026-05-20T00:00:00.000Z"


class _RecordingClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.calls: list[dict[str, Any]] = []

    def request(self, path: str, **kwargs: Any) -> _FakeResp:
        self.calls.append({"path": path, **kwargs})
        return _FakeResp(self._payload)


def _tool(name: str):
    for t in TOOLS:
        if t.name == name:
            return t
    raise AssertionError(f"tool {name} not registered")


# --- prepay_verdict ---------------------------------------------------------


def test_prepay_verdict_canonical_inputs_route_through_helpers() -> None:
    inp = PrepayVerdictInput(slug="acme-llm", amount_usd=0.25, unit="tokens")
    assert inp.effective_target() == "acme-llm"
    assert inp.effective_amount_micros() == 250_000


def test_prepay_verdict_legacy_url_and_amount_micros_aliases() -> None:
    inp = PrepayVerdictInput(url="https://example.com/x402", amountMicros=500_000)
    assert inp.effective_target() == "https://example.com/x402"
    assert inp.effective_amount_micros() == 500_000


def test_prepay_verdict_legacy_amount_micros_snake_case_alias() -> None:
    inp = PrepayVerdictInput(slug="acme-llm", amount_micros=750_000)
    assert inp.effective_amount_micros() == 750_000


def test_prepay_verdict_rejects_missing_target_and_amount() -> None:
    with pytest.raises(Exception):
        PrepayVerdictInput(amount_usd=1.0)
    with pytest.raises(Exception):
        PrepayVerdictInput(slug="acme-llm")


def test_prepay_verdict_run_sends_resolved_target_and_amount() -> None:
    client = _RecordingClient({
        "decision": "pay",
        "verdict": {"label": "green", "deltaPct": 0},
        "fmvMicros": 500_000,
        "amountMicros": 500_000,
        "currency": "USD",
        "chain": "off-chain",
    })
    _tool("prepay_verdict").run(
        {"url": "https://example.com/x402", "amountMicros": 500_000},  # type: ignore[arg-type]
        client,  # type: ignore[arg-type]
    )
    sent = client.calls[0].get("json") or {}
    assert sent.get("url") == "https://example.com/x402"
    assert sent.get("amountMicros") == 500_000


# --- get_signed_receipt -----------------------------------------------------


def test_for_request_id_accepts_canonical_receipt_id() -> None:
    inp = ForRequestIdInput(receipt_id="rcpt_abc")
    assert inp.effective_receipt_id() == "rcpt_abc"


def test_for_request_id_accepts_deprecated_alias() -> None:
    inp = ForRequestIdInput(for_request_id="rcpt_abc")
    assert inp.effective_receipt_id() == "rcpt_abc"


def test_for_request_id_requires_one_of_the_two() -> None:
    with pytest.raises(Exception):
        ForRequestIdInput()


# --- subscribe_alert --------------------------------------------------------


def test_subscribe_alert_accepts_canonical_webhook_url() -> None:
    inp = SubscribeAlertInput(
        slug="acme-llm",
        webhook_url="https://hooks.example.com/abc",
        condition="above",
        threshold=1.5,
    )
    assert str(inp.effective_webhook()).rstrip("/") == "https://hooks.example.com/abc"


def test_subscribe_alert_accepts_deprecated_webhook_alias() -> None:
    inp = SubscribeAlertInput(
        slug="acme-llm",
        webhook="https://hooks.example.com/abc",
        condition="above",
        threshold=1.5,
    )
    assert str(inp.effective_webhook()).rstrip("/") == "https://hooks.example.com/abc"
