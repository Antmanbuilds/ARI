# SPDX-License-Identifier: Apache-2.0
"""HTTP client with automatic Ed25519 receipt verification.

Mirrors the TypeScript client: build-time pinned publisher key when
running against the default API base URL (no TOFU window), with an
explicit ``--api-base-url`` opting back into a single ``/.well-known``
fetch from the override host.
"""

from __future__ import annotations

import dataclasses
import os
from typing import Any, Mapping

import httpx

from .embedded_key import (
    ACCEPTED_KEY_IDS,
    EMBEDDED_PUBLIC_KEY_PEM,
    PINNED_BASE_URL,
)
from .verify import verify_receipt

DEFAULT_API_BASE_URL = os.environ.get("ARI_API_BASE_URL", PINNED_BASE_URL)


class AriHttpError(RuntimeError):
    def __init__(self, message: str, status: int, url: str, body: str):
        super().__init__(message)
        self.status = status
        self.url = url
        self.body = body


class AriReceiptError(RuntimeError):
    def __init__(self, message: str, errors: list[str], url: str):
        super().__init__(message)
        self.errors = errors
        self.url = url


@dataclasses.dataclass
class AriResponse:
    data: Any
    receipt_id: str | None = None
    signed_at: str | None = None
    key_id: str | None = None
    canonical_hash: str | None = None


class AriClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        public_key_pem: str | bytes | None = None,
        insecure_skip_verify: bool = False,
        insecure_skip_pin: bool = False,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = (base_url or DEFAULT_API_BASE_URL).rstrip("/")
        self.api_key = api_key
        self.insecure_skip_verify = insecure_skip_verify
        self.insecure_skip_pin = insecure_skip_pin
        self._http = httpx.Client(timeout=timeout, follow_redirects=True)

        if public_key_pem is not None:
            # Operator-supplied override always wins.
            self._public_key: str | bytes | None = public_key_pem
            self.using_embedded_key = False
        elif self.base_url == PINNED_BASE_URL.rstrip("/"):
            # Default base URL → use the embedded build-time pin. No TOFU.
            self._public_key = EMBEDDED_PUBLIC_KEY_PEM
            self.using_embedded_key = True
        else:
            # User explicitly overrode the base URL → fall back to a
            # single /.well-known fetch from THAT host.
            self._public_key = None
            self.using_embedded_key = False

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "AriClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _well_known_pubkey_url(self) -> str:
        # /.well-known is at root, NOT under /api.
        root = self.base_url
        for suffix in ("/api/v1", "/api"):
            if root.endswith(suffix):
                root = root[: -len(suffix)]
                break
        return root.rstrip("/") + "/.well-known/ari-pubkey.pem"

    def _get_public_key(self) -> str | bytes:
        if self._public_key is not None:
            return self._public_key
        url = self._well_known_pubkey_url()
        r = self._http.get(url)
        if r.status_code != 200:
            raise AriHttpError(
                f"Failed to fetch public key: HTTP {r.status_code}",
                r.status_code,
                url,
                r.text,
            )
        self._public_key = r.text
        return self._public_key

    def request(
        self,
        path: str,
        method: str = "GET",
        json: Any = None,
        params: Mapping[str, Any] | None = None,
    ) -> AriResponse:
        url = self.base_url + (path if path.startswith("/") else "/" + path)
        headers = {
            "Accept": "application/json",
            "User-Agent": "ari-mcp/0.1.2 (python)",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        r = self._http.request(method, url, headers=headers, json=json, params=params)
        body = r.text
        if r.status_code >= 400:
            raise AriHttpError(
                f"ARI {r.status_code} for {path}", r.status_code, url, body
            )

        signature = r.headers.get("ari-signature")
        key_id = r.headers.get("ari-key-id")
        receipt_id = r.headers.get("ari-receipt-id")
        signed_at = r.headers.get("ari-signed-at")
        canonical_hash = r.headers.get("ari-canonical-hash")

        if not self.insecure_skip_verify:
            if not signature:
                raise AriReceiptError(
                    "Response missing Ari-Signature header · refusing to trust unsigned ARI data.",
                    ["missing Ari-Signature"],
                    url,
                )
            # **Build-time pin check.** When using the embedded PEM
            # (default base URL), the server's ``Ari-Key-Id`` MUST be in
            # the accepted-id list shipped with this package version.
            if self.using_embedded_key and not self.insecure_skip_pin:
                if not key_id:
                    raise AriReceiptError(
                        "Response missing Ari-Key-Id header · required for pinned verification.",
                        ["missing Ari-Key-Id"],
                        url,
                    )
                if key_id not in ACCEPTED_KEY_IDS:
                    raise AriReceiptError(
                        f"Refusing receipt: key id {key_id} is not in this build's "
                        f"accepted-id list [{', '.join(ACCEPTED_KEY_IDS)}]. The publisher "
                        "may have rotated keys; upgrade ari-mcp to pick up the new pin, "
                        "or pass --insecure-skip-pin to override.",
                        ["pinned key id mismatch"],
                        url,
                    )

            pem = self._get_public_key()
            result = verify_receipt(body, dict(r.headers), pem)
            if not result.valid:
                raise AriReceiptError(
                    f"Receipt verification failed for {path}: {'; '.join(result.errors)}",
                    result.errors,
                    url,
                )

        try:
            data = r.json()
        except Exception as e:
            raise AriHttpError(
                f"ARI returned non-JSON body: {e}", r.status_code, url, body
            )

        return AriResponse(
            data=data,
            receipt_id=receipt_id,
            signed_at=signed_at,
            key_id=key_id,
            canonical_hash=canonical_hash,
        )
