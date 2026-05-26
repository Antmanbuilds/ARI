# SPDX-License-Identifier: Apache-2.0
"""ARI live-API integration suite (Python mirror of the Node suite).

Mirrors T01-T15 from ``tools/ari-mcp-ts/tests/integration.test.js``
against ``https://agentrateindicators.com``. The Node suite is the
authoritative shipment gate; this suite exists so Python operators can
re-run the same checks before a PyPI release without the Node toolchain.

Implementation reuses the *shipped* verifier (``ari_mcp.verify``) so
that any divergence between the published Python package and the live
API is caught here · not papered over with bespoke test-only crypto.
"""

from __future__ import annotations

import hashlib
import os

import httpx
import pytest

from ari_mcp.verify import verify_receipt

BASE_URL = os.environ.get("ARI_API_BASE_URL", "https://agentrateindicators.com").rstrip("/")
NO_DATA_SLUG = "ari-test-no-data-xyz"
MISSING_SLUG = "ari-does-not-exist-xyz"
WEBHOOK_URL_FOR_T14 = "https://webhook.site/test"

REQUIRED_RECEIPT_HEADERS = (
    "ari-receipt-id",
    "ari-signed-at",
    "ari-canonical-hash",
    "ari-key-id",
    "ari-signature",
)


def _load_pinned_pem() -> str:
    r = httpx.get(BASE_URL + "/.well-known/ari-pubkey.pem", timeout=15)
    r.raise_for_status()
    return r.text


PINNED_PEM: str = _load_pinned_pem()


class ApiResult:
    __slots__ = ("status", "headers", "body_text", "body", "receipt_id")

    def __init__(self, status: int, headers: dict[str, str], body_text: str, body):
        self.status = status
        self.headers = headers
        self.body_text = body_text
        self.body = body
        self.receipt_id = headers.get("ari-receipt-id")


def _call(path: str, *, method: str = "GET", json_body=None) -> ApiResult:
    url = path if path.startswith("http") else BASE_URL + path
    with httpx.Client(timeout=30, follow_redirects=True) as c:
        r = c.request(method, url, json=json_body, headers={"Accept": "application/json"})
    body_text = r.text
    h = {k.lower(): v for k, v in r.headers.items()}
    parsed = None
    if body_text:
        try:
            parsed = r.json()
        except Exception:
            parsed = None
    # Strict: any signed response must carry the full 5-header set AND
    # verify with the shipped verifier. A missing header or a math
    # failure both throw here so the test that called us is marked FAIL.
    if h.get("ari-signature"):
        missing = [k for k in REQUIRED_RECEIPT_HEADERS if not h.get(k)]
        if missing:
            raise AssertionError(f"missing Ari-* headers: {', '.join(missing)}")
        v = verify_receipt(body_text, h, PINNED_PEM)
        if not v.valid:
            raise AssertionError(
                f"receipt verification failed for {path}: {'; '.join(v.errors) or '(no error)'}"
            )
    return ApiResult(r.status_code, h, body_text, parsed)


def _say(tool: str, receipt: str | None, status: str = "PASS", reason: str = "") -> None:
    if status == "PASS":
        print(f"PASS [{tool}] — receipt: {receipt or '(none)'}", flush=True)
    else:
        print(f"FAIL [{tool}] — {reason}", flush=True)


# ---- shared discovery: one live, FMV-bearing x402 slug ---------------------


def _discover_known_good() -> dict:
    r = _call("/api/v1/services?protocol=x402&limit=200")
    assert r.status == 200, f"discovery failed HTTP {r.status}"
    for s in r.body.get("items", []):
        fp = s.get("fairPrice") or {}
        if (
            isinstance(fp.get("fmvMicros"), (int, float))
            and fp["fmvMicros"] > 0
            and isinstance(fp.get("lowMicros"), (int, float))
            and isinstance(fp.get("highMicros"), (int, float))
            and fp["lowMicros"] <= fp["fmvMicros"] <= fp["highMicros"]
            and (fp.get("sampleSize") or 0) > 0
        ):
            return s
    raise RuntimeError("no live x402 service has a usable FMV band; cannot bootstrap suite")


KNOWN = _discover_known_good()
KNOWN_SLUG: str = KNOWN["slug"]
KNOWN_FMV: int = int(KNOWN["fairPrice"]["fmvMicros"])
T01_RECEIPT: dict[str, str | None] = {"id": None}


def _require_headers(h):
    missing = [k for k in REQUIRED_RECEIPT_HEADERS if not h.get(k)]
    if missing:
        raise AssertionError(f"missing Ari-* headers: {', '.join(missing)}")


# ---- T01 -------------------------------------------------------------------


def test_T01_is_fair_price_3x_above_fmv_never_green():
    tool = "is_fair_price"
    try:
        amount = KNOWN_FMV * 3
        r = _call(f"/api/v1/fair-price?service={KNOWN_SLUG}&amount_micros={amount}")
        assert r.status == 200, f"HTTP {r.status}"
        _require_headers(r.headers)
        verdict = (r.body or {}).get("verdict", {}).get("label")
        assert verdict != "green", f"verdict must not be green; got {verdict!r}"
        assert isinstance(verdict, str), "verdict.label missing"
        T01_RECEIPT["id"] = r.receipt_id
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T02_is_fair_price_at_fmv_is_green():
    tool = "is_fair_price"
    try:
        r = _call(f"/api/v1/fair-price?service={KNOWN_SLUG}&amount_micros={KNOWN_FMV}")
        assert r.status == 200, f"HTTP {r.status}"
        _require_headers(r.headers)
        verdict = (r.body or {}).get("verdict", {}).get("label")
        assert verdict == "green", f"expected verdict=green at FMV, got {verdict!r}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T03_get_fmv_known_slug_band_ok():
    tool = "get_fmv"
    try:
        r = _call(f"/api/v1/services/{KNOWN_SLUG}")
        assert r.status == 200
        _require_headers(r.headers)
        fp = (r.body or {}).get("fairPrice") or {}
        fmv, low, high = (
            float(fp.get("fmvMicros") or 0),
            float(fp.get("lowMicros") or 0),
            float(fp.get("highMicros") or 0),
        )
        assert fmv > 0, f"fmv must be > 0, got {fmv}"
        assert (fp.get("sampleSize") or 0) > 0, "sample_size must be > 0"
        assert low <= fmv <= high, f"band violated: low={low} fmv={fmv} high={high}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T04_get_fmv_no_data_slug_returns_strict_null():
    tool = "get_fmv"
    try:
        r = _call(f"/api/v1/services/{NO_DATA_SLUG}")
        if r.status == 200:
            _require_headers(r.headers)
            fmv = (r.body or {}).get("fairPrice", {}).get("fmvMicros")
            assert fmv is None, f"fmv_usd must be strict null, got {fmv!r}"
            _say(tool, r.receipt_id)
            return
        if r.status == 404:
            # Task #535 · the no-data fixture is seeded by the local
            # api-server's `ensureNoDataFixture()` and is not guaranteed
            # to exist against arbitrary base URLs (e.g. prod, a fresh
            # staging deploy). Skip rather than fail when the fixture
            # isn't present · the null-contract is still exercised by
            # the local TS integration suite and the matching unit test.
            import pytest as _pytest

            _say(tool, None, "SKIP", f"no-data fixture {NO_DATA_SLUG!r} not deployed at {BASE_URL}")
            _pytest.skip(f"no-data fixture {NO_DATA_SLUG!r} not deployed at {BASE_URL}")
        raise AssertionError(f"unexpected HTTP {r.status}")
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T05_refuse_if_overpriced_no_data_abstains():
    tool = "refuse_if_overpriced"
    try:
        r = _call(f"/api/v1/fair-price?service={NO_DATA_SLUG}&amount_micros=1000")
        if r.status == 200:
            _require_headers(r.headers)
            ok = (r.body or {}).get("ok")
            reason = (r.body or {}).get("reason") or (r.body or {}).get("verdict", {}).get("reason")
            assert ok is True, f"expected ok=True on no-data response, got ok={ok!r}"
            assert reason == "no_data", f"expected reason='no_data', got reason={reason!r}"
            _say(tool, r.receipt_id)
            return
        if r.status == 404:
            # Task #535 · see T04 note · skip if fixture absent at this base URL.
            import pytest as _pytest

            _say(tool, None, "SKIP", f"no-data fixture {NO_DATA_SLUG!r} not deployed at {BASE_URL}")
            _pytest.skip(f"no-data fixture {NO_DATA_SLUG!r} not deployed at {BASE_URL}")
        raise AssertionError(f"unexpected HTTP {r.status}")
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T06_get_service_has_required_fields():
    tool = "get_service"
    try:
        r = _call(f"/api/v1/services/{KNOWN_SLUG}")
        assert r.status == 200
        _require_headers(r.headers)
        for k in ("slug", "protocol", "category"):
            assert (r.body or {}).get(k), f"missing field {k!r}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T07_list_services_protocol_x402_filter_holds():
    tool = "list_services"
    try:
        r = _call("/api/v1/services?protocol=x402&limit=50")
        assert r.status == 200
        _require_headers(r.headers)
        items = (r.body or {}).get("items", [])
        assert items, "no x402 services returned"
        bad = next((s for s in items if s.get("protocol") != "x402"), None)
        assert bad is None, f"item {bad and bad.get('slug')} has protocol={bad and bad.get('protocol')}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T08_list_services_protocol_mpp_filter_holds():
    tool = "list_services"
    try:
        r = _call("/api/v1/services?protocol=mpp&limit=50")
        assert r.status == 200
        _require_headers(r.headers)
        items = (r.body or {}).get("items", [])
        assert items, "no mpp services returned"
        bad = next((s for s in items if s.get("protocol") != "mpp"), None)
        assert bad is None, f"item {bad and bad.get('slug')} has protocol={bad and bad.get('protocol')}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T09_get_leaderboard_min_three_entries_with_fmv():
    tool = "get_leaderboard"
    try:
        r = _call("/api/v1/leaderboard?metric=cheapest&limit=10")
        assert r.status == 200
        _require_headers(r.headers)
        entries = (r.body or {}).get("entries", [])
        assert len(entries) >= 3, f"expected >= 3 entries, got {len(entries)}"
        for e in entries:
            fmv = ((e.get("service") or {}).get("fairPrice") or {}).get("fmvMicros")
            assert isinstance(fmv, (int, float)), (
                f"entry {(e.get('service') or {}).get('slug')} missing fmvMicros"
            )
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T10_recent_observations_array_shape():
    tool = "recent_observations"
    try:
        r = _call(f"/api/v1/services/{KNOWN_SLUG}/observations?limit=5")
        assert r.status == 200
        _require_headers(r.headers)
        assert isinstance(r.body, list) and r.body, "expected non-empty array"
        for o in r.body:
            assert o.get("observedAt"), "observedAt missing"
            assert "amountMicros" in o, "amountMicros missing"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def _call_verify_receipt_with_retry(rid: str, *, timeout_s: float = 3.0, step_s: float = 0.15):
    # Task #535 · receipts are persisted asynchronously by the
    # server's WAL queue (artifacts/api-server/src/lib/receiptsStore.ts),
    # so an immediate verify-receipt lookup right after the originating
    # request can race the writer and return 404. Mirror the TS
    # callVerifyReceiptWithRetry helper · poll up to 3s at 150ms.
    import time as _time

    deadline = _time.monotonic() + timeout_s
    last = _call(f"/api/v1/verify-receipt?receipt_id={rid}")
    while last.status == 404 and _time.monotonic() < deadline:
        _time.sleep(step_s)
        last = _call(f"/api/v1/verify-receipt?receipt_id={rid}")
    return last


def test_T11_verify_receipt_real_id():
    tool = "verify_receipt"
    try:
        rid = T01_RECEIPT["id"]
        assert rid, "T01 did not produce a receipt id"
        r = _call_verify_receipt_with_retry(rid)
        assert r.status == 200, f"HTTP {r.status}"
        _require_headers(r.headers)
        verified = (r.body or {}).get("valid") is True or (
            bool((r.body or {}).get("payload")) and bool((r.body or {}).get("signature"))
        )
        assert verified, f"verified=false for {rid}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T12_verify_receipt_tampered_signature_returns_false():
    tool = "verify_receipt"
    try:
        rid = T01_RECEIPT["id"]
        assert rid, "T01 did not produce a receipt id"
        lookup = _call_verify_receipt_with_retry(rid)
        assert lookup.status == 200, f"could not fetch T01 receipt (HTTP {lookup.status})"
        orig = (lookup.body or {}).get("signature")
        assert isinstance(orig, str) and len(orig) > 8, "T01 receipt has no signature to tamper"
        # Flip one base64 character in the middle of the signature to
        # force an Ed25519 verify failure (keeps length + charset valid
        # so the server actually runs the verify code path).
        idx = len(orig) // 2
        swap = "B" if orig[idx] == "A" else "A"
        tampered_sig = orig[:idx] + swap + orig[idx + 1 :]
        r = _call(
            "/api/v1/verify-receipt",
            method="POST",
            json_body={
                "body": lookup.body["payload"],
                "signature": tampered_sig,
                "signedAt": lookup.body.get("signedAt"),
                "keyId": lookup.body.get("keyId"),
                "receiptId": lookup.body.get("receiptId"),
            },
        )
        assert r.status == 200, f"expected HTTP 200, got {r.status}"
        assert r.body is not None and r.body.get("valid") is False, (
            f"tampered signature must return valid=False; got valid={r.body and r.body.get('valid')!r}"
        )
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T13_get_signed_receipt_returns_payload_and_signature():
    tool = "get_signed_receipt"
    try:
        rid = T01_RECEIPT["id"]
        assert rid, "T01 did not produce a receipt id"
        r = _call_verify_receipt_with_retry(rid)
        assert r.status == 200
        _require_headers(r.headers)
        for k in ("payload", "signature", "canonicalHash"):
            assert (r.body or {}).get(k), f"{k} missing"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T14_subscribe_alert_has_receipt_id():
    tool = "subscribe_alert"
    try:
        import time

        payload = {
            "channel": "webhook",
            "webhookUrl": WEBHOOK_URL_FOR_T14,
            "condition": "price_move_pct",
            "label": f"ari-shipment-gate-{int(time.time() * 1000)}",
            "config": {"thresholdPct": 5},
        }
        r = _call("/api/alerts/subscriptions", method="POST", json_body=payload)
        assert r.receipt_id, f"no Ari-Receipt-Id on response (HTTP {r.status})"
        assert r.status in (200, 201, 400), f"unexpected HTTP {r.status}"
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


def test_T15_get_service_missing_slug_404_with_error():
    tool = "get_service"
    try:
        r = _call(f"/api/v1/services/{MISSING_SLUG}")
        assert r.status == 404, f"expected HTTP 404, got {r.status}"
        assert isinstance((r.body or {}).get("error"), str), "error field missing"
        assert "fmv_usd" not in (r.body or {}) and "fmvMicros" not in (r.body or {}), (
            "404 body must not include fmv_usd / fmvMicros"
        )
        _say(tool, r.receipt_id)
    except AssertionError as e:
        _say(tool, None, "FAIL", str(e))
        raise


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-s", "-q"]))
