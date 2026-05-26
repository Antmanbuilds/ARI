// SPDX-License-Identifier: Apache-2.0
//
// Thin HTTP client for the ARI API. Every call:
//   1. Hits the user-configured base URL (default https://agentrateindicators.com).
//   2. Reads the wire body verbatim (canonical bytes).
//   3. Verifies the Ed25519 signature against the **build-time embedded**
//      publisher key when running against the default base URL · there is
//      no TOFU window. When the user has explicitly overridden the base
//      URL with `--api-base-url`, we fall back to fetching the key from
//      the override's `/.well-known/ari-pubkey.pem` (which is itself a
//      single TOFU step the operator opted in to).
//   4. Returns parsed JSON + the receipt headers so tools can surface
//      `receipt_id` to agents.
//
// Task #440 · the verification call boundary is now value-returning:
// `verifyReceipt` always returns `{ verified, errors, ... }` and never
// throws. The throw-on-failure ergonomics callers rely on are driven
// from `result.verified === false` here, NOT from exceptions inside
// the verifier. This makes the wrapper's behaviour easy to mutation-
// test and prevents a missed try/catch from turning a verification
// failure into an uncaught crash.

import {
  verifyReceipt,
  fetchPublicKey,
  deriveKeyIdFromPem,
} from "./verify.js";
import {
  ACCEPTED_KEY_IDS,
  EMBEDDED_PUBLIC_KEY_PEM,
  PINNED_BASE_URL,
} from "./embeddedKey.js";
import { USER_AGENT } from "./version.js";

export const DEFAULT_API_BASE_URL =
  process.env["ARI_API_BASE_URL"] ?? PINNED_BASE_URL;

export interface AriClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /**
   * Override the publisher key entirely. Useful for self-hosted ARI
   * mirrors or test rigs. When set, this PEM is used regardless of base
   * URL · neither the embedded pin nor `/.well-known` fetch fires.
   */
  publicKeyPem?: string;
  /**
   * Skip Ed25519 receipt verification entirely. Off by default. ONLY
   * for test setups; agents must never run this in production.
   */
  insecureSkipVerify?: boolean;
  /**
   * Skip the build-time key-id pin check (`ACCEPTED_KEY_IDS`). When
   * set, the client will accept any key id the server returns as long
   * as the signature itself verifies under the embedded PEM. Useful
   * during a key rotation when a release with the new id has not
   * shipped yet.
   */
  insecureSkipPin?: boolean;
  fetchImpl?: typeof fetch;
}

export interface AriResponse<T> {
  data: T;
  receiptId?: string | undefined;
  signedAt?: string | undefined;
  keyId?: string | undefined;
  canonicalHash?: string | undefined;
}

export class AriReceiptError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
    public readonly url: string,
  ) {
    super(message);
    this.name = "AriReceiptError";
  }
}

export class AriHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "AriHttpError";
  }
}

export class AriClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly insecureSkipVerify: boolean;
  readonly insecureSkipPin: boolean;
  readonly usingEmbeddedKey: boolean;
  private readonly fetchImpl: typeof fetch;
  private cachedPublicKey?: string;
  /**
   * Pinned key id for the cached PEM. For the default base URL this is
   * the build-time embedded id; for overridden hosts it's derived from
   * the PEM the operator supplied (or TOFU-fetched). Task #440 step 4
   * uses this to fail closed when an overridden host's `Ari-Key-Id`
   * stops matching its own PEM mid-session.
   */
  private cachedKeyId?: string;

  constructor(opts: AriClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    if (opts.apiKey) this.apiKey = opts.apiKey;
    this.insecureSkipVerify = opts.insecureSkipVerify ?? false;
    this.insecureSkipPin = opts.insecureSkipPin ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;

    if (opts.publicKeyPem) {
      // Operator-supplied override always wins.
      this.cachedPublicKey = opts.publicKeyPem;
      this.usingEmbeddedKey = false;
    } else if (this.baseUrl === PINNED_BASE_URL.replace(/\/+$/, "")) {
      // Default base URL → use the embedded build-time pin. No TOFU.
      this.cachedPublicKey = EMBEDDED_PUBLIC_KEY_PEM;
      this.usingEmbeddedKey = true;
    } else {
      // User explicitly overrode the base URL → fall back to a single
      // /.well-known fetch from THAT host (TOFU within the override).
      this.usingEmbeddedKey = false;
    }
  }

  private async getPublicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;
    this.cachedPublicKey = await fetchPublicKey(this.baseUrl, this.fetchImpl);
    return this.cachedPublicKey;
  }

  /**
   * Resolve the pinned key id for the cached PEM. Memoized so we don't
   * re-hash the SPKI DER on every request.
   */
  private async getPinnedKeyId(): Promise<string> {
    if (this.cachedKeyId) return this.cachedKeyId;
    const pem = await this.getPublicKey();
    this.cachedKeyId = await deriveKeyIdFromPem(pem);
    return this.cachedKeyId;
  }

  async request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<AriResponse<T>> {
    const url = this.baseUrl + (path.startsWith("/") ? path : "/" + path);
    const headers = new Headers(init.headers ?? {});
    headers.set("Accept", "application/json");
    headers.set("User-Agent", USER_AGENT);
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);

    const res = await this.fetchImpl(url, { ...init, headers });
    const body = await res.text();

    if (!res.ok) {
      throw new AriHttpError(
        `ARI ${res.status} ${res.statusText} for ${path}`,
        res.status,
        url,
        body,
      );
    }

    const signature = res.headers.get("ari-signature");
    const keyId = res.headers.get("ari-key-id") ?? undefined;
    const receiptId = res.headers.get("ari-receipt-id") ?? undefined;
    const signedAt = res.headers.get("ari-signed-at") ?? undefined;
    const canonicalHash = res.headers.get("ari-canonical-hash") ?? undefined;
    const scheduleProof = res.headers.get("ari-schedule-proof") ?? undefined;
    const receiptSpec = res.headers.get("ari-receipt-spec") ?? undefined;
    // Task #535 · v3 signed-preamble headers; required for fair-price
    // (and any future v3-only route) to verify end-to-end.
    const confidence = res.headers.get("ari-confidence") ?? undefined;
    const fmvSource = res.headers.get("ari-fmv-source") ?? undefined;

    if (!this.insecureSkipVerify) {
      // **Build-time / PEM-derived pin check.** Drive AriReceiptError
      // throws off `result.verified === false` (task #440 step 5);
      // we still pre-check the pin here so a wrong key id short-
      // circuits before we even hand bytes to the crypto layer with
      // a clearer error message than "signature does not verify".
      //
      // Coverage:
      //   - Embedded key (default base URL) → must be in ACCEPTED_KEY_IDS.
      //   - Overridden host (operator PEM or TOFU fetch) → must match
      //     the PEM's own fingerprint. Without this, an overridden
      //     host could rotate `Ari-Key-Id` mid-session and we'd never
      //     notice as long as the signature still verified under the
      //     cached PEM (the original audit gap).
      if (!this.insecureSkipPin) {
        const pinnedId = this.usingEmbeddedKey
          ? null // checked against ACCEPTED_KEY_IDS below
          : await this.getPinnedKeyId();
        if (this.usingEmbeddedKey) {
          if (keyId && !ACCEPTED_KEY_IDS.includes(keyId)) {
            throw new AriReceiptError(
              `Refusing receipt: key id ${keyId} is not in this build's accepted-id list ` +
                `[${ACCEPTED_KEY_IDS.join(", ")}]. The publisher may have rotated keys; ` +
                `upgrade ari-mcp to pick up the new pin, or pass --insecure-skip-pin to override.`,
              [`pinned key id mismatch`],
              url,
            );
          }
        } else if (pinnedId && keyId && keyId !== pinnedId) {
          throw new AriReceiptError(
            `Refusing receipt: Ari-Key-Id ${keyId} does not match the pinned PEM fingerprint ${pinnedId} ` +
              `for ${this.baseUrl}. The host may have rotated keys mid-session; restart the client ` +
              `to re-pin, or pass --insecure-skip-pin to override.`,
            [`pinned key id mismatch`],
            url,
          );
        }
      }

      const pem = await this.getPublicKey();
      const result = await verifyReceipt(
        body,
        {
          signature: signature ?? "",
          keyId,
          signedAt,
          receiptId,
          canonicalHash,
          license: res.headers.get("license") ?? undefined,
          contentType: res.headers.get("content-type") ?? undefined,
          // Task #437 · forward the optional sixth signed header so
          // receipts that carry it verify against the same bytes the
          // server signed over.
          scheduleProof,
          receiptSpec,
          confidence,
          fmvSource,
        },
        pem,
      );
      // Drive the throw off the structured result (task #440). Strict
      // `=== false` check so an accidentally-truthy `verified` (e.g.
      // a future field renaming) doesn't quietly let bad receipts
      // through.
      if (result.verified === false) {
        throw new AriReceiptError(
          `Receipt verification failed for ${path}: ${result.errors.join("; ")}`,
          result.errors,
          url,
        );
      }
    }

    let data: T;
    try {
      data = JSON.parse(body) as T;
    } catch (e: unknown) {
      throw new AriHttpError(
        "ARI returned non-JSON body: " +
          (e instanceof Error ? e.message : String(e)),
        res.status,
        url,
        body,
      );
    }

    return { data, receiptId, signedAt, keyId, canonicalHash };
  }
}
