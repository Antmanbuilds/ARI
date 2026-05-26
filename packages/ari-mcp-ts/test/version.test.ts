// SPDX-License-Identifier: Apache-2.0
//
// Regression gate for task #545. Previously `cli.ts` hardcoded `"0.1.3\n"`
// for the `--version` subcommand and `client.ts` hardcoded `"ari-mcp/0.1.3"`
// for the HTTP User-Agent · both drifted from `package.json` (which had
// already moved to `0.2.0`) and would have surfaced as "wrong tarball
// got published" on the first smoke after upload. This test fails if
// the auto-generated `src/version.ts` is out of sync with the source
// of truth (package.json).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION, USER_AGENT } from "../src/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

test("VERSION matches package.json#version", () => {
  assert.equal(
    VERSION,
    pkg.version,
    "src/version.ts is out of sync with package.json · run `pnpm run build` (it auto-regenerates version.ts) and commit the change",
  );
});

test("USER_AGENT embeds the same version", () => {
  assert.equal(USER_AGENT, `ari-mcp/${pkg.version}`);
});
