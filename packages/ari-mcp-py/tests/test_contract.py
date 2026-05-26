# SPDX-License-Identifier: Apache-2.0
"""Cross-language contract tests.

Drives every MCP tool against the canned API fixtures in
``tools/fixtures/mcp-contract.json``. The Node test suite at
``tools/ari-mcp-ts/test/contract.test.ts`` consumes the SAME file and
asserts the SAME ``expect`` shape · this is the bar that catches Node
↔ Python behaviour drift before a release.

Receipt headers are stamped onto every stub response and stripped from
the comparison so the expected shapes do not have to repeat them.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from ari_mcp.client import AriResponse
from ari_mcp.tools import TOOLS

FIXTURE = (
    pathlib.Path(__file__).resolve().parents[2] / "fixtures" / "mcp-contract.json"
)


def _load_cases() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = json.loads(FIXTURE.read_text())
    return raw["receipt"], raw["cases"]


RECEIPT, CASES = _load_cases()


class StubClient:
    """Minimal AriClient stand-in · returns canned responses in order
    and asserts the tool hit the path the fixture expected."""

    def __init__(self, responses: list[dict[str, Any]]):
        self._queue = list(responses)
        self.base_url = "https://stub.test"

    def request(
        self,
        path: str,
        method: str = "GET",
        json: Any = None,
        params: Any = None,
    ) -> AriResponse:
        assert self._queue, f"Tool made an unexpected request to {path}"
        expected = self._queue.pop(0)
        assert path == expected["path"], (
            f"Tool requested {path!r}, fixture expected {expected['path']!r}"
        )
        expected_method = expected.get("method", "GET")
        assert method == expected_method, (
            f"Tool used method {method}, fixture expected {expected_method}"
        )
        return AriResponse(
            data=expected["body"],
            receipt_id=RECEIPT["receipt_id"],
            signed_at=RECEIPT["signed_at"],
        )


def _tool(name: str):
    for t in TOOLS:
        if t.name == name:
            return t
    raise AssertionError(f"tool {name} not registered")


def test_fixture_covers_every_registered_tool() -> None:
    """Every tool registered in TOOLS must have at least one contract
    case. Without this guard, adding a new tool would silently bypass
    the cross-language parity check."""
    covered = {c["tool"] for c in CASES}
    registered = {t.name for t in TOOLS}
    missing = registered - covered
    assert not missing, (
        f"contract fixture is missing cases for tools: {sorted(missing)}"
    )


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_contract(case: dict[str, Any]) -> None:
    client = StubClient(case["responses"])
    result = _tool(case["tool"]).run(case["input"], client)
    for key, expected_value in case["expect"].items():
        assert key in result, f"missing key {key!r} in result for {case['name']}"
        actual = result[key]
        # JSON has no integer/float distinction · normalise numeric
        # equality so 0 and 0.0 compare equal across languages.
        if isinstance(expected_value, (int, float)) and isinstance(actual, (int, float)):
            assert float(actual) == float(expected_value), (
                f"{case['name']}: {key} = {actual!r}, expected {expected_value!r}"
            )
        else:
            assert actual == expected_value, (
                f"{case['name']}: {key} = {actual!r}, expected {expected_value!r}"
            )
