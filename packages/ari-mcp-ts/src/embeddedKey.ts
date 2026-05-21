// SPDX-License-Identifier: Apache-2.0
//
// **Build-time pinned publisher key.**
//
// The publish-time release script (`scripts/refresh-embedded-key.ts`)
// regenerates this file from the live `https://agentrateindicators.com/.well-known/ari-pubkey.json`
// before each `npm publish`. We embed the PEM verbatim so a fresh
// `npx -y ari-mcp` install can verify receipts on the very first call,
// with no TOFU window · an attacker who MITMs the user's first request
// cannot inject their own public key, because we never fetch one when
// running against the default base URL.
//
// Rotation strategy: the publisher rotates keys by adding the new
// `keyId` to `ACCEPTED_KEY_IDS` while keeping the old PEM as
// `EMBEDDED_PUBLIC_KEY_PEM` for one release cycle, then dropping the old
// id in the next minor version. Users on stale package versions still
// verify correctly until they upgrade.
//
// When the user passes `--api-base-url` to point at a self-hosted ARI
// (or staging), we fall back to fetching the key from `<base>/.well-known`
// (TOFU within the explicitly-overridden host). That fallback is OFF by
// default for the production host.

export const EMBEDDED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkvPU1HujL+OSz3DyLaVpWh0ae0qffvEDK0wZ+iChdr0=
-----END PUBLIC KEY-----
`;

export const EMBEDDED_KEY_ID = "ari-aedbd75d43c8";

export const ACCEPTED_KEY_IDS: readonly string[] = [EMBEDDED_KEY_ID];

export const PINNED_BASE_URL = "https://agentrateindicators.com";
