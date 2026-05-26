// SPDX-License-Identifier: Apache-2.0
// Cross-language contract tests.
//
// Drives every MCP tool against the canned API fixtures in
// `tools/fixtures/mcp-contract.json`. The Python test suite at
// `tools/ari-mcp-py/tests/test_contract.py` consumes the SAME file
// and asserts the SAME `expect` shape · this is the bar that catches
// Node ↔ Python behaviour drift before a release.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TOOLS } from "../src/tools/index.js";
import type { AriClient, AriResponse } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, "..", "..", "fixtures", "mcp-contract.json");

interface StubbedResponse {
  path: string;
  method?: string;
  body: unknown;
}
interface ContractCase {
  name: string;
  tool: string;
  input: Record<string, unknown>;
  responses: StubbedResponse[];
  expect: Record<string, unknown>;
}
interface Fixture {
  receipt: { receipt_id: string; signed_at: string };
  cases: ContractCase[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

function makeClient(responses: StubbedResponse[]): AriClient {
  const queue = [...responses];
  const request = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<AriResponse<T>> => {
    const expected = queue.shift();
    assert.ok(expected, `Tool made an unexpected request to ${path}`);
    // The TS tools embed query params in the path; the fixture stores
    // just the bare URL path so the comparison is language-neutral.
    const bare = path.split("?")[0];
    assert.equal(bare, expected.path, `Tool requested ${bare}, expected ${expected.path}`);
    const method = (init.method ?? "GET").toUpperCase();
    const expectedMethod = (expected.method ?? "GET").toUpperCase();
    assert.equal(method, expectedMethod);
    return {
      data: expected.body as T,
      receiptId: fixture.receipt.receipt_id,
      signedAt: fixture.receipt.signed_at,
    };
  };
  return { request } as unknown as AriClient;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not registered`);
  return t!;
}

describe("cross-language contract", () => {
  it("fixture covers every registered tool", () => {
    // Without this guard, adding a new tool would silently bypass the
    // cross-language parity check.
    const covered = new Set(fixture.cases.map((c) => c.tool));
    const registered = new Set(TOOLS.map((t) => t.name));
    const missing = [...registered].filter((n) => !covered.has(n));
    assert.deepEqual(
      missing,
      [],
      `contract fixture is missing cases for tools: ${missing.join(", ")}`,
    );
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const client = makeClient(c.responses);
      const result = (await tool(c.tool).run(c.input, client)) as Record<string, unknown>;
      for (const [key, expected] of Object.entries(c.expect)) {
        assert.ok(key in result, `missing key ${key} in result for ${c.name}`);
        const actual = result[key];
        if (typeof expected === "number" && typeof actual === "number") {
          assert.equal(actual, expected, `${c.name}: ${key} = ${actual}, expected ${expected}`);
        } else {
          assert.deepEqual(actual, expected, `${c.name}: ${key} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        }
      }
    });
  }
});
