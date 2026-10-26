/**
 * Release notes come from docs/release-notes/<version>.md through the signed channel file. They are written in a small
 * Markdown subset; render that subset (paragraphs, "- " lists, **bold** headings and runs, `code`) as DOM nodes instead
 * of showing the raw markup. Text only ever becomes text nodes, never HTML.
 */
import { h } from '../ui/dom';

export type Run = { text: string; style?: 'strong' | 'code' };
export type Block = { kind: 'p' | 'h'; runs: Run[] } | { kind: 'ul'; items: Run[][] };

/** Inline runs: `code` and **bold**, everything else plain text. */
export function parseInline(text: string): Run[] {
  const out: Run[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); last = re.lastIndex) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], style: 'code' } : { text: m[2], style: 'strong' });
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Blocks separated by blank lines; consecutive "- " lines are a list, a line that is only **…** (or # …) a heading. */
export function parseNotes(markdown: string): Block[] {
  const blocks: Block[] = [];
  let list: { kind: 'ul'; items: Run[][] } | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) blocks.push({ kind: 'p', runs: parseInline(para.join(' ')) }); para = []; };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      if (!list) { list = { kind: 'ul', items: [] }; blocks.push(list); }
      list.items.push(parseInline(item[1]));
      continue;
    }
    list = null;
    if (!line) { flushPara(); continue; }
    const heading = /^\*\*([^*]+)\*\*$/.exec(line) ?? /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { flushPara(); blocks.push({ kind: 'h', runs: [{ text: heading[1] }] }); continue; }
    para.push(line);
  }
  flushPara();
  return blocks;
}

const runs = (rs: Run[]) => rs.map((r) => (r.style ? h(r.style, {}, r.text) : r.text));

export function renderNotes(markdown: string): HTMLElement[] {
  return parseNotes(markdown).map((b) =>
    b.kind === 'ul' ? h('ul', {}, ...b.items.map((item) => h('li', {}, ...runs(item))))
      : h(b.kind === 'h' ? 'h4' : 'p', {}, ...runs(b.runs)));
}
