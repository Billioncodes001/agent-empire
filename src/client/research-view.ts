// ORG-05: rendering a research report as text. Shared by the game (research card) and the founder desk. Nothing a
// worker wrote is ever parsed as HTML: text nodes only, and https links as anchors with rel="noopener noreferrer".

import { CONFIDENCE_LABEL, FEASIBILITY_LABEL, URL_RE, researchedBy, safeHttpsUrl, type ResearchReport, type ResearchReportSummary, type ToolProposal } from '../shared/research';

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/** An https URL as a safe anchor; anything else stays plain text. */
export function safeLink(url: string, label?: string): HTMLElement | Text {
  const href = safeHttpsUrl(url);
  if (!href) return document.createTextNode(label ?? url);
  const a = el('a', 'research-link', label ?? url);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** Text with its http(s) URLs as safe anchors (http stays text). */
export function linkify(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:]+$/, '');
    const at = m.index ?? 0;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));
    out.push(safeLink(raw));
    last = at + raw.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Markdown-ish text as paragraphs and bullet lists of text nodes. Tables and headings stay readable text. */
export function textBlock(text: string): HTMLElement {
  const box = el('div', 'research-text');
  let list: HTMLUListElement | undefined;
  let para: string[] = [];
  const flush = () => { if (para.length) { box.append(el('p', '', ...linkify(para.join(' ')))); para = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { flush(); if (!list) { list = el('ul'); box.append(list); } list.append(el('li', '', ...linkify(bullet[1]))); continue; }
    if (!line.trim()) { flush(); list = undefined; continue; }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // table separator rows
    list = undefined;
    para.push(line.replace(/^#+\s*/, '').replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · '));
  }
  flush();
  return box;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const date = (at: number) => new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const STATUS_LABEL: Record<ResearchReportSummary['status'], string> = {
  awaiting_approval: 'Awaiting your approval',
  queued: 'Queued',
  running: 'Researching',
  imported: 'Report in',
  needs_attention: 'Needs attention',
  rejected: 'Declined',
};

/** Feasibility · confidence · date · cost, as short chips. */
export function reportFacts(r: ResearchReportSummary): HTMLElement {
  const chips: Child[] = [
    r.feasibility ? el('span', `research-chip feas-${r.feasibility}`, FEASIBILITY_LABEL[r.feasibility]) : el('span', 'research-chip', STATUS_LABEL[r.status]),
    r.confidence ? el('span', 'research-chip', CONFIDENCE_LABEL[r.confidence]) : null,
    el('span', 'research-chip quiet', date(r.importedAt ?? r.askedAt)),
    el('span', 'research-chip quiet', r.costUsd !== undefined ? `${usd(r.costUsd)} provider cost` : 'cost not recorded'),
  ];
  return el('p', 'research-facts', ...chips);
}

const DECISION: Record<ToolProposal['decision'], string> = { pending: 'Waiting for your decision', approved: 'Approved — decision recorded, nothing installed', rejected: 'Declined — decision recorded' };

export function toolList(tools: ToolProposal[]): HTMLElement {
  if (!tools.length) return el('p', 'research-note', 'No tools proposed.');
  return el('ul', 'research-tools', ...tools.map((t) => el('li', `research-tool decision-${t.decision}`,
    el('strong', '', t.name), ' ', safeLink(t.url),
    el('span', 'research-tool-meta', `Licence ${t.licence} · Enables: ${t.enables} · Risk: ${t.risk}`),
    el('span', 'research-tool-decision', `${DECISION[t.decision]}${t.approvalId ? ` · ${t.approvalId}` : ''}${t.decidedBy ? ` · ${t.decidedBy}` : ''}`))));
}

/** The full report view: honest label, facts, the four sections and the tools with their recorded decisions. */
export function reportBody(r: ResearchReport): HTMLElement {
  const box = el('article', 'research-report');
  box.append(el('p', 'research-label', r.worker ? researchedBy(r.worker) : 'Not written yet — not verified'), reportFacts(r));
  if (r.reason) box.append(el('p', 'research-reason', r.reason));
  if (r.sections) {
    const section = (title: string, text: string) => el('section', 'research-section', el('h4', '', title), textBlock(text));
    box.append(
      section(`Findings${r.sources ? ` · ${r.sources} source${r.sources === 1 ? '' : 's'} cited` : ''}`, r.sections.findings),
      section('What we can do now', r.sections.canDoNow),
      section('What we can’t do yet and why', r.sections.cannotYet),
    );
  }
  box.append(el('section', 'research-section', el('h4', '', 'Proposed tools'), toolList(r.tools)));
  box.append(el('p', 'research-note', 'Sources were cited by the worker and are not checked by the Empire. Approving a tool only records your decision.'));
  return box;
}
