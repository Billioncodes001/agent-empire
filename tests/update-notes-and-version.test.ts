import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseNotes } from '../src/client/update/notes';
import { findAppDir } from '../src/server/upgrade';

// The owner saw beta.3's notes as raw "**The city architect**" and "- …" in the Updates dialog.
test('release notes render headings, lists, bold and code instead of raw Markdown', () => {
  const notes = readFileSync(path.resolve('docs/release-notes/1.0.0-beta.3.md'), 'utf8');
  const blocks = parseNotes(notes);
  const text = JSON.stringify(blocks);
  assert.ok(!text.includes('**'), 'no raw bold markers');
  assert.ok(blocks.some((b) => b.kind === 'h' && b.runs[0].text === 'The city architect'));
  const list = blocks.find((b) => b.kind === 'ul');
  assert.ok(list && list.kind === 'ul' && list.items.length >= 2);
  assert.ok(!list.items.some((item) => item[0].text.startsWith('- ')), 'list markers are removed');
  assert.ok(text.includes('"style":"code"'), 'file names render as code');

  assert.deepEqual(parseNotes('Plain <b>not html</b> text'), [{ kind: 'p', runs: [{ text: 'Plain <b>not html</b> text' }] }], 'HTML stays text');
  assert.deepEqual(parseNotes('a\nb\n\nc'), [{ kind: 'p', runs: [{ text: 'a b' }] }, { kind: 'p', runs: [{ text: 'c' }] }]);
});

// The packaged desktop server reported "Server 0.0.0": the install lookup still searched for the pre-rename package name.
test('the server finds its own install (package renamed from agent-office to agent-empire)', () => {
  const dir = findAppDir();
  assert.ok(dir, 'install found');
  assert.equal(JSON.parse(readFileSync(path.join(dir!, 'package.json'), 'utf8')).name, 'agent-empire');
});
