# FREE-06 report: one repository per product

Branch `claude/free-06-products` from `origin/codex/empire-world` at `e822739`. Author: Claude (Opus, Engineer role) in an isolated worktree. Status: design recorded first (this section), then implemented; see "Implementation" and "Evidence" below.

## The gap

Before FREE-06 every worker, worktree, queue task and client job ran in the office host's own repository (`cfg.dir`). Client labels in the consultancy were names only ([CONSULTANCY.md](../../CONSULTANCY.md)). The promise is "the limit is credits, not a fixed cap", so the company must be able to run several products side by side, each in its own repository.

## Design (recorded before coding)

### Products registry

- `src/server/products.ts`, persisted in `<dataDir>/products.json` (`{ version: 1, products: [...], creations: [timestamps] }`), atomic writes like the other journals.
- A product: `id`, `name`, `client?`, `dir` (absolute local path of the repo), `github?` (`owner/name`, read from the `origin` remote or from creation), `defaultBranch?`, `origin` (`linked` or `created`), `createdAt`, `createdBy`, optional `maxWorkers` (per-product concurrency cap).
- **The office repository is the built-in default product `office`.** It is never written to `products.json`. Anything saved without a `productId` (workers, queue tasks, consultancy jobs, chief plans) means `office`, so existing saves, the queue and existing worktrees are untouched and load unchanged.
- A missing `products.json` means "only the office product". A corrupt one is a recovery error: products cannot be linked or created until it is fixed, and the office product keeps working.

### Link or create (explicit CEO actions)

- **Link** an existing local repo or clone: an absolute path that is a git work tree top level, not the office repo, not inside or containing another product, not already linked. The office adds `.agent-office/` to that repo's `.git/info/exclude` (as for the office repo), because its worktrees live under `<repo>/.agent-office/worktrees`.
- **Create** a new GitHub repo in the user's account (or an organisation the user names as `owner/name`) through the GitHub CLI the office already uses (`gh`: the boards and the PR flow). No new credential is asked for or stored; `gh auth status` output is read only to say whether gh is signed in. `gh repo create <name> --private --add-readme --clone` runs in the products folder (`<dataDir>/products`, or `AGENT_EMPIRE_PRODUCTS_DIR`). Private by default; public only if the CEO ticks it.
- **Confirmation:** the API refuses a create unless the body repeats the exact repository name (`confirm`), and the UI shows a confirmation dialog saying it creates a repository on GitHub. Only the signed-in CEO's same-origin HTTP request can create; no model, chief, Telegram command or queue path calls it.
- **Throttle** (GitHub secondary limits, FREE_STACK §8: about 80 content-creating requests a minute, 500 an hour): at most `AGENT_EMPIRE_REPO_CREATES_PER_HOUR` creations per rolling hour (default 3, max 20), at least 60 s apart, one at a time. Attempts are recorded before `gh` runs and persisted, so a restart does not reset the window. A refusal says when the next one is allowed.
- **Unlink** removes the registry entry only; it never deletes the folder or the GitHub repo. It is refused while a worker or an unfinished queue task uses the product.

### Jobs, queue and workers

- `ConsultancyCreateInput.productId?`, stored on the job (in the fingerprint only when set, so old fingerprints still match), validated against the registry, passed to the queue for every item.
- `QueueTask.productId?` / `productName?`; `TaskQueue.add(..., { productId })`. Seating passes the product to `WorkerManager.spawn`. An unlinked product fails the task with a clear message instead of falling back to the office repo.
- `WorkerInfo.productId?` / `productName?`. The worker's cwd and worktree come from the product's repo: `WorkerManager` keeps one `Worktrees` per repo. Worktree paths stay relative to that repo, so inspect, remove, the PR flow and prune work per product.
- Continuity (LIFE-04): a continuing task looks up its predecessor's branch in its own product's repo; a dependency from another product therefore starts from HEAD with the existing factual note.
- Dependencies and budgets (ORG-02) are per job, so they are already per product. Per-product concurrency: an optional `maxWorkers` on a product, checked by the queue next to the global limit.
- The chief's plan request can carry `productId`; the resulting plan is still a pending proposal the CEO approves.

### Isolation (what it is and is not)

A worker for product A runs with its cwd in A's repo (or A's worktree) and gets A's branch; it is never handed B's path, and B's worktrees live in B's repo. This is **working-directory separation, not a sandbox**: the worker process runs as the same OS user and could read other folders it is told about. Real isolation needs separate OS users or containers (a later milestone).

### UI

- Settings → **Products** panel: list (the default office product first, then linked/created ones, GitHub name, branch, folder present or missing, workers and unfinished tasks per product), link a local repo, create a GitHub repo (confirmation dialog, throttle message), unlink (confirmation), optional per-product worker cap.
- A product chooser on the hire dialog and the founder desk brief (shown only when more than one product exists).
- The product name on worker cards and queue rows when it is not the office product.

### Cloud mode

Cloud execution still uses only the first selected project (cloud-exec-setup.md). FREE-06 does not change cloud mode; multi-product cloud execution is recorded as part of FREE-07.

### Tests (fakes only; no network, no real repos on GitHub)

Registry persistence and old-save compatibility; job → product → worktree binding; isolation (cwd per product); creation throttle, confirmation and a fake `gh`; the default product unchanged. UI check `tools/products-ui-check.ts` (refuses 4610), screenshots under `docs/team/reports/free-06/` at 1440x900 and 874x402.
