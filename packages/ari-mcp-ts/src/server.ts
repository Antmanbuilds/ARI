// SPDX-License-Identifier: Apache-2.0
//
// MCP server wiring. Uses the low-level `Server` API from
// `@modelcontextprotocol/sdk/server/index.js` (NOT the higher-level
// `McpServer.registerTool`) so that:
//   1. We get fully-typed `setRequestHandler` overloads · no `any` escape
//      and no "Type instantiation is excessively deep" diagnostics.
//   2. Tool errors return `{ isError: true, content: [...] }` per the
//      MCP spec instead of being thrown across the transport boundary.
//
// Two transports are wired up:
//   - stdio (the default; what every desktop MCP host launches)
//   - streamable HTTP (for hosted deployments, exposed via
//     `--transport http --port N`).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AriClient, AriHttpError, AriReceiptError } from "./client.js";
import { TOOLS, type ToolDef } from "./tools/index.js";
import { zodToJsonSchema } from "./jsonschema.js";

export const SERVER_VERSION = "0.1.2";

export interface CreateServerOptions {
  baseUrl?: string;
  apiKey?: string;
  publicKeyPem?: string;
  insecureSkipVerify?: boolean;
  insecureSkipPin?: boolean;
}

export function createAriMcpServer(opts: CreateServerOptions = {}): {
  server: Server;
  client: AriClient;
} {
  const client = new AriClient(opts);
  const server = new Server(
    { name: "ari-mcp", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "ARI (Agentic Rate Indicators) · pricing oracle for x402 + MPP services. " +
        "Call `is_fair_price` or `refuse_if_overpriced` BEFORE honoring any 402 quote. " +
        "Every tool result includes a citable `receipt_id` you can verify later with " +
        "`verify_receipt`. Source: https://agentrateindicators.com",
    },
  );

  const toolList: Tool[] = TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema) as Tool["inputSchema"],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList,
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> => {
      const { name, arguments: rawArgs } = req.params;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return errorResult(`Unknown tool: ${name}`);
      }
      try {
        const parsed = (tool as ToolDef<z.ZodType>).inputSchema.parse(
          rawArgs ?? {},
        );
        const result = await tool.run(parsed, client);
        const text = JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err: unknown) {
        return errorResult(formatToolError(err));
      }
    },
  );

  return { server, client };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function formatToolError(err: unknown): string {
  if (err instanceof AriReceiptError) {
    return (
      `ARI receipt verification failed: ${err.message}\n\n` +
      `This usually means the response was tampered with in transit, ` +
      `or the publisher's signing key was rotated and your local pin is stale. ` +
      `Re-fetch the public key from ${err.url.replace(/\/api\/.*/, "")}/.well-known/ari-pubkey.pem.`
    );
  }
  if (err instanceof AriHttpError) {
    return `ARI API error (${err.status}): ${err.message}\n\nResponse body:\n${err.body.slice(0, 2000)}`;
  }
  if (err instanceof z.ZodError) {
    return `Invalid arguments: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function runStdio(opts: CreateServerOptions = {}): Promise<void> {
  const { server } = createAriMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface RunHttpOptions extends CreateServerOptions {
  port: number;
  host?: string;
  path?: string;
}

export async function runHttp(opts: RunHttpOptions): Promise<void> {
  const { server } = createAriMcpServer(opts);
  const path = opts.path ?? "/mcp";
  const host = opts.host ?? "127.0.0.1";
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const http = await import("node:http");
  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith(path)) {
      res.statusCode = 404;
      res.end("not found · POST or GET " + path);
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error("[ari-mcp http] transport error", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("internal transport error");
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, host, () => resolve());
  });
  process.stderr.write(
    `ari-mcp listening on http://${host}:${opts.port}${path} (Streamable HTTP transport)\n`,
  );
}
