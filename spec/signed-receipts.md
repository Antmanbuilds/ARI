# ARI signed receipts · wire spec

This document describes the receipt envelope ARI emits on every `/api/*` JSON response. It is normative for clients that verify receipts offline.

## Headers

Every signed response carries five headers. All five are required.

| Header | Value |
| --- | --- |
| `Ari-Receipt-Id` | A ULID. Short, sortable, citable. |
| `Ari-Signed-At` | RFC 3339 UTC timestamp at the moment of signing. |
| `Ari-Canonical-Hash` | Lowercase hex `sha256` of the canonical payload bytes (see below). |
| `Ari-Key-Id` | The signing key id, of the form `ari-<sha256(SPKI DER)[0..12]>`. |
| `Ari-Signature` | `base64(ed25519(signing_input))`. Standard base64 with padding. |

Header names match case-insensitively per HTTP, but the canonical signing input uses the exact casing above.

## Canonical payload

ARI signs JSON wire payloads only. The server never emits non-JSON-native input types (`Date`, `Map`, `Set`, typed array, `RegExp`, class instances) on `/api/*` responses. Canonicalization follows [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) with one profile addition described next.

### Large-integer rule

Integers whose absolute value is strictly greater than `Number.MAX_SAFE_INTEGER` (`2^53 - 1 = 9007199254740991`) MUST be encoded as JSON strings (the decimal digits, wrapped in JSON quotes). Within the safe range they are encoded as JSON numbers.

- In TypeScript, the `bigint` type is always encoded as a JSON string regardless of magnitude. This trivially satisfies the rule.
- In Python, an `int` is checked at serialization time. In-range emits as a JSON number, out-of-range emits as a JSON string.

Both implementations produce byte-for-byte identical canonical bytes for the same logical integer value. See the cross-language test vectors shipped with each client package.

### What is signed

`canonical_bytes` = JCS-canonicalized UTF-8 bytes of the JSON body.

`Ari-Canonical-Hash` = lowercase hex of `sha256(canonical_bytes)`.

## Signing input

The Ed25519 signature is computed over the following bytes:

```
signing_input =
    "Ari-Receipt-Id: "    + receipt_id    + "\n" +
    "Ari-Signed-At: "     + signed_at     + "\n" +
    "Ari-Canonical-Hash: " + canonical_hash + "\n" +
    "Ari-Key-Id: "        + key_id
```

UTF-8 encoded. No trailing newline. The order of the four lines is fixed.

The signature is then `base64(Ed25519_sign(signing_input))` and goes in `Ari-Signature`.

## Verification

A verifier MUST:

1. Read the five `Ari-*` headers. If any is missing, fail.
2. Re-canonicalize the response body to `canonical_bytes` and compute `sha256` of it. Compare hex against `Ari-Canonical-Hash`. If different, fail.
3. Reconstruct `signing_input` exactly as above.
4. Look up the public key for `Ari-Key-Id` in its pinned set. If the key id is unknown, fail (do not fall back to fetching unknown keys at verify time).
5. Verify the Ed25519 signature against `signing_input`. If invalid, fail.
6. Optionally enforce a maximum age on `Ari-Signed-At` for replay protection.

The reference TypeScript and Python verifiers in this repository implement this flow identically.

## Key distribution

The currently active publisher key is served at:

- [`/.well-known/ari-pubkey.json`](https://agentrateindicators.com/.well-known/ari-pubkey.json) · `{ keyId, algorithm, publicKey, format }`
- [`/.well-known/ari-pubkey.pem`](https://agentrateindicators.com/.well-known/ari-pubkey.pem) · raw PEM, SPKI format

The MCP client packages embed the current key id and PEM at build time and maintain a small `ACCEPTED_KEY_IDS` list so that key rotation does not break existing installs. Operators can override by setting environment variables documented in each package README.

## Versioning

This spec is `Ari Receipt Canonicalization v1`. The live machine-readable version is at [`/api/v1/spec/canonicalization`](https://agentrateindicators.com/api/v1/spec/canonicalization). Any breaking change will increment the path version (`/v2/spec/...`) and be announced in [CHANGELOG.md](../CHANGELOG.md) at least one minor release before becoming required.
