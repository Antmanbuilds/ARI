# Verifying an ARI receipt

This is a step-by-step walkthrough for verifying a receipt by hand. The reference clients do this for you · this page exists so that anyone porting the verifier to another language has an unambiguous reference.

## Quick path · use a published client

```bash
# Node
npx ari-mcp verify --url https://agentrateindicators.com/api/v1/pubkey

# Python
uvx ari-mcp verify --url https://agentrateindicators.com/api/v1/pubkey
```

Both print a one-line `OK` or a structured failure with the reason.

## Long path · verify by hand in Node

```ts
import { canonicalize } from "ari-mcp/canonical";
import { ed25519 } from "@noble/ed25519";
import { createHash } from "node:crypto";

const res = await fetch("https://agentrateindicators.com/api/v1/pubkey");
const body = await res.text();
const headers = {
  receiptId:     res.headers.get("ari-receipt-id"),
  signedAt:      res.headers.get("ari-signed-at"),
  canonicalHash: res.headers.get("ari-canonical-hash"),
  keyId:         res.headers.get("ari-key-id"),
  signature:     res.headers.get("ari-signature"),
};

// 1. Canonicalize
const canonical = canonicalize(JSON.parse(body));
const canonicalBytes = new TextEncoder().encode(canonical);

// 2. Hash check
const hashHex = createHash("sha256").update(canonicalBytes).digest("hex");
if (hashHex !== headers.canonicalHash) throw new Error("hash mismatch");

// 3. Signing input
const signingInput = new TextEncoder().encode(
  `Ari-Receipt-Id: ${headers.receiptId}\n` +
  `Ari-Signed-At: ${headers.signedAt}\n` +
  `Ari-Canonical-Hash: ${headers.canonicalHash}\n` +
  `Ari-Key-Id: ${headers.keyId}`
);

// 4. Resolve key (in production, look up keyId in a pinned map)
const pubkeyRes = await fetch("https://agentrateindicators.com/.well-known/ari-pubkey.pem");
const pem = await pubkeyRes.text();
const pubKey = pemToRawEd25519(pem); // 32 raw bytes

// 5. Verify
const sig = Buffer.from(headers.signature, "base64");
const ok = await ed25519.verify(sig, signingInput, pubKey);
if (!ok) throw new Error("bad signature");
```

## Long path · verify by hand in Python

```python
import base64, hashlib, json, httpx
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from ari_mcp.canonical import jcs

res = httpx.get("https://agentrateindicators.com/api/v1/pubkey")
body = res.text
h = {
    "receiptId":     res.headers["ari-receipt-id"],
    "signedAt":      res.headers["ari-signed-at"],
    "canonicalHash": res.headers["ari-canonical-hash"],
    "keyId":         res.headers["ari-key-id"],
    "signature":     res.headers["ari-signature"],
}

canonical_bytes = jcs(json.loads(body)).encode()
assert hashlib.sha256(canonical_bytes).hexdigest() == h["canonicalHash"]

signing_input = (
    f"Ari-Receipt-Id: {h['receiptId']}\n"
    f"Ari-Signed-At: {h['signedAt']}\n"
    f"Ari-Canonical-Hash: {h['canonicalHash']}\n"
    f"Ari-Key-Id: {h['keyId']}"
).encode()

pem = httpx.get("https://agentrateindicators.com/.well-known/ari-pubkey.pem").content
pubkey = load_pem_public_key(pem)
pubkey.verify(base64.b64decode(h["signature"]), signing_input)
```

## Failure modes worth handling

| Symptom | Likely cause |
| --- | --- |
| Hash mismatch | Body was re-serialized somewhere along the path (a proxy reformatted JSON). Verify against the raw response bytes, not a re-stringified parsed object. |
| Unknown key id | Client is older than a key rotation. Upgrade the client or extend its `ACCEPTED_KEY_IDS` list. |
| Bad signature, hash OK | Public key encoding mismatch (PEM vs raw 32 bytes) or the wrong key for the given `Ari-Key-Id`. |
| Missing headers | The response was served from a non-signing path (sandbox / static asset / error page). Only `/api/*` JSON responses are signed. |
| Clock skew failure | If you enforce max age on `Ari-Signed-At`, allow at least 5 minutes of skew. |

## Test vectors

The reference clients ship cross-language test vectors. They are deliberately exhaustive on the integer-boundary edge cases described in [signed-receipts.md](signed-receipts.md). If you port the verifier, run those vectors through your implementation before trusting it.
