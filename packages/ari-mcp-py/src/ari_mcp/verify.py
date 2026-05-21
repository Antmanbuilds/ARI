# SPDX-License-Identifier: Apache-2.0
"""Receipt verification · Python mirror of the Node package's ``verify.ts``."""

from __future__ import annotations

import base64
import dataclasses
import hashlib
from typing import Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

from .canonical import (
    RECEIPT_SPEC_HEADER_V2,
    compose_signing_input,
    compose_signing_input_v2,
)


@dataclasses.dataclass
class VerifyResult:
    valid: bool
    errors: list[str]
    canonical_hash: str
    key_id: str | None = None
    receipt_id: str | None = None
    signed_at: str | None = None


def verify_receipt(
    body: str | bytes,
    headers: Mapping[str, str | None],
    public_key_pem: str | bytes,
) -> VerifyResult:
    """Verify a wire body against its signed-header preamble."""
    errors: list[str] = []
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    body_str = body_bytes.decode("utf-8")
    digest = hashlib.sha256(body_bytes).hexdigest()

    canonical_hash = headers.get("ari-canonical-hash") or headers.get("Ari-Canonical-Hash")
    if canonical_hash and canonical_hash.lower() != digest:
        errors.append(
            f"canonical hash mismatch: header says {canonical_hash}, body hashes to {digest}"
        )

    signature_b64 = headers.get("ari-signature") or headers.get("Ari-Signature") or ""
    key_id = headers.get("ari-key-id") or headers.get("Ari-Key-Id")
    signed_at = headers.get("ari-signed-at") or headers.get("Ari-Signed-At")
    receipt_id = headers.get("ari-receipt-id") or headers.get("Ari-Receipt-Id")
    license_ = headers.get("license") or headers.get("License")
    content_type = headers.get("content-type") or headers.get("Content-Type")

    preamble_headers = {
        "License": license_,
        "Content-Type": content_type,
        "Ari-Signed-At": signed_at,
        "Ari-Key-Id": key_id,
        "Ari-Receipt-Id": receipt_id,
    }
    receipt_spec = headers.get("ari-receipt-spec") or headers.get("Ari-Receipt-Spec")
    spec = (receipt_spec or RECEIPT_SPEC_HEADER_V2).lower()
    is_v2 = spec == RECEIPT_SPEC_HEADER_V2.lower()
    if is_v2:
        signing_input = compose_signing_input_v2(body_str, preamble_headers).encode("utf-8")
    else:
        signing_input = compose_signing_input(body_str, preamble_headers).encode("utf-8")

    try:
        sig_bytes = base64.b64decode(signature_b64, validate=True)
    except (ValueError, TypeError) as e:
        return VerifyResult(
            valid=False,
            errors=[*errors, f"signature is not valid base64: {e}"],
            canonical_hash=digest,
            key_id=key_id,
            receipt_id=receipt_id,
            signed_at=signed_at,
        )

    pem_bytes = (
        public_key_pem if isinstance(public_key_pem, bytes) else public_key_pem.encode("utf-8")
    )
    try:
        pub = load_pem_public_key(pem_bytes)
    except Exception as e:  # noqa: BLE001 · surface any PEM error
        errors.append(f"public key is not loadable: {e}")
        return VerifyResult(
            valid=False, errors=errors, canonical_hash=digest,
            key_id=key_id, receipt_id=receipt_id, signed_at=signed_at,
        )
    if not isinstance(pub, Ed25519PublicKey):
        errors.append("public key is not Ed25519")
    else:
        try:
            pub.verify(sig_bytes, signing_input)
        except InvalidSignature:
            errors.append("ed25519 signature does not verify")

    return VerifyResult(
        valid=len(errors) == 0,
        errors=errors,
        canonical_hash=digest,
        key_id=key_id,
        receipt_id=receipt_id,
        signed_at=signed_at,
    )
