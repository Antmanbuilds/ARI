// SPDX-License-Identifier: Apache-2.0
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jcs, composeSigningInput } from "../src/canonical.js";

describe("jcs canonicalization (mirror of ari-verify)", () => {
  it("sorts keys lexicographically", () => {
    assert.equal(jcs({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("drops undefined and preserves null", () => {
    assert.equal(jcs({ a: 1, b: undefined, c: null }), '{"a":1,"c":null}');
  });

  it("rejects NaN and Infinity", () => {
    assert.throws(() => jcs(NaN));
    assert.throws(() => jcs(Infinity));
  });

  it("encodes bigint as JSON string (ari-receipts/v1 large-int rule)", () => {
    assert.equal(jcs({ id: 9007199254740993n }), '{"id":"9007199254740993"}');
  });

  it("rejects non-JSON object types", () => {
    assert.throws(() => jcs(new Date()));
    assert.throws(() => jcs(new Map([["a", 1]])));
  });
});

describe("composeSigningInput", () => {
  it("appends signed headers in fixed order, skipping missing", () => {
    const input = composeSigningInput('{"a":1}', {
      License: "BUSL-1.1; change-date=2030-04-25",
      "Content-Type": "application/json",
      "Ari-Signed-At": "2026-04-25T12:00:00Z",
      "Ari-Key-Id": "ari-deadbeef0000",
      "Ari-Receipt-Id": "01HZX",
    });
    assert.equal(
      input,
      '{"a":1}\nLicense: BUSL-1.1; change-date=2030-04-25\nContent-Type: application/json\nAri-Signed-At: 2026-04-25T12:00:00Z\nAri-Key-Id: ari-deadbeef0000\nAri-Receipt-Id: 01HZX',
    );
  });

  it("skips missing headers", () => {
    const input = composeSigningInput('"x"', {
      License: "BUSL-1.1",
      "Ari-Key-Id": "ari-x",
    });
    assert.equal(input, '"x"\nLicense: BUSL-1.1\nAri-Key-Id: ari-x');
  });
});
