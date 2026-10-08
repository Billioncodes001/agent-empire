/**
 * CLOUD-06 slice 06-3: the repository helper shipped into every OpenAI-hosted sandbox (`environment.files`, inline,
 * well under the 5 MiB limit) as /workspace/.agent-empire/ae-repo.mjs.
 *
 * Why it exists: the Agents API has no GitHub repository mount, and the project token must never be visible in the
 * sandbox (owner decision D2). The token lives in an OpenAI vault as an `environment_variable` credential bound to
 * api.github.com: the sandbox sees only a placeholder in AE_GITHUB_TOKEN, and OpenAI's egress proxy substitutes the real
 * value in HTTPS headers sent to api.github.com. So the helper talks only to the GitHub REST API:
 *
 *   fetch    GET /repos/{o}/{r}/tarball/{sourceCommit} → extract into /workspace/repo → local baseline commit (tag
 *            ae-baseline) so the agent can `git diff`. (setup_commands; a nonzero exit prevents the sandbox starting)
 *   publish  every change since the baseline → Git Data API blobs, a tree on the source commit's tree, a commit whose
 *            parent is the task branch head (or sourceCommit for the first publish), and the task ref, created or
 *            fast-forwarded with force=false. Refuses any ref other than agent-empire/task-<uuid>.
 *
 * UNVERIFIED until the first real run (spike U3): that the placeholder is substituted for these calls, and that the
 * tarball redirect to codeload.github.com (which needs network but no secret) succeeds. U4 (`git push` through the proxy)
 * is not relied on.
 *
 * The script is plain ES2022 JavaScript kept as a string, so the exact bytes the sandbox runs are what the tests import
 * (tests/openai-repo-helper.test.ts) with injected fakes for fetch, tar and git. It has no dependencies.
 */
export const HELPER_PATH = '/workspace/.agent-empire/ae-repo.mjs';
export const HELPER_SETUP_COMMAND = `node ${HELPER_PATH} fetch`;

export const HELPER_SOURCE = String.raw`// Agent Empire repository helper (CLOUD-06). Usage: node ae-repo.mjs fetch|publish
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TASK_BRANCH = /^agent-empire\/task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LIMITS = { fileBytes: 10 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, files: 2000 };
const API = 'https://api.github.com';

export function config(env) {
  const [owner, name, extra] = String(env.AE_REPO || '').split('/');
  if (!owner || !name || extra !== undefined || !/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error('AE_REPO must be owner/name.');
  const sourceCommit = String(env.AE_SOURCE_COMMIT || '');
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('AE_SOURCE_COMMIT must be a commit SHA.');
  const branch = String(env.AE_TASK_BRANCH || '');
  if (!TASK_BRANCH.test(branch)) throw new Error('Refusing: only an agent-empire/task-<id> branch can be published.');
  return { owner, name, sourceCommit, branch, token: String(env.AE_GITHUB_TOKEN || ''), dir: String(env.AE_REPO_DIR || '/workspace/repo') };
}

const headers = (cfg, json) => ({ authorization: 'Bearer ' + cfg.token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(json ? { 'content-type': 'application/json' } : {}) });

async function gh(deps, cfg, method, path, body) {
  const res = await deps.fetch(API + path, { method, headers: headers(cfg, body !== undefined), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) { const error = new Error('GitHub ' + method + ' ' + path.split('?')[0] + ' failed with HTTP ' + res.status + '.'); error.status = res.status; throw error; }
  return data;
}

/** Repository-relative, normalized, never escaping the checkout or touching .git. */
export function safePath(path) {
  const p = normalize(String(path)).replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p === '..' || p.startsWith('../') || p.split('/').includes('.git') || p.includes('\0')) throw new Error('Refusing unsafe path ' + JSON.stringify(String(path).slice(0, 200)) + '.');
  return p;
}

export async function fetchRepo(deps, env) {
  const cfg = config(env);
  const res = await deps.fetch(API + '/repos/' + cfg.owner + '/' + cfg.name + '/tarball/' + cfg.sourceCommit, { headers: headers(cfg, false), redirect: 'follow' });
  if (!res.ok) throw new Error('Downloading the repository snapshot failed with HTTP ' + res.status + '.');
  const archive = new Uint8Array(await res.arrayBuffer());
  deps.extract(archive, cfg.dir);
  deps.git(cfg.dir, ['init', '-q']);
  deps.git(cfg.dir, ['add', '-A']);
  deps.git(cfg.dir, ['-c', 'user.name=Agent Empire', '-c', 'user.email=agent-empire@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'Agent Empire baseline ' + cfg.sourceCommit]);
  deps.git(cfg.dir, ['tag', '-f', 'ae-baseline']);
  return { status: 'fetched', dir: cfg.dir, sourceCommit: cfg.sourceCommit, bytes: archive.length };
}

export async function publish(deps, env, message) {
  const cfg = config(env);
  const changes = deps.changes(cfg.dir);
  if (!changes.length) return { status: 'nothing_to_publish', branch: cfg.branch };
  if (changes.length > LIMITS.files) throw new Error('Refusing to publish ' + changes.length + ' files; the limit is ' + LIMITS.files + '.');
  const repo = '/repos/' + cfg.owner + '/' + cfg.name;
  const base = await gh(deps, cfg, 'GET', repo + '/git/commits/' + cfg.sourceCommit);
  if (!base || !base.tree || typeof base.tree.sha !== 'string') throw new Error('GitHub did not return the source commit tree.');
  const tree = [];
  let total = 0;
  for (const change of changes) {
    const path = safePath(change.path);
    if (change.deleted) { tree.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
    const file = deps.read(cfg.dir, path);
    if (file.symlink) throw new Error('Refusing to publish symbolic link ' + path + '.');
    if (file.bytes.length > LIMITS.fileBytes) throw new Error(path + ' is larger than ' + LIMITS.fileBytes + ' bytes.');
    total += file.bytes.length;
    if (total > LIMITS.totalBytes) throw new Error('The change is larger than ' + LIMITS.totalBytes + ' bytes in total.');
    const blob = await gh(deps, cfg, 'POST', repo + '/git/blobs', { content: Buffer.from(file.bytes).toString('base64'), encoding: 'base64' });
    tree.push({ path, mode: file.executable ? '100755' : '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(deps, cfg, 'POST', repo + '/git/trees', { base_tree: base.tree.sha, tree });
  let head = null;
  try { const ref = await gh(deps, cfg, 'GET', repo + '/git/ref/heads/' + cfg.branch); head = ref && ref.object ? ref.object.sha : null; }
  catch (error) { if (error.status !== 404) throw error; }
  const parent = head || cfg.sourceCommit;
  const commit = await gh(deps, cfg, 'POST', repo + '/git/commits', { message: message || 'Agent Empire task work', tree: newTree.sha, parents: [parent] });
  if (head) await gh(deps, cfg, 'PATCH', repo + '/git/refs/heads/' + cfg.branch, { sha: commit.sha, force: false });
  else await gh(deps, cfg, 'POST', repo + '/git/refs', { ref: 'refs/heads/' + cfg.branch, sha: commit.sha });
  return { status: 'published', branch: cfg.branch, commit: commit.sha, parent, files: changes.length };
}

/** Real sandbox dependencies: global fetch, the tar and git CLIs, and the filesystem. */
export const systemDeps = {
  fetch: (...args) => fetch(...args),
  extract(archive, dir) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync('tar', ['-xzf', '-', '--strip-components=1', '-C', dir], { input: archive });
    if (r.status !== 0) throw new Error('Extracting the repository snapshot failed.');
  },
  git: (dir, args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(),
  changes(dir) {
    execFileSync('git', ['-C', dir, 'add', '-A']);
    const out = execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-status', '--no-renames', '-z', 'ae-baseline']).toString().split('\0').filter(Boolean);
    const list = [];
    for (let i = 0; i + 1 < out.length; i += 2) list.push({ path: out[i + 1], deleted: out[i] === 'D' });
    return list;
  },
  read(dir, path) {
    const full = join(dir, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return { symlink: true, bytes: new Uint8Array() };
    return { bytes: readFileSync(full), executable: (stat.mode & 0o111) !== 0 };
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const run = command === 'fetch' ? fetchRepo(systemDeps, process.env) : command === 'publish' ? publish(systemDeps, process.env, process.argv[3]) : Promise.reject(new Error('usage: ae-repo.mjs fetch|publish'));
  run.then((result) => { console.log(JSON.stringify(result)); }, (error) => { console.error('ae-repo: ' + (error && error.message ? error.message : 'failed')); process.exitCode = 1; });
}
`;

/** Base64 of the helper, for `environment.files` (UNVERIFIED field shape; see openai-adapter.ts). */
export function helperBase64(): string {
  const bytes = new TextEncoder().encode(HELPER_SOURCE);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
