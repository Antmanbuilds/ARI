#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// `ari-mcp` CLI · entry point for `npx -y ari-mcp` and the `ari-mcp` bin.
// Supports two modes:
//
//   ari-mcp · start the MCP stdio server (what every desktop
//                         host launches; never produces stdout output).
//   ari-mcp install · print copy-paste config blocks for Claude Desktop,
//                         Cursor, Continue, Windsurf, Zed, ChatGPT desktop.
//   ari-mcp ping · best-effort opt-in install ping (one-shot).
//
// Flags:
//   --api-base-url URL   Override the ARI API base (default https://agentrateindicators.com)
//   --api-key KEY        Optional bearer token for paid tiers
//   --insecure-skip-verify  Skip receipt signature checks (NOT FOR PROD)

import { runStdio, runHttp } from "./server.js";

interface Cli {
  command: "serve" | "install" | "ping" | "version" | "help";
  baseUrl?: string;
  apiKey?: string;
  insecureSkipVerify?: boolean;
  insecureSkipPin?: boolean;
  client?: string;
  transport?: "stdio" | "http";
  port?: number;
  host?: string;
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = { command: "serve" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--api-base-url") {
      out.baseUrl = argv[++i];
    } else if (arg.startsWith("--api-base-url=")) {
      out.baseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-key") {
      out.apiKey = argv[++i];
    } else if (arg.startsWith("--api-key=")) {
      out.apiKey = arg.slice("--api-key=".length);
    } else if (arg === "--insecure-skip-verify") {
      out.insecureSkipVerify = true;
    } else if (arg === "--insecure-skip-pin") {
      out.insecureSkipPin = true;
    } else if (arg === "--transport") {
      const v = argv[++i];
      if (v !== "stdio" && v !== "http") {
        throw new Error(`--transport must be "stdio" or "http" (got ${v})`);
      }
      out.transport = v;
    } else if (arg.startsWith("--transport=")) {
      const v = arg.slice("--transport=".length);
      if (v !== "stdio" && v !== "http") {
        throw new Error(`--transport must be "stdio" or "http" (got ${v})`);
      }
      out.transport = v;
    } else if (arg === "--port") {
      out.port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      out.port = Number(arg.slice("--port=".length));
    } else if (arg === "--host") {
      out.host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      out.host = arg.slice("--host=".length);
    } else if (arg === "--client") {
      out.client = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      out.command = "help";
    } else if (arg === "--version" || arg === "-v") {
      out.command = "version";
    } else {
      positional.push(arg);
    }
  }
  // Only resolve the positional command if a flag (--help / --version)
  // hasn't already chosen one. Otherwise `--version` would silently get
  // demoted to `serve` because there are no positional args.
  if (out.command === "serve") {
    if (positional[0] === "install") out.command = "install";
    else if (positional[0] === "ping") out.command = "ping";
    else if (positional[0] === "help") out.command = "help";
    else if (positional[0] === "version") out.command = "version";
    else out.command = "serve";
  }
  return out;
}

const HELP = `ari-mcp · MCP server for Agentic Rate Indicators

USAGE
  ari-mcp [serve]            Start the MCP stdio server (default).
  ari-mcp install            Print install snippets for popular MCP hosts.
  ari-mcp ping               Send a one-shot opt-in install ping.
  ari-mcp --version          Print the server version.

OPTIONS
  --api-base-url URL         Override the ARI API base URL.
  --api-key KEY              Bearer token for paid tiers (optional).
  --transport stdio|http     Transport for 'serve'. Default: stdio.
  --port N                   HTTP port (when --transport=http). Default: 8765.
  --host HOST                HTTP bind host. Default: 127.0.0.1.
  --insecure-skip-verify     Skip Ed25519 receipt verification.
  --insecure-skip-pin        Skip the build-time key-id pin (allow rotation).
  --client NAME              For 'install', print only the snippet for one host.

DOCS
  https://agentrateindicators.com/docs/mcp
`;

interface InstallSnippet {
  client: string;
  configPath: string;
  json: object;
  notes?: string;
}

function installSnippets(baseUrl?: string): InstallSnippet[] {
  const args: string[] = ["ari-mcp"];
  if (baseUrl) args.push("--api-base-url", baseUrl);

  const stdioBlock = {
    command: "npx",
    args: ["-y", ...args],
  };

  return [
    {
      client: "claude-desktop",
      configPath: "~/Library/Application Support/Claude/claude_desktop_config.json (macOS) · %APPDATA%/Claude/claude_desktop_config.json (Windows)",
      json: { mcpServers: { ari: stdioBlock } },
    },
    {
      client: "cursor",
      configPath: "~/.cursor/mcp.json",
      json: { mcpServers: { ari: stdioBlock } },
    },
    {
      client: "continue",
      configPath: "~/.continue/config.json (mcpServers section)",
      json: { mcpServers: [{ name: "ari", ...stdioBlock }] },
    },
    {
      client: "windsurf",
      configPath: "~/.codeium/windsurf/mcp_config.json",
      json: { mcpServers: { ari: stdioBlock } },
    },
    {
      client: "zed",
      configPath: "Zed settings.json (under context_servers)",
      json: { context_servers: { ari: { source: "custom", ...stdioBlock } } },
      notes: "Zed uses `context_servers` (not `mcpServers`) and `source: \"custom\"`.",
    },
    {
      client: "chatgpt-desktop",
      configPath: "ChatGPT desktop → Settings → Integrations → Add MCP server",
      json: { name: "ari", ...stdioBlock },
      notes: "Paste the command + args into the dialog; ChatGPT desktop has no JSON file.",
    },
    {
      client: "gemini-cli",
      configPath: "~/.config/gemini-cli/mcp.json",
      json: { servers: [{ name: "ari", ...stdioBlock }] },
    },
  ];
}

function printInstall(filter?: string, baseUrl?: string): void {
  const snippets = installSnippets(baseUrl);
  const sel = filter ? snippets.filter((s) => s.client === filter) : snippets;
  if (sel.length === 0) {
    process.stderr.write(`Unknown --client. Try one of: ${snippets.map((s) => s.client).join(", ")}\n`);
    process.exit(1);
  }
  for (const snip of sel) {
    process.stdout.write(`\n# ${snip.client}\n`);
    process.stdout.write(`# Config file: ${snip.configPath}\n`);
    if (snip.notes) process.stdout.write(`# Note: ${snip.notes}\n`);
    process.stdout.write(JSON.stringify(snip.json, null, 2) + "\n");
  }
  process.stdout.write(
    `\n# Then restart your MCP host. Verify in the host's tool inspector that\n` +
      `# 10 ari-mcp tools appear (is_fair_price, refuse_if_overpriced, ...).\n` +
      `# More: https://agentrateindicators.com/docs/mcp\n`,
  );
}

async function pingInstall(baseUrl?: string): Promise<void> {
  // Best-effort, opt-in. Generates a per-machine install id and POSTs it once.
  // We never collect anything beyond `{install_id, kind: "ts", version, client}`.
  const url =
    (baseUrl ?? "https://agentrateindicators.com").replace(/\/+$/, "") +
    "/api/v1/mcp/install-ping";
  const installId = randomInstallId();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: installId,
        kind: "ts",
        version: "0.1.3",
      }),
    });
    if (!res.ok) {
      process.stderr.write(`install-ping: HTTP ${res.status}\n`);
      process.exit(2);
    }
    process.stdout.write("install-ping: ok\n");
  } catch (e: unknown) {
    process.stderr.write(`install-ping failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(3);
  }
}

function randomInstallId(): string {
  // 16 bytes, hex. Stable across a process invocation but new each time.
  const b = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  switch (cli.command) {
    case "help":
      process.stdout.write(HELP);
      return;
    case "version":
      process.stdout.write("0.1.3\n");
      return;
    case "install":
      printInstall(cli.client, cli.baseUrl);
      return;
    case "ping":
      await pingInstall(cli.baseUrl);
      return;
    case "serve":
    default: {
      const opts: ConstructorParameters<typeof import("./client.js").AriClient>[0] = {};
      if (cli.baseUrl !== undefined) opts.baseUrl = cli.baseUrl;
      if (cli.apiKey !== undefined) opts.apiKey = cli.apiKey;
      if (cli.insecureSkipVerify !== undefined)
        opts.insecureSkipVerify = cli.insecureSkipVerify;
      if (cli.insecureSkipPin !== undefined)
        opts.insecureSkipPin = cli.insecureSkipPin;
      if ((cli.transport ?? "stdio") === "http") {
        await runHttp({
          ...opts,
          port: cli.port ?? 8765,
          host: cli.host ?? "127.0.0.1",
        });
        return;
      }
      await runStdio(opts);
      return;
    }
  }
}

main().catch((err: unknown) => {
  // The MCP host never sees stdout (that's the protocol channel). Errors
  // go to stderr so users at least see them in the host log panel.
  process.stderr.write(
    `ari-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
