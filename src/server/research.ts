import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsultancyJob, ConsultancySnapshot } from '../shared/consultancy.js';
import type { QueueState, QueueTask } from '../shared/protocol.js';
import {
  CONFIDENCES, FEASIBILITIES, MAX_QUESTION, RESEARCH_DIR, URL_RE, safeHttpsUrl,
  type Confidence, type Feasibility, type ResearchReport, type ResearchReportSummary, type ResearchSections, type ResearchState, type ResearchStatus, type ToolProposal,
} from '../shared/research.js';
import type { ArtifactResult } from './artifacts.js';
import { writeJsonAtomic } from './persistence.js';

// ORG-05: the research executive. It is rule-based: it files the CEO's question as an internal consultancy job (which
// needs approval like any job), imports the worker's report strictly when the task finishes, and raises one
// tool_proposal inbox item per proposed tool. A decision on a proposal is only recorded; nothing is installed.

const FILE = 'research.json';
const MAX_TOOLS = 10;
const MAX_FIELD = 300;
const MAX_REPORTS = 500;
export const INTERNAL_CLIENT = 'Internal';

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
    if (names.has(name.toLowerCase())) return { ok: false, reason: `Proposed tool "${clip(name, 60)}" is listed twice.` };
    names.add(name.toLowerCase());
    tools.push({ name: clip(name, 120), url, licence: clip(licence, 120), enables: clip(enables), risk: clip(risk) });
  }
  return tools;
}

// ---- The desk -------------------------------------------------------------------------------------------------------

/** What research needs from the rest of the server; all of it existing state. */
export interface ResearchPorts {
  create(input: { requestId: string; client: string; title: string; brief: string; tasks: { title: string; prompt: string }[] }, actor: string): ConsultancyJob;
  snapshot(): ConsultancySnapshot;
  queue(): QueueState;
  /** The shared artifact importer (src/server/artifacts.ts, readArtifact(projectDir, task, 'research', jobId)). */
  readArtifact(task: QueueTask, jobId: string): ArtifactResult;
  /** Raises a tool_proposal inbox item (idempotent by source) and answers its id. */
  raiseTool?(input: { source: string; jobId: string; tool: ParsedTool; question: string }): string | undefined;
  /** The inbox item's decision, to record on the research card. */
  decision?(approvalId: string): { status: 'pending' | 'approved' | 'rejected' | 'resolved'; decidedAt?: number; decidedBy?: string } | undefined;
}

export class ResearchError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ResearchError'; }
}

interface StoredReport {
  jobId: string;
  requestId: string;
  question: string;
  askedAt: number;
  askedBy: string;
  /** Review fix 2: the queue task first seen for its item, so a task cleared before reconcile can still be imported. */
  binding?: { taskId: string; attempt: number; branch?: string; worker?: string };
  /** The import of a finished task: taskId and attempt it was made from, and its result. */
  import?: {
    taskId: string;
    attempt: number;
    at: number;
    worker: string;
    ok: boolean;
    reason?: string;
    feasibility?: Feasibility;
    confidence?: Confidence;
    sources?: number;
    sections?: ResearchSections;
  };
  tools: ToolProposal[];
}

interface StoredFile { version: 1; revision: number; reports: StoredReport[] }

export class ResearchDesk {
  private readonly file: string;
  private data: StoredFile = { version: 1, revision: 0, reports: [] };
  private storageError?: string;
  private busy = false;

  constructor(dataDir: string, private readonly ports: ResearchPorts, private readonly onChange?: () => void, private readonly now = Date.now) {
    this.file = path.join(dataDir, FILE);
    this.restore();
  }

  get recoveryError() { return this.storageError; }

  /** Files the question as an internal job pending approval. Idempotent per requestId. */
  ask(question: unknown, actor: string, requestId: string): { report: ResearchReportSummary; job: ConsultancyJob } {
    if (this.storageError) throw new ResearchError(503, this.storageError);
    const q = typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
    if (!q) throw new ResearchError(400, 'Ask a question for research.');
    if (q.length > MAX_QUESTION) throw new ResearchError(400, `Keep the question under ${MAX_QUESTION} characters.`);
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 100) throw new ResearchError(400, 'requestId is invalid');
    const key = `research-${requestId.trim()}`;
    const known = this.data.reports.find((r) => r.requestId === key);
    if (known && known.question !== q) throw new ResearchError(409, 'This request was already used for a different question.');
    const job = this.ports.create({
      requestId: key,
      client: INTERNAL_CLIENT,
      title: `Research: ${q.length > 120 ? `${q.slice(0, 117)}…` : q}`,
      brief: `Internal research for the CEO. ${q}\n\nThe worker writes a sourced report; nothing is installed or adopted.`,
      tasks: [{ title: 'Research report', prompt: researchPrompt(q) }],
    }, actor);
    if (!known) {
      this.data.reports.push({ jobId: job.id, requestId: key, question: q, askedAt: this.now(), askedBy: actor, tools: [] });
      if (this.data.reports.length > MAX_REPORTS) this.data.reports.splice(0, this.data.reports.length - MAX_REPORTS);
      this.save();
    }
    return { report: this.summary(this.data.reports.find((r) => r.jobId === job.id)!, this.jobs()), job };
  }

  /** Imports finished reports, raises tool proposals once, and records decisions. Never throws. */
  reconcile(): boolean {
    if (this.storageError || this.busy) return false;
    this.busy = true;
    try {
      const before = JSON.stringify(this.data.reports);
      let queue: QueueState | undefined;
      try { queue = this.ports.queue(); } catch { queue = undefined; }
      const jobs = this.jobs();
      for (const report of this.data.reports) {
        const job = jobs.get(report.jobId);
        if (queue && job?.decision === 'approved') this.importIfDone(report, job, queue);
        this.raiseTools(report);
        this.syncDecisions(report);
      }
      if (JSON.stringify(this.data.reports) === before) return false;
      this.save();
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Why the item of a research job needs attention after its task finished, or undefined. Used by consultancy. */
  issue(jobKey: string): string | undefined {
    const [, jobId] = /^consultancy:([^:]+):item-1$/.exec(jobKey) ?? [];
    const imported = jobId ? this.data.reports.find((r) => r.jobId === jobId)?.import : undefined;
    return imported && !imported.ok ? `Research report not accepted: ${imported.reason}` : undefined;
  }

  isResearchJob(jobId: string) { return this.data.reports.some((r) => r.jobId === jobId); }

  state(): ResearchState {
    const jobs = this.jobs();
    const reports = [...this.data.reports].sort((a, b) => b.askedAt - a.askedAt).map((r) => this.summary(r, jobs));
    return {
      schemaVersion: 1,
      reports,
      openProposals: reports.reduce((n, r) => n + r.tools.filter((t) => t.decision === 'pending').length, 0),
      ...(this.storageError ? { storageError: this.storageError } : {}),
    };
  }

  report(jobId: string): ResearchReport | undefined {
    const stored = this.data.reports.find((r) => r.jobId === jobId);
    if (!stored) return undefined;
    const summary = this.summary(stored, this.jobs());
    return stored.import?.ok && stored.import.sections ? { ...summary, sections: structuredClone(stored.import.sections) } : summary;
  }

  private jobs(): Map<string, ConsultancyJob> {
    try { return new Map(this.ports.snapshot().jobs.map((j) => [j.id, j])); } catch { return new Map(); }
  }

  private importIfDone(report: StoredReport, job: ConsultancyJob, queue: QueueState) {
    const item = job.items[0];
    if (!item) return;
    let task = queue.tasks.find((t) => t.jobKey === item.jobKey && (item.queueTaskId === undefined || t.id === item.queueTaskId));
    if (task) {
      const binding = { taskId: task.id, attempt: task.attempt ?? 0, ...(task.branch ? { branch: task.branch } : {}), ...(task.workerName ? { worker: task.workerName } : {}) };
      if (JSON.stringify(report.binding) !== JSON.stringify(binding)) report.binding = binding;
    } else {
      // Cleared from the queue before this reconcile: import only a recorded successful finish, from the saved branch.
      const b = report.binding;
      if (!b?.branch || !item.finishedOk || (item.queueTaskId !== undefined && item.queueTaskId !== b.taskId)) return;
      task = { id: b.taskId, attempt: b.attempt, branch: b.branch, workerName: b.worker, jobKey: item.jobKey, title: item.title, prompt: '', addedBy: '', addedAt: 0, status: 'done', outcome: 'done' };
    }
    if (task.status !== 'done' || task.outcome !== 'done') return;
    const attempt = task.attempt ?? 0;
    // Once accepted, a report is never re-imported. A rejected one is re-read only after a new attempt finishes.
    if (report.import && (report.import.ok || (report.import.taskId === task.id && report.import.attempt === attempt))) return;
    let artifact: ArtifactResult;
    try { artifact = this.ports.readArtifact(task, report.jobId); } catch (error) { artifact = { ok: false, reason: `The report could not be read: ${(error as Error).message}` }; }
    const parsed = parseResearchReport(artifact);
    const base = { taskId: task.id, attempt, at: this.now(), worker: task.workerName || 'a worker' };
    if (!parsed.ok) { report.import = { ...base, ok: false, reason: parsed.reason }; return; }
    report.import = { ...base, ok: true, feasibility: parsed.feasibility, confidence: parsed.confidence, sources: parsed.sources, sections: parsed.sections };
    report.tools = parsed.tools.map((t) => ({ ...t, decision: 'pending' }));
  }

  private raiseTools(report: StoredReport) {
    if (!this.ports.raiseTool || !report.import?.ok) return;
    report.tools.forEach((tool, i) => {
      // Review minor: a pending proposal whose inbox item is unknown (approvals.json restored from a backup) is raised again.
      if (tool.approvalId && !(tool.decision === 'pending' && this.ports.decision && !this.ports.decision(tool.approvalId))) return;
      const id = this.ports.raiseTool!({ source: `tool:${report.jobId}:${i + 1}`, jobId: report.jobId, tool, question: report.question });
      if (id) tool.approvalId = id;
    });
  }

  private syncDecisions(report: StoredReport) {
    if (!this.ports.decision) return;
    for (const tool of report.tools) {
      if (!tool.approvalId || tool.decision !== 'pending') continue;
      const d = this.ports.decision(tool.approvalId);
      if (!d || (d.status !== 'approved' && d.status !== 'rejected')) continue;
      tool.decision = d.status;
      if (d.decidedAt !== undefined) tool.decidedAt = d.decidedAt;
      if (d.decidedBy) tool.decidedBy = d.decidedBy;
    }
  }

  private summary(r: StoredReport, jobs: Map<string, ConsultancyJob>): ResearchReportSummary {
    const job = jobs.get(r.jobId);
    let status: ResearchStatus;
    let reason: string | undefined;
    if (r.import?.ok) status = 'imported';
    else if (r.import) { status = 'needs_attention'; reason = r.import.reason; }
    else if (!job) { status = 'needs_attention'; reason = 'Its job is missing from the consultancy journal.'; }
    else if (job.decision === 'pending_approval') status = 'awaiting_approval';
    else if (job.decision === 'rejected') status = 'rejected';
    else if (job.status === 'running') status = 'running';
    else if (job.status === 'needs_attention') { status = 'needs_attention'; reason = job.attention; }
    else if (job.status === 'awaiting_review') { status = 'needs_attention'; reason = 'The task finished but its report was not imported yet.'; }
    else status = 'queued';
    const cost = job?.actualSpendUsd;
    return {
      jobId: r.jobId,
      question: r.question,
      askedAt: r.askedAt,
      askedBy: r.askedBy,
      status,
      ...(reason ? { reason } : {}),
      ...(r.import?.ok ? { feasibility: r.import.feasibility, confidence: r.import.confidence, sources: r.import.sources, importedAt: r.import.at } : {}),
      ...(r.import ? { worker: r.import.worker } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      tools: r.tools.map((t) => ({ ...t })),
    };
  }

  private save() {
    this.data.revision += 1;
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (error) {
      this.storageError = `Research reports could not be saved; preserve research.json, repair storage and restart. ${(error as Error).message}`;
      throw new ResearchError(503, this.storageError);
    }
    try { this.onChange?.(); } catch { /* observers cannot undo a saved index */ }
  }

  private restore() {
    // An older data directory has no research.json: it starts empty.
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredFile;
      if (!raw || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.reports)) throw new Error('research.json has an unsupported shape');
      for (const r of raw.reports) {
        if (!r || typeof r.jobId !== 'string' || typeof r.question !== 'string' || typeof r.requestId !== 'string' || !Number.isSafeInteger(r.askedAt) || !Array.isArray(r.tools)) throw new Error('a report entry is incomplete');
        for (const t of r.tools) if (!safeHttpsUrl(t.url) || !['pending', 'approved', 'rejected'].includes(t.decision)) throw new Error('a tool proposal is invalid');
      }
      this.data = raw;
    } catch (error) {
      this.storageError = `Cannot restore research.json; preserve the file and recover a valid backup. ${(error as Error).message}`;
    }
  }
}
