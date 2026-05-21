// SPDX-License-Identifier: Apache-2.0
//
// Client-side receipt verification · every API response from ARI carries an
// Ed25519 signature in `Ari-Signature` over a deterministic signing input
// (canonical body + signed-header preamble). The MCP server verifies that
// signature on every tool call so that an attacker MITMing the API can't
// forge a fair-price verdict; tools error out with a clear message if a
// receipt fails to verify.

import {
  composeSigningInput,
  composeSigningInputV2,
  RECEIPT_SPEC_HEADER_V2,
} from "./canonical.js";

export interface ReceiptHeaders {
  signature: string;
  keyId?: string | undefined;
  signedAt?: string | undefined;
  receiptId?: string | undefined;
  canonicalHash?: string | undefined;
  license?: string | undefined;
  contentType?: string | undefined;
  /** Value of the `Ari-Receipt-Spec` response header. v2 enables the
   *  domain-separation prefix; v1 (or absent) uses the legacy envelope. */
  receiptSpec?: string | undefined;
}

export interface VerifyResult {
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

export async function verifyReceipt(
  body: string,
  headers: ReceiptHeaders,
  publicKeyPem: string,
): Promise<VerifyResult> {
  const errors: string[] = [];
  const bodyBytes = new TextEncoder().encode(body);
  const canonicalHash = await sha256Hex(bodyBytes);

  if (
    headers.canonicalHash != null &&
    headers.canonicalHash.toLowerCase() !== canonicalHash
  ) {
    errors.push(
      `canonical hash mismatch: header says ${headers.canonicalHash}, body hashes to ${canonicalHash}`,
    );
  }

  // The MCP server pins the publisher key fingerprint at install time; if
  // the response is signed with a *different* key id, refuse to verify
  // even if the math works out. This is what makes a quietly-rotated key
  // visible.
  // (key-id pinning happens in client.ts; here we just verify the math.)

  const preambleHeaders = {
    License: headers.license,
    "Content-Type": headers.contentType,
    "Ari-Signed-At": headers.signedAt,
    "Ari-Key-Id": headers.keyId,
    "Ari-Receipt-Id": headers.receiptId,
  };
  const spec = (headers.receiptSpec ?? RECEIPT_SPEC_HEADER_V2).toLowerCase();
  const isV2 = spec === RECEIPT_SPEC_HEADER_V2.toLowerCase();
  const signingInput = isV2
    ? composeSigningInputV2(body, preambleHeaders)
    : composeSigningInput(body, preambleHeaders);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64Decode(headers.signature);
  } catch (e: unknown) {
    return {
      valid: false,
      errors: [
        ...errors,
        "signature is not valid base64: " +
          (e instanceof Error ? e.message : String(e)),
      ],
      canonicalHash,
      keyId: headers.keyId,
      receiptId: headers.receiptId,
      signedAt: headers.signedAt,
    };
  }

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
  }

  return {
    valid: errors.length === 0,
    errors,
    canonicalHash,
    keyId: headers.keyId,
    receiptId: headers.receiptId,
    signedAt: headers.signedAt,
  };
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
