/**
 * FREE-07 re-review follow-ups (on a126875): a narrower hidden-character screen for research reports (shared with the
 * server), the org.json quarantine at the store level, and the research read order. Run against a126875 first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchReport } from '../src/shared/research-report';
import { parseArtifact } from '../src/shared/artifact-parse';
import { hasDeceptiveChars } from '../src/shared/text-safety';
import { ORG_FILE, emptyOrg, researchDue } from '../src/cloud/org';
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { installStateRepository } from '../src/cloud/installer';
import { runCoordinatorTick } from '../src/cloud/tick';
import { readCloudView } from '../src/cloud/client';
import { CloudRepo } from '../src/client/cloud/repo';
import { FakeGitHub } from './fake-github';
import { EXECUTION, FakeProvider, T0, uuid } from './cloud-fixtures';

const report = (finding: string, tool = 'Tool') => `---\nquestion: q\nfeasibility: feasible\nconfidence: low\n---\n## Findings\n- ${finding} https://example.com\n## What we can do now\nx\n## What we can't do yet and why\ny\n## Proposed tools\n| Name | URL | Licence | Enables | Risk |\n|---|---|---|---|---|\n| ${tool} | https://example.com/t | MIT | a | b |\n`;
const accepts = (finding: string, tool?: string) => parseResearchReport(parseArtifact(report(finding, tool))).ok;

// ---------------------------------------------------------------- 1. narrower screen

test('re-review 1: legitimate text is accepted (emoji ZWJ, soft hyphen, Persian ZWNJ, unassigned emoji)', () => {
  assert.equal(accepts('A developer 👩‍💻 joins the team'), true, 'emoji ZWJ sequence');
  assert.equal(accepts('Family 👨‍👩‍👧‍👦 plans'), true, 'multi-ZWJ emoji');
  assert.equal(accepts('Use hyphen­ation hints'), true, 'soft hyphen');
  assert.equal(accepts('Persian می‌خواهم text'), true, 'ZWNJ between letters');
  assert.equal(accepts('New emoji \u{1FAEA} support', 'Tool \u{1FAEB}'), true, 'unassigned code points (newer emoji)');
  assert.equal(accepts('Rainbow flag 🏳️‍🌈 shown'), true, 'ZWJ after a variation selector');
});

test('re-review 1: every deceptive character is still refused', () => {
  const attacks: [string, string][] = [
    ['‮', 'RLO override'], ['‪', 'LRE'], ['‫', 'RLE'], ['‬', 'PDF'], ['‭', 'LRO'],
    ['⁦', 'LRI isolate'], ['⁧', 'RLI'], ['⁨', 'FSI'], ['⁩', 'PDI'],
    ['\u{E0041}', 'tag character'], ['\u{E007F}', 'cancel tag'],
    ['\u0007', 'C0 bell'], ['\u001B', 'escape'], ['\u0085', 'C1 NEL'], ['\u009B', 'C1 CSI'],
    ['\uD800', 'lone high surrogate'], ['\uDC00', 'lone low surrogate'],
    ['​', 'zero-width space'], ['⁠', 'word joiner'], ['﻿', 'BOM'],
  ];
  for (const [ch, name] of attacks) {
    assert.equal(hasDeceptiveChars(`safe${ch}text`), true, name);
    assert.equal(accepts(`claim${ch}hidden`), false, `${name} in a finding`);
    assert.equal(accepts('fine', `Tool${ch}x`), false, `${name} in a tool name`);
  }
  // ZWJ / ZWNJ outside a joining context hide nothing legitimate and are refused.
  assert.equal(hasDeceptiveChars('‍start'), true);
  assert.equal(hasDeceptiveChars('end‌'), true);
  assert.equal(hasDeceptiveChars('a ‍ b'), true, 'ZWJ between spaces');
  assert.equal(hasDeceptiveChars('line one\n\tline two'), false, 'newline and tab are fine');
});

// ---------------------------------------------------------------- 3. store-level quarantine

async function repoWithOrg(patch: (url: URL, res: Response) => Promise<Response>) {
  const gh = new FakeGitHub();
  await installStateRepository(new GitHubClient('gho_fixture', { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 },
    execution: EXECUTION, coordinatorBundle: '// bundle\n', now: T0, sleep: async () => {},
  }, async (k, v) => `sealed(${k}):${v.length}`);
  gh.commitOnBranch('founder/agent-empire-state', { [ORG_FILE]: JSON.stringify(emptyOrg()) + '\n' }, 'org');
  const fetch = (async (input: any, init?: any) => { const res = await gh.fetch(input, init); return patch(new URL(typeof input === 'string' ? input : input.url), res); }) as typeof globalThis.fetch;
  const store = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  return { gh, store, fetch };
}
const orgSha = (gh: FakeGitHub) => {
  const repo = (gh as any).repos.get('founder/agent-empire-state');
  return repo.trees.get(repo.commits.get(repo.ref).tree).get(ORG_FILE) as string;
};
const json = async (res: Response) => JSON.parse(await res.clone().text());
const replace = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('re-review 3: an org.json that is not UTF-8 is quarantined; the coordinator runs and leaves it untouched', async () => {
  let sha = '';
  const { gh, store } = await repoWithOrg(async (url, res) => sha && url.pathname.endsWith(`/git/blobs/${sha}`) ? replace({ ...(await json(res)), content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') }) : res);
  sha = orgSha(gh);
  const report = await runCoordinatorTick({ store, provider: new FakeProvider(), now: () => T0 + 60_000, runId: 'q1', retry: { sleep: async () => {} } });
  assert.ok(report.revision >= 0);
  const view = await readCloudView(store, T0 + 60_000);
  assert.match(view.state.orgError!, /UTF-8/);
  assert.equal(orgSha(gh), sha, 'the file is left as it was');
});

test('re-review 3: an org.json over 4 MiB is quarantined; the coordinator runs and leaves it untouched', async () => {
  let sha = '';
  const { gh, store } = await repoWithOrg(async (url, res) => {
    if (!url.pathname.includes('/git/trees/')) return res;
    const body = await json(res);
    return replace({ ...body, tree: body.tree.map((e: any) => e.path === ORG_FILE ? { ...e, size: 5 * 1024 * 1024 } : e) });
  });
  sha = orgSha(gh);
  await runCoordinatorTick({ store, provider: new FakeProvider(), now: () => T0 + 60_000, runId: 'q2', retry: { sleep: async () => {} } });
  const view = await readCloudView(store, T0 + 60_000);
  assert.match(view.state.orgError!, /larger/);
  assert.equal(orgSha(gh), sha);
});

test('re-review 3: the game reader quarantines an oversized org.json too instead of refusing the whole Empire', async () => {
  const { fetch } = await repoWithOrg(async (url, res) => {
    if (!url.pathname.includes('/git/trees/')) return res;
    const body = await json(res);
    return replace({ ...body, tree: body.tree.map((e: any) => e.path === ORG_FILE ? { ...e, size: 5 * 1024 * 1024 } : e) });
  });
  const client = new CloudRepo({ owner: 'founder', name: 'agent-empire-state' }, 'gho_fixture', fetch);
  const result = await client.poll();
  assert.ok(result.changed && result.snapshot.state.orgError);
});

// ---------------------------------------------------------------- 4. read order

test('re-review 4: researchDue reads reports with the fewest failed reads first, then the oldest', () => {
  const org = emptyOrg();
  const jobs: any[] = [1, 2, 3].map((n) => ({ id: uuid(n), status: 'awaiting_review', branch: `agent-empire/task-${uuid(n)}` }));
  org.research.push({ jobId: uuid(1), question: 'a', askedAt: 1, status: 'queued', tools: [], readAttempts: 3 });
  org.research.push({ jobId: uuid(2), question: 'b', askedAt: 3, status: 'queued', tools: [] });
  org.research.push({ jobId: uuid(3), question: 'c', askedAt: 2, status: 'queued', tools: [], readAttempts: 1 });
  assert.deepEqual(researchDue(org, jobs).map((d) => d.jobId), [uuid(2), uuid(3), uuid(1)]);
});
