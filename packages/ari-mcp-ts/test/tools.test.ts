// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools/index.js";
import { AriClient } from "../src/client.js";

describe("tool surface", () => {
  it("exposes the 11 documented tools", () => {
    const names = TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_fmv",
      "get_leaderboard",
      "get_service",
      "get_signed_receipt",
      "is_fair_price",
      "list_services",
      "prepay_verdict",
      "recent_observations",
      "refuse_if_overpriced",
      "subscribe_alert",
      "verify_receipt",
    ]);
  });

  it("each tool has a non-empty title and description", () => {
    for (const t of TOOLS) {
      assert.ok(t.title.length > 0, `${t.name} missing title`);
      assert.ok(t.description.length > 20, `${t.name} description too terse`);
    }
  });
});

describe("AriClient (mocked fetch)", () => {
  it("verifies signature using the cached PEM and returns parsed JSON", async () => {
    // Generate a real Ed25519 keypair, sign a body, and exercise the
    // verifying path end-to-end. Confirms client wiring against verify.ts
    // matches the server's signing flow.
    const { generateKeyPairSync, createSign, createPublicKey } = await import(
      "node:crypto"
    );
    const kp = generateKeyPairSync("ed25519");
    const pem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const body = '{"hello":"world"}';
    const signedAt = "2026-04-25T12:00:00.000Z";
    const keyId = "ari-test1234";
    const receiptId = "01HZTEST";
    const license = "BUSL-1.1; change-date=2030-04-25";
    const contentType = "application/json; charset=utf-8";
    // v2 envelope: prepend the "ari-receipts-v1\n" ASCII
    // domain-separation prefix and advertise the new spec via
    // Ari-Receipt-Spec. The client selects the recipe from that header.
    const signingInput =
      "ari-receipts-v1\n" +
      body +
      `\nLicense: ${license}` +
      `\nContent-Type: ${contentType}` +
      `\nAri-Signed-At: ${signedAt}` +
      `\nAri-Key-Id: ${keyId}` +
      `\nAri-Receipt-Id: ${receiptId}`;
    const sig = (await import("node:crypto"))
      .sign(null, Buffer.from(signingInput), kp.privateKey)
      .toString("base64");
    const { createHash } = await import("node:crypto");
    const canonicalHash = createHash("sha256").update(body).digest("hex");

    const fakeFetch: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: {
          "ari-signature": sig,
          "ari-key-id": keyId,
          "ari-signed-at": signedAt,
          "ari-receipt-id": receiptId,
          "ari-canonical-hash": canonicalHash,
          "ari-receipt-spec": "ari-receipts-v2",
          license,
          "content-type": contentType,
        },
      });

    const client = new AriClient({
      baseUrl: "http://example.test",
      publicKeyPem: pem,
      fetchImpl: fakeFetch,
    });
    const r = await client.request<any>("/api/v1/services/foo");
    assert.equal(r.data.hello, "world");
    assert.equal(r.receiptId, receiptId);
    assert.equal(r.canonicalHash, canonicalHash);
  });

  it("throws when signature does not verify", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const kp = generateKeyPairSync("ed25519");
    const pem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const fakeFetch: typeof fetch = async () =>
      new Response('{"a":1}', {
        status: 200,
        headers: {
          "ari-signature": Buffer.from(new Uint8Array(64)).toString("base64"),
          "ari-key-id": "ari-bad",
          "ari-signed-at": new Date().toISOString(),
          "content-type": "application/json",
        },
      });

    const client = new AriClient({
      baseUrl: "http://example.test",
      publicKeyPem: pem,
      fetchImpl: fakeFetch,
    });
    await assert.rejects(
      () => client.request<any>("/api/v1/services/foo"),
      /Receipt verification failed|signature does not verify/,
    );
  });
});
