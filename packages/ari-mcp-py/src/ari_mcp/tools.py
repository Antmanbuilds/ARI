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


# Task #437 · single source of truth for "is this verdict a green light to
# settle?". Default-deny: only an explicit positive label from the FMV
# engine ("green") or the prepay endpoint ("fair") authorises payment.
# Everything else returns "refuse" (amber / stretched / red / overpriced)
# or "abstain" (unknown / insufficient_data / missing / unrecognised
# future label). Mirrors verdictDecision() in tools/index.ts.
_PAY_VERDICTS = frozenset({"green", "fair"})
_REFUSE_VERDICTS = frozenset({"amber", "stretched", "red", "overpriced"})


def _extract_verdict_label(verdict: Any) -> str | None:
    # Task #535 · the server returns `verdict` as either a bare label
    # ("green") or a structured object ({"label": "green", "deltaPct": ...}).
    # Older callers (and the contract fixtures) feed the raw object straight
    # in; collapsing it to a string here keeps the pay/refuse helpers
    # frozenset-hashable and matches the TS path.
    if isinstance(verdict, dict):
        label = verdict.get("label")
        return label if isinstance(label, str) else None
    if isinstance(verdict, str):
        return verdict
    return None


def _verdict_decision(verdict: Any) -> str:
    label = _extract_verdict_label(verdict)
    if label in _PAY_VERDICTS:
        return "pay"
    if label in _REFUSE_VERDICTS:
        return "refuse"
    return "abstain"


# Task #489 · confidence-aware variant. Default-deny: a green verdict
# whose receipt advertises `confidence: low` (e.g. the FMV is a
# category-median fallback) abstains unless the caller explicitly opts
# in via ``accept_low_confidence``. Mirrors verdictDecisionWithConfidence
# in tools/ari-mcp-ts/src/tools/index.ts.
def _verdict_decision_with_confidence(
    verdict: Any,
    confidence: str | None,
    *,
    accept_low_confidence: bool = False,
) -> str:
    base = _verdict_decision(verdict)
    if base != "pay":
        return base
    if confidence in ("high", "medium"):
        return "pay"
    # Task #535 · only DEMOTE on an explicit "low" confidence. Missing /
    # null confidence means the server didn't emit the v3 field (legacy
    # server, service-direct verdict, or a route that doesn't expose it).
    # Treating that as "low" would break the cross-language contract
    # (fixtures send `green` with no confidence) and regress every legacy
    # caller. Default-allow the pay; demote only on explicit "low".
    # Mirrors verdictDecisionWithConfidence in tools/ari-mcp-ts/src/tools/index.ts.
    if confidence == "low":
        if accept_low_confidence:
            return "pay"
        return "abstain"
    return "pay"


class SlugInput(BaseModel):
    slug: str = Field(..., min_length=1)


class FairPriceQuoteInput(BaseModel):
    slug: str = Field(..., min_length=1)
    amount_usd: float = Field(..., gt=0)
    unit: str = Field(
        ...,
        min_length=1,
        description=(
            "Unit code (e.g. tokens, calls, seconds). Required so the quote is "
            "compared against the correct unit's FMV band."
        ),
    )


class ListServicesInput(BaseModel):
    protocol: str | None = Field(None, pattern="^(x402|mpp)$")
    category: str | None = None
    search: str | None = None
    limit: int = Field(25, ge=1, le=200)
    offset: int = Field(0, ge=0)


class LeaderboardInput(BaseModel):
    # Task #437 schema reconciliation: spec lists ``kind`` as optional.
    # Default to ``most_observed`` (the most-trafficked slice) so an LLM
    # that hasn't been told which leaderboard to look at still gets a
    # useful answer · mirrors the TS schema default.
    kind: str = Field(
        "most_observed",
        pattern="^(cheapest|most_expensive|most_volatile|biggest_drop|biggest_jump|most_observed)$",
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
    """Input for get_signed_receipt.

    Canonical field is ``receipt_id``. ``for_request_id`` is kept as a
    deprecated alias for one release.
    """

    receipt_id: str | None = Field(
        None,
        min_length=1,
        description="Canonical: the ARI receipt id (ULID).",
    )
    for_request_id: str | None = Field(
        None,
        min_length=1,
        description="Deprecated alias for `receipt_id`.",
    )

    def effective_receipt_id(self) -> str:
        rid = self.receipt_id if self.receipt_id is not None else self.for_request_id
        if rid is None:
            raise ValueError(
                "receipt_id (canonical) or for_request_id (deprecated alias) is required"
            )
        return rid

    # Task #535 · short alias used by the cross-language verify test.
    # Mirrors `effectiveId()` on the TS input model.
    def effective_id(self) -> str:
        return self.effective_receipt_id()

    def model_post_init(self, __context: Any) -> None:  # noqa: D401
        if self.receipt_id is None and self.for_request_id is None:
            raise ValueError(
                "receipt_id (canonical) or for_request_id (deprecated alias) is required"
            )


class PrepayVerdictInput(BaseModel):
    """Input for prepay_verdict.

    Canonical inputs (per the published spec): ``slug``, ``amount_usd``,
    ``unit``. Legacy aliases ``url``, ``amountMicros``, and
    ``amount_micros`` are accepted and mapped internally for one-release
    backward compatibility.
    """

    model_config = {"populate_by_name": True}

    # Canonical spec inputs.
    slug: str | None = Field(
        None,
        min_length=1,
        description="Canonical: the indexed ARI service slug.",
    )
    amount_usd: float | None = Field(
        None,
        gt=0,
        description="Canonical: quoted amount in US dollars.",
    )
    unit: str | None = Field(
        None,
        description="Canonical: unit code (tokens, calls, seconds).",
    )

    # Legacy aliases (kept for backward compatibility, mapped internally).
    url: str | None = Field(
        None,
        min_length=1,
        description=(
            "Deprecated alias for `slug` · the full URL the agent is about "
            "to call, or a slug. Server resolves slug or hostname."
        ),
    )
    amountMicros: int | None = Field(None, alias="amountMicros", gt=0)
    amount_micros: int | None = Field(None, gt=0)
    currency: str = Field("USD", min_length=1)
    chain: str = Field("off-chain", min_length=1)
    service: str | None = None

    def effective_target(self) -> str:
        target = self.url if self.url is not None else self.slug
        if target is None:
            raise ValueError(
                "slug (canonical) or url (deprecated alias) is required"
            )
        return target

    def effective_amount_micros(self) -> int:
        if self.amountMicros is not None:
            return self.amountMicros
        if self.amount_micros is not None:
            return self.amount_micros
        if self.amount_usd is not None:
            return round(self.amount_usd * 1_000_000)
        raise ValueError(
            "amount_usd (canonical) or amountMicros / amount_micros "
            "(deprecated aliases) is required"
        )

    def model_post_init(self, __context: Any) -> None:  # noqa: D401
        if self.slug is None and self.url is None:
            raise ValueError(
                "slug (canonical) or url (deprecated alias) is required"
            )
        if (
            self.amount_usd is None
            and self.amountMicros is None
            and self.amount_micros is None
        ):
            raise ValueError(
                "amount_usd (canonical) or amountMicros / amount_micros "
                "(deprecated aliases) is required"
            )


class SubscribeAlertInput(BaseModel):
    """Task #437 · webhook XOR email enforced at the schema level so MCP
    callers see a structured validation error (and the published JSON
    schema documents the constraint) instead of a bare ValueError. Also
    accepts ``webhook_url`` as an alias for ``webhook``.

    Schema-reconciliation decision (recorded): ``condition`` and
    ``threshold`` remain required because the underlying
    ``POST /api/v1/alerts`` endpoint requires them · an alert without a
    condition or threshold has no semantic meaning. We document the
    requirement instead of dropping the fields."""

    model_config = {"populate_by_name": True}

    slug: str = Field(..., min_length=1)
    condition: str = Field(..., pattern="^(above|below|volatility_pct)$")
    threshold: float
    webhook: HttpUrl | None = None
    webhook_url: HttpUrl | None = None
    email: EmailStr | None = None

    def effective_webhook(self) -> HttpUrl | None:
        return self.webhook if self.webhook is not None else self.webhook_url

    def model_post_init(self, __context: Any) -> None:  # noqa: D401
        webhook = self.effective_webhook()
        if webhook is None and self.email is None:
            raise ValueError(
                "Provide either a webhook URL (webhook / webhook_url) or an email address."
            )
        if webhook is not None and self.email is not None:
            raise ValueError("Provide a webhook URL OR an email, not both.")


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
    fp = r.data or {}
    return {
        "verdict": (fp.get("verdict") or {}).get("label", "unknown"),
        # Honest-null: never coerce a missing FMV to 0 · that would tell
        # the LLM the service is "free" or that any quote is overpriced.
        "fmv_usd": _micros_to_usd(fp.get("fmvMicros")) if fp.get("fmvMicros") is not None else None,
        "low_usd": _micros_to_usd(fp.get("lowMicros")) if fp.get("lowMicros") is not None else None,
        "high_usd": _micros_to_usd(fp.get("highMicros")) if fp.get("highMicros") is not None else None,
        "delta_pct": (fp.get("verdict") or {}).get("deltaPct"),
        "sample_size": fp.get("sampleSize") if fp.get("sampleSize") is not None else None,
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
            "sample_size": None,
            "last_observed_at": (r.data or {}).get("lastObservedAt"),
            "receipt_id": r.receipt_id,
            "message": "No FMV available · service has no recent observations.",
        }
    return {
        "slug": r.data.get("slug"),
        "fmv_usd": _micros_to_usd(fp.get("fmvMicros")) if fp.get("fmvMicros") is not None else None,
        "low_usd": _micros_to_usd(fp.get("lowMicros")) if fp.get("lowMicros") is not None else None,
        "high_usd": _micros_to_usd(fp.get("highMicros")) if fp.get("highMicros") is not None else None,
        "sample_size": fp.get("sampleSize") if fp.get("sampleSize") is not None else None,
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
    fp = r.data or {}
    verdict = (fp.get("verdict") or {}).get("label", "unknown")
    fmv_usd = _micros_to_usd(fp.get("fmvMicros")) if fp.get("fmvMicros") is not None else None
    high_usd = _micros_to_usd(fp.get("highMicros")) if fp.get("highMicros") is not None else None
    # Honest-null: if the oracle has not computed an FMV yet we MUST NOT
    # synthesise a $0 baseline · doing so would tell an agent that any
    # quote above $0 is overpriced (or that the service is "free").
    # Refuse to decide and surface the unknown state so the caller can
    # fall back to its own policy.
    # Task #437 round-3 · STRICT BOOLEAN fail-closed contract. The
    # previous "honest-null" variant returned should_pay=None for
    # missing-baseline / insufficient_data / unrecognised verdicts.
    # An LLM that branches on `if should_pay:` would treat None as
    # falsy, but agents that branch on `should_pay is not False` would
    # AUTO-PAY on a None. The only way to make this tool safe for
    # every calling pattern is to ALWAYS return a boolean, with the
    # baseline/insufficient/unrecognised cases mapped to False. The
    # `verdict` + `reason` fields still surface the underlying
    # condition so callers can distinguish "ARI said red" from
    # "ARI couldn't decide" and fall back to a human/own policy.
    if fmv_usd is None or high_usd is None:
        return {
            "should_pay": False,
            "verdict": "unknown",
            "reason": (
                "ARI has no fair-market baseline for this service yet "
                "(still indexing or insufficient observations). Refusing to "
                "pay by default · this tool will not synthesise a $0 reference "
                "price. Fall back to your own policy if you want to proceed."
            ),
            "fmv_usd": fmv_usd,
            "high_usd": high_usd,
            "savings_estimate_usd": None,
            "receipt_id": r.receipt_id,
            "signed_at": r.signed_at,
        }
    if verdict == "insufficient_data":
        return {
            "should_pay": False,
            "verdict": verdict,
            "reason": (
                "ARI has an FMV baseline but not enough independent "
                "observations to grade this quote with confidence "
                "(insufficient evidence under the weighted engine). Refusing "
                "to pay by default · fall back to your own policy if you want "
                "to proceed."
            ),
            "fmv_usd": fmv_usd,
            "high_usd": high_usd,
            "savings_estimate_usd": None,
            "receipt_id": r.receipt_id,
            "signed_at": r.signed_at,
        }
    # Default-deny via the shared helper. Only explicit "green"/"fair"
    # produces decision=="pay". Amber/red → "refuse". Unknown labels →
    # "abstain", which (per the strict-boolean contract above) ALSO
    # collapses to should_pay=False here.
    # Task #489 · confidence-aware default-deny. A "green" verdict on a
    # category-median / global-median fallback FMV (`confidence: "low"`)
    # only says the quote landed inside a wide cross-vendor band · it
    # does NOT establish that the offer itself is fair. Demote to
    # abstain so we don't auto-settle on weak evidence.
    confidence = fp.get("confidence")
    decision = _verdict_decision_with_confidence(verdict, confidence)
    if decision == "abstain":
        return {
            "should_pay": False,
            "verdict": verdict,
            "reason": (
                f'ARI returned a verdict label ("{verdict}", confidence '
                f'"{confidence or "missing"}") that this client cannot '
                "auto-settle on. Refusing to pay by default · fall back to "
                "your own policy if you want to proceed."
            ),
            "fmv_usd": fmv_usd,
            "high_usd": high_usd,
            "savings_estimate_usd": None,
            "receipt_id": r.receipt_id,
            "signed_at": r.signed_at,
        }
    should_pay = decision == "pay"
    above_high = inp.amount_usd > high_usd
    savings = max(0.0, inp.amount_usd - high_usd) if (not should_pay and above_high) else 0.0
    if should_pay:
        reason = f"Quote is within ARI's fair-market range (FMV ≈ ${fmv_usd:.6f}/unit)."
    elif above_high:
        reason = (
            f"Quote is more than ARI's high band (${high_usd:.6f}/unit). "
            f"Estimated savings if you walk: ${savings:.6f} per unit."
        )
    else:
        reason = (
            f'ARI graded this quote as "{verdict}" · materially above the fair-market '
            f"midpoint (FMV ≈ ${fmv_usd:.6f}/unit, high band ${high_usd:.6f}/unit). "
            "refuse_if_overpriced refuses to auto-settle on a stretched-band quote."
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
    # Delegate to the canonical server endpoint · same wire as the TS
    # client. The server resolves URL → slug, computes FMV, applies the
    # latency budget, and increments the opt-out metric counter. The
    # tool returns BOTH canonical camelCase and snake_case mirrors so
    # MCP clients keying on either convention work without a re-map.
    inp = PrepayVerdictInput(**args)
    amount_micros = inp.effective_amount_micros()
    body: dict[str, Any] = {
        "url": inp.effective_target(),
        "amountMicros": amount_micros,
        "currency": inp.currency,
        "chain": inp.chain,
    }
    if inp.service:
        body["service"] = inp.service
    if inp.unit:
        body["unit"] = inp.unit
    # Task #437 schema-reconciliation decision (recorded on purpose):
    # the spec-sheet draft suggested ``slug`` + ``amount_usd``, but the
    # canonical server endpoint at POST /api/v1/mcp/prepay-verdict
    # requires ``url`` + ``amountMicros`` (it does URL → slug resolution
    # server-side so the same input shape works for indexed slugs *and*
    # unknown URLs the agent is about to hit). Real callers including
    # the published spec example, the wallet-integration doc, and the
    # TS ari-mcp client already use this shape. Switching the wire shape
    # would break those callers for zero correctness win, so we keep
    # the impl and treat it as the source of truth. We do apply the
    # shared ``_verdict_decision`` helper below to add a normalised
    # ``decision`` field so the rule lives in one place (step 1 of the
    # task) without rewriting the verdict string the server returned.
    r = client.request("/api/v1/mcp/prepay-verdict", method="POST", json=body)
    data = r.data or {}
    suggested_max = data.get("suggestedMax")
    verdict_str = data.get("verdict", "unknown")
    decision = _verdict_decision(verdict_str)
    return {
        "verdict": verdict_str,
        "decision": decision,
        "reason": data.get("reason"),
        "suggestedMax": suggested_max,
        "suggested_max_micros": suggested_max,
        "evidenceUrl": data.get("evidenceUrl"),
        "evidence_url": data.get("evidenceUrl"),
        "fmvMicros": data.get("fmvMicros"),
        "fmv_micros": data.get("fmvMicros"),
        "lowMicros": data.get("lowMicros"),
        "low_micros": data.get("lowMicros"),
        "highMicros": data.get("highMicros"),
        "high_micros": data.get("highMicros"),
        "sampleSize": data.get("sampleSize"),
        "sample_size": data.get("sampleSize"),
        "amountMicros": amount_micros,
        "currency": data.get("currency", inp.currency),
        "chain": data.get("chain", inp.chain),
        "service": data.get("service"),
        "unit": data.get("unit"),
        "latencyMs": data.get("latencyMs"),
        "latency_ms": data.get("latencyMs"),
        "receiptId": r.receipt_id,
        "receipt_id": r.receipt_id,
        "signedAt": r.signed_at,
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
    receipt_id = inp.effective_receipt_id()
    r = client.request("/api/v1/verify-receipt", params={"id": receipt_id})
    d = r.data or {}
    return {
        "receipt_id": receipt_id,
        "signed_at": d.get("signedAt"),
        "request_path": d.get("requestPath"),
        "payload": d.get("payload"),
        "signature": d.get("signature"),
        "canonical_hash": d.get("canonicalHash"),
        "key_id": d.get("keyId"),
        "verifier_receipt_id": r.receipt_id,
    }


def _subscribe_alert(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    # XOR validation lives on SubscribeAlertInput (model_post_init) so the
    # error surfaces as a structured pydantic ValidationError, not a bare
    # ValueError thrown from this function body. See task #437.
    inp = SubscribeAlertInput(**args)
    webhook = inp.effective_webhook()
    body: dict[str, Any] = {
        "serviceSlug": inp.slug,
        "condition": inp.condition,
        "threshold": inp.threshold,
    }
    if webhook is not None:
        body["webhookUrl"] = str(webhook)
    if inp.email:
        body["email"] = str(inp.email)
    r = client.request("/api/v1/alerts", method="POST", json=body)
    d = r.data or {}
    return {
        "alert_id": d.get("id"),
        "slug": inp.slug,
        "condition": inp.condition,
        "threshold": inp.threshold,
        "delivery": "webhook" if webhook is not None else "email",
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
            "Set up a price alert. Canonical delivery field is `webhook_url`; the legacy "
            "`webhook` spelling is still accepted as an alias. Provide AT LEAST ONE of "
            "`webhook_url` or `email` (and not both). Conditions: above, below, volatility_pct."
        ),
        input_model=SubscribeAlertInput,
        run=_subscribe_alert,
    ),
]


# ---------------------------------------------------------------------------
# v0.2.0 additions · 1:1 parity with tools/index.ts in the TS package.
# Backed by /api/v1/* routes added in routes/mcpV2.ts.
# ---------------------------------------------------------------------------


class _BatchFairPriceItem(BaseModel):
    slug: str = Field(..., min_length=1)
    amount_usd: float = Field(..., gt=0)
    unit: str | None = None


class BatchFairPriceInput(BaseModel):
    items: list[_BatchFairPriceItem] = Field(..., min_length=1, max_length=50)


class _BatchPrepayItem(BaseModel):
    url: str = Field(..., min_length=1)
    amount_micros: int = Field(..., gt=0)
    service: str | None = None
    unit: str | None = None
    currency: str = "USD"
    chain: str = "off-chain"


class BatchPrepayInput(BaseModel):
    items: list[_BatchPrepayItem] = Field(..., min_length=1, max_length=50)


class AnomalyInput(BaseModel):
    slug: str = Field(..., min_length=1)
    unit: str | None = None


class CategoryBenchmarkInput(BaseModel):
    category: str = Field(..., min_length=1)
    unit: str = "request"


class SubstitutesInput(BaseModel):
    slug: str = Field(..., min_length=1)
    unit: str | None = None
    limit: int = Field(5, ge=1, le=20)


class HistoricalInput(BaseModel):
    slug: str = Field(..., min_length=1)
    unit: str | None = None
    days: int = Field(30, ge=1, le=180)


class SmartRouteInput(BaseModel):
    category: str = Field(..., min_length=1)
    unit: str = "request"
    limit: int = Field(5, ge=1, le=20)


class HealthPingInput(BaseModel):
    install_id: str = Field(..., min_length=1, max_length=64)


def _is_fair_price_batch(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = BatchFairPriceInput(**args)
    body = {
        "items": [
            {
                "slug": it.slug,
                "amount_micros": _usd_to_micros(it.amount_usd),
                **({"unit": it.unit} if it.unit else {}),
            }
            for it in inp.items
        ],
    }
    r = client.request("/api/v1/fair-price/batch", method="POST", json=body)
    items = (r.data or {}).get("items", []) or []
    out = []
    for row in items:
        fmv = row.get("fmv_micros")
        low = row.get("low_micros")
        high = row.get("high_micros")
        out.append(
            {
                "slug": row.get("slug"),
                "unit": row.get("unit"),
                "verdict": row.get("verdict", "unknown"),
                "reason": row.get("reason"),
                "delta_pct": row.get("delta_pct"),
                "fmv_usd": _micros_to_usd(fmv) if fmv is not None else None,
                "low_usd": _micros_to_usd(low) if low is not None else None,
                "high_usd": _micros_to_usd(high) if high is not None else None,
                "sample_size": row.get("sample_size"),
                "category_inferred": row.get("category_inferred", False),
            }
        )
    return {"items": out, "receipt_id": r.receipt_id}


def _prepay_verdict_batch(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = BatchPrepayInput(**args)
    body = {"items": [it.model_dump(exclude_none=True) for it in inp.items]}
    r = client.request("/api/v1/mcp/prepay-verdict/batch", method="POST", json=body)
    return {"items": (r.data or {}).get("items", []), "receipt_id": r.receipt_id}


def _detect_anomaly(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = AnomalyInput(**args)
    params: dict[str, Any] = {}
    if inp.unit:
        params["unit"] = inp.unit
    r = client.request(f"/api/v1/services/{inp.slug}/anomaly", params=params or None)
    return {**(r.data or {}), "receipt_id": r.receipt_id}


def _category_benchmark(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = CategoryBenchmarkInput(**args)
    r = client.request(
        f"/api/v1/categories/{inp.category}/benchmark",
        params={"unit": inp.unit},
    )
    d = r.data or {}
    return {
        "category": inp.category,
        "unit": inp.unit,
        "fmv_usd": _micros_to_usd(d.get("fmvMicros")) if d.get("fmvMicros") is not None else None,
        "low_usd": _micros_to_usd(d.get("lowMicros")) if d.get("lowMicros") is not None else None,
        "high_usd": _micros_to_usd(d.get("highMicros")) if d.get("highMicros") is not None else None,
        "sample_size": d.get("sampleSize"),
        "contributor_count": d.get("contributorCount"),
        "inferred": d.get("inferred", False),
        "receipt_id": r.receipt_id,
    }


def _find_substitutes(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = SubstitutesInput(**args)
    params: dict[str, Any] = {"limit": inp.limit}
    if inp.unit:
        params["unit"] = inp.unit
    r = client.request(f"/api/v1/services/{inp.slug}/substitutes", params=params)
    d = r.data or {}
    return {
        "slug": d.get("slug", inp.slug),
        "category": d.get("category"),
        "unit": d.get("unit", inp.unit),
        "substitutes": [
            {
                "slug": p.get("slug"),
                "name": p.get("name"),
                "fmv_usd": _micros_to_usd(p.get("fmv_micros")),
                "sample_size": p.get("sample_size"),
            }
            for p in (d.get("substitutes") or [])
        ],
        "receipt_id": r.receipt_id,
    }


def _historical_fmv(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = HistoricalInput(**args)
    params: dict[str, Any] = {"days": inp.days}
    if inp.unit:
        params["unit"] = inp.unit
    r = client.request(f"/api/v1/services/{inp.slug}/historical", params=params)
    d = r.data or {}
    return {
        "slug": d.get("slug", inp.slug),
        "unit": d.get("unit", inp.unit),
        "window_days": d.get("window_days", inp.days),
        "series": [
            {
                "day": p.get("day"),
                "fmv_usd": _micros_to_usd(p.get("fmv_micros")),
                "sample_size": p.get("sample_size"),
            }
            for p in (d.get("series") or [])
        ],
        "receipt_id": r.receipt_id,
    }


def _smart_route(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = SmartRouteInput(**args)
    r = client.request(
        f"/api/v1/categories/{inp.category}/smart-route",
        params={"unit": inp.unit, "limit": inp.limit},
    )
    d = r.data or {}

    def _norm(p: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "slug": p.get("slug"),
            "name": p.get("name"),
            "fmv_usd": _micros_to_usd(p.get("fmv_micros")),
            "sample_size": p.get("sample_size"),
        }

    return {
        "category": d.get("category", inp.category),
        "unit": d.get("unit", inp.unit),
        "cheapest": _norm(d["cheapest"]) if d.get("cheapest") else None,
        "candidates": [_norm(p) for p in (d.get("candidates") or [])],
        "receipt_id": r.receipt_id,
    }


def _mcp_health_ping(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = HealthPingInput(**args)
    try:
        r = client.request(
            "/api/v1/mcp/health-ping",
            method="POST",
            json={"install_id": inp.install_id},
        )
        d = r.data or {}
        from datetime import datetime, timezone

        return {
            "ok": d.get("ok", True),
            "ts": d.get("ts") or datetime.now(timezone.utc).isoformat(),
        }
    except Exception:
        from datetime import datetime, timezone

        return {"ok": False, "ts": datetime.now(timezone.utc).isoformat()}


def _why(args: Mapping[str, Any], client: AriClient) -> dict[str, Any]:
    inp = ReceiptIdInput(**args)
    r = client.request(f"/api/v1/why/{inp.receipt_id}")
    return {"receipt_id": inp.receipt_id, **(r.data or {})}


TOOLS.extend(
    [
        ToolDef(
            name="is_fair_price_batch",
            title="Batch fair-price verdict",
            description=(
                "Grade up to 50 quotes in one round-trip. Falls back to a category-inferred FMV "
                "(flagged category_inferred:true) when a service has no observations yet."
            ),
            input_model=BatchFairPriceInput,
            run=_is_fair_price_batch,
        ),
        ToolDef(
            name="prepay_verdict_batch",
            title="Batch pre-payment fairness check",
            description=(
                "Apply the Universal Fairness Skill to up to 50 candidate URLs at once. "
                "Returns one of `fair`, `stretched`, `overpriced`, `unknown` per row."
            ),
            input_model=BatchPrepayInput,
            run=_prepay_verdict_batch,
        ),
        ToolDef(
            name="detect_anomaly",
            title="Detect a price anomaly for a service",
            description=(
                "Flag the latest observation as anomalous when its robust z-score "
                "exceeds 3 over a rolling 14-day window."
            ),
            input_model=AnomalyInput,
            run=_detect_anomaly,
        ),
        ToolDef(
            name="category_benchmark",
            title="Category-level fair-price benchmark",
            description=(
                "Return the unweighted median + p10/p90 band across the indexed services in one category."
            ),
            input_model=CategoryBenchmarkInput,
            run=_category_benchmark,
        ),
        ToolDef(
            name="find_substitutes",
            title="Find cheaper substitutes for a service",
            description=(
                "List the cheapest indexed peers in the same category, ranked by FMV ascending."
            ),
            input_model=SubstitutesInput,
            run=_find_substitutes,
        ),
        ToolDef(
            name="historical_fmv",
            title="Per-day FMV history for a service",
            description=(
                "Return the per-UTC-day median + sample count for one service over the last N days "
                "(default 30, max 180)."
            ),
            input_model=HistoricalInput,
            run=_historical_fmv,
        ),
        ToolDef(
            name="smart_route",
            title="Route to the cheapest peer in a category",
            description=(
                "One-call helper that returns the cheapest indexed service in a category plus a short "
                "list of alternates."
            ),
            input_model=SmartRouteInput,
            run=_smart_route,
        ),
        ToolDef(
            name="mcp_health_ping",
            title="Heartbeat from a running MCP session",
            description=(
                "Best-effort heartbeat that bumps last_seen_at on the install row. Never blocks the "
                "agent and never collects identifying data."
            ),
            input_model=HealthPingInput,
            run=_mcp_health_ping,
        ),
        ToolDef(
            name="why",
            title="Explain a previously-issued receipt",
            description=(
                "Re-fetch a receipt by id and render the human-readable evidence trail the FMV engine "
                "relied on."
            ),
            input_model=ReceiptIdInput,
            run=_why,
        ),
    ]
)
