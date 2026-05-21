# Contributing

Thanks for the interest. This repository ships two reference MCP clients and the public wire spec. The internal API server, methodology, and scrapers live elsewhere and are intentionally not part of this project · pull requests that try to add them will be closed.

## What we accept

- Bug fixes in either client
- Improvements to the tool surface that any agent author would want
- Better install snippets for additional MCP hosts
- Documentation fixes, including the OpenAPI schema in [`spec/`](spec/)
- New test cases, especially for receipt verification edge cases
- Translations of the README into other languages

## What we will not accept

- Code that calls anything other than the documented public read endpoints
- Changes that loosen receipt verification by default
- New runtime dependencies without a clear justification
- Generated boilerplate, mass-produced documentation pull requests, or unsolicited rewrites

## Setup

```bash
git clone https://github.com/Antmanbuilds/ARI.git
cd ARI
```

### Node client

```bash
cd packages/ari-mcp-ts
npm install
npm test
npm run build
```

Requires Node 18 or newer. The build emits both ESM (`dist/`) and CJS (`dist-cjs/`) so any runtime can consume the package.

### Python client

```bash
cd packages/ari-mcp-py
python -m venv .venv
source .venv/bin/activate
pip install -e .
pip install pytest
pytest
```

Requires Python 3.10 or newer. The package is built with setuptools and uses `httpx` for HTTP and `cryptography` for Ed25519 verification.

## Pull request flow

1. Open an issue first for anything non-trivial · a five-line description is plenty
2. Branch from `main`
3. Keep commits small and use [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `docs:`, `chore:`, `test:`, `refactor:`)
4. Run both test suites locally before pushing
5. Open the pull request against `main` · CI will run both test suites on Node 20 + 22 and on Python 3.10 + 3.11 + 3.12 + 3.13
6. A maintainer will review within a few working days

The `main` branch is protected. Direct pushes are blocked; everything goes through pull requests with passing CI and at least one approving review.

## House style

- No em-dashes or en-dashes. Use a middle dot `·` for inline lists
- No exclamation marks, no emoji in code or commit messages
- Contractions are fine
- Comments explain why, not what
- Public-facing strings are professional and human · no marketing copy, no "we are excited"

## Release process

Maintainers tag a release with `git tag v0.X.Y && git push --tags`. The `release.yml` workflow builds both packages, runs the test suites again, publishes to npm with OIDC provenance, publishes to PyPI as a trusted publisher, and then publishes the `server.json` for each package to the official MCP registry. There are no long-lived publishing tokens checked in anywhere.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not file public issues for vulnerabilities.

## Code of conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under [Apache-2.0](LICENSE), the same license as the project.
