// SPDX-License-Identifier: Apache-2.0
//
// MCP tool surface. Each entry is `{ name, title, description, inputSchema, run }`
// where `run` takes the parsed input + a shared `AriClient` and returns a
// JSON-serializable result. The MCP server (server.ts) wraps these into MCP
// `tools/call` responses with `isError: true` on thrown exceptions and a
// `_receipt` block on success.

import { z } from "zod";
import type { AriClient } from "../client.js";

export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  run: (input: z.infer<I>, client: AriClient) => Promise<unknown>;
}

const SlugInput = z.object({ slug: z.string().min(1, "slug is required") });

const FairPriceQuoteInput = z.object({
  slug: z.string().min(1),
  amount_usd: z
    .number()
    .positive("amount_usd must be a positive number of US dollars"),
  unit: z
    .string()
    .min(1)
    .describe("Unit code (e.g. tokens, calls, seconds). Required so the quote is compared against the correct unit's FMV band."),
});

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

// Task #437 · single source of truth for "is this verdict a green light to
// settle?". Default-deny: only an *explicit* positive label from the FMV
// engine ("green") or the prepay endpoint ("fair") authorises payment.
// Everything else · the stretched/amber bands, the explicit red/overpriced
// refusal, the honest-null "unknown" / "insufficient_data" states, and any
// future label the server might introduce · returns either `false` (refuse)
// or `null` (abstain · honest-null, surface uncertainty to the caller).
//
// The previous implementation collapsed this to `verdict !== "red"`, which
// fails open on amber/unknown/insufficient_data/missing values · exactly the
// classes of input where the agent MUST NOT auto-settle.
export type PayDecision = "pay" | "refuse" | "abstain";
export function verdictDecision(verdict: string | null | undefined): PayDecision {
  switch (verdict) {
    case "green":
    case "fair":
      return "pay";
    case "amber":
    case "stretched":
    case "red":
    case "overpriced":
      return "refuse";
    case "unknown":
    case "insufficient_data":
    case null:
    case undefined:
    case "":
      return "abstain";
    default:
      // Unknown future label · honest-null rather than fail-open.
      return "abstain";
  }
}

/**
 * Task #489 · confidence-aware verdict decision.
 *
 * The verdict-only `verdictDecision` above predates the v3 receipt and
 * treats every "green" label as a green light to pay. That's correct
 * when the FMV came from service-exact, fresh, multi-source evidence
 * (`confidence: "high"` or `"medium"`). It's NOT correct when the FMV
 * is a category-median fallback (`confidence: "low"` /
 * `fmv_source: "category-median"`): the band is wide and an offer that
 * happens to land inside it tells you nothing about whether the offer
 * itself is fair.
 *
 * Default-deny: a green verdict on `low` confidence ABSTAINS unless the
 * caller explicitly passes `acceptLowConfidence: true` (e.g. an agent
 * that prefers to act on weak evidence and accepts the risk · this is
 * the Pyth/Chainlink "best-effort" tier). `insufficient_data` always
 * abstains. `red` always refuses regardless of confidence.
 */
export interface ConfidenceAwareInputs {
  verdict: string | null | undefined;
  confidence?: string | null | undefined;
  fmvSource?: string | null | undefined;
}

export interface ConfidenceAwareOptions {
  acceptLowConfidence?: boolean;
}

export function verdictDecisionWithConfidence(
  inputs: ConfidenceAwareInputs,
  opts: ConfidenceAwareOptions = {},
): PayDecision {
  const base = verdictDecision(inputs.verdict);
  // refuse / abstain are unchanged · low confidence never *upgrades*
  // a refusal to a pay, and we don't second-guess the engine's red.
  if (base !== "pay") return base;
  const conf = inputs.confidence;
  if (conf === "high" || conf === "medium") return "pay";
  // Task #535 · only DEMOTE on an explicit "low" confidence (the v3
  // signal that the FMV came from a category/global-median fallback).
  // Missing / null / undefined confidence means the server didn't
  // emit the v3 field at all (legacy server, service-direct verdict,
  // or a route that doesn't expose it) · treating that as "low" would
  // break the cross-language contract (fixtures send `green` with no
  // confidence) and would regress every legacy caller. Default-allow
  // the pay; demote only when the server explicitly said "low".
  if (conf === "low") {
    if (opts.acceptLowConfidence) return "pay";
    return "abstain";
  }
  return "pay";
}

// ---- Narrow response types for the ARI HTTP endpoints we consume.
// These are intentionally minimal · every field is `?` and tools tolerate
// missing fields with sensible defaults. Whenever the API adds a field
// we want to surface, we widen the type here. No `any` anywhere.

interface FairPriceResponse {
  fmvMicros?: number | string;
  lowMicros?: number | string;
  highMicros?: number | string;
  sampleSize?: number;
  currency?: string;
  unitCode?: string;
  verdict?: {
    label?: string;
    deltaPct?: number | null;
    // Task #489 · v3 fields. May also live on the receipt headers
    // (Ari-Confidence/Ari-Fmv-Source); the route echoes them onto the
    // verdict + top-level body so non-header-aware callers see them.
    confidence?: string | null;
    fmvSource?: string | null;
  };
  /** Task #489 · top-level mirror of verdict.confidence. */
  confidence?: string | null;
  /** Task #489 · top-level mirror of verdict.fmvSource. */
  fmv_source?: string | null;
}

interface ServiceFairPrice {
  fmvMicros?: number | string;
  lowMicros?: number | string;
  highMicros?: number | string;
  sampleSize?: number;
  currency?: string;
  unitCode?: string;
  updatedAt?: string;
}

interface ServiceRow {
  slug: string;
  name?: string;
  vendor?: string;
  protocol?: string;
  category?: { slug?: string };
  categorySlug?: string;
  fairPrice?: ServiceFairPrice;
  lastObservedAt?: string;
  units?: unknown[];
  sources?: unknown[];
  related?: ServiceRow[];
}

interface ListServicesResponse {
  items?: ServiceRow[];
  total?: number;
}

interface LeaderboardEntry {
  service?: { slug?: string; name?: string; vendor?: string };
  value?: number;
  label?: string;
  deltaPct?: number | null;
}

interface LeaderboardResponse {
  entries?: LeaderboardEntry[];
}

interface ObservationRow {
  observedAt: string;
  amountMicros: number | string;
  unitCode?: string;
  currency?: string;
  source?: string;
}

interface VerifyReceiptResponse {
  valid?: boolean;
  keyId?: string;
  signedAt?: string;
  requestPath?: string;
  payload?: unknown;
  signature?: string;
  canonicalHash?: string;
}

interface AlertResponse {
  id?: string;
  createdAt?: string;
}

export const TOOLS: ToolDef[] = [
  {
    name: "is_fair_price",
    title: "Check if a quoted price is fair",
    description:
      "Compare a quoted price for a known service against ARI's current fair-market value (FMV) band. Returns a verdict (green/amber/red), the FMV, the band, the percentile, the sample size, and a citable signed receipt id.",
    inputSchema: FairPriceQuoteInput,
    run: async ({ slug, amount_usd, unit }, client) => {
      const params = new URLSearchParams({
        service: slug,
        amount_micros: String(usdToMicros(amount_usd)),
      });
      if (unit) params.set("unit", unit);
      const r = await client.request<FairPriceResponse>(`/api/v1/fair-price?${params}`);
      const fp = r.data;
      return {
        verdict: fp.verdict?.label ?? "unknown",
        // Honest-null: agents must distinguish "no FMV computed yet" from
        // "FMV is exactly $0.00". Returning null forces the LLM to handle
        // the indexing-state case explicitly instead of quoting "Free".
        fmv_usd: fp.fmvMicros != null ? microsToUsd(Number(fp.fmvMicros)) : null,
        low_usd: fp.lowMicros != null ? microsToUsd(Number(fp.lowMicros)) : null,
        high_usd: fp.highMicros != null ? microsToUsd(Number(fp.highMicros)) : null,
        delta_pct: fp.verdict?.deltaPct ?? null,
        sample_size: fp.sampleSize ?? null,
        currency: fp.currency ?? "USD",
        unit: fp.unitCode ?? unit ?? null,
        receipt_id: r.receiptId ?? null,
        signed_at: r.signedAt ?? null,
      };
    },
  },
  {
    name: "get_fmv",
    title: "Get the fair-market value for a service",
    description:
      "Look up the current FMV (median + low/high band) for an indexed service. Use this when you need the price you'd quote a counterparty before knowing their ask.",
    inputSchema: SlugInput,
    run: async ({ slug }, client) => {
      const r = await client.request<ServiceRow>(
        `/api/v1/services/${encodeURIComponent(slug)}`,
      );
      const fp = r.data?.fairPrice;
      if (!fp) {
        return {
          slug,
          fmv_usd: null,
          low_usd: null,
          high_usd: null,
          sample_size: null,
          last_observed_at: r.data?.lastObservedAt ?? null,
          receipt_id: r.receiptId ?? null,
          message: "No FMV available · service has no recent observations.",
        };
      }
      // Honest-null: every price field is null when missing, so an
      // agent reading this output cannot misread "indexing" as "$0.00".
      return {
        slug: r.data.slug,
        fmv_usd: fp.fmvMicros != null ? microsToUsd(Number(fp.fmvMicros)) : null,
        low_usd: fp.lowMicros != null ? microsToUsd(Number(fp.lowMicros)) : null,
        high_usd: fp.highMicros != null ? microsToUsd(Number(fp.highMicros)) : null,
        sample_size: fp.sampleSize ?? null,
        last_observed_at: r.data?.lastObservedAt ?? fp.updatedAt ?? null,
        currency: fp.currency ?? "USD",
        unit: fp.unitCode ?? null,
        receipt_id: r.receiptId ?? null,
        signed_at: r.signedAt ?? null,
      };
    },
  },
  {
    name: "list_services",
    title: "List indexed services",
    description:
      "Browse the ARI service index. Filter by protocol (`x402`, `mpp`), category, or free-text search. Returns paginated rows with slug, name, vendor, protocol, category, FMV, and last-observed-at.",
    inputSchema: z.object({
      protocol: z.enum(["x402", "mpp"]).optional(),
      category: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(25),
      offset: z.number().int().min(0).default(0),
    }),
    run: async (input, client) => {
      const params = new URLSearchParams();
      if (input.protocol) params.set("protocol", input.protocol);
      if (input.category) params.set("category", input.category);
      if (input.search) params.set("q", input.search);
      params.set("limit", String(input.limit));
      params.set("offset", String(input.offset));
      const r = await client.request<ListServicesResponse>(
        `/api/v1/services?${params}`,
      );
      const items = (r.data?.items ?? []).map((svc) => ({
        slug: svc.slug,
        name: svc.name,
        vendor: svc.vendor,
        protocol: svc.protocol,
        category: svc.categorySlug ?? svc.category?.slug,
        fmv_usd: svc.fairPrice?.fmvMicros
          ? microsToUsd(Number(svc.fairPrice.fmvMicros))
          : null,
        last_observed_at: svc.lastObservedAt ?? null,
      }));
      return {
        items,
        total: r.data?.total ?? items.length,
        limit: input.limit,
        offset: input.offset,
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "get_service",
    title: "Get full service detail",
    description:
      "Return the full detail row for one service: slug, name, vendor, protocol, category, units, fair price, sources, related services.",
    inputSchema: SlugInput,
    run: async ({ slug }, client) => {
      const r = await client.request<ServiceRow>(
        `/api/v1/services/${encodeURIComponent(slug)}`,
      );
      const svc = r.data;
      return {
        slug: svc.slug,
        name: svc.name,
        vendor: svc.vendor,
        protocol: svc.protocol,
        category: svc.categorySlug ?? svc.category?.slug ?? null,
        units: svc.units ?? [],
        sources: svc.sources ?? [],
        fmv_usd: svc.fairPrice?.fmvMicros
          ? microsToUsd(Number(svc.fairPrice.fmvMicros))
          : null,
        low_usd: svc.fairPrice?.lowMicros
          ? microsToUsd(Number(svc.fairPrice.lowMicros))
          : null,
        high_usd: svc.fairPrice?.highMicros
          ? microsToUsd(Number(svc.fairPrice.highMicros))
          : null,
        last_observed_at: svc.lastObservedAt ?? null,
        related: (svc.related ?? []).map((rel) => ({
          slug: rel.slug,
          name: rel.name,
          fmv_usd: rel.fairPrice?.fmvMicros
            ? microsToUsd(Number(rel.fairPrice.fmvMicros))
            : null,
        })),
        receipt_id: r.receiptId ?? null,
        signed_at: r.signedAt ?? null,
      };
    },
  },
  {
    name: "get_leaderboard",
    title: "Get a leaderboard slice",
    description:
      "Return the top services for one of the canonical leaderboards: cheapest, most_expensive, most_volatile, biggest_drop, biggest_jump, most_observed. `kind` is optional and defaults to `most_observed` (most-trafficked services).",
    // Task #437 schema reconciliation: the published 11-tool spec lists
    // `kind` as optional. Make the schema match the spec · default to
    // `most_observed`, which is the most useful "what's hot right now"
    // slice for an LLM that hasn't been told which leaderboard to look at.
    inputSchema: z.object({
      kind: z
        .enum([
          "cheapest",
          "most_expensive",
          "most_volatile",
          "biggest_drop",
          "biggest_jump",
          "most_observed",
        ])
        .default("most_observed"),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    run: async ({ kind, category, limit }, client) => {
      const params = new URLSearchParams({ metric: kind, limit: String(limit) });
      if (category) params.set("category", category);
      const r = await client.request<LeaderboardResponse>(
        `/api/v1/leaderboard?${params}`,
      );
      return {
        kind,
        category: category ?? null,
        entries: (r.data?.entries ?? []).map((e) => ({
          slug: e.service?.slug,
          name: e.service?.name,
          vendor: e.service?.vendor,
          value: e.value,
          label: e.label,
          delta_pct: e.deltaPct ?? null,
        })),
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "recent_observations",
    title: "Recent observations for a service",
    description:
      "Return the most recent price observations for one service, oldest-newest by `observedAt`. Useful when an agent wants to spot intraday trends or audit the inputs to FMV.",
    inputSchema: z.object({
      slug: z.string().min(1),
      limit: z.number().int().min(1).max(500).default(50),
      since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601 timestamp; only return observations newer than this."),
    }),
    run: async ({ slug, limit, since }, client) => {
      const params = new URLSearchParams({ limit: String(limit) });
      const r = await client.request<ObservationRow[]>(
        `/api/v1/services/${encodeURIComponent(slug)}/observations?${params}`,
      );
      let items: ObservationRow[] = r.data ?? [];
      if (since) {
        const cutoff = Date.parse(since);
        if (Number.isFinite(cutoff)) {
          items = items.filter((o) => Date.parse(o.observedAt) >= cutoff);
        }
      }
      return {
        slug,
        items: items.map((o) => ({
          observed_at: o.observedAt,
          amount_usd: microsToUsd(Number(o.amountMicros)),
          unit: o.unitCode,
          currency: o.currency,
          source: o.source,
        })),
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "refuse_if_overpriced",
    title: "Decide whether to pay a quote",
    description:
      "Convenience wrapper agents call right before paying. Returns `should_pay: true` ONLY when ARI returned an explicit green/fair verdict against a usable FMV baseline. Every other outcome · amber, red, insufficient_data, missing FMV baseline, or any verdict label this client cannot interpret · returns `should_pay: false` (fail-closed). The companion `verdict` and `reason` fields explain why so the agent can decide whether to fall back to its own policy.",
    inputSchema: FairPriceQuoteInput,
    run: async ({ slug, amount_usd, unit }, client) => {
      const params = new URLSearchParams({
        service: slug,
        amount_micros: String(usdToMicros(amount_usd)),
      });
      if (unit) params.set("unit", unit);
      const r = await client.request<FairPriceResponse>(`/api/v1/fair-price?${params}`);
      const fp = r.data;
      const verdict = fp.verdict?.label ?? "unknown";
      const fmvUsd = fp.fmvMicros != null ? microsToUsd(Number(fp.fmvMicros)) : null;
      const highUsd = fp.highMicros != null ? microsToUsd(Number(fp.highMicros)) : null;
      const haveBaseline = fmvUsd != null && highUsd != null;
      // Task #437 round-3 · STRICT BOOLEAN fail-closed contract. The
      // previous "honest-null" variant returned should_pay:null for
      // missing-baseline / insufficient_data / unrecognised verdicts.
      // Reviewer feedback: an LLM that branches on `if (should_pay)`
      // would treat `null` as falsy on every path EXCEPT explicit
      // green/fair, but a small number of agents `=== true` instead,
      // and any agent that does `should_pay !== false` would AUTO-PAY
      // on a null. The only way to make this tool safe for every
      // calling pattern is to ALWAYS return a boolean, with the
      // baseline/insufficient/unrecognised cases mapped to `false`.
      // The `verdict` + `reason` fields still surface the underlying
      // condition so the caller can distinguish "ARI said red" from
      // "ARI couldn't decide" and fall back to a human/its own policy.
      if (!haveBaseline) {
        return {
          should_pay: false,
          verdict: "unknown",
          reason:
            "ARI has no fair-market baseline for this service yet (still indexing or insufficient observations). " +
            "Refusing to pay by default · this tool will not synthesise a $0 reference price. " +
            "Fall back to your own policy if you want to proceed.",
          fmv_usd: fmvUsd,
          high_usd: highUsd,
          savings_estimate_usd: null,
          receipt_id: r.receiptId ?? null,
          signed_at: r.signedAt ?? null,
        };
      }
      if (verdict === "insufficient_data") {
        return {
          should_pay: false,
          verdict,
          reason:
            "ARI has an FMV baseline but not enough independent observations to grade this quote with confidence " +
            "(insufficient evidence under the weighted engine). Refusing to pay by default · fall back to your own policy if you want to proceed.",
          fmv_usd: fmvUsd,
          high_usd: highUsd,
          savings_estimate_usd: null,
          receipt_id: r.receiptId ?? null,
          signed_at: r.signedAt ?? null,
        };
      }
      // Default-deny via the shared helper. Only an explicit "green"
      // (or "fair", for parity with the prepay endpoint's vocabulary)
      // produces decision==="pay". Amber/red → "refuse". Any label we
      // don't recognise → "abstain", which (per the strict-boolean
      // contract above) ALSO collapses to should_pay:false here.
      // Task #489 · confidence-aware default-deny. A "green" verdict on
      // a category-median / global-median fallback FMV (`confidence:
      // "low"`) only tells the agent that the quote is inside a wide
      // cross-vendor band · it does NOT mean the offer itself is fair.
      // Demote to abstain so we don't auto-settle on weak evidence.
      const confidence = (fp.confidence ?? null) as string | null;
      const decision = verdictDecisionWithConfidence({
        verdict,
        confidence,
      });
      if (decision === "abstain") {
        return {
          should_pay: false,
          verdict,
          reason:
            `ARI returned a verdict label ("${verdict}", confidence "${confidence ?? "missing"}") that this client cannot auto-settle on. ` +
            "Refusing to pay by default · fall back to your own policy if you want to proceed.",
          fmv_usd: fmvUsd,
          high_usd: highUsd,
          savings_estimate_usd: null,
          receipt_id: r.receiptId ?? null,
          signed_at: r.signedAt ?? null,
        };
      }
      const shouldPay = decision === "pay";
      const aboveHigh = amount_usd > highUsd;
      const savings = !shouldPay && aboveHigh ? Math.max(0, amount_usd - highUsd) : 0;
      let reason: string;
      if (shouldPay) {
        reason = `Quote is within ARI's fair-market range (FMV ≈ $${fmvUsd.toFixed(6)}/unit).`;
      } else if (aboveHigh) {
        reason =
          `Quote is more than ARI's high band ($${highUsd.toFixed(6)}/unit). ` +
          `Estimated savings if you walk: $${savings.toFixed(6)} per unit.`;
      } else {
        reason =
          `ARI graded this quote as "${verdict}" · materially above the fair-market midpoint ` +
          `(FMV ≈ $${fmvUsd.toFixed(6)}/unit, high band $${highUsd.toFixed(6)}/unit). ` +
          "refuse_if_overpriced refuses to auto-settle on a stretched-band quote.";
      }
      return {
        should_pay: shouldPay,
        verdict,
        reason,
        fmv_usd: fmvUsd,
        high_usd: highUsd,
        savings_estimate_usd: savings,
        receipt_id: r.receiptId ?? null,
        signed_at: r.signedAt ?? null,
      };
    },
  },
  {
    name: "prepay_verdict",
    title: "Universal pre-payment fairness check",
    description:
      "The Universal Fairness Skill entry point. Wraps any agent wallet (Coinbase Agentic Wallet, AgentCash, ATXP, 1Pay.ing, …) with a refuse-to-overpay safety check. Call BEFORE settling any HTTP 402 / x402 / MPP quote. Canonical inputs: `slug` (the indexed ARI service slug), `amount_usd` (the quoted price in US dollars), and `unit` (the unit code, e.g. tokens). Legacy aliases `url`, `amountMicros`, and `amount_micros` are accepted and mapped internally for backward compatibility. Returns `{ verdict: 'fair' | 'stretched' | 'overpriced' | 'unknown', reason, suggestedMax, evidenceUrl }`. Refuse to settle on `overpriced`; surface the warning and ask consent on `stretched`; settle on `fair`.",
    inputSchema: z
      .object({
        // Canonical spec inputs.
        slug: z.string().min(1).optional().describe("Canonical: the indexed ARI service slug."),
        amount_usd: z
          .number()
          .positive()
          .optional()
          .describe("Canonical: quoted amount in US dollars."),
        unit: z.string().optional().describe("Canonical: unit code (tokens, calls, seconds)."),
        // Legacy aliases (kept for backward compatibility, mapped internally).
        url: z
          .string()
          .min(1)
          .optional()
          .describe("Deprecated alias for `slug` · the full URL the agent is about to call, or a slug. Server resolves slug or hostname."),
        amountMicros: z.number().positive().optional(),
        amount_micros: z.number().positive().optional(),
        currency: z.string().min(1).default("USD"),
        chain: z.string().min(1).default("off-chain"),
        service: z.string().optional(),
      })
      .refine((v) => v.slug != null || v.url != null, {
        message: "slug (canonical) or url (deprecated alias) is required",
      })
      .refine(
        (v) => v.amount_usd != null || v.amountMicros != null || v.amount_micros != null,
        { message: "amount_usd (canonical) or amountMicros / amount_micros (deprecated aliases) is required" },
      ),
    run: async (input, client) => {
      const amountMicros =
        input.amountMicros ??
        input.amount_micros ??
        (input.amount_usd != null ? usdToMicros(input.amount_usd) : undefined)!;
      const target = input.url ?? input.slug!;
      // Delegate to the canonical server endpoint, which handles
      // URL → slug resolution, FMV lookup, latency budget headers,
      // and the opt-out metric counter.
      const r = await client.request<{
        verdict?: string;
        reason?: string;
        suggestedMax?: number | null;
        evidenceUrl?: string;
        fmvMicros?: number;
        lowMicros?: number;
        highMicros?: number;
        sampleSize?: number;
        currency?: string;
        chain?: string;
        service?: string;
        unit?: string;
        latencyMs?: number;
      }>(`/api/v1/mcp/prepay-verdict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: target,
          amountMicros,
          currency: input.currency,
          chain: input.chain,
          ...(input.service ? { service: input.service } : {}),
          ...(input.unit ? { unit: input.unit } : {}),
        }),
      });
      const data = r.data ?? {};
      const verdictStr = data.verdict ?? "unknown";
      // Apply the shared allow-list (Task #437 step 1) so an MCP client
      // can branch on a single normalised field without having to
      // re-implement the green/fair/amber/red mapping itself. The raw
      // `verdict` string is preserved untouched for UIs that key off it.
      const decision = verdictDecision(verdictStr);
      // Return both canonical camelCase {verdict, reason, suggestedMax,
      // evidenceUrl} and snake_case mirrors so MCP clients keying on
      // either convention work without a re-map step.
      return {
        verdict: verdictStr,
        decision, // "pay" | "refuse" | "abstain" · derived via shared helper
        reason: data.reason ?? null,
        suggestedMax: data.suggestedMax ?? null,
        suggested_max_micros: data.suggestedMax ?? null,
        evidenceUrl: data.evidenceUrl ?? null,
        evidence_url: data.evidenceUrl ?? null,
        fmvMicros: data.fmvMicros ?? null,
        fmv_micros: data.fmvMicros ?? null,
        lowMicros: data.lowMicros ?? null,
        low_micros: data.lowMicros ?? null,
        highMicros: data.highMicros ?? null,
        high_micros: data.highMicros ?? null,
        sampleSize: data.sampleSize ?? null,
        sample_size: data.sampleSize ?? null,
        amountMicros,
        currency: data.currency ?? input.currency,
        chain: data.chain ?? input.chain,
        service: data.service ?? null,
        unit: data.unit ?? null,
        latencyMs: data.latencyMs ?? null,
        latency_ms: data.latencyMs ?? null,
        receiptId: r.receiptId ?? null,
        receipt_id: r.receiptId ?? null,
        signedAt: r.signedAt ?? null,
        signed_at: r.signedAt ?? null,
      };
    },
  },
  {
    name: "verify_receipt",
    title: "Verify a previously-issued ARI receipt",
    description:
      "Re-fetch a receipt by its ULID and re-verify the Ed25519 signature. Use to audit a counterparty's claim, e.g. 'I refused this payment because ARI Receipt 01HZ… said it was overpriced'.",
    inputSchema: z.object({ receipt_id: z.string().min(1) }),
    run: async ({ receipt_id }, client) => {
      const r = await client.request<VerifyReceiptResponse>(
        `/api/v1/verify-receipt?id=${encodeURIComponent(receipt_id)}`,
      );
      return {
        receipt_id,
        valid: r.data?.valid ?? false,
        key_id: r.data?.keyId ?? null,
        signed_at: r.data?.signedAt ?? null,
        request_path: r.data?.requestPath ?? null,
        canonical_hash: r.data?.canonicalHash ?? null,
        verifier_receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "get_signed_receipt",
    title: "Re-fetch a previous signed receipt body",
    description:
      "Look up the canonical signed body for a previously-issued receipt id, so an agent can show the exact bytes it relied on when making a payment decision. Canonical input: `receipt_id`. The legacy alias `for_request_id` is still accepted for one release.",
    inputSchema: z
      .object({
        receipt_id: z.string().min(1).optional().describe("Canonical: the ARI receipt id (ULID)."),
        for_request_id: z
          .string()
          .min(1)
          .optional()
          .describe("Deprecated alias for `receipt_id`."),
      })
      .refine((v) => v.receipt_id != null || v.for_request_id != null, {
        message: "receipt_id (canonical) or for_request_id (deprecated alias) is required",
      }),
    run: async (input, client) => {
      const receiptId = input.receipt_id ?? input.for_request_id!;
      const r = await client.request<VerifyReceiptResponse>(
        `/api/v1/verify-receipt?id=${encodeURIComponent(receiptId)}`,
      );
      return {
        receipt_id: receiptId,
        signed_at: r.data?.signedAt ?? null,
        request_path: r.data?.requestPath ?? null,
        payload: r.data?.payload ?? null,
        signature: r.data?.signature ?? null,
        canonical_hash: r.data?.canonicalHash ?? null,
        key_id: r.data?.keyId ?? null,
        verifier_receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "subscribe_alert",
    title: "Subscribe to a price alert",
    description:
      "Set up a price alert. Canonical delivery field is `webhook_url`; the legacy `webhook` spelling is still accepted as an alias. Provide AT LEAST ONE of `webhook_url` or `email` (and not both). Conditions: `above`, `below`, or `volatility_pct` with a numeric threshold (USD or %). Proxies the existing /api/v1/alerts endpoint.",
    inputSchema: z
      .object({
        slug: z.string().min(1),
        condition: z.enum(["above", "below", "volatility_pct"]),
        threshold: z.number(),
        // `webhook_url` is the canonical field (matches the server
        // payload). `webhook` is kept as a deprecated alias so callers
        // using the older spelling succeed without a re-map.
        webhook_url: z.string().url().optional().describe("Canonical webhook URL for alert delivery."),
        webhook: z.string().url().optional().describe("Deprecated alias for `webhook_url`."),
        email: z.string().email().optional(),
      })
      // Task #437 · enforce the webhook XOR email constraint at the
      // *schema* level so the MCP client sees a structured validation
      // error (and the JSON schema published to LLMs documents the
      // constraint) instead of a bare thrown Error at run time.
      .refine(
        (v) => (v.webhook_url ?? v.webhook ?? null) !== null || v.email !== undefined,
        { message: "Provide either a webhook URL (webhook_url / webhook) or an email address." },
      )
      .refine(
        (v) => !((v.webhook_url ?? v.webhook) && v.email),
        { message: "Provide a webhook URL OR an email, not both." },
      ),
    run: async (input, client) => {
      const webhook = input.webhook_url ?? input.webhook;
      const r = await client.request<AlertResponse>(`/api/v1/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceSlug: input.slug,
          condition: input.condition,
          threshold: input.threshold,
          webhookUrl: webhook,
          email: input.email,
        }),
      });
      return {
        alert_id: r.data?.id ?? null,
        slug: input.slug,
        condition: input.condition,
        threshold: input.threshold,
        delivery: webhook ? "webhook" : "email",
        created_at: r.data?.createdAt ?? null,
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  // -------------------------------------------------------------------------
  // v0.2.0 tools.
  // Backed by /api/v1/* routes added in routes/mcpV2.ts (each gated by
  // `ARI_ROUTE_<NAME>` on the server, default on). The TS surface matches
  // tools.py 1:1 for cross-runtime parity.
  // -------------------------------------------------------------------------
  {
    name: "is_fair_price_batch",
    title: "Batch fair-price verdict",
    description:
      "Grade up to 50 quotes in one round-trip. Falls back to a category-inferred FMV (flagged category_inferred:true) when a service has no observations yet.",
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            slug: z.string().min(1),
            amount_usd: z.number().positive(),
            unit: z.string().optional(),
          }),
        )
        .min(1)
        .max(50),
    }),
    run: async ({ items }, client) => {
      const body = {
        items: items.map((it: { slug: string; amount_usd: number; unit?: string }) => ({
          slug: it.slug,
          amount_micros: usdToMicros(it.amount_usd),
          ...(it.unit ? { unit: it.unit } : {}),
        })),
      };
      const r = await client.request<{ items?: Array<Record<string, unknown>> }>(
        `/api/v1/fair-price/batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const out = (r.data?.items ?? []).map((row) => {
        const fmv = row["fmv_micros"];
        const low = row["low_micros"];
        const high = row["high_micros"];
        return {
          slug: row["slug"] ?? null,
          unit: row["unit"] ?? null,
          verdict: row["verdict"] ?? "unknown",
          reason: row["reason"] ?? null,
          delta_pct: row["delta_pct"] ?? null,
          fmv_usd: typeof fmv === "number" ? microsToUsd(fmv) : null,
          low_usd: typeof low === "number" ? microsToUsd(low) : null,
          high_usd: typeof high === "number" ? microsToUsd(high) : null,
          sample_size: row["sample_size"] ?? null,
          category_inferred: row["category_inferred"] ?? false,
        };
      });
      return { items: out, receipt_id: r.receiptId ?? null };
    },
  },
  {
    name: "prepay_verdict_batch",
    title: "Batch pre-payment fairness check",
    description:
      "Apply the Universal Fairness Skill to up to 50 candidate URLs at once. Returns a verdict (`fair` | `stretched` | `overpriced` | `unknown`) per row.",
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            url: z.string().min(1),
            amount_micros: z.number().positive(),
            service: z.string().optional(),
            unit: z.string().optional(),
            currency: z.string().default("USD"),
            chain: z.string().default("off-chain"),
          }),
        )
        .min(1)
        .max(50),
    }),
    run: async ({ items }, client) => {
      const r = await client.request<{ items?: Array<Record<string, unknown>> }>(
        `/api/v1/mcp/prepay-verdict/batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        },
      );
      return { items: r.data?.items ?? [], receipt_id: r.receiptId ?? null };
    },
  },
  {
    name: "detect_anomaly",
    title: "Detect a price anomaly for a service",
    description:
      "Flag the latest observation as anomalous when its robust z-score exceeds 3 over a rolling 14-day window. Returns z-score + baseline median + MAD.",
    inputSchema: z.object({
      slug: z.string().min(1),
      unit: z.string().optional(),
    }),
    run: async ({ slug, unit }, client) => {
      const qs = unit ? `?unit=${encodeURIComponent(unit)}` : "";
      const r = await client.request<Record<string, unknown>>(
        `/api/v1/services/${encodeURIComponent(slug)}/anomaly${qs}`,
      );
      return { ...(r.data ?? {}), receipt_id: r.receiptId ?? null };
    },
  },
  {
    name: "category_benchmark",
    title: "Category-level fair-price benchmark",
    description:
      "Return the unweighted median + p10/p90 band across the indexed services in one category.",
    inputSchema: z.object({
      category: z.string().min(1),
      unit: z.string().default("request"),
    }),
    run: async ({ category, unit }, client) => {
      const r = await client.request<{
        fmvMicros?: number;
        lowMicros?: number;
        highMicros?: number;
        sampleSize?: number;
        contributorCount?: number;
        inferred?: boolean;
      }>(
        `/api/v1/categories/${encodeURIComponent(category)}/benchmark?unit=${encodeURIComponent(unit)}`,
      );
      const d = r.data ?? {};
      return {
        category,
        unit,
        fmv_usd: d.fmvMicros != null ? microsToUsd(Number(d.fmvMicros)) : null,
        low_usd: d.lowMicros != null ? microsToUsd(Number(d.lowMicros)) : null,
        high_usd: d.highMicros != null ? microsToUsd(Number(d.highMicros)) : null,
        sample_size: d.sampleSize ?? null,
        contributor_count: d.contributorCount ?? null,
        inferred: d.inferred ?? false,
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "find_substitutes",
    title: "Find cheaper substitutes for a service",
    description:
      "List the cheapest indexed peers in the same category, ranked by FMV ascending.",
    inputSchema: z.object({
      slug: z.string().min(1),
      unit: z.string().optional(),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    run: async ({ slug, unit, limit }, client) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (unit) params.set("unit", unit);
      const r = await client.request<{
        slug?: string;
        category?: string;
        unit?: string;
        substitutes?: Array<{
          slug: string;
          name: string;
          fmv_micros: number;
          sample_size: number;
        }>;
      }>(`/api/v1/services/${encodeURIComponent(slug)}/substitutes?${params}`);
      return {
        slug: r.data?.slug ?? slug,
        category: r.data?.category ?? null,
        unit: r.data?.unit ?? unit ?? null,
        substitutes: (r.data?.substitutes ?? []).map((p) => ({
          slug: p.slug,
          name: p.name,
          fmv_usd: microsToUsd(Number(p.fmv_micros)),
          sample_size: p.sample_size,
        })),
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "historical_fmv",
    title: "Per-day FMV history for a service",
    description:
      "Return the per-UTC-day median + sample count for one service over the last N days (default 30, max 180).",
    inputSchema: z.object({
      slug: z.string().min(1),
      unit: z.string().optional(),
      days: z.number().int().min(1).max(180).default(30),
    }),
    run: async ({ slug, unit, days }, client) => {
      const params = new URLSearchParams({ days: String(days) });
      if (unit) params.set("unit", unit);
      const r = await client.request<{
        slug?: string;
        unit?: string;
        window_days?: number;
        series?: Array<{ day: string; fmv_micros: number; sample_size: number }>;
      }>(`/api/v1/services/${encodeURIComponent(slug)}/historical?${params}`);
      return {
        slug: r.data?.slug ?? slug,
        unit: r.data?.unit ?? unit ?? null,
        window_days: r.data?.window_days ?? days,
        series: (r.data?.series ?? []).map((p) => ({
          day: p.day,
          fmv_usd: microsToUsd(Number(p.fmv_micros)),
          sample_size: p.sample_size,
        })),
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "smart_route",
    title: "Route to the cheapest peer in a category",
    description:
      "One-call helper that returns the cheapest indexed service in a category plus a short list of alternates.",
    inputSchema: z.object({
      category: z.string().min(1),
      unit: z.string().default("request"),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    run: async ({ category, unit, limit }, client) => {
      const params = new URLSearchParams({ unit, limit: String(limit) });
      const r = await client.request<{
        category?: string;
        unit?: string;
        cheapest?: { slug: string; name: string; fmv_micros: number; sample_size: number };
        candidates?: Array<{ slug: string; name: string; fmv_micros: number; sample_size: number }>;
      }>(`/api/v1/categories/${encodeURIComponent(category)}/smart-route?${params}`);
      const d = r.data ?? {};
      const norm = (p: { slug: string; name: string; fmv_micros: number; sample_size: number }) => ({
        slug: p.slug,
        name: p.name,
        fmv_usd: microsToUsd(Number(p.fmv_micros)),
        sample_size: p.sample_size,
      });
      return {
        category: d.category ?? category,
        unit: d.unit ?? unit,
        cheapest: d.cheapest ? norm(d.cheapest) : null,
        candidates: (d.candidates ?? []).map(norm),
        receipt_id: r.receiptId ?? null,
      };
    },
  },
  {
    name: "mcp_health_ping",
    title: "Heartbeat from a running MCP session",
    description:
      "Best-effort heartbeat that bumps last_seen_at on the install row. Never blocks the agent and never collects identifying data.",
    inputSchema: z.object({ install_id: z.string().min(1).max(64) }),
    run: async ({ install_id }, client) => {
      try {
        const r = await client.request<{ ok?: boolean; ts?: string }>(
          `/api/v1/mcp/health-ping`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ install_id }),
          },
        );
        return {
          ok: r.data?.ok ?? true,
          ts: r.data?.ts ?? new Date().toISOString(),
        };
      } catch {
        return { ok: false, ts: new Date().toISOString() };
      }
    },
  },
  {
    name: "why",
    title: "Explain a previously-issued receipt",
    description:
      "Re-fetch a receipt by id and render the human-readable evidence trail the FMV engine relied on.",
    inputSchema: z.object({ receipt_id: z.string().min(1) }),
    run: async ({ receipt_id }, client) => {
      const r = await client.request<Record<string, unknown>>(
        `/api/v1/why/${encodeURIComponent(receipt_id)}`,
      );
      return { receipt_id, ...(r.data ?? {}) };
    },
  },
];
