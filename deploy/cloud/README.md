# Dedicated VPS deployment

This recipe prepares one private, single-owner Agent Empire host. VPS hosting is an optional execution mode; the current product direction prefers supported provider-hosted cloud tasks and lets users choose their own VPS. No purchase is planned by default. If selected, this must be a separate VPS for Agent Empire. Do not deploy on Vantage, reuse its VM, or change its DNS, HTTPS routing, service accounts or credentials. It does not purchase a machine, configure DNS, transfer your current laptop save or start provider jobs automatically. Use a dedicated service account/project because coding agents execute commands on this host. Never mount the Docker socket or unrelated home directories.

## Initial server sizing

Proposed pilot: x86-64 Linux, 4 vCPUs, 8 GiB RAM and at least 80 GiB SSD, with one or two concurrent coding jobs initially. This is a starting estimate, not a measured concurrency guarantee; agent builds and tests determine capacity. Graphics render on the client, so the host does not require a graphics GPU for the current application. Increase resources or split runners after measuring job memory and CPU. AI provider usage, backups, taxes and any domain charges are separate from the VPS base price.

Only if VPS mode is selected: provider, region, final configuration and recurring budget must be settled before purchase. No server has been ordered. See [execution setup](../../docs/EXECUTION_SETUP.md) for the provider-hosted and local alternatives.

## Prepare

Use a maintained Linux host with Docker/Compose, Git, persistent disk and an HTTPS domain. Clone the desired project on that host. Preserve `.git` and `.agent-office` together; worker worktree metadata refers to that project. Make the project writable by container UID 1000. Review disk space for assets, worktrees, checkpoints and full Git bundles.

From an Agent Empire checkout, set `EMPIRE_PROJECT_DIR` to that project and supply a strong `AGENT_OFFICE_PASSWORD` through a protected environment/secret manager. The compose recipe reads an optional `ANTHROPIC_API_KEY`; leave it unset until provider setup is intentionally completed. It defaults to a $10/day warning/new-hire gate. That gate does not forcibly terminate a currently running expensive job, so also configure provider account limits.

```sh
docker compose -f deploy/cloud/compose.yaml build
docker compose -f deploy/cloud/compose.yaml up -d
```

The application is bound to **127.0.0.1:4600** on the host. Test `/api/health` locally, then configure Caddy using `Caddyfile.example` with the actual domain. Add `command: ["--host", "0.0.0.0", "--port", "4600", "--trust-proxy"]` to the service when the trusted local reverse proxy is in use. Never expose the plain HTTP application port to the Internet. Caddy must preserve the original Host and handle HTTPS; the application uses same-origin session cookies and checks mutation origins.

The image runs as the unprivileged `node` user with a pinned Claude Code package. Login/API configuration and Git author/repository credentials must be set on this host without baking them into the image. Agent permission prompts remain interactive. The image does not include every build tool that arbitrary project tasks might require; extend it deliberately for the chosen project.

## Persistence and recovery

The project bind mount keeps code, `.git`, worktrees and `.agent-office` across container replacement. The `agent-home` volume keeps the provider's home/configuration; back it up as secret-bearing data. `restart: unless-stopped` restarts the service, but interrupted workers are not silently retried. Check [recovery](../../docs/RECOVERY.md) and [continuity](../../docs/CONTINUITY.md) before restarting a busy host.

Back up project and agent-home while the service is stopped for a consistent backup. Stop through Compose, preserve the volumes, snapshot/copy them, then start and review interrupted jobs. Test a restore into a separate host before relying on the backup. Do not run two instances on the same data directory; the local lock is not a distributed lease.

For upgrades, preserve the volumes and project, build the reviewed revision and recreate only this service during a maintenance window. There is no unattended deployment or auto-migration of a running laptop session in this recipe. Checkpoint history supplements operational saves; it does not make separate worker/queue/economy writes into a multi-file transaction.
