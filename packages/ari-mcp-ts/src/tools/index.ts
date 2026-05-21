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
    .optional()
    .describe("Unit code (e.g. tokens, calls, seconds). Defaults to the service's primary unit."),
});

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function microsToUsd(micros: number): number {
  return micros / 1_000_000;
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
  verdict?: { label?: string; deltaPct?: number | null };
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
      "Return the top services for one of the canonical leaderboards: cheapest, most_expensive, most_volatile, biggest_drop, biggest_jump, most_observed.",
    inputSchema: z.object({
      kind: z.enum([
        "cheapest",
        "most_expensive",
        "most_volatile",
        "biggest_drop",
        "biggest_jump",
        "most_observed",
      ]),
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
      "Convenience wrapper agents call right before paying. Returns `should_pay: false` (with a reason and savings estimate) when the quoted amount is materially above ARI's high band; `should_pay: true` otherwise.",
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
      // Honest-null: if the oracle has not computed an FMV yet we MUST
      // NOT synthesise a $0 fair-market baseline · doing so would tell
      // an agent that any quote above $0 is overpriced (or that the
      // service is "free"). Instead, refuse to decide and surface the
      // unknown state so the calling agent can fall back to its own
      // policy (ask the user, pay anyway, walk away · its choice).
      const fmvUsd = fp.fmvMicros != null ? microsToUsd(Number(fp.fmvMicros)) : null;
      const highUsd = fp.highMicros != null ? microsToUsd(Number(fp.highMicros)) : null;
      const haveBaseline = fmvUsd != null && highUsd != null;
      if (!haveBaseline) {
        return {
          should_pay: null,
          verdict: "unknown",
          reason:
            "ARI has no fair-market baseline for this service yet (still indexing or insufficient observations). " +
            "Decide based on your own policy · this tool will not synthesise a $0 reference price.",
          fmv_usd: fmvUsd,
          high_usd: highUsd,
          savings_estimate_usd: null,
          receipt_id: r.receiptId ?? null,
          signed_at: r.signedAt ?? null,
        };
      }
      const shouldPay = verdict !== "red";
      const savings =
        verdict === "red" && highUsd > 0
          ? Math.max(0, amount_usd - highUsd)
          : 0;
      return {
        should_pay: shouldPay,
        verdict,
        reason: shouldPay
          ? `Quote is within ARI's fair-market range (FMV ≈ $${fmvUsd.toFixed(6)}/unit).`
          : `Quote is more than ARI's high band ($${highUsd.toFixed(6)}/unit). ` +
            `Estimated savings if you walk: $${savings.toFixed(6)} per unit.`,
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
      "The Universal Fairness Skill entry point. Wraps any agent wallet (Coinbase Agentic Wallet, AgentCash, ATXP, 1Pay.ing, …) with a refuse-to-overpay safety check. Call BEFORE settling any HTTP 402 / x402 / MPP quote. Pass the target URL (or service slug), the quoted amount in micros, the currency (default USD), and the chain (default off-chain). Returns `{ verdict: 'fair' | 'stretched' | 'overpriced' | 'unknown', reason, suggestedMax, evidenceUrl }`. Refuse to settle on `overpriced`; surface the warning and ask consent on `stretched`; settle on `fair`.",
    inputSchema: z
      .object({
        url: z
          .string()
          .min(1)
          .describe(
            "The full URL the agent is about to POST/GET against, OR the indexed ARI service slug. The server resolves slug or hostname.",
          ),
        // Accept both camelCase (canonical) and snake_case (legacy MCP).
        amountMicros: z.number().positive().optional(),
        amount_micros: z.number().positive().optional(),
        currency: z.string().min(1).default("USD"),
        chain: z.string().min(1).default("off-chain"),
        service: z.string().optional(),
        unit: z.string().optional(),
      })
      .refine((v) => v.amountMicros != null || v.amount_micros != null, {
        message: "amountMicros (or amount_micros) is required",
      }),
    run: async (input, client) => {
      const amountMicros = input.amountMicros ?? input.amount_micros!;
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
          url: input.url,
          amountMicros,
          currency: input.currency,
          chain: input.chain,
          ...(input.service ? { service: input.service } : {}),
          ...(input.unit ? { unit: input.unit } : {}),
        }),
      });
      const data = r.data ?? {};
      // Return both canonical camelCase {verdict, reason, suggestedMax,
      // evidenceUrl} and snake_case mirrors so MCP clients keying on
      // either convention work without a re-map step.
      return {
        verdict: data.verdict ?? "unknown",
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
      "Look up the canonical signed body for a previously-issued receipt id, so an agent can show the exact bytes it relied on when making a payment decision.",
    inputSchema: z.object({ for_request_id: z.string().min(1) }),
    run: async ({ for_request_id }, client) => {
      const r = await client.request<VerifyReceiptResponse>(
        `/api/v1/verify-receipt?id=${encodeURIComponent(for_request_id)}`,
      );
      return {
        receipt_id: for_request_id,
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
      "Set up a price alert. Pass a webhook URL OR an email. Conditions: `above`, `below`, or `volatility_pct` with a numeric threshold (USD or %). Proxies the existing /api/v1/alerts endpoint.",
    inputSchema: z.object({
      slug: z.string().min(1),
      condition: z.enum(["above", "below", "volatility_pct"]),
      threshold: z.number(),
      webhook: z.string().url().optional(),
      email: z.string().email().optional(),
    }),
    run: async (input, client) => {
      if (!input.webhook && !input.email) {
        throw new Error("Provide either a webhook URL or an email address.");
      }
      const r = await client.request<AlertResponse>(`/api/v1/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceSlug: input.slug,
          condition: input.condition,
          threshold: input.threshold,
          webhookUrl: input.webhook,
          email: input.email,
        }),
      });
      return {
        alert_id: r.data?.id ?? null,
        slug: input.slug,
        condition: input.condition,
        threshold: input.threshold,
        delivery: input.webhook ? "webhook" : "email",
        created_at: r.data?.createdAt ?? null,
        receipt_id: r.receiptId ?? null,
      };
    },
  },
];
