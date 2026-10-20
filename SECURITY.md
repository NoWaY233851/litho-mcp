# Security policy

## Supported versions

Only `main` is supported. litho-mcp has no releases: each deployment is built from a clone of `main`, so fixes land on `main` and reach a deployment when its owner redeploys.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: choose **Report a vulnerability** on this repository's security tab (see [GitHub's guide](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Please do not open a public issue, pull request or discussion about a vulnerability.

A useful report says what an attacker can do, gives the steps or the request that shows it, and names the commit you tested. The project has one maintainer, so replies are best effort. The report is discussed in its advisory, which is published once a fix is on `main`.

## Scope

Reports about this repository's code are in scope, especially:

- **The connector secret check** ([ADR 0009](docs/design/0009-connector-secret-header.md)): reaching the MCP endpoint without the connector secret or the cleanup endpoint without `CRON_SECRET`, or learning either secret from responses or timing.
- **SSRF-protected fetching** ([ADR 0007](docs/design/0007-reference-urls-ssrf.md)): making the server connect to a private, loopback, link-local or other non-public address, or getting past the size and format limits on reference images.
- **Blob storage** ([ADR 0010](docs/design/0010-vercel-blob-storage.md)): guessing or listing image URLs, storing something other than a checked image, or keeping images past the retention period.

Out of scope:

- Behavior described under [Security notes](README.md#security-notes), such as anyone who holds an image link being able to view that image.
- What someone who holds the connector secret can do with the deployment, including OpenRouter spending and Vercel quota use.
- Vulnerabilities in Vercel, OpenRouter, claude.ai or a dependency itself. Report those to their maintainers; how litho-mcp uses them is in scope.
