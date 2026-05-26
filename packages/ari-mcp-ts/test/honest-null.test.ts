// SPDX-License-Identifier: Apache-2.0
// Regression tests for the MCP tool surface's honest-null contract.
//
// When the ARI API has no fair-market value for a service (still
// indexing, insufficient observations, unknown unit, etc.) the MCP
// tools MUST return `null` for every price-shaped field instead of
// silently emitting `0`. A `?? 0` default would tell an LLM agent
// that the service is "free" or that any quote above zero is
// overpriced · either lie is a payment-safety bug.
//
// These tests construct a stub `AriClient` whose `request()` returns
// the kind of API response that triggered the original bug (empty
// `fairPrice`, missing `fmvMicros`, etc.) and assert the contract on
// every public tool that exposes a price.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../src/tools/index.js";
import type { AriClient, AriResponse } from "../src/client.js";

type ReqFn = <T>(path: string, init?: RequestInit) => Promise<AriResponse<T>>;

function makeClient(request: ReqFn): AriClient {
  // The tools only touch `client.request()`; the rest of the AriClient
  // surface (key fetching, verify, etc.) is not exercised here, so a
  // structural duck-type cast is safe and intentional.
  return { request } as unknown as AriClient;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not registered`);
  return t!;
}

const RECEIPT_HEADERS = {
  receiptId: "01HZTESTRECEIPT",
  signedAt: "2026-05-20T00:00:00.000Z",
  keyId: "ari-test",
  canonicalHash: "deadbeef",
};

function ok<T>(data: T): AriResponse<T> {
  return { data, ...RECEIPT_HEADERS };
}

describe("honest-null contract · get_fmv", () => {
  it("returns null for every price field when the service has no fairPrice", async () => {
    const client = makeClient(async () =>
      ok({ slug: "acme-llm", name: "Acme LLM", lastObservedAt: null }) as AriResponse<unknown>,
    );
    const result = (await tool("get_fmv").run({ slug: "acme-llm" }, client)) as Record<
      string,
      unknown
    >;
    assert.equal(result["fmv_usd"], null, "fmv_usd must be null, never 0");
    assert.equal(result["low_usd"], null, "low_usd must be null, never 0");
    assert.equal(result["high_usd"], null, "high_usd must be null, never 0");
    assert.equal(result["sample_size"], null, "sample_size must be null, never 0");
  });

  it("returns null for fmv/low/high when fairPrice exists but micros fields are missing", async () => {
    const client = makeClient(async () =>
      ok({
        slug: "acme-llm",
        fairPrice: { sampleSize: 0, currency: "USD", unitCode: "tokens" },
        lastObservedAt: "2026-05-19T00:00:00.000Z",
      }) as AriResponse<unknown>,
    );
    const result = (await tool("get_fmv").run({ slug: "acme-llm" }, client)) as Record<
      string,
      unknown
    >;
    assert.equal(result["fmv_usd"], null);
    assert.equal(result["low_usd"], null);
    assert.equal(result["high_usd"], null);
    // sampleSize of 0 is real data (the API said zero), it should pass through.
    assert.equal(result["sample_size"], 0);
  });
});

describe("honest-null contract · is_fair_price", () => {
  it("returns null prices when the FMV endpoint has no data yet", async () => {
    const client = makeClient(async () =>
      ok({
        verdict: { label: "unknown", deltaPct: null },
        sampleSize: 0,
        currency: "USD",
        unitCode: "tokens",
      }) as AriResponse<unknown>,
    );
    const result = (await tool("is_fair_price").run(
      { slug: "acme-llm", amount_usd: 0.001 },
      client,
    )) as Record<string, unknown>;
    assert.equal(result["fmv_usd"], null, "fmv_usd must be null when API omits fmvMicros");
    assert.equal(result["low_usd"], null);
    assert.equal(result["high_usd"], null);
    assert.equal(result["delta_pct"], null);
    assert.equal(result["verdict"], "unknown");
  });
});

describe("honest-null contract · refuse_if_overpriced", () => {
  it("returns should_pay: false (strict boolean fail-closed) when no FMV baseline exists", async () => {
    // Task #437 round-3 · the contract is now a STRICT boolean. Every
    // path that isn't an explicit green/fair on a usable baseline MUST
    // return false so an agent that branches on `should_pay !== false`
    // cannot AUTO-PAY when ARI couldn't decide. The `reason` field
    // still surfaces why so callers can fall back to their own policy.
    const client = makeClient(async () =>
      ok({
        verdict: { label: "unknown", deltaPct: null },
        sampleSize: 0,
      }) as AriResponse<unknown>,
    );
    const result = (await tool("refuse_if_overpriced").run(
      { slug: "acme-llm", amount_usd: 0.5 },
      client,
    )) as Record<string, unknown>;
    assert.equal(
      result["should_pay"],
      false,
      "should_pay must be the boolean false when there is no baseline · fail-closed contract",
    );
    assert.equal(result["verdict"], "unknown");
    assert.equal(result["fmv_usd"], null);
    assert.equal(result["high_usd"], null);
    assert.equal(result["savings_estimate_usd"], null);
    assert.ok(
      typeof result["reason"] === "string" && (result["reason"] as string).length > 0,
      "reason string must explain why the tool refused",
    );
  });

  it("returns should_pay: false (refuse) on amber · fails closed, not open", async () => {
    // Task #437 regression · the prior implementation used
    // `verdict !== "red"`, which silently auto-settled amber quotes.
    const client = makeClient(async () =>
      ok({
        verdict: { label: "amber", deltaPct: 18 },
        fmvMicros: 1_000_000,
        lowMicros: 800_000,
        highMicros: 1_200_000,
        sampleSize: 12,
      }) as AriResponse<unknown>,
    );
    const result = (await tool("refuse_if_overpriced").run(
      { slug: "acme-llm", amount_usd: 1.15 },
      client,
    )) as Record<string, unknown>;
    assert.equal(result["should_pay"], false, "amber must refuse, not pay");
    assert.equal(result["verdict"], "amber");
    assert.ok(
      typeof result["reason"] === "string" && (result["reason"] as string).length > 0,
    );
  });

  it("signing input: Ari-Schedule-Proof appended in the right slot when present, skipped when absent", async () => {
    // Task #437 cross-language regression · the MCP TS/Py canonical
    // mirrors previously omitted Ari-Schedule-Proof from the
    // SIGNED_HEADER_NAMES list, so any receipt that carried the header
    // would verify against the wrong bytes. This test pins the order
    // (License, Content-Type, Ari-Signed-At, Ari-Key-Id, Ari-Receipt-Id,
    // Ari-Schedule-Proof) and confirms absent values are skipped.
    const { composeSigningInput, SIGNED_HEADER_NAMES } = await import("../src/canonical.js");
    // Task #535 · v3 added Ari-Confidence and Ari-Fmv-Source to the
    // signed preamble for fair-price (category-median fallback). Verifiers
    // MUST include them in the canonicalization order or every signed
    // fair-price receipt will appear to have a bad signature.
    assert.deepEqual(
      [...SIGNED_HEADER_NAMES],
      [
        "License",
        "Content-Type",
        "Ari-Signed-At",
        "Ari-Key-Id",
        "Ari-Receipt-Id",
        "Ari-Schedule-Proof",
        "Ari-Confidence",
        "Ari-Fmv-Source",
      ],
    );
    const withProof = composeSigningInput("{}", {
      License: "BUSL-1.1",
      "Content-Type": "application/json",
      "Ari-Signed-At": "2026-01-01T00:00:00Z",
      "Ari-Key-Id": "kid-1",
      "Ari-Receipt-Id": "01HZ",
      "Ari-Schedule-Proof": "proof-abc",
    });
    assert.equal(
      withProof,
      "{}\nLicense: BUSL-1.1\nContent-Type: application/json\n" +
        "Ari-Signed-At: 2026-01-01T00:00:00Z\nAri-Key-Id: kid-1\n" +
        "Ari-Receipt-Id: 01HZ\nAri-Schedule-Proof: proof-abc",
    );
    const withoutProof = composeSigningInput("{}", {
      License: "BUSL-1.1",
      "Content-Type": "application/json",
      "Ari-Signed-At": "2026-01-01T00:00:00Z",
      "Ari-Key-Id": "kid-1",
      "Ari-Receipt-Id": "01HZ",
    });
    assert.ok(
      !withoutProof.includes("Ari-Schedule-Proof"),
      "absent Ari-Schedule-Proof must be skipped, not emitted with empty value",
    );
  });

  it("verifier: refuses when required headers are missing (fails closed, no math runs)", async () => {
    // Task #437 regression · the prior implementation would happily compute
    // a signing input over an empty preamble and report valid:true if the
    // math happened to work. The hardened verifier refuses to even attempt
    // verification when any of Ari-Key-Id/Ari-Receipt-Id/Ari-Signed-At/
    // Ari-Signature are absent.
    const { verifyReceipt } = await import("../src/verify.js");
    const fakePem =
      "-----BEGIN PUBLIC KEY-----\n" +
      "MCowBQYDK2VwAyEAkvPU1HujL+OSz3DyLaVpWh0ae0qffvEDK0wZ+iChdr0=\n" +
      "-----END PUBLIC KEY-----\n";
    const result = await verifyReceipt("{}", {}, fakePem);
    assert.equal(result.valid, false, "missing required headers must fail closed");
    assert.ok(
      result.errors.some((e) => e.includes("receipt headers missing")),
      `expected explicit missing-headers error, got: ${result.errors.join(" | ")}`,
    );
    for (const h of ["Ari-Key-Id", "Ari-Receipt-Id", "Ari-Signed-At", "Ari-Signature"]) {
      assert.ok(
        result.errors.join(" | ").includes(h),
        `expected ${h} in error list, got: ${result.errors.join(" | ")}`,
      );
    }
  });

  it("schema: get_leaderboard defaults `kind` to most_observed when omitted", () => {
    // Task #437 schema reconciliation · spec lists `kind` as optional.
    const t = tool("get_leaderboard");
    const parsed = (t.inputSchema as unknown as { parse: (x: unknown) => { kind: string; limit: number } }).parse({});
    assert.equal(parsed.kind, "most_observed");
    assert.equal(parsed.limit, 10);
  });

  it("schema: get_signed_receipt accepts receipt_id (spec) and for_request_id (legacy)", () => {
    const t = tool("get_signed_receipt");
    const schema = t.inputSchema as unknown as {
      parse: (x: unknown) => Record<string, unknown>;
      safeParse: (x: unknown) => { success: boolean };
    };
    assert.doesNotThrow(() => schema.parse({ receipt_id: "01HZNEW" }));
    assert.doesNotThrow(() => schema.parse({ for_request_id: "01HZOLD" }));
    assert.equal(
      schema.safeParse({}).success,
      false,
      "must reject payloads with neither identifier",
    );
  });

  it("schema: subscribe_alert rejects payloads with neither webhook nor email", () => {
    const schema = tool("subscribe_alert").inputSchema as unknown as {
      safeParse: (x: unknown) => { success: boolean };
    };
    assert.equal(
      schema.safeParse({ slug: "x", condition: "above", threshold: 1 }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        slug: "x",
        condition: "above",
        threshold: 1,
        webhook: "https://example.com/wh",
        email: "ops@example.com",
      }).success,
      false,
      "must reject payloads with both delivery channels",
    );
    assert.equal(
      schema.safeParse({
        slug: "x",
        condition: "above",
        threshold: 1,
        webhook_url: "https://example.com/wh",
      }).success,
      true,
      "must accept the webhook_url alias",
    );
  });

  it("returns should_pay: false (strict boolean fail-closed) when the verdict label is unrecognised", async () => {
    // Forward-compat: if the server invents a new verdict label, the MCP
    // tool MUST NOT default to should_pay:true.
    const client = makeClient(async () =>
      ok({
        verdict: { label: "experimental_new_label", deltaPct: 0 },
        fmvMicros: 1_000_000,
        lowMicros: 800_000,
        highMicros: 1_200_000,
        sampleSize: 42,
      }) as AriResponse<unknown>,
    );
    const result = (await tool("refuse_if_overpriced").run(
      { slug: "acme-llm", amount_usd: 1.0 },
      client,
    )) as Record<string, unknown>;
    assert.equal(
      result["should_pay"],
      false,
      "unrecognised verdict labels must fail closed (false), never auto-pay",
    );
    assert.equal(result["verdict"], "experimental_new_label");
  });

  it("still returns a real decision when the API does have a baseline", async () => {
    // Sanity floor: the null path must not be the only path.
    const client = makeClient(async () =>
      ok({
        verdict: { label: "green", deltaPct: -5 },
        fmvMicros: 1_000_000,
        lowMicros: 800_000,
        highMicros: 1_200_000,
        sampleSize: 42,
      }) as AriResponse<unknown>,
    );
    const result = (await tool("refuse_if_overpriced").run(
      { slug: "acme-llm", amount_usd: 1.0 },
      client,
    )) as Record<string, unknown>;
    assert.equal(result["should_pay"], true);
    assert.equal(result["verdict"], "green");
    assert.equal(result["fmv_usd"], 1);
    assert.equal(result["high_usd"], 1.2);
  });
});

describe("honest-null contract · prepay_verdict", () => {
  it("returns null micros fields and verdict=unknown when API has no data", async () => {
    const client = makeClient(async () =>
      ok({
        verdict: "unknown",
        reason: "No baseline yet for example.com",
        suggestedMax: null,
        evidenceUrl: "https://agentrateindicators.com/services/example",
        currency: "USD",
        chain: "off-chain",
      }) as AriResponse<unknown>,
    );
    const result = (await tool("prepay_verdict").run(
      { url: "https://example.com/x402", amountMicros: 100_000 },
      client,
    )) as Record<string, unknown>;
    assert.equal(result["verdict"], "unknown");
    assert.equal(result["fmvMicros"], null);
    assert.equal(result["fmv_micros"], null);
    assert.equal(result["lowMicros"], null);
    assert.equal(result["low_micros"], null);
    assert.equal(result["highMicros"], null);
    assert.equal(result["high_micros"], null);
    assert.equal(result["sampleSize"], null);
    assert.equal(result["sample_size"], null);
    assert.equal(result["suggestedMax"], null);
    assert.equal(result["suggested_max_micros"], null);
  });
});
