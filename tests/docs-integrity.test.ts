// Structural checks on the hand-maintained docs, so a bad scripted edit (a duplicated file body, a paragraph pasted
// into a table) fails CI instead of reaching readers. Code fences are skipped: shell comments there start with "# ".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = [
  ...readdirSync(path.join(ROOT, 'docs')).filter(n => n.endsWith('.md')).map(n => `docs/${n}`),
  'docs/team/RELEASE_PLAN.md',
  'docs/team/reports/release-assets.md',
];

/** The lines outside fenced code blocks, with their 1-based line numbers. */
function prose(text: string): Array<{ n: number; line: string }> {
  let fenced = false;
  const out: Array<{ n: number; line: string }> = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (!fenced) out.push({ n: i + 1, line });
  });
  return out;
}

test('docs: one top-level heading per file, and the title line appears once (catches a duplicated body)', () => {
  for (const rel of DOCS) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    const headings = prose(text).filter(l => /^# /.test(l.line));
    assert.equal(headings.length, 1, `${rel}: top-level headings at lines ${headings.map(h => h.n).join(', ')}`);
    // Independent of code fences and line starts: a bad paste (String.replace with "$`") can splice the file's
    // beginning into the middle of a line and unbalance the fences.
    const title = text.split('\n')[0];
    const copies = text.split('\n').map((l, i) => (l.includes(title) ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(copies, [1], `${rel}: the title "${title}" appears at lines ${copies.join(', ')}`);
  }
});

test('docs: every table starts with a header and a separator row (no rows split off by stray text)', () => {
  for (const rel of DOCS) {
    const lines = prose(readFileSync(path.join(ROOT, rel), 'utf8'));
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].line.startsWith('|') || lines[i - 1]?.line.startsWith('|')) continue;
      assert.match(lines[i + 1]?.line ?? '', /^\|(\s*:?-{3,}:?\s*\|)+\s*$/, `${rel}:${lines[i].n}: a table row without a header and separator above it`);
    }
  }
});

test('DISTRIBUTION.md: the Obtainium filter is the one RELEASING.md documents for the new APK name', () => {
  const dist = readFileSync(path.join(ROOT, 'docs/DISTRIBUTION.md'), 'utf8');
  const releasing = readFileSync(path.join(ROOT, 'docs/RELEASING.md'), 'utf8');
  const filter = '`^Agent-Empire-Android\\.apk$`';
  assert.ok(releasing.includes(filter));
  const row = dist.split('\n').find(l => l.startsWith('| Filter APKs by regular expression |'));
  assert.ok(row?.startsWith(`| Filter APKs by regular expression | ${filter} `), row);
  assert.ok(row?.trimEnd().endsWith('|'), 'the row is complete');
});
