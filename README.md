# ARI · Agentic Rate Indicators

[![npm](https://img.shields.io/npm/v/ari-mcp.svg?label=npm)](https://www.npmjs.com/package/ari-mcp)
[![PyPI](https://img.shields.io/pypi/v/ari-mcp-py.svg?label=PyPI)](https://pypi.org/project/ari-mcp-py/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed)](https://modelcontextprotocol.io)

Live fair-market-value lookups, leaderboards, and Ed25519 signed-receipt verification for x402/MPP services. `ari-mcp` lets any MCP-aware agent answer two questions cleanly:

1. **Is this API price fair?** Compare a quoted unit price against the live ARI fair-price band for that service.
2. **Is this receipt real?** Verify the signed receipt returned by an x402/MPP facilitator offline, with a pinned publisher key.

The same package ships for Node and Python, with the same tool surface and the same wire spec.

```
┌──────────┐     stdio     ┌──────────┐     HTTPS    ┌──────────────────────────┐
│  Agent   │ ────────────▶ │ ari-mcp  │ ───────────▶ │ agentrateindicators.com  │
│ (Claude, │ ◀──────────── │  server  │ ◀────────── │   /api/v1/*              │
│ Cursor…) │   tool JSON   └──────────┘   signed     └──────────────────────────┘
└──────────┘                                receipts
```

## Install in your agent

Pick the host you use. Each block is copy-paste, no edits required.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

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

`~/.cursor/mcp.json` (or the per-workspace `.cursor/mcp.json`):

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

### Continue

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: ari
    command: npx
    args: ["-y", "ari-mcp"]
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ari": { "command": "npx", "args": ["-y", "ari-mcp"] }
  }
}
```

### Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "ari": {
      "command": { "path": "npx", "args": ["-y", "ari-mcp"] }
    }
  }
}
```

### Gemini CLI / ChatGPT desktop / any other MCP host

`command: npx`, `args: ["-y", "ari-mcp"]`. Or, for Python-native hosts, `command: uvx`, `args: ["ari-mcp-py"]`.

## Tools

| Tool | What it does |
| --- | --- |
| `is_fair_price` | Green / amber / red verdict for a quoted price against the live FMV band. |
| `refuse_if_overpriced` | Convenience wrapper to call right before paying · returns `{ok, reason}`. |
| `prepay_verdict` | Full pre-pay decision with FMV band, deviation, and a citable receipt id. |
| `get_fmv` | Median plus low / high band and sample size for a service. |
| `get_service` | Full detail row · sources, related services, last observation. |
| `list_services` | Browse or filter the index by protocol or category. |
| `get_leaderboard` | Cheapest, most expensive, biggest movers in a category. |
| `recent_observations` | Raw observed price history for a service. |
| `verify_receipt` | Re-verify a previously issued receipt id offline. |
| `get_signed_receipt` | Re-fetch the signed body for a receipt id. |
| `subscribe_alert` | Set up a webhook or email price alert for a service. |

Every tool returns JSON shaped for citation rather than free text. Agents that quote tool output verbatim end up with good citations for free.

## A real tool call

Asking Claude *"is this quote fair before I pay it?"* triggers:

```json
{
  "tool": "is_fair_price",
  "arguments": {
    "slug": "openrouter-anthropic-claude-3-5-sonnet",
    "amount_usd": 4.10,
    "unit": "1m_input_tokens"
  }
}
```

and the server returns:

```json
{
  "verdict": "amber",
  "fmv_usd": 3.04,
  "low_usd": 2.87,
  "high_usd": 3.21,
  "delta_pct": 34.9,
  "sample_size": 47,
  "currency": "USD",
  "unit": "1m_input_tokens",
  "receipt_id": "01J5ZK8E2K7Q3R5W8X9Y0Z1A2B",
  "signed_at": "2026-05-21T14:02:11Z"
}
```

The agent now has a concrete reason to push back on the quote, plus an auditable receipt id. When ARI has not yet computed a baseline for a service, `verdict` is `"unknown"` and the FMV fields are `null` rather than zero · agents should treat `null` as "no opinion", never as "free".

## Verify a receipt yourself

```bash
# Node
npx ari-mcp verify --url https://agentrateindicators.com/api/v1/pubkey

# Python
uvx ari-mcp verify --url https://agentrateindicators.com/api/v1/pubkey
```

Both print `OK` on success and a structured failure with the exact reason on failure (hash mismatch, unknown key id, bad signature, missing header). See [spec/verification.md](spec/verification.md) for the by-hand walkthrough.

## Why this exists

Agents are starting to spend real money through x402 and MPP facilitators. There are two things they cannot do today without help:

- **Sanity-check a price before paying it.** Facilitators are free to quote anything. ARI keeps a live, public fair-price band per service so an agent (or a human reviewer) can see when a quote is out of line.
- **Verify a receipt after paying.** Facilitators return signed metadata about the transaction, but most agents take this on faith. ARI publishes the receipt canonicalization and an Ed25519 verifier so receipts can be checked offline, against a pinned key.

`ari-mcp` exposes both as plain MCP tools. No new protocols for the agent author to learn.

## Wire spec

The repository is the source of truth for the wire format:

- [`spec/openapi.yaml`](spec/openapi.yaml) · public HTTP surface
- [`spec/signed-receipts.md`](spec/signed-receipts.md) · receipt canonicalization and header layout
- [`spec/verification.md`](spec/verification.md) · step-by-step verifier in Node and Python

Anyone porting `ari-mcp` to another language can work from `spec/` alone.

## Packages

| Language | Package | Source |
| --- | --- | --- |
| Node 18+ | [`ari-mcp` on npm](https://www.npmjs.com/package/ari-mcp) | [`packages/ari-mcp-ts`](packages/ari-mcp-ts) |
| Python 3.10+ | [`ari-mcp-py` on PyPI](https://pypi.org/project/ari-mcp-py/) | [`packages/ari-mcp-py`](packages/ari-mcp-py) |

Both packages share the same tool names, argument shapes, and JSON return shapes. Both ship offline receipt verification with a pinned key and an `ACCEPTED_KEY_IDS` list for graceful rotation. Both default to the public ARI API and accept `ARI_API_BASE_URL` to point at a private mirror.

## Security

If you find a security issue, please report it privately. See [SECURITY.md](SECURITY.md). The current publisher key, the canonicalization spec, and the verification walkthrough are all linked from there.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports, small fixes, and additional install snippets for other MCP hosts are all welcome. The internal API server, fair-price methodology, and data adapters live elsewhere and are intentionally not part of this repository · pull requests that try to add them will be closed.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
