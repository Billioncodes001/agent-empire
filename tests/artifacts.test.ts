import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, artifactPath, artifactTestHooks, parseArtifact, readArtifact } from '../src/server/artifacts.ts';

const JOB = 'consultancy-0123456789ab';
const DONE = { status: 'done' as const, outcome: 'done' as const };
const GOOD = '---\nsubject: Hello {{name}}\naudience: [customers, L3]\nproposedLeads:\n  - Ann | ann@example.com | Acme | conference | met at a booth\n---\n\nHi {{name}},\nBody.\n';

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-artifacts-'));
  return dir;
}
function write(root: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

test('parseArtifact: strict frontmatter with scalars, inline and block lists', () => {
  const r = parseArtifact(GOOD);
  assert.ok(r.ok);
  assert.deepEqual(r.frontmatter, { subject: 'Hello {{name}}', audience: ['customers', 'L3'], proposedLeads: ['Ann | ann@example.com | Acme | conference | met at a booth'] });
  assert.equal(r.body, 'Hi {{name}},\nBody.');
  assert.deepEqual(parseArtifact('---\na: "quoted: \\"x\\""\nb: \'it\'\'s\'\n---\nbody').ok && parseArtifact('---\na: "quoted: \\"x\\""\nb: \'it\'\'s\'\n---\nbody'), { ok: true, frontmatter: { a: 'quoted: "x"', b: "it's" }, body: 'body' });
});

test('parseArtifact: anything outside the grammar is refused with a reason, never guessed', () => {
  for (const [text, reason] of [
    ['subject: x\n---\n', /must start/],
    ['---\nsubject: x\n', /no closing/],
    ['---\nsubject: x\nsubject: y\n---\n', /duplicate key/],
    ['---\njust words\n---\n', /expected "key: value"/],
    ['---\n  - orphan\n---\n', /list item without/],
    ['---\nbad key: x\n---\n', /not a valid key/],
    ['---\na: [x, y\n---\n', /unterminated \[list\]/],
    ['---\na: "open\n---\n', /unterminated/],
    ['---\na: x\0\n---\n', /NUL/],
  ] as const) {
    const r = parseArtifact(text);
    assert.equal(r.ok, false, text);
    assert.match((r as { reason: string }).reason, reason);
  }
});

test('readArtifact: reads the file from the task worktree, only once the task finished with outcome done', () => {
  const dir = project();
  const wt = path.join(dir, '.agent-office/worktrees/wren-ab12');
  write(wt, artifactPath('campaigns', JOB), GOOD);
  const task = { ...DONE, branch: 'office/wren-ab12' };
  const r = readArtifact(dir, task, 'campaigns', JOB);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.source, 'worktree');
  assert.equal(r.frontmatter.subject, 'Hello {{name}}');
  assert.match((readArtifact(dir, { ...task, outcome: 'exited' }, 'campaigns', JOB) as { reason: string }).reason, /outcome done/);
  assert.match((readArtifact(dir, { ...task, status: 'running', outcome: undefined }, 'campaigns', JOB) as { reason: string }).reason, /outcome done/);
  // A task without a worktree worked in the project folder itself.
  write(dir, artifactPath('research', JOB), '---\nquestion: q\n---\nFindings');
  const p = readArtifact(dir, DONE, 'research', JOB);
  assert.ok(p.ok && p.source === 'project');
});

test('readArtifact: path confinement — symlinks, .., bad ids and branch names, oversize files', () => {
  const dir = project();
  const outside = project();
  write(outside, 'secret.md', GOOD);
  const wt = path.join(dir, '.agent-office/worktrees/w1');
  mkdirSync(path.join(wt, 'docs/empire/campaigns'), { recursive: true });
  // The file itself is a symlink to something outside.
  symlinkSync(path.join(outside, 'secret.md'), path.join(wt, artifactPath('campaigns', JOB)));
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/w1' }, 'campaigns', JOB) as { reason: string }).reason, /symlink/);
  // A folder on the way is a symlink.
  const wt2 = path.join(dir, '.agent-office/worktrees/w2');
  mkdirSync(path.join(wt2, 'docs'), { recursive: true });
  mkdirSync(path.join(outside, 'empire/campaigns'), { recursive: true });
  writeFileSync(path.join(outside, 'empire/campaigns', `${JOB}.md`), GOOD);
  symlinkSync(path.join(outside, 'empire'), path.join(wt2, 'docs/empire'));
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/w2' }, 'campaigns', JOB) as { reason: string }).reason, /symlink/);
  // The worktree folder itself is a symlink.
  symlinkSync(outside, path.join(dir, '.agent-office/worktrees/w3'));
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/w3' }, 'campaigns', JOB) as { reason: string }).reason, /not a plain folder/);
  // .. and anything that is not a consultancy id never reaches the file system.
  for (const id of ['../../secret', 'consultancy-0123456789ab/../x', 'consultancy-XYZ']) assert.match((readArtifact(dir, DONE, 'campaigns', id) as { reason: string }).reason, /not a consultancy job id/);
  for (const branch of ['office/../../x', 'office/a/b', 'main', 'office/..']) assert.equal(readArtifact(dir, { ...DONE, branch }, 'campaigns', JOB).ok, false, branch);
  // Size cap.
  const wt4 = path.join(dir, '.agent-office/worktrees/w4');
  write(wt4, artifactPath('campaigns', JOB), `---\nsubject: x\n---\n${'a'.repeat(MAX_ARTIFACT_BYTES)}`);
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/w4' }, 'campaigns', JOB) as { reason: string }).reason, /larger than 256 KB/);
  // Missing.
  mkdirSync(path.join(dir, '.agent-office/worktrees/w5'));
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/w5' }, 'campaigns', JOB) as { reason: string }).reason, /missing/);
  // Not UTF-8.
  const wt6 = path.join(dir, '.agent-office/worktrees/w6');
  mkdirSync(path.join(wt6, 'docs/empire/campaigns'), { recursive: true });
  writeFileSync(path.join(wt6, artifactPath('campaigns', JOB)), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]));
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/w6' }, 'campaigns', JOB) as { reason: string }).reason, /UTF-8/);
});

test('readArtifact: falls back to the committed blob on the branch when the worktree is gone; a committed symlink is refused', () => {
  const dir = project();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(dir, 'README.md'), 'x');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'office/gone-1');
  write(dir, artifactPath('campaigns', JOB), GOOD);
  git('add', '.');
  git('commit', '-qm', 'draft');
  git('checkout', '-qb', 'office/link-1', 'main');
  mkdirSync(path.join(dir, 'docs/empire/campaigns'), { recursive: true });
  symlinkSync('/etc/hosts', path.join(dir, artifactPath('campaigns', JOB)));
  git('add', '.');
  git('commit', '-qm', 'link');
  git('checkout', '-q', 'main');
  const r = readArtifact(dir, { ...DONE, branch: 'office/gone-1' }, 'campaigns', JOB);
  assert.ok(r.ok && r.source === 'branch', JSON.stringify(r));
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/link-1' }, 'campaigns', JOB) as { reason: string }).reason, /symlink/);
  assert.match((readArtifact(dir, { ...DONE, branch: 'office/never-1' }, 'campaigns', JOB) as { reason: string }).reason, /both gone/);
});

test('readArtifact is race-safe: a file or folder swapped between the checks and the read is refused, never followed or hung on', () => {
  const dir = project();
  const wt = path.join(dir, '.agent-office/worktrees/race-1');
  const rel = artifactPath('campaigns', JOB);
  const task = { ...DONE, branch: 'office/race-1' };
  const reason = () => (readArtifact(dir, task, 'campaigns', JOB) as { reason: string }).reason;
  const reset = () => { rmSync(path.join(wt, 'docs'), { recursive: true, force: true }); write(wt, rel, GOOD); };
  try {
    // Swapped for a FIFO: O_NONBLOCK means no hang, and fstat shows it is not the regular file that was checked.
    reset();
    artifactTestHooks.beforeOpen = (file) => { rmSync(file); execFileSync('mkfifo', [file]); };
    const started = Date.now();
    assert.match(reason(), /changed while it was read/);
    assert.ok(Date.now() - started < 2000);
    // Swapped for a symlink to /dev/zero: O_NOFOLLOW refuses it.
    reset();
    artifactTestHooks.beforeOpen = (file) => { rmSync(file); symlinkSync('/dev/zero', file); };
    assert.match(reason(), /changed while it was read/);
    // A parent folder swapped for another holding a different file of the same name: dev/ino differ.
    reset();
    artifactTestHooks.beforeOpen = () => {
      const campaigns = path.join(wt, 'docs/empire/campaigns');
      renameSync(campaigns, `${campaigns}-old`);
      mkdirSync(campaigns);
      writeFileSync(path.join(campaigns, `${JOB}.md`), GOOD.replace('Hello', 'Swapped'));
    };
    assert.match(reason(), /changed while it was read/);
    // Grows past the cap after the size check: at most MAX+1 bytes are read, and it is refused.
    reset();
    artifactTestHooks.beforeOpen = (file) => appendFileSync(file, 'a'.repeat(MAX_ARTIFACT_BYTES));
    assert.match(reason(), /larger than 256 KB/);
    // A direct symlink to /dev/zero is refused before any open.
    artifactTestHooks.beforeOpen = undefined;
    rmSync(path.join(wt, rel));
    symlinkSync('/dev/zero', path.join(wt, rel));
    assert.match(reason(), /symlink/);
    // Untouched, the same file reads fine.
    reset();
    assert.equal(readArtifact(dir, task, 'campaigns', JOB).ok, true);
  } finally {
    artifactTestHooks.beforeOpen = undefined;
  }
});
