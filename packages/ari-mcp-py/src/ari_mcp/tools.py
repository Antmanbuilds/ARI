# SPDX-License-Identifier: Apache-2.0
"""Tool surface · same names and JSON schemas as the Node package."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from pydantic import BaseModel, Field, HttpUrl, EmailStr

from .client import AriClient


def _usd_to_micros(usd: float) -> int:
    return round(usd * 1_000_000)


def _micros_to_usd(micros: int | float | None) -> float | None:
    if micros is None:
        return None
    return float(micros) / 1_000_000


class SlugInput(BaseModel):
    slug: str = Field(..., min_length=1)


class FairPriceQuoteInput(BaseModel):
    slug: str = Field(..., min_length=1)
    amount_usd: float = Field(..., gt=0)
    unit: str | None = None


class ListServicesInput(BaseModel):
    protocol: str | None = Field(None, pattern="^(x402|mpp)$")
    category: str | None = None
    search: str | None = None
    limit: int = Field(25, ge=1, le=200)
    offset: int = Field(0, ge=0)


class LeaderboardInput(BaseModel):
    kind: str = Field(
        ..., pattern="^(cheapest|most_expensive|most_volatile|biggest_drop|biggest_jump|most_observed)$"
    )
    category: str | None = None
    limit: int = Field(10, ge=1, le=50)


class RecentObservationsInput(BaseModel):
    slug: str = Field(..., min_length=1)
    limit: int = Field(50, ge=1, le=500)
    since: str | None = None


class ReceiptIdInput(BaseModel):
    receipt_id: str = Field(..., min_length=1)


class ForRequestIdInput(BaseModel):
    for_request_id: str = Field(..., min_length=1)


class PrepayVerdictInput(BaseModel):
    url: str = Field(
        ...,
        min_length=1,
        description=(
            "The full URL the agent is about to POST/GET against, OR the indexed "
            "ARI service slug. Tries slug-match first, then domain-match."
        ),
    )
    amount_micros: int = Field(..., gt=0)
    currency: str = Field("USD", min_length=1)
    chain: str | None = None


class SubscribeAlertInput(BaseModel):
    slug: str = Field(..., min_length=1)
    condition: str = Field(..., pattern="^(above|below|volatility_pct)$")
    threshold: float
    webhook: HttpUrl | None = None
    email: EmailStr | None = None


@dataclass
class ToolDef:
    name: str
    title: str
    description: str
    input_model: type[BaseModel]
    run: Callable[[Mapping[str, Any], AriClient], dict[str, Any]]


def _is_fair_price(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = FairPriceQuoteInput(**args)
    params = {"service": inp.slug, "amount_micros": _usd_to_micros(inp.amount_usd)}
    if inp.unit:
        params["unit"] = inp.unit
    r = client.request("/api/v1/fair-price", params=params)
    fp = r.data
    return {
        "verdict": (fp.get("verdict") or {}).get("label", "unknown"),
        "fmv_usd": _micros_to_usd(fp.get("fmvMicros", 0)),
        "low_usd": _micros_to_usd(fp.get("lowMicros", 0)),
        "high_usd": _micros_to_usd(fp.get("highMicros", 0)),
        "delta_pct": (fp.get("verdict") or {}).get("deltaPct"),
        "sample_size": fp.get("sampleSize", 0),
        "currency": fp.get("currency", "USD"),
        "unit": fp.get("unitCode") or inp.unit,
        "receipt_id": r.receipt_id,
        "signed_at": r.signed_at,
    }


def _get_fmv(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = SlugInput(**args)
    r = client.request(f"/api/v1/services/{inp.slug}")
    fp = (r.data or {}).get("fairPrice")
    if not fp:
        return {
            "slug": inp.slug,
            "fmv_usd": None,
            "low_usd": None,
            "high_usd": None,
            "sample_size": 0,
            "last_observed_at": (r.data or {}).get("lastObservedAt"),
            "receipt_id": r.receipt_id,
            "message": "No FMV available · service has no recent observations.",
        }
    return {
        "slug": r.data.get("slug"),
        "fmv_usd": _micros_to_usd(fp.get("fmvMicros", 0)),
        "low_usd": _micros_to_usd(fp.get("lowMicros", 0)),
        "high_usd": _micros_to_usd(fp.get("highMicros", 0)),
        "sample_size": fp.get("sampleSize", 0),
        "last_observed_at": r.data.get("lastObservedAt") or fp.get("updatedAt"),
        "currency": fp.get("currency", "USD"),
        "unit": fp.get("unitCode"),
        "receipt_id": r.receipt_id,
        "signed_at": r.signed_at,
    }


def _list_services(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = ListServicesInput(**args)
    params: dict[str, Any] = {"limit": inp.limit, "offset": inp.offset}
    if inp.protocol:
        params["protocol"] = inp.protocol
    if inp.category:
        params["category"] = inp.category
    if inp.search:
        params["q"] = inp.search
    r = client.request("/api/v1/services", params=params)
    items = []
    for svc in (r.data or {}).get("items", []) or []:
        fp = svc.get("fairPrice") or {}
        items.append(
            {
                "slug": svc.get("slug"),
                "name": svc.get("name"),
                "vendor": svc.get("vendor"),
                "protocol": svc.get("protocol"),
                "category": svc.get("categorySlug")
                or (svc.get("category") or {}).get("slug"),
                "fmv_usd": _micros_to_usd(fp.get("fmvMicros")) if fp.get("fmvMicros") else None,
                "last_observed_at": svc.get("lastObservedAt"),
            }
        )
    return {
        "items": items,
        "total": (r.data or {}).get("total", len(items)),
        "limit": inp.limit,
        "offset": inp.offset,
        "receipt_id": r.receipt_id,
    }


def _get_service(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = SlugInput(**args)
    r = client.request(f"/api/v1/services/{inp.slug}")
    svc = r.data or {}
    fp = svc.get("fairPrice") or {}
    return {
        "slug": svc.get("slug"),
        "name": svc.get("name"),
        "vendor": svc.get("vendor"),
        "protocol": svc.get("protocol"),
        "category": svc.get("categorySlug")
        or (svc.get("category") or {}).get("slug"),
        "units": svc.get("units", []),
        "sources": svc.get("sources", []),
        "fmv_usd": _micros_to_usd(fp.get("fmvMicros")) if fp.get("fmvMicros") else None,
        "low_usd": _micros_to_usd(fp.get("lowMicros")) if fp.get("lowMicros") else None,
        "high_usd": _micros_to_usd(fp.get("highMicros")) if fp.get("highMicros") else None,
        "last_observed_at": svc.get("lastObservedAt"),
        "related": [
            {
                "slug": rel.get("slug"),
                "name": rel.get("name"),
                "fmv_usd": _micros_to_usd((rel.get("fairPrice") or {}).get("fmvMicros"))
                if (rel.get("fairPrice") or {}).get("fmvMicros")
                else None,
            }
            for rel in svc.get("related", []) or []
        ],
        "receipt_id": r.receipt_id,
        "signed_at": r.signed_at,
    }


def _get_leaderboard(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = LeaderboardInput(**args)
    params: dict[str, Any] = {"metric": inp.kind, "limit": inp.limit}
    if inp.category:
        params["category"] = inp.category
    r = client.request("/api/v1/leaderboard", params=params)
    return {
        "kind": inp.kind,
        "category": inp.category,
        "entries": [
            {
                "slug": (e.get("service") or {}).get("slug"),
                "name": (e.get("service") or {}).get("name"),
                "vendor": (e.get("service") or {}).get("vendor"),
                "value": e.get("value"),
                "label": e.get("label"),
                "delta_pct": e.get("deltaPct"),
            }
            for e in (r.data or {}).get("entries", []) or []
        ],
        "receipt_id": r.receipt_id,
    }


def _recent_observations(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = RecentObservationsInput(**args)
    r = client.request(
        f"/api/v1/services/{inp.slug}/observations",
        params={"limit": inp.limit},
    )
    items = r.data or []
    if inp.since:
        from datetime import datetime

        try:
            cutoff = datetime.fromisoformat(inp.since.replace("Z", "+00:00"))
            items = [
                o
                for o in items
                if datetime.fromisoformat(o["observedAt"].replace("Z", "+00:00"))
                >= cutoff
            ]
        except ValueError:
            pass
    return {
        "slug": inp.slug,
        "items": [
            {
                "observed_at": o.get("observedAt"),
                "amount_usd": _micros_to_usd(o.get("amountMicros")),
                "unit": o.get("unitCode"),
                "currency": o.get("currency"),
                "source": o.get("source"),
            }
            for o in items
        ],
        "receipt_id": r.receipt_id,
    }


def _refuse_if_overpriced(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = FairPriceQuoteInput(**args)
    params: dict[str, Any] = {
        "service": inp.slug,
        "amount_micros": _usd_to_micros(inp.amount_usd),
    }
    if inp.unit:
        params["unit"] = inp.unit
    r = client.request("/api/v1/fair-price", params=params)
    fp = r.data
    verdict = (fp.get("verdict") or {}).get("label", "unknown")
    fmv_usd = _micros_to_usd(fp.get("fmvMicros", 0)) or 0.0
    high_usd = _micros_to_usd(fp.get("highMicros", 0)) or 0.0
    should_pay = verdict != "red"
    savings = max(0.0, inp.amount_usd - high_usd) if (verdict == "red" and high_usd > 0) else 0.0
    if should_pay:
        reason = (
            f"Quote is within ARI's fair-market range (FMV ≈ ${fmv_usd:.6f}/unit)."
        )
    else:
        reason = (
            f"Quote is more than ARI's high band (${high_usd:.6f}/unit). "
            f"Estimated savings if you walk: ${savings:.6f} per unit."
        )
    return {
        "should_pay": should_pay,
        "verdict": verdict,
        "reason": reason,
        "fmv_usd": fmv_usd,
        "high_usd": high_usd,
        "savings_estimate_usd": savings,
        "receipt_id": r.receipt_id,
        "signed_at": r.signed_at,
    }


def _prepay_verdict(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    from urllib.parse import urlparse

    inp = PrepayVerdictInput(**args)
    slug = inp.url
    host: str | None = None
    parsed = urlparse(inp.url)
    if parsed.scheme and parsed.hostname:
        host = parsed.hostname.removeprefix("www.")
        slug = host

    def _fetch(svc: str):
        return client.request(
            "/api/v1/fair-price",
            params={"service": svc, "amount_micros": inp.amount_micros},
        )

    r = _fetch(slug)
    fp = r.data or {}
    if (not fp.get("fmvMicros") or int(fp.get("fmvMicros") or 0) == 0) and host:
        try:
            lookup = client.request("/api/v1/services", params={"q": host, "limit": 1})
            items = (lookup.data or {}).get("items") or []
            resolved = items[0].get("slug") if items else None
            if resolved and resolved != slug:
                slug = resolved
                r = _fetch(slug)
                fp = r.data or {}
        except Exception:
            pass

    label = (fp.get("verdict") or {}).get("label", "unknown")
    fmv = int(fp.get("fmvMicros") or 0)
    high = int(fp.get("highMicros") or 0)
    overpriced = (
        label in ("red", "overpriced") or (high > 0 and inp.amount_micros > high)
    )
    stretched = (not overpriced) and label in ("amber", "stretched")
    verdict = "overpriced" if overpriced else ("stretched" if stretched else "fair")
    if verdict == "overpriced":
        reason = (
            f"Quote ({inp.amount_micros} micro-{inp.currency}) is above ARI's high "
            f"band ({high}). REFUSE."
        )
    elif verdict == "stretched":
        reason = (
            f"Quote is above the FMV ({fmv}) but inside the trusted band. "
            "Settle with caution."
        )
    else:
        reason = f"Quote is within ARI's fair-market range (FMV ≈ {fmv} micro-{inp.currency})."
    suggested_max = high if high > 0 else None
    return {
        "verdict": verdict,
        "reason": reason,
        "suggestedMax": suggested_max,
        "suggestedMaxMicros": suggested_max,
        "amountMicros": inp.amount_micros,
        "fmvMicros": fmv,
        "evidenceUrl": f"{client.base_url}/api/v1/services/{slug}",
        "slug": slug,
        "chain": inp.chain,
        "currency": inp.currency,
        "receipt_id": r.receipt_id,
        "signed_at": r.signed_at,
    }


def _verify_receipt(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = ReceiptIdInput(**args)
    r = client.request("/api/v1/verify-receipt", params={"id": inp.receipt_id})
    d = r.data or {}
    return {
        "receipt_id": inp.receipt_id,
        "valid": d.get("valid", False),
        "key_id": d.get("keyId"),
        "signed_at": d.get("signedAt"),
        "request_path": d.get("requestPath"),
        "canonical_hash": d.get("canonicalHash"),
        "verifier_receipt_id": r.receipt_id,
    }


def _get_signed_receipt(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = ForRequestIdInput(**args)
    r = client.request("/api/v1/verify-receipt", params={"id": inp.for_request_id})
    d = r.data or {}
    return {
        "receipt_id": inp.for_request_id,
        "signed_at": d.get("signedAt"),
        "request_path": d.get("requestPath"),
        "payload": d.get("payload"),
        "signature": d.get("signature"),
        "canonical_hash": d.get("canonicalHash"),
        "key_id": d.get("keyId"),
        "verifier_receipt_id": r.receipt_id,
    }


def _subscribe_alert(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = SubscribeAlertInput(**args)
    if not inp.webhook and not inp.email:
        raise ValueError("Provide either a webhook URL or an email address.")
    body = {
        "serviceSlug": inp.slug,
        "condition": inp.condition,
        "threshold": inp.threshold,
    }
    if inp.webhook:
        body["webhookUrl"] = str(inp.webhook)
    if inp.email:
        body["email"] = str(inp.email)
    r = client.request("/api/v1/alerts", method="POST", json=body)
    d = r.data or {}
    return {
        "alert_id": d.get("id"),
        "slug": inp.slug,
        "condition": inp.condition,
        "threshold": inp.threshold,
        "delivery": "webhook" if inp.webhook else "email",
        "created_at": d.get("createdAt"),
        "receipt_id": r.receipt_id,
    }


TOOLS: list[ToolDef] = [
    ToolDef(
        name="is_fair_price",
        title="Check if a quoted price is fair",
        description=(
            "Compare a quoted price for a known service against ARI's current fair-market value (FMV) band. "
            "Returns a verdict (green/amber/red), the FMV, the band, the percentile, the sample size, and a "
            "citable signed receipt id."
        ),
        input_model=FairPriceQuoteInput,
        run=_is_fair_price,
    ),
    ToolDef(
        name="get_fmv",
        title="Get the fair-market value for a service",
        description=(
            "Look up the current FMV (median + low/high band) for an indexed service. Use this when you "
            "need the price you'd quote a counterparty before knowing their ask."
        ),
        input_model=SlugInput,
        run=_get_fmv,
    ),
    ToolDef(
        name="list_services",
        title="List indexed services",
        description=(
            "Browse the ARI service index. Filter by protocol (x402, mpp), category, or free-text search."
        ),
        input_model=ListServicesInput,
        run=_list_services,
    ),
    ToolDef(
        name="get_service",
        title="Get full service detail",
        description="Return the full detail row for one service.",
        input_model=SlugInput,
        run=_get_service,
    ),
    ToolDef(
        name="get_leaderboard",
        title="Get a leaderboard slice",
        description=(
            "Return the top services for one of the canonical leaderboards: cheapest, most_expensive, "
            "most_volatile, biggest_drop, biggest_jump, most_observed."
        ),
        input_model=LeaderboardInput,
        run=_get_leaderboard,
    ),
    ToolDef(
        name="recent_observations",
        title="Recent observations for a service",
        description="Return the most recent price observations for one service.",
        input_model=RecentObservationsInput,
        run=_recent_observations,
    ),
    ToolDef(
        name="refuse_if_overpriced",
        title="Decide whether to pay a quote",
        description=(
            "Convenience wrapper agents call right before paying. Returns should_pay: false (with a reason "
            "and savings estimate) when the quoted amount is materially above ARI's high band."
        ),
        input_model=FairPriceQuoteInput,
        run=_refuse_if_overpriced,
    ),
    ToolDef(
        name="verify_receipt",
        title="Verify a previously-issued ARI receipt",
        description="Re-fetch a receipt by its ULID and re-verify the Ed25519 signature.",
        input_model=ReceiptIdInput,
        run=_verify_receipt,
    ),
    ToolDef(
        name="get_signed_receipt",
        title="Re-fetch a previous signed receipt body",
        description="Look up the canonical signed body for a previously-issued receipt id.",
        input_model=ForRequestIdInput,
        run=_get_signed_receipt,
    ),
    ToolDef(
        name="prepay_verdict",
        title="Pre-flight a 402 / MPP payment quote against ARI",
        description=(
            "Universal Fairness Skill entry point. Call BEFORE settling any x402 HTTP 402 "
            "challenge or MPP inline quote. Returns { verdict, reason, suggestedMax, "
            "evidenceUrl, receipt_id } so the agent can refuse-to-overpay with a citable "
            "reason."
        ),
        input_model=PrepayVerdictInput,
        run=_prepay_verdict,
    ),
    ToolDef(
        name="subscribe_alert",
        title="Subscribe to a price alert",
        description=(
            "Set up a price alert. Pass a webhook URL or an email. Conditions: above, below, volatility_pct."
        ),
        input_model=SubscribeAlertInput,
        run=_subscribe_alert,
    ),
]
