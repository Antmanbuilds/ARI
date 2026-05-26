// SPDX-License-Identifier: Apache-2.0
//
// Shared helpers for the live integration suite. We deliberately re-use
// the *shipped* canonicalization + verifier from the package's own
// `dist/` build instead of reimplementing them in test code · that way
// the gate fails loudly the moment the published verifier disagrees
// with the live API (which is exactly the bug the gate exists to catch).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distVerify = join(here, "..", "dist", "verify.js");
const { verifyReceipt: shippedVerifyReceipt, fetchPublicKey: shippedFetchPublicKey } =
  await import(distVerify);

export const BASE_URL = (process.env.ARI_API_BASE_URL || "https://agentrateindicators.com").replace(
  /\/+$/,
  "",
);

// The five Ari-* headers the live API is contractually required to send
// on every signed v1 response. The verifier needs Ari-Key-Id /
// Ari-Receipt-Id / Ari-Signed-At / Ari-Signature to even compose the
// signing input; Ari-Canonical-Hash is required so a downstream proxy
// can't swap the body without invalidating the receipt.
export const REQUIRED_RECEIPT_HEADERS = [
  "ari-receipt-id",
  "ari-signed-at",
  "ari-canonical-hash",
  "ari-key-id",
  "ari-signature",
];

/** Fetch + memoize the pinned Ed25519 PEM. */
let _pemPromise = null;
export function fetchPinnedPublicKey() {
  if (!_pemPromise) _pemPromise = shippedFetchPublicKey(BASE_URL);
  return _pemPromise;
}

export function headersObject(res) {
  const out = {};
  for (const [k, v] of res.headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

function assertReceiptHeadersPresent(h) {
  const missing = REQUIRED_RECEIPT_HEADERS.filter((k) => !h[k]);
  if (missing.length > 0) {
    throw new Error(`missing required Ari-* headers: ${missing.join(", ")}`);
  }
}

/**
 * Perform an HTTP request, parse JSON when possible, and verify the
 * receipt using the package's shipped verifier. Strict by default:
 * if the response carries `Ari-Signature` then ALL five required Ari-*
 * headers MUST be present AND the Ed25519 signature MUST verify
 * against the pinned key. Any failure throws.
 *
 * Returns { status, headers, bodyText, body, receiptId }.
 */
export async function callApi(path, { method = "GET", body, headers, publicKeyPem } = {}) {
  const url = path.startsWith("http") ? path : BASE_URL + path;
  const init = { method, headers: { Accept: "application/json", ...(headers || {}) } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
  }
  const res = await fetch(url, init);
  const bodyText = await res.text();
  const h = headersObject(res);
  let parsed = null;
  if (bodyText.length > 0) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
  }
  if (h["ari-signature"]) {
    assertReceiptHeadersPresent(h);
    if (!publicKeyPem) throw new Error("publicKeyPem required to verify a signed response");
    const verdict = await shippedVerifyReceipt(
      bodyText,
      {
        signature: h["ari-signature"],
        keyId: h["ari-key-id"],
        signedAt: h["ari-signed-at"],
        receiptId: h["ari-receipt-id"],
        canonicalHash: h["ari-canonical-hash"],
        license: h["license"],
        contentType: h["content-type"],
        scheduleProof: h["ari-schedule-proof"],
        receiptSpec: h["ari-receipt-spec"],
        // Task #535 · v3 signed-preamble headers (fair-price route).
        confidence: h["ari-confidence"],
        fmvSource: h["ari-fmv-source"],
      },
      publicKeyPem,
    );
    if (!verdict.valid) {
      throw new Error(
        `receipt verification failed for ${path}: ${verdict.errors.join("; ") || "(no error message)"}`,
      );
    }
  }
  return {
    status: res.status,
    headers: h,
    bodyText,
    body: parsed,
    receiptId: h["ari-receipt-id"] || null,
  };
}
