# SPDX-License-Identifier: Apache-2.0
"""Task #437 regression tests.

Covers the two integrity bugs fixed in tools.py and verify.py:

1. ``refuse_if_overpriced`` previously used ``verdict != "red"`` which
   failed *open* on amber / unknown / missing-baseline verdicts. The
   helper :func:`ari_mcp.tools._verdict_decision` is now an allow-list
   (only ``green``/``fair`` returns ``"pay"``) and the tool must refuse
   on amber as well as on every other non-green outcome · including
   unknown labels, ``insufficient_data``, and missing FMV baselines ·
   by returning the strict boolean ``should_pay=False`` (fail-closed).

2. ``verify_receipt`` previously returned ``valid=True`` whenever no
   error was appended. A forgotten check would silently pass. The
   verifier now requires every entry in ``_REQUIRED_CHECKS`` to be
   positively recorded and must refuse to verify a partial preamble
   (missing ``Ari-Key-Id`` / ``Ari-Receipt-Id`` / ``Ari-Signed-At`` /
   ``Ari-Signature``).
"""

from __future__ import annotations

from typing import Any

import pytest

from ari_mcp.tools import TOOLS, _verdict_decision
from ari_mcp.verify import verify_receipt


# --- helper coverage ---------------------------------------------------------

@pytest.mark.parametrize(
    "verdict,expected",
    [
        ("green", "pay"),
        ("fair", "pay"),
        ("amber", "refuse"),
        ("stretched", "refuse"),
        ("red", "refuse"),
        ("overpriced", "refuse"),
        ("unknown", "abstain"),
        ("insufficient_data", "abstain"),
        ("", "abstain"),
        (None, "abstain"),
        ("brand_new_label_we_have_not_seen", "abstain"),
    ],
)
def test_verdict_decision_allow_list(verdict: str | None, expected: str) -> None:
    assert _verdict_decision(verdict) == expected


# --- refuse_if_overpriced via the registered tool ---------------------------

class _FakeResp:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.receipt_id = "01HZTESTRECEIPT"
        self.signed_at = "2026-05-20T00:00:00.000Z"


class _FakeClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def request(self, *_args: Any, **_kwargs: Any) -> _FakeResp:
        return _FakeResp(self._payload)


def _tool(name: str):
    for t in TOOLS:
        if t.name == name:
            return t
    raise AssertionError(f"tool {name} not registered")


def test_refuse_if_overpriced_refuses_on_amber() -> None:
    # Regression for the prior `verdict != "red"` fail-open bug.
    client = _FakeClient({
        "verdict": {"label": "amber", "deltaPct": 18},
        "fmvMicros": 1_000_000,
        "lowMicros": 800_000,
        "highMicros": 1_200_000,
        "sampleSize": 12,
    })
    out = _tool("refuse_if_overpriced").run(
        {"slug": "acme-llm", "amount_usd": 1.15, "unit": "tokens"}, client  # type: ignore[arg-type]
    )
    assert out["should_pay"] is False
    assert out["verdict"] == "amber"
    assert isinstance(out["reason"], str) and out["reason"]


def test_refuse_if_overpriced_abstains_on_unknown_label() -> None:
    client = _FakeClient({
        "verdict": {"label": "brand_new_label", "deltaPct": 0},
        "fmvMicros": 1_000_000,
        "highMicros": 1_200_000,
    })
    out = _tool("refuse_if_overpriced").run(
        {"slug": "acme-llm", "amount_usd": 1.0, "unit": "tokens"}, client  # type: ignore[arg-type]
    )
    assert out["should_pay"] is False, "unknown labels must fail closed, never auto-pay"
    assert out["verdict"] == "brand_new_label"


def test_refuse_if_overpriced_pays_on_green() -> None:
    client = _FakeClient({
        "verdict": {"label": "green", "deltaPct": -5},
        "fmvMicros": 1_000_000,
        "lowMicros": 800_000,
        "highMicros": 1_200_000,
        "sampleSize": 42,
    })
    out = _tool("refuse_if_overpriced").run(
        {"slug": "acme-llm", "amount_usd": 1.0, "unit": "tokens"}, client  # type: ignore[arg-type]
    )
    assert out["should_pay"] is True
    assert out["verdict"] == "green"


# --- verifier required-header / positive-assertion contract -----------------

# A throwaway ed25519 PEM is fine here · we only assert the verifier *refuses
# to attempt* verification when required headers are missing, so the math
# never runs. (Any well-formed PEM works.)
_PEM = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MCowBQYDK2VwAyEAkvPU1HujL+OSz3DyLaVpWh0ae0qffvEDK0wZ+iChdr0=\n"
    "-----END PUBLIC KEY-----\n"
)


def test_verifier_refuses_when_canonical_hash_missing() -> None:
    # Task #535 cross-language parity · the TS verifier already
    # treats a missing Ari-Canonical-Hash as a hard refusal. Without
    # this gate, a stripping middlebox (or a buggy publisher) could
    # omit the body-integrity assertion and still earn `valid=True`.
    # Pin the fail-closed behavior so we don't regress to the
    # legacy "absent = pass" silently-permissive shape.
    result = verify_receipt(
        "{}",
        {
            # Note: no Ari-Canonical-Hash header. All four other
            # required-preamble headers are present so we isolate
            # the canonical-hash gate from the missing-headers gate.
            "Ari-Key-Id": "kid-1",
            "Ari-Receipt-Id": "01HZ",
            "Ari-Signed-At": "2026-01-01T00:00:00Z",
            "Ari-Signature": "AAAA",
        },
        _PEM,
    )
    assert result.valid is False
    joined = " | ".join(result.errors)
    assert "Ari-Canonical-Hash header missing" in joined


def test_verifier_refuses_when_required_headers_missing() -> None:
    # Missing Ari-Key-Id, Ari-Receipt-Id, Ari-Signed-At, Ari-Signature.
    # Even though the body would canonically hash and the math *could* be
    # attempted with an empty preamble, the verifier MUST refuse and
    # surface the missing headers explicitly.
    result = verify_receipt("{}", {}, _PEM)
    assert result.valid is False
    joined = " | ".join(result.errors)
    assert "required receipt headers missing" in joined
    for h in ("Ari-Key-Id", "Ari-Receipt-Id", "Ari-Signed-At", "Ari-Signature"):
        assert h in joined


# --- schema reconciliation ---------------------------------------------------

def test_get_leaderboard_defaults_kind_to_most_observed() -> None:
    from ari_mcp.tools import LeaderboardInput

    parsed = LeaderboardInput()
    assert parsed.kind == "most_observed"
    assert parsed.limit == 10


def test_get_signed_receipt_accepts_either_id() -> None:
    from pydantic import ValidationError

    from ari_mcp.tools import ForRequestIdInput

    a = ForRequestIdInput(receipt_id="01HZSPEC")
    b = ForRequestIdInput(for_request_id="01HZLEGACY")
    assert a.effective_id() == "01HZSPEC"
    assert b.effective_id() == "01HZLEGACY"
    with pytest.raises(ValidationError):
        ForRequestIdInput()


def test_subscribe_alert_schema_xor() -> None:
    from pydantic import ValidationError

    from ari_mcp.tools import SubscribeAlertInput

    with pytest.raises(ValidationError):
        SubscribeAlertInput(slug="x", condition="above", threshold=1.0)
    with pytest.raises(ValidationError):
        SubscribeAlertInput(
            slug="x",
            condition="above",
            threshold=1.0,
            webhook="https://example.com/wh",  # type: ignore[arg-type]
            email="ops@example.com",  # type: ignore[arg-type]
        )
    # webhook_url alias must succeed
    ok = SubscribeAlertInput(
        slug="x",
        condition="above",
        threshold=1.0,
        webhook_url="https://example.com/wh",  # type: ignore[arg-type]
    )
    assert ok.effective_webhook() is not None


def test_signing_input_includes_schedule_proof_in_order() -> None:
    # Task #437 cross-language regression · mirror of the TS test in
    # tools/ari-mcp-ts/test/honest-null.test.ts. Pins SIGNED_HEADER_NAMES
    # membership + order and confirms absent values are skipped.
    from ari_mcp.canonical import SIGNED_HEADER_NAMES, compose_signing_input

    assert tuple(SIGNED_HEADER_NAMES) == (
        "License",
        "Content-Type",
        "Ari-Signed-At",
        "Ari-Key-Id",
        "Ari-Receipt-Id",
        "Ari-Schedule-Proof",
        # Task #489 / #535 · v3 signed-preamble fields.
        "Ari-Confidence",
        "Ari-Fmv-Source",
    )
    with_proof = compose_signing_input(
        "{}",
        {
            "License": "BUSL-1.1",
            "Content-Type": "application/json",
            "Ari-Signed-At": "2026-01-01T00:00:00Z",
            "Ari-Key-Id": "kid-1",
            "Ari-Receipt-Id": "01HZ",
            "Ari-Schedule-Proof": "proof-abc",
        },
    )
    assert with_proof == (
        "{}\nLicense: BUSL-1.1\nContent-Type: application/json\n"
        "Ari-Signed-At: 2026-01-01T00:00:00Z\nAri-Key-Id: kid-1\n"
        "Ari-Receipt-Id: 01HZ\nAri-Schedule-Proof: proof-abc"
    )
    without_proof = compose_signing_input(
        "{}",
        {
            "License": "BUSL-1.1",
            "Content-Type": "application/json",
            "Ari-Signed-At": "2026-01-01T00:00:00Z",
            "Ari-Key-Id": "kid-1",
            "Ari-Receipt-Id": "01HZ",
        },
    )
    assert "Ari-Schedule-Proof" not in without_proof


def test_verifier_required_checks_locked() -> None:
    # Regression for the "forgot-to-record a check" failure mode · the
    # required-checks list is the source of truth for what verify_receipt
    # gates on. Locking the membership here means a future PR that adds a
    # check has to also wire it through this test (and the verifier
    # function itself) before this assertion passes again.
    from ari_mcp.verify import _REQUIRED_CHECKS

    assert set(_REQUIRED_CHECKS) == {
        # Task #535 · added `canonical_hash_present` to fail-closed on a
        # missing Ari-Canonical-Hash header (cross-language parity with
        # tools/ari-mcp-ts/src/verify.ts).
        "canonical_hash_present",
        "canonical_hash_match",
        "headers_present",
        "signature_decodable",
        "public_key_loadable",
        "ed25519_signature",
    }


def test_verifier_refuses_on_canonical_hash_mismatch() -> None:
    result = verify_receipt(
        "{}",
        {
            "Ari-Canonical-Hash": "deadbeef",  # disagrees with body hash
            "Ari-Key-Id": "ari-test",
            "Ari-Receipt-Id": "01HZTEST",
            "Ari-Signed-At": "2026-05-20T00:00:00Z",
            "Ari-Signature": "AA==",
        },
        _PEM,
    )
    assert result.valid is False
    assert any("canonical hash mismatch" in e for e in result.errors)
