# Security policy

## Reporting a vulnerability

If you find a security issue in either MCP client (`ari-mcp` on npm or PyPI), in the published wire spec, or in the live ARI API at [agentrateindicators.com](https://agentrateindicators.com), please report it privately.

- Email · `security@agenticrates.org`
- PGP key · [https://agentrateindicators.com/.well-known/pgp-pubkey.asc](https://agentrateindicators.com/.well-known/pgp-pubkey.asc)
- Backup channel · open a [GitHub security advisory](https://github.com/Antmanbuilds/ARI/security/advisories/new) and we will respond from there

We aim to acknowledge new reports within 72 hours and to ship a fix or mitigation within 30 days for high-severity issues. Coordinated disclosure is welcome · let us know your preferred timeline in the first email and we will work to it.

Please do not open public GitHub issues for vulnerabilities. Please do not test for security issues against the live API by running attacks · the sandbox at `/api/v1/sandbox/probe` is rate-limited but open to anyone who wants to probe response shapes safely.

## Scope

In scope:

- The Node and Python MCP clients in this repository
- The Ed25519 receipt verification path, including key pinning and rotation
- The published OpenAPI schema in [`spec/openapi.yaml`](spec/openapi.yaml)
- Anything reachable from `https://agentrateindicators.com/api/v1/*`
- Anything served from `https://agentrateindicators.com/.well-known/*`

Out of scope:

- The internal FMV methodology, scraper adapters, and database schema (not in this repository)
- Third-party agent runtimes that embed the client (report to the runtime vendor)
- Best-practice nags without a working proof of concept

## Publisher signing key

The current publisher key is pinned at build time in both clients. The active key id and PEM are also served live:

- Pubkey JSON · [https://agentrateindicators.com/.well-known/ari-pubkey.json](https://agentrateindicators.com/.well-known/ari-pubkey.json)
- Pubkey PEM · [https://agentrateindicators.com/.well-known/ari-pubkey.pem](https://agentrateindicators.com/.well-known/ari-pubkey.pem)
- Canonicalization spec · [https://agentrateindicators.com/api/v1/spec/canonicalization](https://agentrateindicators.com/api/v1/spec/canonicalization)

A key rotation is announced one release in advance · the new id is added to the client's `ACCEPTED_KEY_IDS` list before the server starts signing with it, so existing installs keep verifying correctly until they upgrade.

## Hall of fame

Researchers who report a valid vulnerability and follow coordinated disclosure are credited at [agentrateindicators.com/security#hall-of-fame](https://agentrateindicators.com/security#hall-of-fame) unless they ask to remain anonymous.
