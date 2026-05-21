# SPDX-License-Identifier: Apache-2.0
"""MCP server wiring for ari-mcp Python package.

Two transports are wired up:
- ``stdio`` (default; what every desktop MCP host launches)
- streamable ``http`` (for hosted deployments, exposed via
  ``--transport http --port N``).

Tool errors surface as MCP-protocol error responses
(``CallToolResult(content=..., isError=True)``) per the SDK contract,
so MCP hosts can render them as failed-tool indications instead of
silently treating the error string as a successful tool result.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import AsyncExitStack
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, TextContent, Tool

from .client import AriClient, AriHttpError, AriReceiptError
from .tools import TOOLS

SERVER_NAME = "ari-mcp"
SERVER_VERSION = "0.1.3"


def _format_tool_error(err: Exception) -> str:
    if isinstance(err, AriReceiptError):
        return (
            f"ARI receipt verification failed: {err}\n\n"
            "This usually means the response was tampered with in transit, "
            "or the publisher's signing key was rotated and your local pin is stale. "
            "Re-fetch the public key from <base>/.well-known/ari-pubkey.pem."
        )
    if isinstance(err, AriHttpError):
        body = err.body[:2000] if err.body else ""
        return f"ARI API error ({err.status}): {err}\n\nResponse body:\n{body}"
    return f"{type(err).__name__}: {err}"


def create_server(
    base_url: str | None = None,
    api_key: str | None = None,
    insecure_skip_verify: bool = False,
    insecure_skip_pin: bool = False,
) -> tuple[Server, AriClient]:
    server: Server = Server(SERVER_NAME, version=SERVER_VERSION)
    client = AriClient(
        base_url=base_url,
        api_key=api_key,
        insecure_skip_verify=insecure_skip_verify,
        insecure_skip_pin=insecure_skip_pin,
    )

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        out: list[Tool] = []
        for t in TOOLS:
            out.append(
                Tool(
                    name=t.name,
                    title=t.title,
                    description=t.description,
                    inputSchema=t.input_model.model_json_schema(),
                )
            )
        return out

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
        tool = next((t for t in TOOLS if t.name == name), None)
        if tool is None:
            # `isError=True` is the MCP-spec way to signal a tool-level
            # failure: the agent's MCP host sees a failed call rather
            # than a successful one whose text body happens to contain
            # an error message.
            return CallToolResult(
                isError=True,
                content=[TextContent(type="text", text=f"Unknown tool: {name}")],
            )
        try:
            # Tool runners are blocking httpx calls; run in a thread so the
            # event loop stays responsive.
            result = await asyncio.to_thread(tool.run, arguments, client)
            return CallToolResult(
                content=[
                    TextContent(
                        type="text",
                        text=json.dumps(result, indent=2, default=str),
                    )
                ],
                structuredContent=result if isinstance(result, dict) else None,
            )
        except Exception as e:  # noqa: BLE001 · surface every error to the agent
            return CallToolResult(
                isError=True,
                content=[
                    TextContent(type="text", text=_format_tool_error(e))
                ],
            )

    return server, client


async def run_stdio(
    base_url: str | None = None,
    api_key: str | None = None,
    insecure_skip_verify: bool = False,
    insecure_skip_pin: bool = False,
) -> None:
    server, client = create_server(
        base_url=base_url,
        api_key=api_key,
        insecure_skip_verify=insecure_skip_verify,
        insecure_skip_pin=insecure_skip_pin,
    )
    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )
    finally:
        client.close()


async def run_http(
    port: int,
    host: str = "127.0.0.1",
    path: str = "/mcp",
    base_url: str | None = None,
    api_key: str | None = None,
    insecure_skip_verify: bool = False,
    insecure_skip_pin: bool = False,
) -> None:
    """Start the Streamable HTTP transport.

    Uses the SDK's ``StreamableHTTPSessionManager`` mounted as a Starlette
    app served by uvicorn. Stateless mode (``stateless=True``) keeps each
    HTTP request self-contained, which is the right mode for an
    ARI-style oracle (every tool call is independently signed).
    """
    import uvicorn
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from starlette.applications import Starlette
    from starlette.routing import Mount

    server, client = create_server(
        base_url=base_url,
        api_key=api_key,
        insecure_skip_verify=insecure_skip_verify,
        insecure_skip_pin=insecure_skip_pin,
    )

    session_manager = StreamableHTTPSessionManager(
        app=server,
        event_store=None,
        json_response=False,
        stateless=True,
    )

    async def handle_streamable_http(scope, receive, send):  # type: ignore[no-untyped-def]
        await session_manager.handle_request(scope, receive, send)

    @asynccontextmanager_compat
    async def lifespan(app):  # type: ignore[no-untyped-def]
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(session_manager.run())
            try:
                yield
            finally:
                client.close()

    # Mount on both `/mcp` and `/mcp/` so clients that omit (or include)
    # the trailing slash both reach the session manager directly without
    # eating a 307 redirect. Some MCP hosts treat the redirect as an
    # error.
    routes = [Mount(path, app=handle_streamable_http)]
    if not path.endswith("/"):
        routes.append(Mount(path + "/", app=handle_streamable_http))
    app = Starlette(debug=False, routes=routes, lifespan=lifespan)
    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server_instance = uvicorn.Server(config)
    await server_instance.serve()


# Tiny back-compat shim so the lifespan helper above does not have to
# import contextlib at module scope (keeps the stdio import path lean).
def asynccontextmanager_compat(func):  # type: ignore[no-untyped-def]
    from contextlib import asynccontextmanager

    return asynccontextmanager(func)
