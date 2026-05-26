// SPDX-License-Identifier: Apache-2.0
//
// Client-side receipt verification · every API response from ARI carries an
// Ed25519 signature in `Ari-Signature` over a deterministic signing input
// (canonical body + signed-header preamble). The MCP server verifies that
// signature on every tool call so that an attacker MITMing the API can't
// forge a fair-price verdict; tools error out with a clear message if a
// receipt fails to verify.
//
// Task #440 hardening: this module is now fully fail-closed and never
// throws across the verify boundary. Every failure mode (missing header,
// unknown key id, bad base64, hash mismatch, malformed PEM, ed25519
// rejection) returns `{ verified: false, errors: [...] }`. The structured
// result lets `AriClient` decide whether to surface the failure as an
// exception at the wrapper layer · the verifier itself never raises.

import {
  composeSigningInput,
  composeSigningInputV2,
  RECEIPT_SPEC_HEADER_V2,
  RECEIPT_SPEC_HEADER_V3,
} from "./canonical.js";

export interface ReceiptHeaders {
  signature: string;
  keyId?: string | undefined;
  signedAt?: string | undefined;
  receiptId?: string | undefined;
  canonicalHash?: string | undefined;
  license?: string | undefined;
  contentType?: string | undefined;
  /** `Ari-Schedule-Proof` is only emitted on the observations route but is
   *  part of `SIGNED_HEADER_NAMES`, so verifiers MUST plumb it through or
   *  every observations response will appear to have a bad signature. */
  scheduleProof?: string | undefined;
  /** Value of the `Ari-Receipt-Spec` response header. v2 enables the
   *  domain-separation prefix; v1 (or absent) uses the legacy envelope. */
  receiptSpec?: string | undefined;
  /** Task #535 · v3-only signed headers. The fair-price route emits
   *  these and includes them in the signed preamble (per
   *  `SIGNED_HEADER_NAMES` in canonical.ts). Verifiers MUST plumb them
   *  through or every v3 fair-price response will appear to have a
   *  bad signature. Optional on routes that don't emit them. */
  confidence?: string | undefined;
  fmvSource?: string | undefined;
}

/**
 * Task #535 · public surface ergonomics. Real-world callers reach
 * `verifyReceipt` with one of three shapes after calling `fetch()`:
 *
 *   1. A `Headers` instance (`res.headers`) · keys are lowercased and
 *      accessed via `.get("ari-key-id")`.
 *   2. A plain object whose keys are the HTTP wire form
 *      (`"ari-key-id"`, `"ari-signature"`, ...). This is what
 *      `Object.fromEntries(res.headers)` yields and what `node-fetch`
 *      / undici both return from their `.headers` iterator.
 *   3. The historical `ReceiptHeaders` shape with camelCase keys
 *      (`{ keyId, signature, ... }`). Existing call sites (AriClient,
 *      the test fixtures in this repo) still use this shape.
 *
 * Forcing every external caller to hand-map the wire form into the
 * camelCase shape is hostile · they'd predictably mistype one key and
 * silently lose the receipt's hash binding. The normalizer below
 * accepts any of the three and produces the canonical `ReceiptHeaders`
 * the rest of the verifier expects.
 */
export type ReceiptHeadersInput =
  | ReceiptHeaders
  | Headers
  | Record<string, string | string[] | undefined>;

interface CamelCaseDetected {
  signature?: unknown;
  keyId?: unknown;
  signedAt?: unknown;
  receiptId?: unknown;
  canonicalHash?: unknown;
  license?: unknown;
  contentType?: unknown;
  scheduleProof?: unknown;
  receiptSpec?: unknown;
  confidence?: unknown;
  fmvSource?: unknown;
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}

/**
 * Convert any of the accepted input shapes into the strict
 * `ReceiptHeaders` shape the verifier consumes. Exported so external
 * tooling (and the test suite) can exercise the normalization step in
 * isolation. The function is intentionally pure and dependency-free.
 */
export function normalizeReceiptHeaders(input: ReceiptHeadersInput): ReceiptHeaders {
  // Branch 1 · fetch Headers instance. Detected structurally (works
  // across `globalThis.Headers`, undici's Headers, and node-fetch's
  // Headers without instanceof coupling).
  if (
    input &&
    typeof (input as Headers).get === "function" &&
    typeof (input as Headers).forEach === "function"
  ) {
    const h = input as Headers;
    return {
      signature: h.get("ari-signature") ?? "",
      keyId: h.get("ari-key-id") ?? undefined,
      signedAt: h.get("ari-signed-at") ?? undefined,
      receiptId: h.get("ari-receipt-id") ?? undefined,
      canonicalHash: h.get("ari-canonical-hash") ?? undefined,
      license: h.get("license") ?? undefined,
      contentType: h.get("content-type") ?? undefined,
      scheduleProof: h.get("ari-schedule-proof") ?? undefined,
      receiptSpec: h.get("ari-receipt-spec") ?? undefined,
      confidence: h.get("ari-confidence") ?? undefined,
      fmvSource: h.get("ari-fmv-source") ?? undefined,
    };
  }

  const obj = input as Record<string, unknown> & CamelCaseDetected;

  // Branch 3 · the historical camelCase shape (what AriClient and
  // the existing test fixtures pass). Detected by the presence of
  // `signature` as a string AND at least one camelCase Ari-* field.
  // The `signature` key alone is ambiguous because lowercase-wire
  // shapes use `ari-signature` instead, so a bare `signature` field
  // is the camelCase tell.
  const looksCamel =
    typeof obj["signature"] === "string" &&
    ("keyId" in obj ||
      "receiptId" in obj ||
      "signedAt" in obj ||
      "canonicalHash" in obj ||
      "receiptSpec" in obj ||
      "scheduleProof" in obj);
  if (looksCamel) {
    // Already in the right shape · spread to drop any extra keys the
    // caller may have attached and to widen `undefined` slots.
    return {
      signature: obj["signature"] as string,
      keyId: firstString(obj["keyId"]),
      signedAt: firstString(obj["signedAt"]),
      receiptId: firstString(obj["receiptId"]),
      canonicalHash: firstString(obj["canonicalHash"]),
      license: firstString(obj["license"]),
      contentType: firstString(obj["contentType"]),
      scheduleProof: firstString(obj["scheduleProof"]),
      receiptSpec: firstString(obj["receiptSpec"]),
      confidence: firstString(obj["confidence"]),
      fmvSource: firstString(obj["fmvSource"]),
    };
  }

  // Branch 2 · lowercased plain object (the wire form). Lowercase
  // every key defensively · servers and proxies sometimes preserve
  // mixed case (`Ari-Key-Id`) even when forwarded into a "plain"
  // object via `Object.fromEntries`. Lowercasing once here means
  // callers don't have to remember the convention.
  const lower: Record<string, string | string[] | undefined> = {};
  for (const k of Object.keys(obj)) {
    lower[k.toLowerCase()] = obj[k] as string | string[] | undefined;
  }
  return {
    signature: firstString(lower["ari-signature"]) ?? "",
    keyId: firstString(lower["ari-key-id"]),
    signedAt: firstString(lower["ari-signed-at"]),
    receiptId: firstString(lower["ari-receipt-id"]),
    canonicalHash: firstString(lower["ari-canonical-hash"]),
    license: firstString(lower["license"]),
    contentType: firstString(lower["content-type"]),
    scheduleProof: firstString(lower["ari-schedule-proof"]),
    receiptSpec: firstString(lower["ari-receipt-spec"]),
    confidence: firstString(lower["ari-confidence"]),
    fmvSource: firstString(lower["ari-fmv-source"]),
  };
}

export interface VerifyResult {
  /**
   * Task #440 contract: callers MUST check `result.verified === true`
   * (strict equality). Any failure mode returns `verified: false`; the
   * verifier never throws.
   */
  verified: boolean;
  /**
   * Backwards-compatible alias for `verified` so existing call sites
   * (`if (!result.valid)` ...) keep working. New code should use
   * `verified` so the field name matches the audit contract.
   */
  valid: boolean;
  errors: string[];
  canonicalHash: string;
  keyId?: string | undefined;
  receiptId?: string | undefined;
  signedAt?: string | undefined;
}

function base64Decode(s: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(s, "base64"));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", ab);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export function pemToDer(pem: string): Uint8Array {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return base64Decode(cleaned);
}

/**
 * Extract the raw 32-byte Ed25519 public key from an SPKI DER blob.
 * SPKI for Ed25519 is fixed-shape and the trailing 32 bytes are always
 * the raw public key, so we can avoid pulling in a full ASN.1 parser.
 */
function spkiToRawEd25519Key(der: Uint8Array): Uint8Array {
  if (der.length < 32) throw new Error("Public key DER is too short");
  return der.slice(der.length - 32);
}

/**
 * Derive the publisher's short key id from a PEM-encoded SPKI public
 * key. Mirrors the server-side `deriveKeyId` in
 * `artifacts/api-server/src/lib/signing.ts` byte-for-byte:
 *
 *   keyId = "ari-" + sha256(SPKI_DER).hex.slice(0, 12)
 *
 * Used by the client to pin `Ari-Key-Id` against the trusted PEM even
 * for overridden hosts (task #440 step 4 · the previous code only
 * pinned against the embedded build-time list, so an overridden host
 * could swap its key id silently between calls).
 */
export async function deriveKeyIdFromPem(pem: string): Promise<string> {
  const der = pemToDer(pem);
  const hex = await sha256Hex(der);
  return "ari-" + hex.slice(0, 12);
}

async function ed25519Verify(
  signingInput: Uint8Array,
  signature: Uint8Array,
  publicKeyPem: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const ed = await import("@noble/ed25519");
    if (!ed.etc.sha512Sync) {
      try {
        const nodeCrypto = await import("node:crypto");
        ed.etc.sha512Sync = (...m: Uint8Array[]) => {
          const h = nodeCrypto.createHash("sha512");
          for (const c of m) h.update(c);
          return new Uint8Array(h.digest());
        };
      } catch {
        // verifyAsync will fall back to WebCrypto's subtle.digest path.
      }
    }
    const rawKey = spkiToRawEd25519Key(pemToDer(publicKeyPem));
    const ok = await ed.verifyAsync(signature, signingInput, rawKey);
    return { ok };
  } catch (e: unknown) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// Task #437 · positive-assertion list. `verifyReceipt` previously defined
// success as "no error was pushed" · a verifier that forgot to push an
// error would silently report `verified:true`. We require *every* check
// in this list to fire and pass before returning `verified:true`.
// Task #440 promotes `headers_present` to require all 5 Ari-* headers
// (incl. Ari-Canonical-Hash, which was optional in #437) and adds an
// explicit `canonical_hash_present` check so an absent header is a hard
// failure, not a silent pass.
const REQUIRED_CHECKS = [
  "headers_present",
  "canonical_hash_present",
  "canonical_hash_match",
  "signature_decodable",
  "ed25519_signature",
] as const;
type RequiredCheck = (typeof REQUIRED_CHECKS)[number];

function makeFailure(
  errors: string[],
  canonicalHash: string,
  headers: ReceiptHeaders,
): VerifyResult {
  return {
    verified: false,
    valid: false,
    errors,
    canonicalHash,
    keyId: headers.keyId,
    receiptId: headers.receiptId,
    signedAt: headers.signedAt,
  };
}

export async function verifyReceipt(
  body: string,
  headersInput: ReceiptHeadersInput,
  publicKeyPem: string,
): Promise<VerifyResult> {
  // Task #535 · normalize the input shape up front so the body of the
  // verifier continues to operate on the strict camelCase shape it
  // was originally written against. The normalizer never throws.
  const headers: ReceiptHeaders = normalizeReceiptHeaders(headersInput);
  // Task #440 step 1 · wrap the entire verification in a single
  // try/catch so any unexpected throw from the crypto layer, the PEM
  // parser, or a future helper surfaces as a structured failure rather
  // than crashing the caller. The original bug: `verifyReceipt` could
  // throw out of `ed25519Verify` if `publicKeyPem` was malformed (e.g.
  // truncated PEM) and the AriClient wrapper's `if (!result.verified)`
  // branch would never run. Fail-closed means we always return a
  // result; the wrapper layer decides whether to throw.
  try {
    const errors: string[] = [];
    const passed = new Set<RequiredCheck>();

    const bodyBytes = new TextEncoder().encode(body);
    const canonicalHash = await sha256Hex(bodyBytes);

    // Task #440 step 2 · require ALL 5 Ari-* headers up front, before
    // we touch the hash or the signature. Previously Ari-Canonical-Hash
    // was treated as optional and Ari-Signature-only failure modes were
    // handled by the client wrapper · meaning a response that omitted
    // Ari-Canonical-Hash entirely could still flip `verified` to true
    // as long as the signature happened to verify. The audit flagged
    // this as a hash-binding gap: without the hash header, a verifier
    // that only checks the signature can't prove the body wasn't
    // swapped for a different body that also signs under this key
    // (replay across receipts). Make presence of all 5 a hard gate.
    const missing: string[] = [];
    if (!headers.signature) missing.push("Ari-Signature");
    if (!headers.keyId) missing.push("Ari-Key-Id");
    if (!headers.receiptId) missing.push("Ari-Receipt-Id");
    if (!headers.signedAt) missing.push("Ari-Signed-At");
    if (!headers.canonicalHash) missing.push("Ari-Canonical-Hash");
    if (missing.length > 0) {
      return makeFailure(
        [
          `required Ari-* receipt headers missing: ${missing.join(", ")} ` +
            `· refusing to verify a partial preamble`,
        ],
        canonicalHash,
        headers,
      );
    }
    passed.add("headers_present");

    // Task #440 step 3 · mandatory canonical-hash compare. We have just
    // proved Ari-Canonical-Hash is present (above). Recompute SHA-256
    // of the body bytes and require an exact (case-insensitive) match
    // BEFORE touching the signature. The original bug: the hash check
    // was inside an `if (canonicalHash != null)` branch, so an absent
    // header silently passed; with header presence now mandatory we
    // can also assert the hash matches up front and short-circuit on
    // mismatch. A mismatch means body bytes were swapped post-signing
    // and no amount of signature math can fix that.
    const headerHash = headers.canonicalHash!.toLowerCase();
    passed.add("canonical_hash_present");
    if (headerHash !== canonicalHash) {
      return makeFailure(
        [
          `canonical hash mismatch: header says ${headers.canonicalHash}, ` +
            `body hashes to ${canonicalHash}`,
        ],
        canonicalHash,
        headers,
      );
    }
    passed.add("canonical_hash_match");

    // Compose the signing input. v2 prepends the ari-receipts-v1
    // domain-separation prefix; v1 (or absent receipt-spec) uses the
    // legacy unprefixed composition for receipts emitted before the v2
    // bump.
    const preambleHeaders = {
      License: headers.license,
      "Content-Type": headers.contentType,
      "Ari-Signed-At": headers.signedAt,
      "Ari-Key-Id": headers.keyId,
      "Ari-Receipt-Id": headers.receiptId,
      // Task #437 · optional sixth signed header. Only appended to the
      // signing input when the server emits it (composeSigningInput*
      // skips entries with `undefined` values). Keeping this in
      // lock-step with SIGNED_HEADER_NAMES is required so receipts
      // that DO carry a schedule proof verify against the same bytes
      // the server signed.
      "Ari-Schedule-Proof": headers.scheduleProof,
      // Task #535 · v3 signed-preamble fields. `composeSigningInput*`
      // skips undefined entries, so adding them here is byte-compatible
      // with v2 receipts that don't emit them.
      "Ari-Confidence": headers.confidence,
      "Ari-Fmv-Source": headers.fmvSource,
    };
    // Task #535 · v3 reuses the v2 composition (same `ari-receipts-v1`
    // prefix, same algorithm) but advertises that the receipt MAY
    // include `Ari-Confidence` / `Ari-Fmv-Source` in its signed
    // preamble (see canonical.ts comment for the contract). Treat
    // both v2 and v3 as the prefixed composition. Anything else (a
    // legacy v1 receipt, or a future-unknown spec) falls back to the
    // unprefixed v1 composition.
    const spec = (headers.receiptSpec ?? RECEIPT_SPEC_HEADER_V2).toLowerCase();
    const isV2OrV3 =
      spec === RECEIPT_SPEC_HEADER_V2.toLowerCase() ||
      spec === RECEIPT_SPEC_HEADER_V3.toLowerCase();
    const signingInput = isV2OrV3
      ? composeSigningInputV2(body, preambleHeaders)
      : composeSigningInput(body, preambleHeaders);

    // Check 4 · signature must be well-formed base64. The original bug:
    // a malformed signature was caught here AND in ed25519Verify, but
    // ed25519Verify's catch swallowed the reason into a generic
    // "signature does not verify" line. Decoding up front gives a
    // clearer error string and avoids handing junk bytes to the
    // crypto layer.
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = base64Decode(headers.signature);
    } catch (e: unknown) {
      return makeFailure(
        [
          "signature is not valid base64: " +
            (e instanceof Error ? e.message : String(e)),
        ],
        canonicalHash,
        headers,
      );
    }
    passed.add("signature_decodable");

    // Check 5 · ed25519 math. ed25519Verify converts every internal
    // exception (malformed PEM, unsupported curve, runtime crypto
    // unavailable) into `{ok:false, reason}` so we cannot throw out
    // of this branch.
    const verdict = await ed25519Verify(
      new TextEncoder().encode(signingInput),
      signatureBytes,
      publicKeyPem,
    );
    if (!verdict.ok) {
      errors.push(
        "ed25519 signature does not verify" +
          (verdict.reason ? ` (${verdict.reason})` : ""),
      );
    } else {
      passed.add("ed25519_signature");
    }

    // Positive assertion: verified iff every required check is in the
    // passed set AND no error was pushed. The double-gate is
    // intentional · either condition alone would let a forgotten
    // error or a forgotten `passed.add` silently flip the outcome.
    const allPassed = REQUIRED_CHECKS.every((c) => passed.has(c));
    if (errors.length === 0 && !allPassed) {
      const missingChecks = REQUIRED_CHECKS.filter((c) => !passed.has(c));
      errors.push(
        `internal verifier error: required checks did not run [${missingChecks.join(", ")}]`,
      );
    }
    const verified = errors.length === 0 && allPassed;
    return {
      verified,
      valid: verified,
      errors,
      canonicalHash,
      keyId: headers.keyId,
      receiptId: headers.receiptId,
      signedAt: headers.signedAt,
    };
  } catch (e: unknown) {
    // Last-resort backstop · per task #440 the verifier MUST NOT throw
    // across its public boundary. If something genuinely unexpected
    // raises (e.g. TextEncoder ENOMEM, SubtleCrypto unavailable,
    // future helper added without its own try/catch), convert it into
    // a structured failure so the AriClient wrapper's
    // `result.verified === false` branch fires and the caller sees a
    // clear AriReceiptError rather than a stack trace.
    return {
      verified: false,
      valid: false,
      errors: [
        "verifier internal error: " +
          (e instanceof Error ? e.message : String(e)),
      ],
      canonicalHash: "",
      keyId: headers.keyId,
      receiptId: headers.receiptId,
      signedAt: headers.signedAt,
    };
  }
}

export async function fetchPublicKey(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // /.well-known is mounted at the express app root, NOT under /api, per RFC 8615.
  const root = baseUrl.replace(/\/?api\/?v?\d*\/?$/, "").replace(/\/+$/, "");
  const url = root + "/.well-known/ari-pubkey.pem";
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ARI public key from ${url}: HTTP ${res.status}`);
  }
  return await res.text();
}
