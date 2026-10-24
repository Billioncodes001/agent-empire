import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Opened from disk (file://), a page's root-relative /assets/ links fail and it renders unstyled. Each entry page
// carries an inline-styled notice that its own stylesheet hides, so it only shows when that stylesheet did not load.
const pages: [html: string, css: string][] = [
  ['src/client/index.html', 'src/client/style.css'],
  ['src/client/consultancy.html', 'src/client/consultancy.css'],
  ['src/client/login.html', 'src/client/login.css'],
  ['src/client/claim.html', 'src/client/login.css'],
];

test('entry pages show the opened-from-disk notice only when their stylesheet is missing', () => {
  for (const [html, css] of pages) {
    const page = readFileSync(html, 'utf8');
    const note = page.match(/<div class="file-open-note"[^>]*style="([^"]+)"/);
    assert.ok(note, `${html} has the notice`);
    assert.match(note[1], /position:fixed/, `${html}: the notice is visible without any stylesheet`);
    assert.ok(page.indexOf('file-open-note') < page.search(/<main|<div id="splash"|<header/), `${html}: the notice comes first`);
    assert.match(readFileSync(css, 'utf8'), /\.file-open-note\s*\{\s*display:\s*none\s*!important;?\s*\}/, `${css} hides it when served`);
  }
});
