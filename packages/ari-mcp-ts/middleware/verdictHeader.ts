// SPDX-License-Identifier: Apache-2.0
/**
 * ARI-Verdict-Id Express middleware (task #308 · phase 3 item 5).
 *
 * x402 vendors can drop this middleware into their service to advertise
 * that a recently-priced quote was verdict-checked by ARI · downstream
 * agents see an `ARI-Verdict-Id: <receipt_id>` header on the response and
 * can fetch `/api/v1/verify-receipt?id=<receipt_id>` to confirm the
 * verdict was within the fair-market band.
 *
 * Header spec (one-pager, see https://agentrateindicators.com/spec/ari-verdict-id-header):
 *
 *   ARI-Verdict-Id: <receipt_id>; ts=<unix_ms>; verdict=<green|amber|red>
 *
 *   - `receipt_id` MUST be the ULID returned by `/api/v1/fair-price`.
 *   - `ts` is the wall-clock ms when ARI signed the receipt.
 *   - `verdict` mirrors the receipt's label so a downstream agent can
 *     gate on it before fetching the receipt body.
 *
 * The middleware attaches the header just before headers are committed
 * to the wire by wrapping `res.writeHead`. Setting the header after
 * Node has flushed headers would silently fail with ERR_HTTP_HEADERS_SENT
 * (this was the original v0 bug · see task #308 review). The wrap is
 * idempotent and falls back to direct `setHeader` if `writeHead` is
 * unavailable (e.g. exotic mocks in tests).
 *
 * Usage:
 *
 *   import express from "express";
 *   import { verdictHeader, setVerdict } from "ari-mcp/middleware/verdictHeader";
 *
 *   const app = express();
 *   app.use(verdictHeader({ cacheTtlS: 60 }));
 *
 *   app.post("/buy", async (req, res) => {
 *     const verdict = await ari.fairPrice({
 *       service: "example.x402",
 *       amount_micros: 100_000,
 *     });
 *     setVerdict(req, {
 *       receiptId: verdict.receipt_id,
 *       slug: "example.x402",
 *       amountMicros: 100_000,
 *       unit: "request",
 *       verdict: verdict.verdict.label,
 *       signedAtMs: Date.now(),
 *     });
 *     res.json({ ok: true });
 *   });
 */

// Loose Express-ish types so we don't force the SDK to depend on Express.
type ReqLike = {
  [k: string]: unknown;
};
type ResLike = {
  setHeader?: (name: string, value: string) => void;
  getHeader?: (name: string) => unknown;
  headersSent?: boolean;
  writeHead?: (...args: unknown[]) => unknown;
};
type NextLike = () => void;

export interface VerdictMeta {
  receiptId: string;
  slug: string;
  amountMicros: number;
  unit: string;
  verdict: "green" | "amber" | "red" | "insufficient_data";
  signedAtMs: number;
}

export interface VerdictHeaderOptions {
  /** Time-to-live (seconds) for a cached verdict before we stop emitting the header. Default 60. */
  cacheTtlS?: number;
  /** Override the HTTP header name. Default `ARI-Verdict-Id`. */
  headerName?: string;
  /** Optional clock injection · used by tests. */
  now?: () => number;
}

const VERDICT_KEY = Symbol("ari.verdict");
const WRAPPED_KEY = Symbol("ari.verdict.wrapped");

/**
 * Attach a verdict to the current request so the middleware emits the
 * header on this response. Safe to call multiple times · the most recent
 * call wins.
 */
export function setVerdict(req: ReqLike, meta: VerdictMeta): void {
  (req as Record<symbol, unknown>)[VERDICT_KEY] = meta;
}

function formatHeaderValue(meta: VerdictMeta): string {
  return `${meta.receiptId}; ts=${meta.signedAtMs}; verdict=${meta.verdict}`;
}

/** Express middleware factory. */
export function verdictHeader(opts: VerdictHeaderOptions = {}) {
  const ttlMs = Math.max(1, opts.cacheTtlS ?? 60) * 1000;
  const headerName = opts.headerName ?? "ARI-Verdict-Id";
  const now = opts.now ?? (() => Date.now());

  return function ariVerdictHeader(req: ReqLike, res: ResLike, next: NextLike): void {
    const readVerdict = (): VerdictMeta | undefined =>
      (req as Record<symbol, unknown>)[VERDICT_KEY] as VerdictMeta | undefined;

    const tryStamp = (): void => {
      const meta = readVerdict();
      if (!meta) return;
      if (res.headersSent) return;
      const age = now() - meta.signedAtMs;
      if (age < 0 || age > ttlMs) return;
      try {
        res.setHeader?.(headerName, formatHeaderValue(meta));
      } catch {
        // Best-effort · never break the vendor's response.
      }
    };

    // Wrap writeHead so the header is set on the *same tick* that Node
    // commits headers to the wire. Idempotent · re-entrant calls are
    // a no-op. Falls back to a setHeader call now if writeHead is not
    // a function (e.g. test doubles).
    const resAny = res as ResLike & Record<symbol, unknown>;
    const original = res.writeHead;
    if (typeof original === "function" && !resAny[WRAPPED_KEY]) {
      resAny[WRAPPED_KEY] = true;
      res.writeHead = function patchedWriteHead(this: ResLike, ...args: unknown[]) {
        tryStamp();
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as ResLike["writeHead"];
    } else if (typeof original !== "function") {
      // No writeHead hook available · fall back to stamping at next()
      // time. Handlers that call setVerdict synchronously before any
      // `res.write` / `res.end` still emit the header.
      queueMicrotask(tryStamp);
    }
    next();
  };
}

export const ARI_VERDICT_HEADER_SPEC_URL =
  "https://agentrateindicators.com/spec/ari-verdict-id-header";
