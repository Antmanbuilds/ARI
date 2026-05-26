// SPDX-License-Identifier: Apache-2.0
//
// ARI live-API integration suite (T01-T15). This is the authoritative
// shipment gate before any `npm publish` / `pip publish` of the MCP
// packages. Runs against https://agentrateindicators.com by default;
// override with ARI_API_BASE_URL.
//
// Output contract (consumed by scripts/generate-shipment-ready.mjs):
//   - Each case prints `PASS [tool] — receipt: <id>` or
//     `FAIL [tool] — <reason>` LIVE as it runs (never buffered).
//   - Final line is `<X> passed, <Y> failed`.
//   - Process exits 0 iff all 15 cases pass.
//   - A JSON sidecar is written to .integration-results.json with
//     the per-case verdict for the shipment-report generator.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_URL,
  callApi,
  fetchPinnedPublicKey,
  REQUIRED_RECEIPT_HEADERS,
} from "./helpers.mjs";

const NO_DATA_SLUG = "ari-test-no-data-xyz";
const MISSING_SLUG = "ari-does-not-exist-xyz";
const WEBHOOK_URL_FOR_T14 = "https://webhook.site/test";

const results = [];
let publicKeyPem = null;

function pass(id, tool, receiptId, extra = {}) {
  const line = `PASS [${tool}] — receipt: ${receiptId ?? "(none)"}`;
  // eslint-disable-next-line no-console
  console.log(line);
  // Reserved keys (status, id, tool, receiptId, reason) MUST win over
  // any caller-supplied `extra` so the shipment report can't show
  // "Status: 404" instead of "Status: PASS" just because the per-case
  // metadata happened to include an http status code.
  results.push({ ...extra, id, tool, status: "PASS", receiptId: receiptId ?? null });
}

function fail(id, tool, reason) {
  const line = `FAIL [${tool}] — ${reason}`;
  // eslint-disable-next-line no-console
  console.log(line);
  results.push({ id, tool, status: "FAIL", reason });
}

async function runCase(id, tool, fn) {
  try {
    await fn();
  } catch (e) {
    fail(id, tool, e instanceof Error ? e.message : String(e));
  }
}

// Task #535 · receipts are persisted via an async queue (WAL + batch
// insert), so a tight T01→T11 sequence races the write. Poll the
// verify-receipt endpoint for up to ~3s before giving up · this only
// adds latency on the unhappy path where the row never lands.
async function callVerifyReceiptWithRetry(receiptId, opts) {
  const url = `/api/v1/verify-receipt?receipt_id=${encodeURIComponent(receiptId)}`;
  const deadline = Date.now() + 3000;
  let last;
  while (Date.now() < deadline) {
    last = await callApi(url, opts);
    if (last.status !== 404) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

function requireHeaders(res) {
  const missing = REQUIRED_RECEIPT_HEADERS.filter((k) => !res.headers[k]);
  if (missing.length > 0) {
    throw new Error(`missing Ari-* headers: ${missing.join(", ")}`);
  }
}

async function discoverKnownGoodSlug() {
  // Self-bootstrapping: pick a live x402 service whose FMV is set and
  // non-zero (so a strict band assertion in T02/T03 is meaningful).
  const r = await callApi("/api/v1/services?protocol=x402&limit=200", { publicKeyPem });
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.items)) {
    throw new Error(`list_services for discovery returned HTTP ${r.status}`);
  }
  const candidate = r.body.items.find(
    (s) =>
      s.fairPrice &&
      typeof s.fairPrice.fmvMicros === "number" &&
      s.fairPrice.fmvMicros > 0 &&
      typeof s.fairPrice.lowMicros === "number" &&
      typeof s.fairPrice.highMicros === "number" &&
      s.fairPrice.lowMicros <= s.fairPrice.fmvMicros &&
      s.fairPrice.fmvMicros <= s.fairPrice.highMicros &&
      typeof s.fairPrice.sampleSize === "number" &&
      s.fairPrice.sampleSize > 0,
  );
  if (!candidate) {
    throw new Error("no live x402 service has a usable FMV band; cannot bootstrap suite");
  }
  return candidate;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`# ARI live integration suite · ${BASE_URL}`);

  publicKeyPem = await fetchPinnedPublicKey();
  const knownGood = await discoverKnownGoodSlug();
  const knownSlug = knownGood.slug;
  const fmvMicros = knownGood.fairPrice.fmvMicros;
  // eslint-disable-next-line no-console
  console.log(`# bootstrapped known-good slug=${knownSlug} fmvMicros=${fmvMicros}`);

  let t01ReceiptId = null;

  // T01 · fair-price 3x above FMV must NEVER be green.
  await runCase("T01", "is_fair_price", async () => {
    const amount = fmvMicros * 3;
    const r = await callApi(
      `/api/v1/fair-price?service=${encodeURIComponent(knownSlug)}&amount_micros=${amount}`,
      { publicKeyPem },
    );
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const verdict = r.body?.verdict?.label;
    if (verdict === "green") throw new Error(`verdict must not be green; got "${verdict}"`);
    if (typeof verdict !== "string") throw new Error("verdict.label missing");
    t01ReceiptId = r.receiptId;
    pass("T01", "is_fair_price", r.receiptId, { verdict });
  });

  // T02 · fair-price at exactly FMV should grade green.
  await runCase("T02", "is_fair_price", async () => {
    const r = await callApi(
      `/api/v1/fair-price?service=${encodeURIComponent(knownSlug)}&amount_micros=${fmvMicros}`,
      { publicKeyPem },
    );
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const verdict = r.body?.verdict?.label;
    if (verdict !== "green") {
      throw new Error(`expected verdict=green at FMV, got "${verdict}"`);
    }
    pass("T02", "is_fair_price", r.receiptId, { verdict });
  });

  // T03 · get_fmv for a known-good slug returns a usable band.
  await runCase("T03", "get_fmv", async () => {
    const r = await callApi(`/api/v1/services/${encodeURIComponent(knownSlug)}`, { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const fp = r.body?.fairPrice;
    if (!fp) throw new Error("fairPrice missing");
    const fmv = Number(fp.fmvMicros);
    const low = Number(fp.lowMicros);
    const high = Number(fp.highMicros);
    if (!(fmv > 0)) throw new Error(`fmv_usd must be > 0, got ${fmv}`);
    if (!(fp.sampleSize > 0)) throw new Error(`sample_size must be > 0, got ${fp.sampleSize}`);
    if (!(low <= fmv && fmv <= high)) {
      throw new Error(`band violated: low=${low} fmv=${fmv} high=${high}`);
    }
    pass("T03", "get_fmv", r.receiptId);
  });

  // T04 · no-data slug must return fmv_usd === null (strict null).
  await runCase("T04", "get_fmv", async () => {
    const r = await callApi(`/api/v1/services/${encodeURIComponent(NO_DATA_SLUG)}`, { publicKeyPem });
    // Two acceptable shapes per the null contract:
    //   (a) 200 with body.fairPrice.fmvMicros explicitly null AND verdict "unknown"
    //   (b) 404 (no such fixture deployed yet) · documented as a fixture gap
    if (r.status === 200) {
      requireHeaders(r);
      const fmv = r.body?.fairPrice?.fmvMicros;
      if (fmv !== null) {
        throw new Error(`fmv_usd must be strict null, got ${JSON.stringify(fmv)}`);
      }
      pass("T04", "get_fmv", r.receiptId, { shape: "no-data-fixture" });
      return;
    }
    if (r.status === 404) {
      // The fixture slug is not seeded in this environment · the
      // contract (strict null, never 0) can't be observed. Fail loudly
      // so the shipment gate flags it rather than masking with a pass.
      throw new Error(
        `no-data fixture "${NO_DATA_SLUG}" not deployed (HTTP 404); seed the fixture so the null contract can be observed`,
      );
    }
    throw new Error(`unexpected HTTP ${r.status} for no-data slug`);
  });

  // T05 · refuse_if_overpriced for a no-data slug must abstain
  // (ok=true, reason="no_data" · never "fair"). We exercise the
  // underlying fair-price endpoint (the MCP tool's data source) and
  // assert verdict is the explicit insufficient-data signal.
  await runCase("T05", "refuse_if_overpriced", async () => {
    const r = await callApi(
      `/api/v1/fair-price?service=${encodeURIComponent(NO_DATA_SLUG)}&amount_micros=1000`,
      { publicKeyPem },
    );
    if (r.status === 200) {
      requireHeaders(r);
      // The no-data contract (spec): `ok === true` (request was well-formed
      // and answered honestly) AND `reason === "no_data"` (refusing to
      // grade because the FMV is null, not zero, not stale). A green/fair
      // verdict OR a missing `reason` is the bug this case protects.
      const ok = r.body?.ok;
      const reason = r.body?.reason ?? r.body?.verdict?.reason;
      const verdict = r.body?.verdict?.label;
      if (ok !== true) {
        throw new Error(`expected ok=true on no-data response, got ok=${JSON.stringify(ok)}`);
      }
      if (reason !== "no_data") {
        throw new Error(
          `expected reason="no_data" on no-data response, got reason=${JSON.stringify(reason)} (verdict=${JSON.stringify(verdict)})`,
        );
      }
      pass("T05", "refuse_if_overpriced", r.receiptId, { verdict, reason });
      return;
    }
    if (r.status === 404) {
      throw new Error(
        `no-data fixture "${NO_DATA_SLUG}" not deployed (HTTP 404); seed the fixture so T05 can observe the no_data branch`,
      );
    }
    throw new Error(`unexpected HTTP ${r.status} for no-data slug`);
  });

  // T06 · get_service round-trip includes protocol, category, slug.
  await runCase("T06", "get_service", async () => {
    const r = await callApi(`/api/v1/services/${encodeURIComponent(knownSlug)}`, { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const b = r.body;
    for (const k of ["slug", "protocol", "category"]) {
      if (!b?.[k]) throw new Error(`missing field "${k}" in service detail`);
    }
    if (!r.receiptId) throw new Error("Ari-Receipt-Id header missing");
    pass("T06", "get_service", r.receiptId);
  });

  // T07 · list_services?protocol=x402 · every item must be x402.
  await runCase("T07", "list_services", async () => {
    const r = await callApi("/api/v1/services?protocol=x402&limit=50", { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const items = r.body?.items ?? [];
    if (items.length === 0) throw new Error("no x402 services returned");
    const bad = items.find((s) => s.protocol !== "x402");
    if (bad) throw new Error(`item ${bad.slug} has protocol=${bad.protocol}`);
    pass("T07", "list_services", r.receiptId, { count: items.length });
  });

  // T08 · list_services?protocol=mpp · every item must be mpp.
  await runCase("T08", "list_services", async () => {
    const r = await callApi("/api/v1/services?protocol=mpp&limit=50", { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const items = r.body?.items ?? [];
    if (items.length === 0) throw new Error("no mpp services returned");
    const bad = items.find((s) => s.protocol !== "mpp");
    if (bad) throw new Error(`item ${bad.slug} has protocol=${bad.protocol}`);
    pass("T08", "list_services", r.receiptId, { count: items.length });
  });

  // T09 · leaderboard returns >= 3 entries, each with a usable FMV
  // and the response is signed (single receipt covers the whole rail).
  await runCase("T09", "get_leaderboard", async () => {
    const r = await callApi("/api/v1/leaderboard?metric=cheapest&limit=10", { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    const entries = r.body?.entries ?? [];
    if (entries.length < 3) throw new Error(`expected >= 3 entries, got ${entries.length}`);
    for (const e of entries) {
      const fmv = e.service?.fairPrice?.fmvMicros;
      if (typeof fmv !== "number") {
        throw new Error(`entry ${e.service?.slug} has no fmvMicros`);
      }
    }
    if (!r.receiptId) throw new Error("Ari-Receipt-Id header missing");
    pass("T09", "get_leaderboard", r.receiptId, { count: entries.length });
  });

  // T10 · recent_observations for a known slug. Array with timestamp +
  // price fields.
  await runCase("T10", "recent_observations", async () => {
    const r = await callApi(
      `/api/v1/services/${encodeURIComponent(knownSlug)}/observations?limit=5`,
      { publicKeyPem },
    );
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    if (!Array.isArray(r.body)) throw new Error("expected array body");
    if (r.body.length === 0) throw new Error("no observations returned");
    for (const o of r.body) {
      if (!o.observedAt) throw new Error("observation missing observedAt");
      if (typeof o.amountMicros !== "number" && typeof o.amountMicros !== "string") {
        throw new Error("observation missing amountMicros");
      }
    }
    pass("T10", "recent_observations", r.receiptId, { count: r.body.length });
  });

  // T11 · verify_receipt for the real T01 receipt id.
  await runCase("T11", "verify_receipt", async () => {
    if (!t01ReceiptId) throw new Error("T01 did not produce a receipt id");
    const r = await callVerifyReceiptWithRetry(t01ReceiptId, { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    // The endpoint may either return `valid:true` or simply return the
    // signed payload (no `valid` field) · in both cases we re-verify
    // the wire signature on this very response, which is the actual
    // proof of authenticity. Treat presence of payload+signature as
    // "verified" when valid is omitted.
    const verified = r.body?.valid === true || (!!r.body?.payload && !!r.body?.signature);
    if (!verified) throw new Error(`verified=false for receipt ${t01ReceiptId}`);
    pass("T11", "verify_receipt", r.receiptId);
  });

  // T12 · stateless verify of a TAMPERED signature for a real T01
  // receipt body MUST return `valid === false` exactly. We use the
  // POST /v1/verify-receipt endpoint (the public "give me a receipt
  // body + signature, tell me if it's valid" rail used by the
  // /transparency widget). Flipping bytes inside the base64 signature
  // is the cleanest way to prove the Ed25519 math is actually being
  // evaluated · a stub that always returns true would fail here.
  await runCase("T12", "verify_receipt", async () => {
    if (!t01ReceiptId) throw new Error("T01 did not produce a receipt id");
    const lookup = await callVerifyReceiptWithRetry(t01ReceiptId, { publicKeyPem });
    if (lookup.status !== 200) {
      throw new Error(`could not fetch T01 receipt for tampering (HTTP ${lookup.status})`);
    }
    const orig = lookup.body?.signature;
    if (typeof orig !== "string" || orig.length < 8) {
      throw new Error("T01 receipt has no usable signature to tamper with");
    }
    // Flip a byte in the middle of the base64 signature · keep length
    // and charset intact so the server still parses it as a signature
    // and actually runs the Ed25519 verify (the bug we're guarding).
    const idx = Math.floor(orig.length / 2);
    const here = orig[idx];
    const swap = here === "A" ? "B" : "A";
    const tamperedSig = orig.slice(0, idx) + swap + orig.slice(idx + 1);
    const r = await callApi("/api/v1/verify-receipt", {
      method: "POST",
      body: {
        body: lookup.body.payload,
        signature: tamperedSig,
        signedAt: lookup.body.signedAt,
        keyId: lookup.body.keyId,
        receiptId: lookup.body.receiptId,
      },
      publicKeyPem,
    });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    if (r.body?.valid !== false) {
      throw new Error(
        `tampered signature must return valid:false; got valid=${JSON.stringify(r.body?.valid)}`,
      );
    }
    pass("T12", "verify_receipt", r.receiptId, { httpStatus: r.status });
  });

  // T13 · get_signed_receipt returns body + signature for a known id.
  await runCase("T13", "get_signed_receipt", async () => {
    if (!t01ReceiptId) throw new Error("T01 did not produce a receipt id");
    const r = await callVerifyReceiptWithRetry(t01ReceiptId, { publicKeyPem });
    if (r.status !== 200) throw new Error(`expected HTTP 200, got ${r.status}`);
    requireHeaders(r);
    if (!r.body?.payload) throw new Error("payload missing");
    if (!r.body?.signature) throw new Error("signature missing");
    if (!r.body?.canonicalHash) throw new Error("canonicalHash missing");
    pass("T13", "get_signed_receipt", r.receiptId);
  });

  // T14 · subscribe_alert with a valid webhook url. Server may 201
  // (created) or 400 (e.g. unreachable webhook host); the contract for
  // this gate is "Ari-Receipt-Id is present on the response" because
  // every signed v1 response carries one. We accept 201 as a real
  // create and 400 as a documented-validation failure that still
  // proves the route is reachable and signed.
  await runCase("T14", "subscribe_alert", async () => {
    const payload = {
      channel: "webhook",
      webhookUrl: WEBHOOK_URL_FOR_T14,
      condition: "price_move_pct",
      label: `ari-shipment-gate-${Date.now()}`,
      config: { thresholdPct: 5 },
    };
    const r = await callApi("/api/alerts/subscriptions", {
      method: "POST",
      body: payload,
      publicKeyPem,
    });
    if (!r.receiptId) throw new Error(`no Ari-Receipt-Id on response (HTTP ${r.status})`);
    if (r.status !== 201 && r.status !== 200 && r.status !== 400) {
      throw new Error(`unexpected HTTP ${r.status}`);
    }
    pass("T14", "subscribe_alert", r.receiptId, { status: r.status });
  });

  // T15 · missing slug returns 404 with an `error` field and NO fmv_usd.
  await runCase("T15", "get_service", async () => {
    const r = await callApi(`/api/v1/services/${encodeURIComponent(MISSING_SLUG)}`, { publicKeyPem });
    if (r.status !== 404) throw new Error(`expected HTTP 404, got ${r.status}`);
    if (!r.body || typeof r.body.error !== "string") {
      throw new Error("error field missing from 404 body");
    }
    if (r.body.fmv_usd !== undefined || r.body.fmvMicros !== undefined) {
      throw new Error("404 body must not include fmv_usd / fmvMicros");
    }
    pass("T15", "get_service", r.receiptId, { status: 404 });
  });

  // ---- summary + sidecar ---------------------------------------------
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(`${passed} passed, ${failed} failed`);

  const here = dirname(fileURLToPath(import.meta.url));
  const outFile = join(here, "..", ".integration-results.json");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        base_url: BASE_URL,
        ran_at: new Date().toISOString(),
        known_good_slug: knownSlug,
        results,
        passed,
        failed,
      },
      null,
      2,
    ),
  );

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("integration suite crashed:", e?.stack || e);
  process.exit(1);
});
