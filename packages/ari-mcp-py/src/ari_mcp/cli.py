# SPDX-License-Identifier: Apache-2.0
"""``ari-mcp`` CLI · entry point for ``python -m ari_mcp`` and the bin script."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Sequence

from . import __version__
from .client import DEFAULT_API_BASE_URL, AriClient
from .server import run_http, run_stdio


def _claude_snippet(args: argparse.Namespace) -> dict:
    cmd = "ari-mcp"
    extra = []
    if args.api_base_url and args.api_base_url != DEFAULT_API_BASE_URL:
        extra += ["--api-base-url", args.api_base_url]
    return {
        "mcpServers": {
            "ari": {"command": cmd, "args": extra},
        },
    }


SNIPPETS = [
    (
        "claude",
        "Claude Desktop",
        "~/Library/Application Support/Claude/claude_desktop_config.json (macOS)\n"
        "%APPDATA%/Claude/claude_desktop_config.json (Windows)",
    ),
    ("cursor", "Cursor", "~/.cursor/mcp.json"),
    ("continue", "Continue", "~/.continue/config.json (under `mcpServers`)"),
    ("windsurf", "Windsurf", "~/.codeium/windsurf/mcp_config.json"),
    ("zed", "Zed", "~/.config/zed/settings.json (under `context_servers.ari`)"),
    ("chatgpt", "ChatGPT desktop", "Settings → Connectors → Add custom MCP"),
    ("gemini", "Gemini CLI", "~/.gemini/mcp.json"),
]


def cmd_install(args: argparse.Namespace) -> int:
    block = json.dumps(_claude_snippet(args), indent=2)
    only = (args.client or "").lower()
    print(f"# Install ARI MCP server (v{__version__})\n")
    for slug, label, where in SNIPPETS:
        if only and slug != only:
            continue
        print(f"## {label}")
        print(f"Path: {where}\n")
        print("```json")
        print(block)
        print("```\n")
    print(
        "After saving, restart your MCP host. Then ask the agent: "
        '"List your tools" · you should see is_fair_price, refuse_if_overpriced, etc.'
    )
    return 0


def cmd_ping(args: argparse.Namespace) -> int:
    import httpx
    import os
    import platform
    import uuid

    install_id = os.environ.get("ARI_INSTALL_ID") or str(uuid.uuid4())
    body = {
        "install_id": install_id,
        "kind": "py",
        "version": __version__,
        "client_label": args.client or "unknown",
        "platform": f"{platform.system().lower()}-{platform.machine()}",
    }
    base = args.api_base_url or DEFAULT_API_BASE_URL
    try:
        r = httpx.post(f"{base.rstrip('/')}/api/v1/mcp/install-ping", json=body, timeout=10)
        print(f"Pinged {base}/api/v1/mcp/install-ping → {r.status_code}")
        return 0 if r.status_code < 500 else 2
    except Exception as e:
        print(f"Ping failed (best-effort, OK to ignore): {e}", file=sys.stderr)
        return 1


def cmd_serve(args: argparse.Namespace) -> int:
    if args.transport == "http":
        asyncio.run(
            run_http(
                port=args.port,
                host=args.host,
                base_url=args.api_base_url,
                api_key=args.api_key,
                insecure_skip_verify=args.insecure_skip_verify,
                insecure_skip_pin=args.insecure_skip_pin,
            )
        )
        return 0
    asyncio.run(
        run_stdio(
            base_url=args.api_base_url,
            api_key=args.api_key,
            insecure_skip_verify=args.insecure_skip_verify,
            insecure_skip_pin=args.insecure_skip_pin,
        )
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="ari-mcp",
        description="MCP server for Agentic Rate Indicators.",
    )
    p.add_argument("--api-base-url", default=DEFAULT_API_BASE_URL)
    p.add_argument("--api-key", default=None)
    p.add_argument("--insecure-skip-verify", action="store_true")
    p.add_argument(
        "--insecure-skip-pin",
        action="store_true",
        help="Skip the build-time publisher-key-id pin (allow rotation).",
    )
    p.add_argument(
        "--transport",
        choices=("stdio", "http"),
        default="stdio",
        help="Transport for `serve`. Default: stdio.",
    )
    p.add_argument("--port", type=int, default=8765, help="HTTP port (with --transport http).")
    p.add_argument("--host", default="127.0.0.1", help="HTTP bind host.")
    p.add_argument("--version", action="version", version=f"ari-mcp {__version__}")

    sub = p.add_subparsers(dest="command")
    sub.add_parser("serve", help="Start the MCP server (stdio or http).")
    inst = sub.add_parser("install", help="Print install snippets for popular MCP hosts.")
    inst.add_argument("--client", default=None, help="Print only one host's snippet.")
    ping = sub.add_parser("ping", help="Send an opt-in install ping.")
    ping.add_argument("--client", default=None)

    args = p.parse_args(argv)
    if args.command == "install":
        return cmd_install(args)
    if args.command == "ping":
        return cmd_ping(args)
    return cmd_serve(args)


if __name__ == "__main__":
    raise SystemExit(main())
