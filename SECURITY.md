# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Billioncodes001/agent-empire/security/advisories/new)). Do not open a public issue, discussion or pull request for a security problem.

Include what you found, the version or commit, how to reproduce it, and the impact you expect. Leave real credentials out of the report; describe them instead.

You should get an acknowledgement within 7 days. We will agree a disclosure date with you, credit you in the advisory if you want, and publish a fix before details become public.

## Supported versions

Only the latest release (including the latest pre-release) receives security fixes.

## What is in scope

- The office server and its sign-in, device tokens, WebSocket and terminal handling (`src/server`).
- The browser game, installed web app (service worker) and desktop, Android and iOS shells.
- The release pipeline: update signing (Ed25519 channel and manifest signatures), `release.yml`, the in-app updaters.
- Cloud mode: the generated GitHub Actions workflow and how provider keys are sealed into Actions secrets.

Out of scope: your own office host's operating system, third-party model providers, and findings that need an already-compromised device or office password.

## How the project protects secrets

- Release signing keys exist only as secrets of the GitHub Environment `release`, which only `v*` tag runs may use. Fork pull requests never receive them, and the release workflow has no `pull_request` trigger.
- Builds trust only the pinned release public key. The development key is rejected by release builds.
- The web app's service worker never stores API responses, terminal output, snapshots or credentials.
