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

## The 20 tools

The full surface in v0.2.0 · all 20 are wired in both `ari-mcp` (npm) and [`ari-mcp-server`](https://pypi.org/project/ari-mcp-server/) (PyPI) with byte-identical wire semantics.

### Pricing & verdicts

| Tool | What it does |
| --- | --- |
| `is_fair_price` | Green/amber/red verdict for a quoted price |
| `is_fair_price_batch` | Grade up to 50 quotes in one round-trip |
| `refuse_if_overpriced` | Convenience wrapper to call right before honoring a 402 quote |
| `prepay_verdict` | **Universal Fairness Skill** · refuse-to-overpay check that wraps any agent wallet (Coinbase Agent Wallet, AgentCash, ATXP, 1Pay.ing) before settling x402 / MPP |
| `prepay_verdict_batch` | Same Universal Fairness Skill, applied to up to 50 candidate URLs at once |
| `get_fmv` | Median + low/high band + sample size for a service (returns strict null when there's no data — never a hallucinated price) |
| `historical_fmv` | Per-UTC-day median + sample count over the last N days (max 180) |
| `category_benchmark` | Unweighted median + p10/p90 band across every indexed service in one category |
| `detect_anomaly` | Flag the latest observation as anomalous when its robust z-score crosses 3 over a 14-day window |

### Discovery & routing

| Tool | What it does |
| --- | --- |
| `list_services` | Browse or filter the index by protocol, category, or freshness |
| `get_service` | Full detail row · sources, related services, last observation |
| `get_leaderboard` | Cheapest, most expensive, biggest movers |
| `recent_observations` | Raw observed price history for a service |
| `find_substitutes` | Cheapest indexed peers in the same category, ranked by FMV ascending |
| `smart_route` | One-call helper that returns the cheapest peer in a category plus a short alternates list |

### Receipts & audit

| Tool | What it does |
| --- | --- |
| `verify_receipt` | Re-verify a previously issued receipt id (Ed25519, fail-closed) |
| `get_signed_receipt` | Re-fetch the signed body for a receipt |
| `why` | Re-fetch a receipt and render the human-readable evidence trail the FMV engine relied on |

### Plumbing

| Tool | What it does |
| --- | --- |
| `subscribe_alert` | Set up a webhook or email price alert |
| `mcp_health_ping` | Best-effort heartbeat that bumps `last_seen_at` on the install row · never blocks, never collects identifying data |

### What's new in v0.2.0

- **Receipt spec v3** with confidence-tiered verdicts (`high` / `medium` / `low`). A `pay` verdict is only demoted to `abstain` on an explicit `low` confidence — older v1/v2 routes verify unchanged.
- **Honest-null contract** · `get_fmv` returns a fully null-shaped `fairPrice` block instead of a guessed number when a service has no observations, and `refuse_if_overpriced` returns `{ ok: true, reason: "no_data" }` instead of pretending.
- **Hardened receipt headers** · `ReceiptHeaders` now accepts camelCase, `Headers` instances, and lowercased shapes via `normalizeReceiptHeaders()`.
- **Async receipt resilience** · integration helpers poll for receipt availability so verifies don't flake against the WAL-queue persister.
- **Cross-language parity** · 74 TS unit tests + 15 integration tests, 83 Python tests, all pinned to a shared signed-header order so the wire format can't drift between runtimes.

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

## Framework adapters

`ari-mcp` ships its tool surface as a plain `TOOLS` array so you can wire it
into any agent runtime without subclassing. Pick the snippet that matches
your stack — each one bridges to the same 20 tools.

### Vercel AI SDK (`ai` ≥ 4.0)

```ts
import { tool } from "ai";
import { z } from "zod";
import { AriClient } from "ari-mcp/client";
import { TOOLS } from "ari-mcp/tools";

const client = new AriClient({ baseUrl: "https://api.agentrateindicators.com" });

export const ariTools = Object.fromEntries(
  TOOLS.map((t) => [
    t.name,
    tool({
      description: t.description,
      parameters: t.inputSchema as z.ZodTypeAny,
      execute: async (args) => t.run(args as never, client),
    }),
  ]),
);
// pass `tools: ariTools` to `generateText` / `streamText`.
```

### LangGraph.js

```ts
import { DynamicStructuredTool } from "@langchain/core/tools";
import { AriClient } from "ari-mcp/client";
import { TOOLS } from "ari-mcp/tools";

const client = new AriClient({ baseUrl: "https://api.agentrateindicators.com" });

export const ariLangchainTools = TOOLS.map(
  (t) =>
    new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: t.inputSchema,
      func: async (args) => JSON.stringify(await t.run(args as never, client)),
    }),
);
```

### LlamaIndex.TS

```ts
import { FunctionTool } from "llamaindex";
import { AriClient } from "ari-mcp/client";
import { TOOLS } from "ari-mcp/tools";

const client = new AriClient({ baseUrl: "https://api.agentrateindicators.com" });

export const ariLlamaTools = TOOLS.map((t) =>
  FunctionTool.from(async (args: unknown) => t.run(args as never, client), {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }),
);
```

### Pydantic AI (Python-side bridge)

Pydantic AI is Python-only; from a TS/Node host, expose the MCP server over
stdio and let Pydantic AI consume it as a remote MCP server:

```bash
npx ari-mcp serve --transport stdio
```

Then in Python:

```py
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStdio
agent = Agent("openai:gpt-4o", mcp_servers=[MCPServerStdio("npx", ["-y", "ari-mcp", "serve"])])
```

## License

Apache-2.0 · the live ARI API server is BUSL-1.1, this client library is intentionally permissive so it can ship inside any agent runtime. Contact · `hello@agenticrates.org`.
