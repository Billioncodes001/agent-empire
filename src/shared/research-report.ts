// The research worker's prompt and the strict report parser (ORG-05), shared by the office server (src/server/research.ts
// re-exports these) and the cloud coordinator (FREE-07, src/cloud/org.ts). Pure and browser-safe.

import type { ParsedArtifact as ArtifactResult } from './artifact-parse.js';
import {
  CONFIDENCES, FEASIBILITIES, MAX_QUESTION, RESEARCH_DIR, URL_RE, safeHttpsUrl,
  type Confidence, type Feasibility, type ResearchSections, type ToolProposal,
} from './research.js';

import { hasHiddenChars } from './text-safety.js';

const MAX_TOOLS = 10;
/** FREE-07 review fix 1: the longest tool URL a report may propose. */
export const MAX_TOOL_URL = 500;
const MAX_FIELD = 300;

/** The four required sections, by their exact headings (a straight or curly apostrophe in "can't"). */
const SECTIONS: { key: keyof ResearchSections; heading: RegExp; label: string }[] = [
  { key: 'findings', heading: /^Findings$/, label: 'Findings' },
  { key: 'canDoNow', heading: /^What we can do now$/, label: 'What we can do now' },
  { key: 'cannotYet', heading: /^What we can[’']t do yet and why$/, label: "What we can't do yet and why" },
  { key: 'proposedTools', heading: /^Proposed tools$/, label: 'Proposed tools' },
];

export type ParsedTool = Pick<ToolProposal, 'name' | 'url' | 'licence' | 'enables' | 'risk'>;
export type ParsedReport =
  | { ok: true; question: string; feasibility: Feasibility; confidence: Confidence; sections: ResearchSections; sources: number; tools: ParsedTool[] }
  | { ok: false; reason: string };

/** The prompt the worker receives. `{{jobId}}` is replaced with the job id when the job is created. */
export function researchPrompt(question: string): string {
  return [
    'You are researching a question for the CEO of this company. Research only: do not install, adopt, buy or sign up for anything, and do not change any other file.',
    '',
    `Question: ${question}`,
    '',
    `Write exactly one markdown file at ${RESEARCH_DIR}/{{jobId}}.md in your worktree, and commit it to your branch. It is imported automatically and parsed strictly; anything missing makes the report need attention.`,
    '',
    'It must start with this frontmatter (one line each, nothing else):',
    '---',
    'question: <the question, one line>',
    'feasibility: feasible | partial | not_yet | unknown',
    'confidence: low | medium | high',
    '---',
    '',
    'Then these four sections, with exactly these headings, in this order:',
    '## Findings',
    'A bullet list ("- "). Every bullet is one claim and cites at least one source URL (https://…) that supports it. A claim you cannot source does not belong here.',
    '## What we can do now',
    '## What we can\'t do yet and why',
    '## Proposed tools',
    'Either the single word "None." or a markdown table with exactly these columns:',
    '| Name | URL | Licence | Enables | Risk |',
    '|---|---|---|---|---|',
    `One row per tool (at most ${MAX_TOOLS}): its https URL, its licence as published, what it would let us do, and its risks (security, cost, lock-in, licence). Proposing a tool does not adopt it; the CEO decides.`,
    '',
    'Be honest. If the answer is that we cannot do this yet, or you do not know, say so: use not_yet or unknown, explain why with evidence, and keep confidence low when the sources are thin. Do not overstate certainty and do not invent sources.',
  ].join('\n');
}

const clip = (s: string, n = MAX_FIELD) => s.trim().slice(0, n);

/** Strict parse of a report's frontmatter and body. Returns the first reason it is not acceptable. */
export function parseResearchReport(artifact: ArtifactResult): ParsedReport {
  if (!artifact.ok) return artifact;
  // The shared parser also reads lists; every research field is a single value.
  const listKey = Object.entries(artifact.frontmatter).find(([, v]) => typeof v !== 'string')?.[0];
  if (listKey) return { ok: false, reason: `Frontmatter ${listKey} must be a single value, not a list.` };
  const fm = artifact.frontmatter as Record<string, string>;
  const unknown = Object.keys(fm).filter((k) => !['question', 'feasibility', 'confidence'].includes(k));
  if (unknown.length) return { ok: false, reason: `Unexpected frontmatter key: ${unknown[0]}.` };
  const question = (fm.question ?? '').trim();
  if (!question) return { ok: false, reason: 'Frontmatter is missing question.' };
  if (question.length > MAX_QUESTION) return { ok: false, reason: `Frontmatter question is longer than ${MAX_QUESTION} characters.` };
  if (fm.feasibility === undefined) return { ok: false, reason: 'Frontmatter is missing feasibility.' };
  if (!(FEASIBILITIES as readonly string[]).includes(fm.feasibility)) return { ok: false, reason: `feasibility must be feasible, partial, not_yet or unknown (got "${fm.feasibility.slice(0, 40)}").` };
  if (fm.confidence === undefined) return { ok: false, reason: 'Frontmatter is missing confidence.' };
  if (!(CONFIDENCES as readonly string[]).includes(fm.confidence)) return { ok: false, reason: `confidence must be low, medium or high (got "${fm.confidence.slice(0, 40)}").` };

  // Split on level-2 headings. Text before the first one is allowed (a title); every section must appear once.
  const found = new Map<keyof ResearchSections, string[]>();
  let current: string[] | undefined;
  const order: (keyof ResearchSections)[] = [];
  for (const line of artifact.body.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h && !line.startsWith('###')) {
      const section = SECTIONS.find((s) => s.heading.test(h[1].trim()));
      if (!section) { current = undefined; continue; }
      if (found.has(section.key)) return { ok: false, reason: `The section "${section.label}" appears twice.` };
      current = [];
      found.set(section.key, current);
      order.push(section.key);
      continue;
    }
    current?.push(line);
  }
  for (const s of SECTIONS) if (!found.has(s.key)) return { ok: false, reason: `The required section "${s.label}" is missing.` };
  if (order.some((key, i) => key !== SECTIONS[i].key)) return { ok: false, reason: `The sections are out of order: write ${SECTIONS.map((s) => s.label).join(", then ")}.` };
  const sections = Object.fromEntries(SECTIONS.map((s) => [s.key, found.get(s.key)!.join('\n').trim()])) as unknown as ResearchSections;
  for (const s of SECTIONS.slice(1, 3)) if (!sections[s.key]) return { ok: false, reason: `The section "${s.label}" is empty.` };

  // Findings: a bullet list, and every bullet cites a source URL.
  const bullets: string[] = [];
  for (const line of sections.findings.split('\n')) {
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) bullets.push(line);
    else if (/^\s{2,}\S/.test(line) && bullets.length) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  if (!bullets.length) return { ok: false, reason: 'Findings has no claims: write them as a bullet list, each citing a source URL.' };
  const sources = new Set<string>();
  for (const [i, bullet] of bullets.entries()) {
    const urls = bullet.match(URL_RE) ?? [];
    if (!urls.length) return { ok: false, reason: `Findings claim ${i + 1} cites no source URL.` };
    urls.forEach((u) => sources.add(u.replace(/[.,;:]+$/, '')));
  }

  // FREE-07 review fix 5: a report is shown as text to the CEO; refuse invisible or control characters (newline and tab are fine).
  if (hasHiddenChars(question) || Object.values(sections).some((s) => hasHiddenChars(s))) return { ok: false, reason: 'The report contains invisible or control characters.' };
  const tools = parseTools(sections.proposedTools);
  if (!Array.isArray(tools)) return tools;
  return { ok: true, question, feasibility: fm.feasibility as Feasibility, confidence: fm.confidence as Confidence, sections, sources: sources.size, tools };
}

function parseTools(text: string): ParsedTool[] | { ok: false; reason: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && /^none\.?$/i.test(lines[0])) return [];
  if (!lines.length) return { ok: false, reason: 'Proposed tools is empty: write "None." or a table.' };
  const cells = (line: string) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const rows = lines.filter((l) => l.startsWith('|'));
  if (rows.length !== lines.length) return { ok: false, reason: 'Proposed tools must be "None." or only a table.' };
  const header = cells(rows[0]).map((c) => c.toLowerCase());
  const expected = ['name', 'url', 'licence', 'enables', 'risk'];
  if (header.length !== 5 || header.some((c, i) => c !== expected[i] && !(i === 2 && c === 'license')))
    return { ok: false, reason: 'The Proposed tools table must have the columns Name | URL | Licence | Enables | Risk.' };
  if (!rows[1] || !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*){4}\|?$/.test(rows[1])) return { ok: false, reason: 'The Proposed tools table has no separator row.' };
  const body = rows.slice(2);
  if (!body.length) return { ok: false, reason: 'The Proposed tools table has no rows; write "None." if there are none.' };
  if (body.length > MAX_TOOLS) return { ok: false, reason: `At most ${MAX_TOOLS} proposed tools.` };
  const tools: ParsedTool[] = [];
  const names = new Set<string>();
  for (const [i, row] of body.entries()) {
    const c = cells(row);
    if (c.length !== 5) return { ok: false, reason: `Proposed tool row ${i + 1} does not have 5 columns.` };
    const [name, rawUrl, licence, enables, risk] = c;
    const link = /^\[[^\]]*\]\((.+)\)$/.exec(rawUrl)?.[1] ?? rawUrl.replace(/^<|>$/g, '');
    const url = safeHttpsUrl(link);
    if (!name || !licence || !enables || !risk) return { ok: false, reason: `Proposed tool row ${i + 1} has an empty column.` };
    if (!url) return { ok: false, reason: `Proposed tool "${clip(name, 60)}" needs an https URL.` };
    // FREE-07 review fix 1: stored URLs are bounded (a tool's home page needs no more), never clipped into another link.
    if (url.length > MAX_TOOL_URL) return { ok: false, reason: `Proposed tool "${clip(name, 60)}" has a URL longer than ${MAX_TOOL_URL} characters.` };
    // Review fix 5: text the CEO reads in the inbox must not hide characters.
    if ([name, licence, enables, risk].some((v) => hasHiddenChars(v))) return { ok: false, reason: `Proposed tool row ${i + 1} contains invisible or control characters.` };
    if (names.has(name.toLowerCase())) return { ok: false, reason: `Proposed tool "${clip(name, 60)}" is listed twice.` };
    names.add(name.toLowerCase());
    tools.push({ name: clip(name, 120), url, licence: clip(licence, 120), enables: clip(enables), risk: clip(risk) });
  }
  return tools;
}

