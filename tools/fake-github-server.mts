/**
 * A loopback-only fake api.github.com for simulator checks of cloud mode (never real GitHub, no paid calls). It serves
 * the seeded state repository from tools/cloud-seed.ts with CORS, and logs every write.
 *
 *   FAKE_GITHUB_PORT=4710 npx tsx tools/fake-github-server.mts
 *   VITE_AGENT_EMPIRE_FAKE_GITHUB_API=http://127.0.0.1:4710 npm run build:client   (a fixture build; rebuild normally after)
 *
 * Any bearer token is accepted; the seeded account is "founder".
 */
import { createServer } from 'node:http';
import nacl from 'tweetnacl';
import { seed } from './cloud-seed.ts';

const port = Number(process.env.FAKE_GITHUB_PORT || 4710);
if (!Number.isInteger(port) || port < 1024 || port === 4610) throw new Error('Use an isolated loopback port (not 4610).');
const { gh } = await seed();
gh.publicKey = Buffer.from(nacl.box.keyPair().publicKey).toString('base64'); // a real X25519 key, so the app seals for real
gh.listed = [
  { name: 'storefront', owner: { login: 'founder' }, private: true, default_branch: 'main', description: 'Online shop', pushed_at: new Date().toISOString(), permissions: { push: true } },
  { name: 'repo', owner: { login: 'fixture' }, private: true, default_branch: 'main', description: 'Fixture project', pushed_at: new Date().toISOString(), permissions: { push: true } },
];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'ETag',
};
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const response = await gh.handle(new URL(`https://api.github.com${req.url}`), { method: req.method, headers, body });
  const out: Record<string, string> = { ...CORS };
  response.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
  if (req.method !== 'GET') console.log(`${new Date().toISOString()} ${req.method} ${req.url} → ${response.status}`);
}).listen(port, '127.0.0.1', () => console.log(`fake api.github.com on http://127.0.0.1:${port} (seeded founder/agent-empire-state)`));
