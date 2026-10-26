import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsultancyJob, ConsultancySnapshot } from '../shared/consultancy.js';
import type { QueueState, QueueTask } from '../shared/protocol.js';
import {
  CONFIDENCES, FEASIBILITIES, MAX_QUESTION, RESEARCH_DIR, URL_RE, safeHttpsUrl,
  type Confidence, type Feasibility, type ResearchReport, type ResearchReportSummary, type ResearchSections, type ResearchState, type ResearchStatus, type ToolProposal,
} from '../shared/research.js';
import type { ParsedArtifact as ArtifactResult } from './artifacts.js';
import { writeJsonAtomic } from './persistence.js';
// FREE-07: the prompt and the strict report parser are shared with the cloud coordinator.
import { parseResearchReport, researchPrompt, type ParsedReport, type ParsedTool } from '../shared/research-report.js';
export { parseResearchReport, researchPrompt, type ParsedReport, type ParsedTool };

// ORG-05: the research executive. It is rule-based: it files the CEO's question as an internal consultancy job (which
// needs approval like any job), imports the worker's report strictly when the task finishes, and raises one
// tool_proposal inbox item per proposed tool. A decision on a proposal is only recorded; nothing is installed.

const FILE = 'research.json';
const MAX_REPORTS = 500;
export const INTERNAL_CLIENT = 'Internal';

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
