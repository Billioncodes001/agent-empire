// Ships the cloud coordinator inside the client build (CLOUD-02): the setup's "Create my Empire" commits this exact
// file into the user's state repository at coordinator/agent-empire-coordinator.mjs. A manifest with its size and
// SHA-256 lets the app refuse anything else (an HTML fallback page, a truncated download).
// Run after `vite build` (client) and `vite build --config vite.cloud.config.ts` (coordinator).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'dist/cloud/agent-empire-coordinator.mjs');
// The fixture client build (dist/public-fixture) ships its own copy: `node tools/ship-coordinator.mjs dist/public-fixture`.
const client = process.argv[2] ?? 'dist/public';
if (!['dist/public', 'dist/public-fixture'].includes(client)) throw new Error('Ship the coordinator into dist/public or dist/public-fixture.');
const outDir = resolve(root, client, 'cloud');
const text = readFileSync(source, 'utf8');
if (!text.includes('runCoordinatorTick') || text.length < 10_000) throw new Error(`${source} does not look like the coordinator bundle`);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'agent-empire-coordinator.mjs'), text);
const bytes = Buffer.byteLength(text, 'utf8');
const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
writeFileSync(resolve(outDir, 'coordinator.json'), JSON.stringify({ file: 'agent-empire-coordinator.mjs', bytes, sha256 }, null, 2) + '\n');
console.log(`shipped coordinator: ${client}/cloud/agent-empire-coordinator.mjs (${bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`);
