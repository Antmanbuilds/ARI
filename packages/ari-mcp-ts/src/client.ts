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

import { verifyReceipt, fetchPublicKey } from "./verify.js";
import {
  ACCEPTED_KEY_IDS,
  EMBEDDED_PUBLIC_KEY_PEM,
  PINNED_BASE_URL,
} from "./embeddedKey.js";

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

  async request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<AriResponse<T>> {
    const url = this.baseUrl + (path.startsWith("/") ? path : "/" + path);
    const headers = new Headers(init.headers ?? {});
    headers.set("Accept", "application/json");
    headers.set("User-Agent", "ari-mcp/0.1.2");
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

    if (!this.insecureSkipVerify) {
      if (!signature) {
        throw new AriReceiptError(
          "Response missing Ari-Signature header · refusing to trust unsigned ARI data.",
          ["missing Ari-Signature"],
          url,
        );
      }
      // **Build-time pin check.** When we're using the embedded PEM
      // (default base URL), the server's `Ari-Key-Id` MUST be in the
      // accepted-id list shipped with this package version. This is the
      // line that prevents a MITM attacker from injecting their own key.
      if (this.usingEmbeddedKey && !this.insecureSkipPin) {
        if (!keyId) {
          throw new AriReceiptError(
            "Response missing Ari-Key-Id header · required for pinned verification.",
            ["missing Ari-Key-Id"],
            url,
          );
        }
        if (!ACCEPTED_KEY_IDS.includes(keyId)) {
          throw new AriReceiptError(
            `Refusing receipt: key id ${keyId} is not in this build's accepted-id list ` +
              `[${ACCEPTED_KEY_IDS.join(", ")}]. The publisher may have rotated keys; ` +
              `upgrade ari-mcp to pick up the new pin, or pass --insecure-skip-pin to override.`,
            [`pinned key id mismatch`],
            url,
          );
        }
      }

      const pem = await this.getPublicKey();
      const result = await verifyReceipt(
        body,
        {
          signature,
          keyId,
          signedAt,
          receiptId,
          canonicalHash,
          license: res.headers.get("license") ?? undefined,
          contentType: res.headers.get("content-type") ?? undefined,
        },
        pem,
      );
      if (!result.valid) {
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
