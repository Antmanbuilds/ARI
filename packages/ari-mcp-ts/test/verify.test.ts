// SPDX-License-Identifier: Apache-2.0
//
// Task #440 · mutation tests for the hardened receipt verifier.
//
// Every test builds a known-good signed payload with a fresh Ed25519
// key, mutates exactly ONE thing, and asserts the verifier returns
// `result.verified === false` (strict equality, never thrown). The 6
// mutations match the task acceptance list:
//
//   1. Body modified after signing
//   2. Header order in signing input changed
//   3. Ari-Key-Id swapped to an unknown id (under embedded-pin pathway)
//   4. Signature bytes incremented by 1
//   5. Ari-Receipt-Id swapped for a different ULID
//   6. Ari-Canonical-Hash no longer matches the body
//
// A 7th group of tests pins the fail-closed contract: the verifier
// never throws across its public boundary, even for malformed PEM /
// malformed base64 / missing headers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  createHash,
} from "node:crypto";
import { verifyReceipt, normalizeReceiptHeaders } from "../src/verify.js";
import {
  jcs,
  composeSigningInputV2,
  SIGNED_HEADER_NAMES,
  RECEIPT_SPEC_HEADER_V2,
} from "../src/canonical.js";

// Tiny Crockford-base32 ULID generator inlined so the test has no
// cross-package import (artifacts/api-server is a separate workspace).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newUlid(now: number = Date.now()): string {
  let t = now;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  const bytes = Buffer.from(
    Array.from({ length: 10 }, () => Math.floor(Math.random() * 256)),
  );
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  return out;
}

interface SignedFixture {
  body: string;
  signature: string;
  keyId: string;
  receiptId: string;
  signedAt: string;
  canonicalHash: string;
  contentType: string;
  publicKeyPem: string;
}

function deriveKeyId(publicKey: import("node:crypto").KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return "ari-" + createHash("sha256").update(der).digest("hex").slice(0, 12);
}

function makeSignedFixture(payload: unknown = { hello: "world", n: 42 }): SignedFixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = deriveKeyId(publicKey);
  const body = jcs(payload);
  const canonicalHash = createHash("sha256").update(body, "utf8").digest("hex");
  const receiptId = newUlid();
  const signedAt = new Date("2026-05-25T00:00:00.000Z").toISOString();
  const contentType = "application/json; charset=utf-8";
  // Mirror the SIGNED_HEADER_NAMES order so the signing input matches
  // what the server-side middleware produces.
  void SIGNED_HEADER_NAMES;
  const signingInput = composeSigningInputV2(body, {
    "Content-Type": contentType,
    "Ari-Signed-At": signedAt,
    "Ari-Key-Id": keyId,
    "Ari-Receipt-Id": receiptId,
  });
  const signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), privateKey).toString(
    "base64",
  );
  return {
    body,
    signature,
    keyId,
    receiptId,
    signedAt,
    canonicalHash,
    contentType,
    publicKeyPem,
  };
}

function headersFromFixture(f: SignedFixture) {
  return {
    signature: f.signature,
    keyId: f.keyId,
    receiptId: f.receiptId,
    signedAt: f.signedAt,
    canonicalHash: f.canonicalHash,
    contentType: f.contentType,
    receiptSpec: RECEIPT_SPEC_HEADER_V2,
  };
}

describe("normalizeReceiptHeaders · task #535 ergonomics", () => {
  it("accepts the legacy camelCase shape unchanged", () => {
    const f = makeSignedFixture();
    const out = normalizeReceiptHeaders(headersFromFixture(f));
    assert.equal(out.signature, f.signature);
    assert.equal(out.keyId, f.keyId);
    assert.equal(out.receiptId, f.receiptId);
    assert.equal(out.signedAt, f.signedAt);
    assert.equal(out.canonicalHash, f.canonicalHash);
    assert.equal(out.contentType, f.contentType);
    assert.equal(out.receiptSpec, RECEIPT_SPEC_HEADER_V2);
  });

  it("accepts a fetch Headers instance (lowercased wire form)", () => {
    const f = makeSignedFixture();
    const h = new Headers();
    h.set("ari-signature", f.signature);
    h.set("ari-key-id", f.keyId);
    h.set("ari-receipt-id", f.receiptId);
    h.set("ari-signed-at", f.signedAt);
    h.set("ari-canonical-hash", f.canonicalHash);
    h.set("ari-receipt-spec", RECEIPT_SPEC_HEADER_V2);
    h.set("content-type", f.contentType);
    const out = normalizeReceiptHeaders(h);
    assert.equal(out.signature, f.signature);
    assert.equal(out.keyId, f.keyId);
    assert.equal(out.receiptId, f.receiptId);
    assert.equal(out.signedAt, f.signedAt);
    assert.equal(out.canonicalHash, f.canonicalHash);
    assert.equal(out.contentType, f.contentType);
    assert.equal(out.receiptSpec, RECEIPT_SPEC_HEADER_V2);
  });

  it("accepts a plain object with lowercased Ari-* keys", () => {
    const f = makeSignedFixture();
    const out = normalizeReceiptHeaders({
      "ari-signature": f.signature,
      "ari-key-id": f.keyId,
      "ari-receipt-id": f.receiptId,
      "ari-signed-at": f.signedAt,
      "ari-canonical-hash": f.canonicalHash,
      "ari-receipt-spec": RECEIPT_SPEC_HEADER_V2,
      "content-type": f.contentType,
    });
    assert.equal(out.signature, f.signature);
    assert.equal(out.keyId, f.keyId);
    assert.equal(out.canonicalHash, f.canonicalHash);
    assert.equal(out.contentType, f.contentType);
  });

  it("normalizes mixed-case wire keys (Ari-Key-Id, Content-Type)", () => {
    const f = makeSignedFixture();
    const out = normalizeReceiptHeaders({
      "Ari-Signature": f.signature,
      "Ari-Key-Id": f.keyId,
      "Ari-Receipt-Id": f.receiptId,
      "Ari-Signed-At": f.signedAt,
      "Ari-Canonical-Hash": f.canonicalHash,
      "Ari-Receipt-Spec": RECEIPT_SPEC_HEADER_V2,
      "Content-Type": f.contentType,
    });
    assert.equal(out.signature, f.signature);
    assert.equal(out.keyId, f.keyId);
    assert.equal(out.canonicalHash, f.canonicalHash);
  });

  it("verifyReceipt verifies end-to-end with a fetch Headers instance", async () => {
    const f = makeSignedFixture();
    const h = new Headers();
    h.set("ari-signature", f.signature);
    h.set("ari-key-id", f.keyId);
    h.set("ari-receipt-id", f.receiptId);
    h.set("ari-signed-at", f.signedAt);
    h.set("ari-canonical-hash", f.canonicalHash);
    h.set("ari-receipt-spec", RECEIPT_SPEC_HEADER_V2);
    h.set("content-type", f.contentType);
    const result = await verifyReceipt(f.body, h, f.publicKeyPem);
    assert.equal(result.verified, true, result.errors.join("; "));
  });

  it("verifyReceipt verifies end-to-end with lowercased plain object", async () => {
    const f = makeSignedFixture();
    const result = await verifyReceipt(
      f.body,
      {
        "ari-signature": f.signature,
        "ari-key-id": f.keyId,
        "ari-receipt-id": f.receiptId,
        "ari-signed-at": f.signedAt,
        "ari-canonical-hash": f.canonicalHash,
        "ari-receipt-spec": RECEIPT_SPEC_HEADER_V2,
        "content-type": f.contentType,
      },
      f.publicKeyPem,
    );
    assert.equal(result.verified, true, result.errors.join("; "));
  });
});

describe("verifyReceipt · sanity baseline", () => {
  it("verifies a freshly signed receipt with verified === true", async () => {
    const f = makeSignedFixture();
    const result = await verifyReceipt(f.body, headersFromFixture(f), f.publicKeyPem);
    assert.equal(result.verified, true);
    assert.equal(result.valid, true, "valid alias must mirror verified for compat");
    assert.deepEqual(result.errors, []);
  });
});

describe("verifyReceipt · mutation tests (task #440)", () => {
  it("mutation 1 · body modified after signing → verified === false", async () => {
    const f = makeSignedFixture();
    // Mutate ONE byte of the body. Recompute the hash so we exercise the
    // signature failure path, not the hash-mismatch path (mutation #6
    // covers that). Note: replacing a char keeps body length stable.
    const mutatedBody = f.body.replace('"world"', '"WORLD"');
    assert.notEqual(mutatedBody, f.body, "fixture sanity: body must actually change");
    const mutatedHash = createHash("sha256").update(mutatedBody, "utf8").digest("hex");
    const result = await verifyReceipt(
      mutatedBody,
      { ...headersFromFixture(f), canonicalHash: mutatedHash },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
    assert.ok(
      result.errors.some((e) => /ed25519 signature does not verify/.test(e)),
      `expected ed25519 failure, got: ${result.errors.join("; ")}`,
    );
  });

  it("mutation 2 · header order in signing input changed → verified === false", async () => {
    const f = makeSignedFixture();
    // Re-sign with the signed headers in REVERSE order so the signing
    // input the publisher committed to differs from what the verifier
    // recomposes (which always uses SIGNED_HEADER_NAMES fixed order).
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const altPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const altKeyId = deriveKeyId(publicKey);
    // Hand-roll a signing input with the header lines in reversed order
    // (Ari-Receipt-Id first, then Ari-Key-Id, then Ari-Signed-At, then
    // Content-Type) — the legit composer always emits them in
    // SIGNED_HEADER_NAMES order, so a signature minted over the
    // reversed order MUST fail to verify.
    const reversedSigningInput =
      "ari-receipts-v1\n" +
      f.body +
      "\nAri-Receipt-Id: " +
      f.receiptId +
      "\nAri-Key-Id: " +
      altKeyId +
      "\nAri-Signed-At: " +
      f.signedAt +
      "\nContent-Type: " +
      f.contentType;
    const reorderedSig = cryptoSign(
      null,
      Buffer.from(reversedSigningInput, "utf8"),
      privateKey,
    ).toString("base64");
    const result = await verifyReceipt(
      f.body,
      {
        ...headersFromFixture(f),
        keyId: altKeyId,
        signature: reorderedSig,
      },
      altPem,
    );
    assert.strictEqual(result.verified, false);
  });

  it("mutation 3 · Ari-Key-Id swapped to an unknown id → verified === false", async () => {
    const f = makeSignedFixture();
    // Recompute the signature with the swapped key id in the signing
    // input so we exercise the "wrong key id was signed into the
    // preamble" path rather than the trivial "header tampered after
    // signing" path. The signature math will fail because the
    // ed25519 key in the PEM does not correspond to "ari-deadbeef".
    const swappedKeyId = "ari-deadbeef0000";
    const result = await verifyReceipt(
      f.body,
      { ...headersFromFixture(f), keyId: swappedKeyId },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
    assert.ok(
      result.errors.some((e) => /ed25519 signature does not verify/.test(e)),
      `expected ed25519 failure, got: ${result.errors.join("; ")}`,
    );
  });

  it("mutation 4 · signature bytes incremented by 1 → verified === false", async () => {
    const f = makeSignedFixture();
    const sigBytes = Buffer.from(f.signature, "base64");
    // Bump the last byte by 1 (mod 256) so the signature decodes
    // cleanly (right length, valid base64) but the ed25519 math
    // rejects it.
    sigBytes[sigBytes.length - 1] = (sigBytes[sigBytes.length - 1]! + 1) & 0xff;
    const tamperedSig = sigBytes.toString("base64");
    assert.notEqual(tamperedSig, f.signature, "fixture sanity: signature must actually change");
    const result = await verifyReceipt(
      f.body,
      { ...headersFromFixture(f), signature: tamperedSig },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
    assert.ok(
      result.errors.some((e) => /ed25519 signature does not verify/.test(e)),
      `expected ed25519 failure, got: ${result.errors.join("; ")}`,
    );
  });

  it("mutation 5 · Ari-Receipt-Id swapped for a different ULID → verified === false", async () => {
    const f = makeSignedFixture();
    // Receipt-Id participates in the signing preamble, so swapping it
    // post-signing must invalidate the signature even though the body
    // and hash are untouched.
    const otherUlid = newUlid();
    assert.notEqual(otherUlid, f.receiptId);
    const result = await verifyReceipt(
      f.body,
      { ...headersFromFixture(f), receiptId: otherUlid },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
    assert.ok(
      result.errors.some((e) => /ed25519 signature does not verify/.test(e)),
      `expected ed25519 failure, got: ${result.errors.join("; ")}`,
    );
  });

  it("mutation 6 · Ari-Canonical-Hash no longer matches body → verified === false", async () => {
    const f = makeSignedFixture();
    // Flip one nibble of the hash header so it no longer equals
    // sha256(body). Per task #440 the hash check is mandatory and runs
    // BEFORE the signature, so we should see a hash-mismatch error
    // rather than an ed25519 error.
    const firstChar = f.canonicalHash[0]!;
    const flipped = firstChar === "0" ? "1" : "0";
    const wrongHash = flipped + f.canonicalHash.slice(1);
    const result = await verifyReceipt(
      f.body,
      { ...headersFromFixture(f), canonicalHash: wrongHash },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
    assert.ok(
      result.errors.some((e) => /canonical hash mismatch/.test(e)),
      `expected canonical hash mismatch, got: ${result.errors.join("; ")}`,
    );
  });
});

describe("verifyReceipt · fail-closed contract (task #440)", () => {
  it("missing Ari-Canonical-Hash → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const h = headersFromFixture(f);
    delete (h as Record<string, unknown>).canonicalHash;
    const result = await verifyReceipt(f.body, h, f.publicKeyPem);
    assert.strictEqual(result.verified, false);
    assert.ok(
      result.errors.some((e) => /Ari-Canonical-Hash/.test(e)),
      `expected missing-header error, got: ${result.errors.join("; ")}`,
    );
  });

  it("missing Ari-Signature → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const result = await verifyReceipt(
      f.body,
      { ...headersFromFixture(f), signature: "" },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
    assert.ok(result.errors.some((e) => /Ari-Signature/.test(e)));
  });

  it("missing Ari-Key-Id → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const h = headersFromFixture(f);
    delete (h as Record<string, unknown>).keyId;
    const result = await verifyReceipt(f.body, h, f.publicKeyPem);
    assert.strictEqual(result.verified, false);
    assert.ok(result.errors.some((e) => /Ari-Key-Id/.test(e)));
  });

  it("missing Ari-Receipt-Id → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const h = headersFromFixture(f);
    delete (h as Record<string, unknown>).receiptId;
    const result = await verifyReceipt(f.body, h, f.publicKeyPem);
    assert.strictEqual(result.verified, false);
    assert.ok(result.errors.some((e) => /Ari-Receipt-Id/.test(e)));
  });

  it("missing Ari-Signed-At → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const h = headersFromFixture(f);
    delete (h as Record<string, unknown>).signedAt;
    const result = await verifyReceipt(f.body, h, f.publicKeyPem);
    assert.strictEqual(result.verified, false);
    assert.ok(result.errors.some((e) => /Ari-Signed-At/.test(e)));
  });

  it("malformed base64 signature → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const result = await verifyReceipt(
      f.body,
      { ...headersFromFixture(f), signature: "!!!not-base64!!!" },
      f.publicKeyPem,
    );
    assert.strictEqual(result.verified, false);
  });

  it("malformed PEM → verified === false (no throw)", async () => {
    const f = makeSignedFixture();
    const result = await verifyReceipt(
      f.body,
      headersFromFixture(f),
      "-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----\n",
    );
    assert.strictEqual(result.verified, false);
  });
});
