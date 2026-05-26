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
    RECEIPT_SPEC_HEADER_V3,
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


# Task #437 · positive-assertion list. ``verify_receipt`` previously defined
# success as "no error was appended", which made it trivial for a missing
# check or an early return to silently report ``valid=True``. We now require
# *every* required check to be recorded in ``passed`` before flipping
# ``valid`` to True. Mirrors REQUIRED_CHECKS in tools/ari-mcp-ts/src/verify.ts.
_REQUIRED_CHECKS: tuple[str, ...] = (
    # Task #535 cross-language parity · the TS verifier
    # (tools/ari-mcp-ts/src/verify.ts) gates on the *presence* of
    # Ari-Canonical-Hash AND on the value matching the body hash.
    # The Python verifier previously only enforced the match and
    # silently passed when the header was absent · that opened a
    # fail-open hole where a publisher (or a stripping middlebox)
    # could omit the header and still earn ``valid=True``. Mirrors
    # REQUIRED_CHECKS in tools/ari-mcp-ts/src/verify.ts.
    "canonical_hash_present",
    "canonical_hash_match",
    "headers_present",
    "signature_decodable",
    "public_key_loadable",
    "ed25519_signature",
)


def verify_receipt(
    body: str | bytes,
    headers: Mapping[str, str | None],
    public_key_pem: str | bytes,
) -> VerifyResult:
    """Verify a wire body against its signed-header preamble.

    Returns ``valid=True`` iff every check in :data:`_REQUIRED_CHECKS`
    has been *positively* recorded (default-deny). A forgotten check or
    an early return both produce ``valid=False`` with an internal-error
    note rather than a silent pass.
    """
    errors: list[str] = []
    passed: set[str] = set()
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    body_str = body_bytes.decode("utf-8")
    digest = hashlib.sha256(body_bytes).hexdigest()

    canonical_hash = headers.get("ari-canonical-hash") or headers.get("Ari-Canonical-Hash")
    # Task #535 · fail-closed on missing Ari-Canonical-Hash to match
    # the TS verifier. Previously an absent header silently passed
    # `canonical_hash_match`; a publisher (or a stripping middlebox)
    # could omit the header and still earn ``valid=True``. Now the
    # presence check is its own required gate.
    if not canonical_hash:
        errors.append(
            "Ari-Canonical-Hash header missing · refusing to verify a "
            "receipt whose body-integrity assertion was stripped"
        )
    else:
        passed.add("canonical_hash_present")
        if canonical_hash.lower() != digest:
            errors.append(
                f"canonical hash mismatch: header says {canonical_hash}, body hashes to {digest}"
            )
        else:
            passed.add("canonical_hash_match")

    signature_b64 = headers.get("ari-signature") or headers.get("Ari-Signature") or ""
    key_id = headers.get("ari-key-id") or headers.get("Ari-Key-Id")
    signed_at = headers.get("ari-signed-at") or headers.get("Ari-Signed-At")
    receipt_id = headers.get("ari-receipt-id") or headers.get("Ari-Receipt-Id")
    license_ = headers.get("license") or headers.get("License")
    content_type = headers.get("content-type") or headers.get("Content-Type")
    schedule_proof = headers.get("ari-schedule-proof") or headers.get("Ari-Schedule-Proof")

    # Required-header check. Composing the signing input over headers the
    # server is required to send but the response omitted would silently
    # produce a signing input the publisher never actually signed. Refuse
    # to even attempt verification in that case.
    missing: list[str] = []
    if not key_id:
        missing.append("Ari-Key-Id")
    if not receipt_id:
        missing.append("Ari-Receipt-Id")
    if not signed_at:
        missing.append("Ari-Signed-At")
    if not signature_b64:
        missing.append("Ari-Signature")
    if missing:
        errors.append(
            "required receipt headers missing: "
            + ", ".join(missing)
            + " · refusing to verify a partial preamble"
        )
    else:
        passed.add("headers_present")

    schedule_proof = headers.get("ari-schedule-proof") or headers.get("Ari-Schedule-Proof")
    # Task #535 · v3 signed-preamble fields. The fair-price route emits
    # Ari-Confidence / Ari-Fmv-Source and includes them in the signed
    # preamble (per SIGNED_HEADER_NAMES in canonical.py). compose_signing_input
    # skips absent entries, so passing None on routes that don't emit
    # them is a no-op.
    confidence = headers.get("ari-confidence") or headers.get("Ari-Confidence")
    fmv_source = headers.get("ari-fmv-source") or headers.get("Ari-Fmv-Source")
    preamble_headers = {
        "License": license_,
        "Content-Type": content_type,
        "Ari-Signed-At": signed_at,
        "Ari-Key-Id": key_id,
        "Ari-Receipt-Id": receipt_id,
        # Task #437 · optional sixth header. compose_signing_input skips
        # absent headers, so passing None for a receipt that didn't carry
        # one is a no-op; passing the value through is required for
        # receipts that DO carry it to verify against the same bytes the
        # server signed.
        "Ari-Schedule-Proof": schedule_proof,
        "Ari-Confidence": confidence,
        "Ari-Fmv-Source": fmv_source,
    }
    receipt_spec = headers.get("ari-receipt-spec") or headers.get("Ari-Receipt-Spec")
    spec = (receipt_spec or RECEIPT_SPEC_HEADER_V2).lower()
    # Task #535 · v3 reuses the v2 composition (same `ari-receipts-v1`
    # prefix, same algorithm) but advertises that the receipt MAY
    # include Ari-Confidence/Ari-Fmv-Source in its signed preamble.
    # Treating v3 as v1 would fall back to the unprefixed signing input
    # and every signed v3 response would appear to have a bad signature.
    is_v2_or_v3 = spec in (
        RECEIPT_SPEC_HEADER_V2.lower(),
        RECEIPT_SPEC_HEADER_V3.lower(),
    )
    if is_v2_or_v3:
        signing_input = compose_signing_input_v2(body_str, preamble_headers).encode("utf-8")
    else:
        signing_input = compose_signing_input(body_str, preamble_headers).encode("utf-8")

    sig_bytes: bytes | None = None
    if signature_b64:
        try:
            sig_bytes = base64.b64decode(signature_b64, validate=True)
            passed.add("signature_decodable")
        except (ValueError, TypeError) as e:
            errors.append(f"signature is not valid base64: {e}")

    pem_bytes = (
        public_key_pem if isinstance(public_key_pem, bytes) else public_key_pem.encode("utf-8")
    )
    pub = None
    try:
        pub = load_pem_public_key(pem_bytes)
        if isinstance(pub, Ed25519PublicKey):
            passed.add("public_key_loadable")
        else:
            errors.append("public key is not Ed25519")
            pub = None
    except Exception as e:  # noqa: BLE001 · surface any PEM error
        errors.append(f"public key is not loadable: {e}")

    if pub is not None and sig_bytes is not None and not missing:
        try:
            pub.verify(sig_bytes, signing_input)
            passed.add("ed25519_signature")
        except InvalidSignature:
            errors.append("ed25519 signature does not verify")

    all_passed = all(c in passed for c in _REQUIRED_CHECKS)
    if not errors and not all_passed:
        missing_checks = [c for c in _REQUIRED_CHECKS if c not in passed]
        errors.append(
            "internal verifier error: required checks did not run ["
            + ", ".join(missing_checks)
            + "]"
        )

    return VerifyResult(
        valid=(not errors) and all_passed,
        errors=errors,
        canonical_hash=digest,
        key_id=key_id,
        receipt_id=receipt_id,
        signed_at=signed_at,
    )
