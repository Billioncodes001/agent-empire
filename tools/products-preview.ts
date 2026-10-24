/**
 * FREE-06 isolated preview: the real office server over throwaway git repos, with a fake `gh` (it makes a local repo;
 * nothing reaches GitHub), no worker process (spawning throws) and a paused queue. Never the protected 4610 session.
 *   PREVIEW_PORT=4910 PREVIEW_PUBLIC=dist/public npx tsx tools/products-preview.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scryptSync } from 'node:crypto';
import { startServer } from '../src/server/server.js';
import type { Config } from '../src/server/config.js';
import type { GhRunner } from '../src/server/products.js';

const port = Number(process.env.PREVIEW_PORT || 4910);
if (port === 4610 || !Number.isInteger(port) || port < 1024) throw new Error('Refusing the protected 4610 session; use an isolated preview port (4910+).');
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'empire-products-preview-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=preview@fixture.invalid', '-c', 'user.name=Preview', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
function repo(dir: string, remote?: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\nSynthetic preview repository.\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Synthetic preview commit');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}
const office = repo(path.join(root, 'northstar-office'), 'https://github.com/fixture-user/northstar-office.git');
const dataDir = path.join(office, '.agent-office');
mkdirSync(dataDir, { recursive: true });
const alpha = repo(path.join(root, 'harbour-dental-site'), 'git@github.com:fixture-user/harbour-dental-site.git');
const now = Date.now();
writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify({ version: 1, creations: [], products: [
  { id: 'harbour-dental', name: 'Harbour Dental site', client: 'Harbour Dental', dir: alpha, github: 'fixture-user/harbour-dental-site', defaultBranch: 'main', origin: 'linked', createdAt: now - 86_400_000, createdBy: 'CEO', maxWorkers: 2 },
] }));
// One stopped worker bound to the product (nothing runs) and two paused queue tasks: one per product.
writeFileSync(path.join(dataDir, 'workers.json'), JSON.stringify([
  { id: 'pv-worker-1', kind: 'agent', name: 'Wren', deskId: 'desk-4', color: '#32685c', createdBy: 'CEO', createdAt: now - 3_600_000, processState: 'stopped', status: 'offline', prompt: 'Build the booking form. Preview only.', productId: 'harbour-dental', productName: 'Harbour Dental site' },
]));
writeFileSync(path.join(dataDir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [
  { id: 'pv-task-1', title: 'Accessibility pass on the booking form', prompt: 'Preview only.', addedBy: 'CEO', addedAt: now - 600_000, status: 'queued', productId: 'harbour-dental', productName: 'Harbour Dental site' },
  { id: 'pv-task-2', title: 'Office: tidy the README', prompt: 'Preview only.', addedBy: 'CEO', addedAt: now - 300_000, status: 'queued' },
] }));
const ghCalls: string[][] = [];
const fakeGh: GhRunner = async (args, cwd) => {
  ghCalls.push(args);
  if (args[0] === 'auth') return 'github.com: Logged in to github.com account fixture-user (preview fake)';
  if (args[0] === 'repo' && args[1] === 'create') {
    const name = args[2];
    const short = name.split('/').pop()!;
    repo(path.join(cwd, short), `https://github.com/${name.includes('/') ? name : `fixture-user/${name}`}.git`);
    console.log(`[fake gh] would have created ${name} (${args[3]}); made a local repo only`);
    return `https://github.com/fixture-user/${short}`;
  }
  throw new Error(`Preview fake gh refuses: gh ${args.join(' ')}`);
};
const cfg: Config = { dir: office, dataDir, host: '127.0.0.1', port, passwordGenerated: false, verifier: scryptSync('products-preview', Buffer.alloc(16, 3), 32), salt: Buffer.alloc(16, 3), secret: 'isolated-products-preview-only', claimed: true, markClaimed() {}, agentCmd: 'disabled-fixture', agentArgs: [], trustProxy: false, iceServers: [], budgetPause: false };
const host = await startServer(cfg, {
  publicDir: process.env.PREVIEW_PUBLIC || path.resolve(import.meta.dirname, '../dist/public'),
  backgroundServices: false, telegram: false, email: false, outreach: false,
  engines: { providerKeys: () => ({}) },
  workers: { taskNaming: false, resolveCommand: () => null, processExists: () => false, spawn() { throw new Error('Preview cannot launch workers'); } },
  products: { gh: fakeGh, productsDir: path.join(root, 'products'), perHour: 3 },
});
console.log(`Isolated products preview: http://127.0.0.1:${port}/ (password: products-preview). Temp: ${root}`);
const stop = () => { host.shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
