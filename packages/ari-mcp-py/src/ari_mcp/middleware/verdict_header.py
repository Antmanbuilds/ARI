# SPDX-License-Identifier: Apache-2.0
"""ARI-Verdict-Id WSGI middleware (task #308 · phase 3 item 5).

x402 vendors can drop this middleware into their WSGI service to advertise
that a recently-priced quote was verdict-checked by ARI · downstream agents
see an ``ARI-Verdict-Id: <receipt_id>`` header on the response and can fetch
``/api/v1/verify-receipt?id=<receipt_id>`` to confirm the verdict was within
the fair-market band.

Header spec (one-pager, see
https://agentrateindicators.com/spec/ari-verdict-id-header)::

    ARI-Verdict-Id: <receipt_id>; ts=<unix_ms>; verdict=<green|amber|red>

The middleware only attaches the header when:

* the caller stored a verdict on the request via :func:`set_verdict`,
* the verdict's ``signed_at_ms`` is within ``cache_ttl_s`` of the current
  wall clock.

Usage::

    from ari_mcp.middleware import verdict_header, set_verdict

    application = verdict_header(application, cache_ttl_s=60)

    def handler(environ, start_response):
        verdict = ari.fair_price(service="example.x402", amount_micros=100_000)
        set_verdict(
            environ,
            VerdictMeta(
                receipt_id=verdict["receipt_id"],
                slug="example.x402",
                amount_micros=100_000,
                unit="request",
                verdict=verdict["verdict"]["label"],
                signed_at_ms=int(time.time() * 1000),
            ),
        )
        ...
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, MutableMapping

ARI_VERDICT_HEADER_SPEC_URL = (
    "https://agentrateindicators.com/spec/ari-verdict-id-header"
)

_ENVIRON_KEY = "ari.verdict"
_DEFAULT_HEADER_NAME = "ARI-Verdict-Id"


@dataclass
class VerdictMeta:
    """The minimum metadata required to emit an ``ARI-Verdict-Id`` header."""

    receipt_id: str
    slug: str
    amount_micros: int
    unit: str
    verdict: str  # "green" | "amber" | "red" | "insufficient_data"
    signed_at_ms: int


def set_verdict(environ: MutableMapping[str, Any], meta: VerdictMeta) -> None:
    """Stash a verdict on the WSGI environ so the middleware emits the header."""
    environ[_ENVIRON_KEY] = meta


def verdict_header(
    app: Callable[..., Iterable[bytes]],
    *,
    cache_ttl_s: int = 60,
    header_name: str = _DEFAULT_HEADER_NAME,
    now_ms: Callable[[], int] | None = None,
) -> Callable[..., Iterable[bytes]]:
    """Wrap a WSGI application so it advertises a fresh ARI verdict.

    The wrapper is best-effort · any exception raised while attaching the
    header is swallowed so the vendor's response is never broken.
    """

    ttl_ms = max(1, int(cache_ttl_s)) * 1000
    clock = now_ms or (lambda: int(time.time() * 1000))

    def wrapped(environ: MutableMapping[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        def patched_start_response(status: str, headers: list[tuple[str, str]], *exc_info: Any) -> Any:
            try:
                meta = environ.get(_ENVIRON_KEY)
                if isinstance(meta, VerdictMeta):
                    age = clock() - meta.signed_at_ms
                    if 0 <= age <= ttl_ms:
                        value = (
                            f"{meta.receipt_id}; ts={meta.signed_at_ms}; "
                            f"verdict={meta.verdict}"
                        )
                        headers = list(headers) + [(header_name, value)]
            except Exception:
                # Never break the vendor's response.
                pass
            return start_response(status, headers, *exc_info)

        return app(environ, patched_start_response)

    return wrapped
