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
  it("returns should_pay: null (not true/false) when no FMV baseline exists", async () => {
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
      null,
      "should_pay must be null when there is no baseline · never true and never false, " +
        "because either would falsely encode certainty",
    );
    assert.equal(result["verdict"], "unknown");
    assert.equal(result["fmv_usd"], null);
    assert.equal(result["high_usd"], null);
    assert.equal(result["savings_estimate_usd"], null);
    assert.ok(
      typeof result["reason"] === "string" && (result["reason"] as string).length > 0,
      "reason string must explain why no decision was made",
    );
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
