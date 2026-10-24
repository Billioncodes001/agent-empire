import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic } from './persistence.js';
import { excludeFromGit } from './config.js';
import { OFFICE_PRODUCT_ID, validRepoName, type ProductInfo, type ProductsState } from '../shared/products.js';

export { OFFICE_PRODUCT_ID } from '../shared/products.js';

/**
 * FREE-06 products registry: one repository per product. The office repository is the built-in `office` product and is
 * never written to products.json, so saves made before FREE-06 (no productId anywhere) load unchanged.
 */

const FILE = 'products.json';
const MAX_PRODUCTS = 200;
const HOUR_MS = 3_600_000;
/** Spacing between repository creations: far below GitHub's ~80 content-creating requests a minute. */
export const MIN_CREATE_GAP_MS = 60_000;
export const DEFAULT_CREATES_PER_HOUR = 3;
export const MAX_CREATES_PER_HOUR = 20;

export class ProductError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ProductError';
  }
}

interface StoredProduct {
  id: string;
  name: string;
  client?: string;
  dir: string;
  github?: string;
  defaultBranch?: string;
  origin: 'linked' | 'created';
  private?: boolean;
  createdAt: number;
  createdBy: string;
  maxWorkers?: number;
}

/** Runs the GitHub CLI the office already uses (boards, PRs). Tests inject a fake: nothing reaches GitHub. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>;

export interface ProductsOptions {
  dataDir: string;
  /** The office host repository: the default product. */
  officeDir: string;
  officeName: string;
  /** Where created repositories are cloned (default <dataDir>/products). */
  productsDir?: string;
  perHour?: number;
  gh?: GhRunner;
  now?: () => number;
  /**
   * Live use per product, for the panel and the unlink guard: workers bound, unfinished queue tasks, and client jobs or
   * chief plans that could still queue work in it (pending approval, approved and unfinished, plans being drafted).
   */
  usage?: (id: string) => { workers: number; openTasks: number; openJobs?: number };
  /** Folders a product may never be (or contain): tests pass a fake home. Default: os.homedir(). */
  home?: string;
}

const defaultGh: GhRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile('gh', args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'GitHub CLI (gh) is not installed on the office host' : msg || 'gh failed'));
    } else resolve(stdout);
  });
});

export function perHourFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_EMPIRE_REPO_CREATES_PER_HOUR);
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_CREATES_PER_HOUR, Math.floor(n)) : DEFAULT_CREATES_PER_HOUR;
}

export class Products {
  private readonly file: string;
  private products: StoredProduct[] = [];
  private creations: number[] = [];
  /** Ids of unlinked products. Never reused, so old jobs, plans and tasks can never land in a different repository. */
  private retired: string[] = [];
  private storageError?: string;
  private inFlight = false;
  readonly productsDir: string;
  readonly perHour: number;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private readonly officeDir: string;

  constructor(private readonly opts: ProductsOptions) {
    this.file = path.join(opts.dataDir, FILE);
    this.officeDir = real(opts.officeDir);
    this.productsDir = path.resolve(opts.productsDir ?? path.join(opts.dataDir, 'products'));
    this.perHour = Math.max(1, Math.min(MAX_CREATES_PER_HOUR, Math.floor(opts.perHour ?? DEFAULT_CREATES_PER_HOUR)));
    this.gh = opts.gh ?? defaultGh;
    this.now = opts.now ?? Date.now;
    this.restore();
  }

  get recoveryError() { return this.storageError; }

  /** The repository a product's workers run in; undefined for an unknown (or unlinked) product. Absent id = office. */
  dir(id?: string): string | undefined {
    if (id === undefined || id === OFFICE_PRODUCT_ID) return this.opts.officeDir;
    return this.products.find((p) => p.id === id)?.dir;
  }

  name(id?: string): string | undefined {
    if (id === undefined || id === OFFICE_PRODUCT_ID) return this.opts.officeName;
    return this.products.find((p) => p.id === id)?.name;
  }

  has(id: string): boolean { return id === OFFICE_PRODUCT_ID || this.products.some((p) => p.id === id); }

  maxWorkers(id?: string): number | undefined {
    if (id === undefined || id === OFFICE_PRODUCT_ID) return undefined;
    return this.products.find((p) => p.id === id)?.maxWorkers;
  }

  /** Why a request naming this product cannot proceed, or undefined. */
  problem(id: unknown): string | undefined {
    if (id === undefined) return undefined;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) return 'productId is invalid';
    return this.has(id) ? undefined : `No such product: ${id}. Link or create it under Settings → Products first.`;
  }

  list(): ProductInfo[] {
    const use = (id: string) => this.opts.usage?.(id) ?? { workers: 0, openTasks: 0 };
    const office: ProductInfo = {
      id: OFFICE_PRODUCT_ID, name: this.opts.officeName, dir: this.opts.officeDir, origin: 'office', createdAt: 0, createdBy: 'office',
      github: githubOf(remoteOf(this.opts.officeDir)), defaultBranch: branchOf(this.opts.officeDir), present: isRepo(this.opts.officeDir), ...use(OFFICE_PRODUCT_ID),
    };
    return [office, ...this.products.map((p) => ({ ...p, present: isRepo(p.dir), ...use(p.id) }))];
  }

  state(): ProductsState {
    const t = this.now();
    const recent = this.creations.filter((c) => t - c < HOUR_MS);
    return {
      products: this.list(),
      creation: { perHour: this.perHour, usedThisHour: recent.length, nextAllowedAt: this.nextAllowedAt(), inFlight: this.inFlight },
      productsDir: this.productsDir,
      storageError: this.storageError,
    };
  }

  /** When the throttle allows the next creation, or undefined when it allows one now. */
  nextAllowedAt(): number | undefined {
    const t = this.now();
    const recent = this.creations.filter((c) => t - c < HOUR_MS).sort((a, b) => a - b);
    let next = 0;
    if (recent.length >= this.perHour) next = recent[recent.length - this.perHour] + HOUR_MS;
    const last = recent[recent.length - 1];
    if (last !== undefined) next = Math.max(next, last + MIN_CREATE_GAP_MS);
    return next > t ? next : undefined;
  }

  /** Links an existing local repository or clone. Explicit CEO action; nothing outside this office host changes. */
  link(input: unknown, actor: string): ProductInfo {
    this.assertMutable();
    const raw = obj(input, ['name', 'client', 'path']);
    const name = text(raw.name, 'name', 80);
    const client = raw.client === undefined || raw.client === '' ? undefined : text(raw.client, 'client', 160);
    if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path.trim())) throw new ProductError(400, 'path must be an absolute folder path on the office host');
    const dir = this.checkRepo(raw.path.trim());
    return this.add({ name, client, dir, origin: 'linked' }, actor);
  }

  /**
   * Creates a private (by default) repository on GitHub with the office's existing gh sign-in and clones it into the
   * products folder. Explicit CEO action with a typed confirmation; throttled for GitHub's secondary rate limits.
   */
  async create(input: unknown, actor: string): Promise<ProductInfo> {
    this.assertMutable();
    const raw = obj(input, ['name', 'client', 'repo', 'confirm', 'public']);
    const name = text(raw.name, 'name', 80);
    const client = raw.client === undefined || raw.client === '' ? undefined : text(raw.client, 'client', 160);
    const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
    if (!validRepoName(repo)) throw new ProductError(400, 'repo must be a GitHub repository name (letters, digits, . _ -), optionally owner/name');
    if (raw.confirm !== repo) throw new ProductError(400, `Type the repository name (${repo}) to confirm: this creates a repository on GitHub.`);
    if (raw.public !== undefined && typeof raw.public !== 'boolean') throw new ProductError(400, 'public must be true or false');
    const isPublic = raw.public === true;
    if (this.inFlight) throw new ProductError(429, 'Another repository is being created. Wait for it to finish.');
    const next = this.nextAllowedAt();
    if (next) throw new ProductError(429, `Repository creation is throttled (at most ${this.perHour} an hour, ${MIN_CREATE_GAP_MS / 1000} s apart, to stay within GitHub's limits). Next allowed at ${new Date(next).toISOString()}.`);
    if (this.products.length >= MAX_PRODUCTS) throw new ProductError(409, `At most ${MAX_PRODUCTS} products`);
    const short = repo.split('/').pop()!;
    const target = path.join(this.productsDir, short);
    if (existsSync(target)) throw new ProductError(409, `${target} already exists. Link it instead, or choose another name.`);
    this.inFlight = true;
    try {
      try { await this.gh(['auth', 'status'], this.officeDir); }
      catch (e) { throw new ProductError(409, `gh is not signed in on the office host (${(e as Error).message}). Run \`gh auth login\` there; the office never asks for or stores GitHub credentials.`); }
      mkdirSync(this.productsDir, { recursive: true });
      // Counted before the call: a failed attempt still used GitHub's write budget.
      this.creations.push(this.now());
      this.creations = this.creations.filter((c) => this.now() - c < HOUR_MS);
      // A repository GitHub made that the throttle never recorded would escape the limit (and nothing would track it).
      if (!this.persist()) throw new ProductError(500, `${this.storageError ?? 'Products could not be saved'}. Nothing was created on GitHub.`);
      try {
        await this.gh(['repo', 'create', repo, isPublic ? '--public' : '--private', '--add-readme', '--clone', '--description', `${name} (Agent Empire product)`], this.productsDir);
      } catch (e) {
        throw new ProductError(502, `GitHub did not create ${repo}: ${(e as Error).message}`);
      }
      if (!isRepo(target)) throw new ProductError(502, `${repo} was created on GitHub but the clone at ${target} is missing. Clone it there and link it.`);
      const dir = this.checkRepo(target);
      const github = githubOf(remoteOf(dir)) ?? (repo.includes('/') ? repo : undefined);
      return this.add({ name, client, dir, origin: 'created', github, private: !isPublic }, actor);
    } finally {
      this.inFlight = false;
    }
  }

  update(id: string, input: unknown): ProductInfo {
    this.assertMutable();
    const p = this.products.find((x) => x.id === id);
    if (!p) throw new ProductError(404, id === OFFICE_PRODUCT_ID ? 'The office product uses the queue limit; it has no separate cap.' : 'No such product');
    const raw = obj(input, ['maxWorkers', 'name', 'client']);
    if (raw.maxWorkers !== undefined) {
      if (raw.maxWorkers === null || raw.maxWorkers === 0) delete p.maxWorkers;
      else if (Number.isSafeInteger(raw.maxWorkers) && (raw.maxWorkers as number) >= 1 && (raw.maxWorkers as number) <= 64) p.maxWorkers = raw.maxWorkers as number;
      else throw new ProductError(400, 'maxWorkers must be 1-64, or 0/null for no cap');
    }
    if (raw.name !== undefined) p.name = text(raw.name, 'name', 80);
    if (raw.client !== undefined) p.client = raw.client === '' ? undefined : text(raw.client, 'client', 160);
    this.persist();
    return this.list().find((x) => x.id === id)!;
  }

  /**
   * Retires every product id that saved work still names (workers, queue tasks, client jobs, chief plans) but the
   * registry does not know, e.g. after products.json was moved away. A repository linked later under the same name
   * then gets a fresh id, so that old work can never run in it. Returns the ids newly retired.
   */
  retireMissing(ids: Iterable<string | undefined>): string[] {
    const added: string[] = [];
    for (const id of ids) {
      if (!id || id === OFFICE_PRODUCT_ID || !/^[a-z0-9-]{1,64}$/.test(id)) continue;
      if (this.products.some((p) => p.id === id) || this.retired.includes(id) || added.includes(id)) continue;
      added.push(id);
    }
    if (!added.length) return added;
    this.retired.push(...added);
    // Read-only after a recovery error: the ids are still retired for this run, and nothing can be linked anyway.
    if (!this.storageError) this.persist();
    return added;
  }

  /** Forgets a product. Never deletes its folder or its GitHub repository. */
  unlink(id: string): void {
    this.assertMutable();
    if (id === OFFICE_PRODUCT_ID) throw new ProductError(400, 'The office product cannot be unlinked');
    const i = this.products.findIndex((p) => p.id === id);
    if (i < 0) throw new ProductError(404, 'No such product');
    const use = this.opts.usage?.(id);
    if (use && (use.workers || use.openTasks || use.openJobs))
      throw new ProductError(409, `${this.products[i].name} still has ${use.workers} worker(s), ${use.openTasks} unfinished task(s) and ${use.openJobs ?? 0} open job(s) or plan(s). Send the workers home, clear the tasks and reject or finish the jobs first.`);
    const [gone] = this.products.splice(i, 1);
    this.retired.push(id);
    if (!this.persist()) { this.products.splice(i, 0, gone); this.retired.pop(); throw new ProductError(500, this.storageError ?? 'Could not save products'); }
  }

  private add(p: Omit<StoredProduct, 'id' | 'createdAt' | 'createdBy' | 'defaultBranch'> & { github?: string }, actor: string): ProductInfo {
    if (this.products.length >= MAX_PRODUCTS) throw new ProductError(409, `At most ${MAX_PRODUCTS} products`);
    const base = slug(p.name);
    let id = base;
    while (id === OFFICE_PRODUCT_ID || this.products.some((x) => x.id === id) || this.retired.includes(id)) id = `${base}-${randomBytes(3).toString('hex')}`;
    excludeFromGit(p.dir);
    const stored: StoredProduct = {
      id, name: p.name, ...(p.client ? { client: p.client } : {}), dir: p.dir,
      ...(p.github ?? githubOf(remoteOf(p.dir)) ? { github: p.github ?? githubOf(remoteOf(p.dir)) } : {}),
      ...(branchOf(p.dir) ? { defaultBranch: branchOf(p.dir) } : {}),
      origin: p.origin, ...(p.private !== undefined ? { private: p.private } : {}),
      createdAt: this.now(), createdBy: actor.slice(0, 120),
    };
    this.products.push(stored);
    if (!this.persist()) { this.products.pop(); throw new ProductError(500, this.storageError ?? 'Could not save products'); }
    return this.list().find((x) => x.id === id)!;
  }

  /** A git work tree's top level, not the office repo, not overlapping another product. */
  private checkRepo(input: string): string {
    if (!existsSync(input) || !statSync(input).isDirectory()) throw new ProductError(400, `${input} is not a folder on the office host`);
    const dir = real(input);
    let top: string;
    try { top = real(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()); }
    catch { throw new ProductError(400, `${dir} is not a git repository. Run git init there (or clone the repo) first.`); }
    if (top !== dir) throw new ProductError(400, `${dir} is inside the repository ${top}; link the repository's top folder.`);
    // Never a home folder (a dotfiles repo at ~), the root, a system folder, or anything containing one of them.
    const home = real(this.opts.home ?? homedir());
    for (const danger of [home, '/', '/etc', '/usr', '/System', '/var', '/private', '/private/etc', '/private/var'].map((d) => (d === home ? d : real(d)))) {
      if (dir === danger || within(dir, danger)) throw new ProductError(400, `${dir} is (or contains) ${danger}. Link a project repository, not a home or system folder.`);
    }
    // The office's data folder: never it or a folder around it. Inside it (and so inside the office repository) only
    // repositories in the products folder, where created products are cloned by default.
    const data = real(this.opts.dataDir);
    const inProducts = within(real(this.productsDir), dir);
    if (dir === this.officeDir || within(dir, this.officeDir)) throw new ProductError(400, 'That is (or contains) the office repository: it is already the default product.');
    if (dir === data || within(dir, data)) throw new ProductError(400, 'That folder is (or contains) the office data folder.');
    if (within(data, dir) && !inProducts) throw new ProductError(400, 'Inside the office data folder, only repositories in the products folder can be products.');
    if (within(this.officeDir, dir) && !(inProducts && within(data, dir))) throw new ProductError(400, 'That folder is inside the office repository, which is already the default product.');
    for (const p of this.products) {
      const other = real(p.dir);
      if (other === dir) throw new ProductError(409, `Already linked as ${p.name}`);
      if (within(other, dir) || within(dir, other)) throw new ProductError(409, `Overlaps the product ${p.name} (${p.dir})`);
    }
    return dir;
  }

  private assertMutable() {
    if (this.storageError) throw new ProductError(503, this.storageError);
  }

  private persist(): boolean {
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      writeJsonAtomic(this.file, { version: 1, products: this.products, creations: this.creations, retired: this.retired });
      return true;
    } catch (e) {
      this.storageError = `Products could not be saved: ${(e as Error).message}`;
      return false;
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!saved || typeof saved !== 'object' || saved.version !== 1 || !Array.isArray(saved.products)) throw new Error('unexpected format');
      const ids = new Set<string>();
      for (const s of saved.products) {
        if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(s.id) || s.id === OFFICE_PRODUCT_ID || ids.has(s.id)) throw new Error('invalid product id');
        if (typeof s.name !== 'string' || typeof s.dir !== 'string' || !path.isAbsolute(s.dir) || (s.origin !== 'linked' && s.origin !== 'created')) throw new Error(`invalid product ${s.id}`);
        ids.add(s.id);
        this.products.push({
          id: s.id, name: s.name.slice(0, 80), dir: s.dir, origin: s.origin, createdAt: Number(s.createdAt) || 0, createdBy: String(s.createdBy ?? '?').slice(0, 120),
          ...(typeof s.client === 'string' ? { client: s.client.slice(0, 160) } : {}),
          ...(typeof s.github === 'string' ? { github: s.github } : {}),
          ...(typeof s.defaultBranch === 'string' ? { defaultBranch: s.defaultBranch } : {}),
          ...(typeof s.private === 'boolean' ? { private: s.private } : {}),
          ...(Number.isSafeInteger(s.maxWorkers) && s.maxWorkers >= 1 && s.maxWorkers <= 64 ? { maxWorkers: s.maxWorkers } : {}),
        });
      }
      this.creations = Array.isArray(saved.creations) ? saved.creations.filter((c: unknown) => typeof c === 'number' && Number.isFinite(c)) : [];
      this.retired = Array.isArray(saved.retired) ? saved.retired.filter((r: unknown): r is string => typeof r === 'string' && /^[a-z0-9-]{1,64}$/.test(r)) : [];
      for (const p of this.products) if (this.retired.includes(p.id)) throw new Error(`product id ${p.id} is both linked and retired`);
    } catch (e) {
      this.products = [];
      this.storageError = `products.json could not be read (${(e as Error).message}). Fix or move it; until then only the office product is available and nothing can be linked or created.`;
    }
  }
}

function obj(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProductError(400, 'Expected a JSON object');
  const raw = input as Record<string, unknown>;
  for (const k of Object.keys(raw)) if (!keys.includes(k)) throw new ProductError(400, `Unknown field: ${k}`);
  return raw;
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new ProductError(400, `${field} is required`);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > max) throw new ProductError(400, `${field} must be at most ${max} characters`);
  return s;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'product';
}

/** The true path: symlinks resolved and, on case-insensitive file systems (macOS), the on-disk case. */
function real(p: string): string {
  try { return realpathSync.native(p); } catch { return path.resolve(p); }
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function git(dir: string, args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || undefined; }
  catch { return undefined; }
}

function isRepo(dir: string): boolean {
  return existsSync(dir) && git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function branchOf(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const b = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : undefined;
}

function remoteOf(dir: string): string | undefined {
  return existsSync(dir) ? git(dir, ['remote', 'get-url', 'origin']) : undefined;
}

/** owner/name from a GitHub remote URL (https or ssh), or undefined. */
export function githubOf(remote?: string): string | undefined {
  const m = remote && /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
