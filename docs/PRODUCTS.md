# Products: one repository per product

The office can run several products at once, each in its own git repository. The limit is credits and workstations, not a fixed number of repositories.

## The default product

The repository the office was started in (`agent-empire [dir]`) is the built-in **office** product. Everything saved before products existed (workers, queue tasks, client jobs, chief plans) belongs to it, and nothing about it changes.

## Adding a product (Settings → Products)

- **Link an existing repository.** Give a name, an optional client and the absolute path of a git repository (or clone) on the office host. It must be the repository's top folder, not the office repository, and not inside or around another product. The office adds `.agent-office/` to that repository's `.git/info/exclude`, because workers' worktrees for this product live under `<repo>/.agent-office/worktrees`.
- **Create a new GitHub repository.** Give a name, an optional client and a repository name (`name`, or `org/name` for an organisation you own). The office uses the GitHub CLI (`gh`) that is already signed in on the office host; it never asks for or stores GitHub credentials. If gh is not signed in, run `gh auth login` on the host. You confirm by typing the repository name. Repositories are **private** unless you tick Public. The new repository is cloned into `<office>/.agent-office/products/<name>` (or `AGENT_EMPIRE_PRODUCTS_DIR`).
- **Creation limits.** To stay far below GitHub's secondary rate limits (about 80 content-creating requests a minute and 500 an hour) and its rules on mass repository creation, the office creates at most `AGENT_EMPIRE_REPO_CREATES_PER_HOUR` repositories per rolling hour (default 3, at most 20), at least a minute apart, one at a time. Failed attempts count too. The limit survives restarts.
- Only you can link or create, from the signed-in page. No model, chief proposal, Telegram command or queue task creates repositories.
- **Unlink** forgets a product. It never deletes the folder or the GitHub repository, and is refused while a worker or an unfinished queue task uses the product.
- **Worker cap.** A product may have its own cap on busy queue workers (the global queue limit still applies). Tasks over the cap wait in the queue with the reason.

## Working in a product

- **Hire dialog:** when there is more than one product, choose the product; the worker runs in that repository (or its own worktree inside it).
- **Founder desk:** a new client brief can name a product; every item of the job runs in it. A chief plan request can name a product too; the plan is still a proposal you approve.
- Worker cards and queue rows show `📦 <product>` for anything outside the office product.
- A continuing task (LIFE-04) starts from its predecessor's branch only when both are in the same product.
- If a product is unlinked while tasks still name it, those tasks fail with a clear message. They never run in another repository.

## Isolation: what it is and is not

A worker for one product is started in that product's repository and is never given another product's path. This is **separate working directories on one host, not a sandbox**: workers run as the same OS user. Do not rely on it to keep untrusted clients' code apart; that needs separate OS users or machines.

## Cloud mode

Cloud execution (the Empire in your own GitHub state repository) still uses only the first selected project. Products apply to the office server only; multi-product cloud execution is part of FREE-07.
