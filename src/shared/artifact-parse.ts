// The strict artifact parser (ORG-04a/ORG-05), shared by the office server (src/server/artifacts.ts, which reads the file
// from a worktree or branch and re-exports this) and the cloud coordinator (FREE-07, which reads it from the task branch
// on GitHub). Pure and browser-safe: text or bytes in, `{ ok, frontmatter, body }` or `{ ok: false, reason }` out.
//
// Frontmatter is a strict YAML subset: `key: value` scalars (optionally "double" or 'single' quoted), inline lists
// `key: [a, b]`, and block lists (`key:` followed by `  - item` lines). Keys are unique; anything else is an error with
// its line number. Nothing is ever guessed.

/** Size cap for one artifact. */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export type Frontmatter = Record<string, string | string[]>;
export type ParsedArtifact = { ok: true; frontmatter: Frontmatter; body: string } | { ok: false; reason: string };

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function unquote(raw: string, line: number): string | { error: string } {
  const v = raw.trim();
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) return { error: `line ${line}: unterminated "quoted" value` };
    const inner = v.slice(1, -1);
    if (/(^|[^\\])"/.test(inner.replace(/\\\\/g, ''))) return { error: `line ${line}: stray quote` };
    return inner.replace(/\\(["\\])/g, '$1');
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) return { error: `line ${line}: unterminated 'quoted' value` };
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * Strict frontmatter + body. The file must start with a `---` line; the frontmatter ends at the next `---` line. Bytes
 * are held to the size cap and must be valid UTF-8.
 */
export function parseArtifact(content: string | Uint8Array): ParsedArtifact {
  let input: string;
  if (typeof content === 'string') input = content;
  else {
    if (content.length > MAX_ARTIFACT_BYTES) return fail(`it is larger than ${MAX_ARTIFACT_BYTES / 1024} KB`);
    try { input = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return fail('it is not valid UTF-8'); }
  }
  if (input.includes('\0')) return fail('contains a NUL byte');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0] !== '---') return fail('must start with a "---" frontmatter line');
  const end = lines.indexOf('---', 1);
  if (end < 0) return fail('the frontmatter has no closing "---" line');
  const frontmatter: Frontmatter = {};
  let listKey: string | undefined;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const n = i + 1;
    if (!line.trim()) { listKey = undefined; continue; }
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item) {
      if (!listKey) return fail(`line ${n}: a list item without a "key:" line above it`);
      const v = unquote(item[1], n);
      if (typeof v !== 'string') return fail(v.error);
      if (!v) return fail(`line ${n}: empty list item`);
      (frontmatter[listKey] as string[]).push(v);
      continue;
    }
    const m = /^([^:\s][^:]*):(?:\s(.*))?$/.exec(line);
    if (!m) return fail(`line ${n}: expected "key: value"`);
    const key = m[1];
    if (!KEY.test(key)) return fail(`line ${n}: "${key.slice(0, 40)}" is not a valid key`);
    if (Object.hasOwn(frontmatter, key)) return fail(`line ${n}: duplicate key "${key}"`);
    const rest = (m[2] ?? '').trim();
    listKey = undefined;
    if (!rest) { frontmatter[key] = []; listKey = key; continue; }
    if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) return fail(`line ${n}: unterminated [list]`);
      const inner = rest.slice(1, -1).trim();
      const values: string[] = [];
      if (inner) for (const part of inner.split(',')) {
        const v = unquote(part, n);
        if (typeof v !== 'string') return fail(v.error);
        if (!v) return fail(`line ${n}: empty list item`);
        values.push(v);
      }
      frontmatter[key] = values;
      continue;
    }
    const v = unquote(rest, n);
    if (typeof v !== 'string') return fail(v.error);
    frontmatter[key] = v;
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return { ok: true, frontmatter, body };
}
