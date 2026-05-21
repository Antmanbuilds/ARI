# ari-mcp · Node

[![npm version](https://img.shields.io/npm/v/ari-mcp.svg)](https://www.npmjs.com/package/ari-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

MCP server for [Agentic Rate Indicators](https://agentrateindicators.com). Gives any MCP-aware agent (Claude Desktop, Cursor, Continue, Windsurf, Zed, ChatGPT desktop, Gemini CLI) live fair-market-value lookups, leaderboards, observation history, and signed-receipt verification for x402 + MPP services.

```bash
npx -y ari-mcp install   # print copy-paste config blocks for popular hosts
```

## Why

LLM agents that pay for things need a pricing oracle they can cite, not a number a seller asserts. ARI indexes services that charge over x402 (Coinbase HTTP 402) and MPP (Stripe + Tempo Machine Payments Protocol), tracks observed prices, computes a Fair Market Value with a low/high band, and returns a green/amber/red verdict before any agent pays. Every JSON response is signed with an Ed25519 key and stamped with a citable receipt id, so an agent can refuse to overpay and a human auditor can re-verify any decision weeks later.

Wire this server into your MCP host once and your agent can:

- Refuse to overpay · call `refuse_if_overpriced` right before honoring a 402 quote
- Look up FMV · `get_fmv("openai-gpt-4o-mpp")` returns median, band, and sample size
- Browse the market · `list_services({ protocol: "x402" })`
- Cite a receipt · every tool call returns a `receipt_id` you can re-verify weeks later with `verify_receipt`

## Install in 30 seconds

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%/Claude/claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "ari": {
      "command": "npx",
      "args": ["-y", "ari-mcp"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "ari": {
      "command": "npx",
      "args": ["-y", "ari-mcp"]
    }
  }
}
```

### Continue, Windsurf, Zed, ChatGPT desktop, Gemini CLI

Run `npx -y ari-mcp install` to print the right config block for each host. Add `--client cursor` (or any other slug) to print only one.

## The eleven tools

| Tool | What it does |
| --- | --- |
| `is_fair_price` | Green/amber/red verdict for a quoted price |
| `refuse_if_overpriced` | Convenience wrapper to call right before paying |
| `prepay_verdict` | Full pre-pay decision · FMV band, deviation, receipt id |
| `get_fmv` | Median plus low/high band plus sample size for a service |
| `get_service` | Full detail row · sources, related services, last observation |
| `list_services` | Browse or filter the index by protocol or category |
| `get_leaderboard` | Cheapest, most expensive, biggest movers |
| `recent_observations` | Raw observed price history for a service |
| `verify_receipt` | Re-verify a previously issued receipt id |
| `get_signed_receipt` | Re-fetch the signed body for a receipt |
| `subscribe_alert` | Set up a webhook or email price alert |

## Why signed receipts

An agent that pays for things needs to trust two parties at once · the seller quoting a price, and any oracle telling it whether that price is fair. ARI signs every response with an Ed25519 key whose public half ships embedded in this client at build time. There is no first-call trust window · the very first request a fresh install makes is verified against the pinned key id `ari-aedbd75d43c8`, and any mismatch fails closed with a clear error. If the publisher rotates keys, the new id is added to an accepted-id list one release before the old one is removed, so stale installs keep verifying correctly until they upgrade.

Pass `--insecure-skip-pin` to accept any key id the server returns (use this only during a rotation when a release with the new id has not shipped yet). Pass `--insecure-skip-verify` to skip Ed25519 verification entirely (test setups only · agents must never run this in production).

## Self-hosting

```bash
npx -y ari-mcp --api-base-url https://ari.example.corp
```

When the base URL is overridden, the client falls back to fetching the publisher key from `<base>/.well-known/ari-pubkey.pem` on first call · a single trust-on-first-use step that the operator opted in to by choosing the mirror.

## CLI reference

```
ari-mcp [serve]            Start the MCP stdio server (default)
ari-mcp install            Print install snippets for popular MCP hosts
ari-mcp ping               Send a one-shot opt-in install ping
ari-mcp --version          Print the server version

OPTIONS
  --api-base-url URL       Override the ARI API base URL
  --api-key KEY            Bearer token for paid tiers (optional)
  --transport stdio|http   Transport for `serve`. Default: stdio
  --port N                 HTTP port (with --transport http). Default: 8765
  --host HOST              HTTP bind host. Default: 127.0.0.1
  --insecure-skip-verify   Skip Ed25519 receipt verification
  --insecure-skip-pin      Skip the build-time key-id pin (allow rotation)
  --client NAME            For `install`, print only one host's snippet
```

## Documentation

- Hosted docs · [agentrateindicators.com/docs/mcp](https://agentrateindicators.com/docs/mcp)
- Receipt format · [github.com/Antmanbuilds/ARI/blob/main/spec/signed-receipts.md](https://github.com/Antmanbuilds/ARI/blob/main/spec/signed-receipts.md)
- OpenAPI · [github.com/Antmanbuilds/ARI/blob/main/spec/openapi.yaml](https://github.com/Antmanbuilds/ARI/blob/main/spec/openapi.yaml)

## License

Apache-2.0 · the live ARI API server is BUSL-1.1, this client library is intentionally permissive so it can ship inside any agent runtime. Contact · `hello@agenticrates.org`.
