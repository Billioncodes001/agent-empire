import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SyncArtifactList, SyncArtifactManifest } from '../shared/continuity.js';
import { importArtifact, MAX_BUNDLE_BYTES, pinServer, readBounded, validateManifest, validateServerUrl } from './device-sync.js';

export async function syncCli(args: string[]): Promise<void> {
  if (args.includes('--help') || !args.length) {
    console.log(`Agent Empire device sync\nUsage: agent-empire-sync --server <https://host> --repo <folder> [--trust-server <id>] [--publish <workerId>]\n\nSet AGENT_EMPIRE_SYNC_PASSWORD in your environment (never a command argument).\nThe first run prints the host identity; review it and repeat with --trust-server.\nOnly clean, stopped workers can publish. Imports create isolated review worktrees.\nThe active branch, index and dirty laptop files are never changed. No automatic merge.`);
    return;
  }
  const options = new Map<string,string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--server','--repo','--trust-server','--publish'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Unknown option or missing value. Use --help.');
    options.set(args[i], args[i+1]);
  }
  const origin = validateServerUrl(options.get('--server') ?? '');
  const repo = path.resolve(options.get('--repo') ?? '.');
  const password = process.env.AGENT_EMPIRE_SYNC_PASSWORD;
  if (!password) throw new Error('Set AGENT_EMPIRE_SYNC_PASSWORD in the environment.');
  const login = await fetch(`${origin}/api/login`, { method:'POST', redirect:'error', signal:AbortSignal.timeout(15000), headers:{'content-type':'application/json', Origin:origin}, body:JSON.stringify({password}) });
  if (!login.ok) throw new Error(`Sign-in failed (${login.status}).`);
  const cookie = login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Host did not provide a session cookie.');
  const request = async (url: string, init: RequestInit = {}) => fetch(origin + url, {...init, redirect:'error', signal:AbortSignal.timeout(60000), headers:{...init.headers,Cookie:cookie,Origin:origin}});
  const list = JSON.parse((await readBounded(await request('/api/sync/artifacts'), 4*1024*1024)).toString()) as SyncArtifactList;
  if (!Array.isArray(list.artifacts)) throw new Error('Invalid host artifact list.');
  console.log(`Host identity: ${list.serverId}`);
  pinServer(repo, origin, list.serverId, options.get('--trust-server'));
  const manifests: SyncArtifactManifest[] = [...list.artifacts];
  if (options.has('--publish')) {
    manifests.push(JSON.parse((await readBounded(await request('/api/sync/artifacts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workerId:options.get('--publish')})}), 65536)).toString()));
  }
  for (const value of new Map(manifests.map(m=>[m.artifactId,m])).values()) {
    const m = validateManifest(value, list.serverId);
    const bytes = await readBounded(await request(m.bundle.url), MAX_BUNDLE_BYTES);
    const result = importArtifact(repo,m,bytes,list.serverId);
    console.log(`${result.reused?'Already imported':'Ready for review'}: ${result.commit}\n${result.worktree}`);
    if (result.conflicts.length) console.log(`Overlapping local changes (manual review): ${result.conflicts.join(', ')}`);
  }
  if (!manifests.length) console.log('No published artifacts. Commit the worker changes, stop its process, then publish that worker.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncCli(process.argv.slice(2)).catch(error=>{console.error(`Sync: ${(error as Error).message}`);process.exitCode=1;});
}
