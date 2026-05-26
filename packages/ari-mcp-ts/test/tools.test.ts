// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools/index.js";
import { AriClient } from "../src/client.js";

describe("tool surface", () => {
  it("exposes the 20 documented tools (v0.2.0)", () => {
    const names = TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "category_benchmark",
      "detect_anomaly",
      "find_substitutes",
      "get_fmv",
      "get_leaderboard",
      "get_service",
      "get_signed_receipt",
      "historical_fmv",
      "is_fair_price",
      "is_fair_price_batch",
      "list_services",
      "mcp_health_ping",
      "prepay_verdict",
      "prepay_verdict_batch",
      "recent_observations",
      "refuse_if_overpriced",
      "smart_route",
      "subscribe_alert",
      "verify_receipt",
      "why",
    ]);
  });

  it("each tool has a non-empty title and description", () => {
    for (const t of TOOLS) {
      assert.ok(t.title.length > 0, `${t.name} missing title`);
      assert.ok(t.description.length > 20, `${t.name} description too terse`);
    }
  });
});

describe("deprecated aliases still validate and route to canonical fields", () => {
  const toolByName = (n: string) => {
    const t = TOOLS.find((x) => x.name === n);
    if (!t) throw new Error(`tool ${n} missing`);
    return t;
  };

  it("prepay_verdict accepts canonical slug + amount_usd + unit", () => {
    const parsed = toolByName("prepay_verdict").inputSchema.parse({
      slug: "acme-llm",
      amount_usd: 0.25,
      unit: "tokens",
    });
    assert.equal((parsed as any).slug, "acme-llm");
    assert.equal((parsed as any).amount_usd, 0.25);
    assert.equal((parsed as any).unit, "tokens");
  });

  it("prepay_verdict accepts legacy url + amountMicros aliases", () => {
    const parsed = toolByName("prepay_verdict").inputSchema.parse({
      url: "https://example.com/x402",
      amountMicros: 500_000,
    });
    assert.equal((parsed as any).url, "https://example.com/x402");
    assert.equal((parsed as any).amountMicros, 500_000);
  });

  it("prepay_verdict rejects when no target or amount is provided", () => {
    assert.throws(() =>
      toolByName("prepay_verdict").inputSchema.parse({ amount_usd: 1.0 }),
    );
    assert.throws(() =>
      toolByName("prepay_verdict").inputSchema.parse({ slug: "acme-llm" }),
    );
  });

  it("get_signed_receipt accepts canonical receipt_id and legacy for_request_id alias", () => {
    const a = toolByName("get_signed_receipt").inputSchema.parse({
      receipt_id: "rcpt_abc",
    });
    const b = toolByName("get_signed_receipt").inputSchema.parse({
      for_request_id: "rcpt_abc",
    });
    assert.equal((a as any).receipt_id, "rcpt_abc");
    assert.equal((b as any).for_request_id, "rcpt_abc");
    assert.throws(() =>
      toolByName("get_signed_receipt").inputSchema.parse({}),
    );
  });

  it("subscribe_alert accepts canonical webhook_url and legacy webhook alias", () => {
    const a = toolByName("subscribe_alert").inputSchema.parse({
      slug: "acme-llm",
      condition: "above",
      threshold: 1.5,
      webhook_url: "https://hooks.example.com/abc",
    });
    const b = toolByName("subscribe_alert").inputSchema.parse({
      slug: "acme-llm",
      condition: "above",
      threshold: 1.5,
      webhook: "https://hooks.example.com/abc",
    });
    assert.equal((a as any).webhook_url, "https://hooks.example.com/abc");
    assert.equal((b as any).webhook, "https://hooks.example.com/abc");
  });
});

describe("AriClient (mocked fetch)", () => {
  it("verifies signature using the cached PEM and returns parsed JSON", async () => {
    // Generate a real Ed25519 keypair, sign a body, and exercise the
    // verifying path end-to-end. Confirms client wiring against verify.ts
    // matches the server's signing flow.
    const { generateKeyPairSync, createSign, createPublicKey, createHash: _hashForKeyId } =
      await import("node:crypto");
    const kp = generateKeyPairSync("ed25519");
    const pem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const body = '{"hello":"world"}';
    const signedAt = "2026-04-25T12:00:00.000Z";
    // Task #440 · the client now pins Ari-Key-Id against the PEM's own
    // fingerprint for overridden hosts. Derive the matching key id
    // here so the pin check passes; previously this test hard-coded a
    // stub id ("ari-test1234") that no longer matches the cached PEM.
    const derPubForId = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const keyId =
      "ari-" + _hashForKeyId("sha256").update(derPubForId).digest("hex").slice(0, 12);
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
      // Task #440 · for overridden hosts the client now pins Ari-Key-Id
      // against the PEM's fingerprint, so a stub id like "ari-bad"
      // surfaces as a "Refusing receipt" pin-mismatch BEFORE the
      // ed25519 math gets a chance to fail. Either error path is a
      // legitimate "verification refused" outcome for this test.
      /Receipt verification failed|signature does not verify|Refusing receipt/,
    );
  });
});
