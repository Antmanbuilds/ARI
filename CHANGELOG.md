# Changelog

All notable changes to the ARI MCP clients are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] · 2026-05-21

### Fixed

- Added the top-level `mcpName` field to `ari-mcp`'s npm `package.json` so the public MCP registry accepts the npm package as the canonical source for `io.github.Antmanbuilds/ari-mcp`
- Added the `mcp-name: io.github.Antmanbuilds/ari-mcp-py` marker line to `ari-mcp-py`'s PyPI `README.md` so the registry accepts the PyPI package as the canonical source for `io.github.Antmanbuilds/ari-mcp-py`

### Changed

- Bumped both `ari-mcp` (npm) and `ari-mcp-py` (PyPI) to 0.1.3 with matching `server.json` entries so the registry submission resolves cleanly

## [0.1.2] · 2026-05-21

### Changed

- Renamed npm package from the previous scoped name to unscoped `ari-mcp` so `npx -y ari-mcp` installs without an organization prefix
- Updated repository metadata in both `package.json` and `pyproject.toml` to point at `github.com/Antmanbuilds/ARI`
- Refreshed the embedded publisher key with the live production key id `ari-aedbd75d43c8`

### Added

- Public reference implementation repository at `github.com/Antmanbuilds/ARI`
- OpenAPI 3.1 schema for the public read endpoints under [`spec/openapi.yaml`](spec/openapi.yaml)
- Signed-receipt verification spec under [`spec/signed-receipts.md`](spec/signed-receipts.md)
- `server.json` for each package, ready for the official MCP registry
- GitHub Actions CI that runs both test suites on Node 20/22 and Python 3.10/3.11/3.12/3.13
- GitHub Actions release workflow that publishes to npm (OIDC provenance), PyPI (trusted publisher), and the MCP registry on tag push

## [0.1.1] · 2026-05-21

### Added

- Apache-2.0 LICENSE file shipped in both package tarballs
- Build-time pinned publisher key with no first-call trust-on-first-use window for the default base URL
- `--insecure-skip-pin` flag for operators rolling through a key rotation

### Fixed

- Honest-null contract for every tool that surfaces a price · MCP responses now return `null` instead of `0` when no FMV is available

## [0.1.0] · 2026-04-25

### Added

- Initial public release of `ari-mcp` for Node (npm) and Python (PyPI)
- Ten MCP tools: `is_fair_price`, `refuse_if_overpriced`, `get_fmv`, `get_service`, `list_services`, `get_leaderboard`, `recent_observations`, `verify_receipt`, `get_signed_receipt`, `subscribe_alert`
- Ed25519 receipt verification per the `ari-receipts/v1` canonicalization profile
- Both stdio and streamable-HTTP transports
- `ari-mcp install` command that prints a host-specific config snippet for Claude Desktop, Cursor, Continue, Windsurf, Zed, ChatGPT desktop, and Gemini CLI

[0.1.3]: https://github.com/Antmanbuilds/ARI/releases/tag/v0.1.3
[0.1.2]: https://github.com/Antmanbuilds/ARI/releases/tag/v0.1.2
[0.1.1]: https://github.com/Antmanbuilds/ARI/releases/tag/v0.1.1
[0.1.0]: https://github.com/Antmanbuilds/ARI/releases/tag/v0.1.0
