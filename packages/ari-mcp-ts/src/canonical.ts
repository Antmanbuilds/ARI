// SPDX-License-Identifier: Apache-2.0
//
// ARI canonicalization profile (`ari-receipts/v1`) · JCS / RFC 8785, with the
// ARI-profile additions documented at /api/v1/spec/canonicalization. This is a
// byte-for-byte copy of tools/ari-verify/src/canonical.ts so the MCP server is
// dependency-free at install time. Keep them in lock-step.

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== "object") return false;
  if (Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

const COMBINING_MARK_RE = /[\u0300-\u036f]/;
function nfcGuard(s: string): void {
  const nfc = s.normalize("NFC");
  if (nfc !== s) {
    throw new Error(
      "JCS: string is not in Unicode NFC normalization form (ari-receipts-v2 requires NFC)",
    );
  }
  if (COMBINING_MARK_RE.test(nfc)) {
    throw new Error(
      "JCS: string contains combining marks (U+0300-U+036F) that survive NFC normalization",
    );
  }
}

function escapeString(s: string): string {
  nfcGuard(s);
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error("JCS: NaN and Infinity are not representable");
  }
  if (Object.is(n, -0)) return "0";
  return JSON.stringify(n);
}

export function jcs(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "bigint") return escapeString(value.toString());
  if (Array.isArray(value)) {
    return "[" + value.map((v) => jcs(v === undefined ? null : v)).join(",") + "]";
  }
  if (isPlainObject(value)) {
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      entries.push([k, v]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => escapeString(k) + ":" + jcs(v)).join(",") + "}";
  }
  if (value === undefined) {
    throw new Error("JCS: cannot serialize undefined at the top level");
  }
  throw new Error(`JCS: cannot serialize value of type ${typeof value}`);
}

export const SIGNED_HEADER_NAMES = [
  "License",
  "Content-Type",
  "Ari-Signed-At",
  "Ari-Key-Id",
  "Ari-Receipt-Id",
] as const;

export function composeSigningInput(
  canonicalPayload: string,
  headers: Record<string, string | undefined>,
): string {
  let out = canonicalPayload;
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = typeof v === "string" ? v : v == null ? undefined : String(v);
  }
  for (const name of SIGNED_HEADER_NAMES) {
    const v = lower[name.toLowerCase()];
    if (v == null) continue;
    out += "\n" + name + ": " + v;
  }
  return out;
}

export const RECEIPT_SIGNING_INPUT_PREFIX_V2 = "ari-receipts-v1\n";
export const RECEIPT_SPEC_HEADER_V1 = "ari-receipts/v1";
export const RECEIPT_SPEC_HEADER_V2 = "ari-receipts-v2";

export function composeSigningInputV2(
  canonicalPayload: string,
  headers: Record<string, string | undefined>,
): string {
  return RECEIPT_SIGNING_INPUT_PREFIX_V2 + composeSigningInput(canonicalPayload, headers);
}
