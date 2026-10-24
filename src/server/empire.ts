import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  initialEmpire,
  newSector,
  SITES,
  managerStartupPrompt,
  type EmpireAction,
  type EmpireState,
  type SectorState,
  type SiteId,
} from '../shared/empire.js';
import {
  applyCityAction, creditTaskReward, serviceCoverage, settleOperatingHour, TASK_REWARD, type CityActionText,
} from '../shared/economy-rules.js';
import type { WorkerInfo, QueueState, QueueTask } from '../shared/protocol.js';
import type { TaskQueue } from './queue.js';
import { DESKS_PER_FLOOR, fundedDesk } from '../shared/layout.js';
import { randomBytes } from 'node:crypto';
import { normalizeCity } from '../shared/city.js';
import { chiefLinksConflict, projectSupervision } from './supervision.js';

/** Host report wording. The rules and amounts are shared with cloud mode (src/shared/economy-rules.ts). */
const SERVER_TEXT: CityActionText = {
  founded: (n) => `Founding plan confirmed: ${n} buildings. Managers have been appointed; their real startup work will use the agent queue.`,
  floor: (n) => `Floor ${n} constructed. Take the elevator upstairs; furnish workstations before hiring.`,
  workstation: (n) => `Workstation ${n} installed with a computer. A new worker can now be employed.`,
  delegated: (on) => on
    ? 'Delegated oversight requested. The server continues rule-based monitoring; this does not start an AI supervisor.'
    : 'CEO resumed direct oversight. The server continues rule-based monitoring.',
  reinvested: (amount) => `Founder reinvested ${amount.toLocaleString()} credits into the city.`,
  land: (site) => `${site.name} parcel acquired for ${site.landCost.toLocaleString()} credits. Construction is now available.`,
  built: (site) => `${site.name} constructed with a manager assignment and one service employee.`,
  hired: (site, staff) => `${site.name}: ${staff}/${site.capacity} service employees. Each earns 18 credits per operating hour.`,
  upgraded: (site, level) => `${site.name} upgraded to level ${level}; service revenue increases 30% per level.`,
};

/** Authoritative district ledger. AI rewards use observed queue outcomes, never invented completions. */
export class Empire {
  state: EmpireState;
  private file: string;
  private reportMinute = 0;
  private readonly serverRunId = randomBytes(12).toString('hex');
  private attentionIds = new Set<string>();
  constructor(
    dataDir: string,
    private changed: (state: EmpireState) => void,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'empire.json');
    this.state = initialEmpire();
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (
        ![1, 2].includes(saved.version) ||
        !Array.isArray(saved.sectors) ||
        !Number.isFinite(saved.funds) ||
        saved.funds < 0 ||
        !Number.isFinite(saved.minutes)
      )
        throw new Error('Invalid empire save; preserve empire.json and restore a valid backup.');
      for (const site of SITES.filter((s) => saved.version === 2 || !['recreation', 'studio'].includes(s.id))) {
        if (
          !saved.sectors.some(
            (s: any) =>
              s.id === site.id && typeof s.built === 'boolean' && Number.isInteger(s.staff) && s.staff >= 0 && s.staff <= site.capacity,
          )
        )
          throw new Error('Invalid sector in empire save');
      }
      if (saved.version === 1) {
        if (!existsSync(this.file + '.v1-backup'))
          writeFileSync(this.file + '.v1-backup', JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
        this.state = {
          ...this.state,
          ...saved,
          version: 2,
          office: { floors: 1, workstations: 16 },
          delegated: true,
          setup: this.state.setup,
          economy: this.state.economy,
          sectors: SITES.map((s) => ({
            ...newSector(s.id),
            ...saved.sectors.find((old: SectorState) => old.id === s.id),
          })),
        };
        this.state.economy.lastHour = Math.floor(this.state.minutes / 60);
        this.report(
          'Chief of staff',
          'Your existing district and treasury have been preserved. Complete founding setup to appoint your sector managers.',
        );
        this.flush();
      } else {
        if (
          !saved.setup ||
          typeof saved.setup.completed !== 'boolean' ||
          !saved.economy ||
          !Array.isArray(saved.economy.rewardedTasks) ||
          !Number.isFinite(saved.economy.lastHour) ||
          !Number.isFinite(saved.economy.ownerBalance) ||
          !Array.isArray(saved.economy.ledger) ||
          !saved.economy.employees ||
          Array.isArray(saved.economy.employees) ||
          !['startedAt', 'lastHour', 'revenue', 'wages', 'upkeep', 'dividends', 'ownerBalance'].every(
            (key) => Number.isFinite(saved.economy[key]) && saved.economy[key] >= 0,
          ) ||
          !Number.isFinite(saved.economy.capital) ||
          !saved.sectors.every(
            (sector: any) =>
              typeof sector.owned === 'boolean' &&
              Number.isInteger(sector.level) &&
              sector.level >= 1 &&
              sector.level <= 3 &&
              ['revenue', 'wages', 'upkeep'].every((key) => Number.isFinite(sector[key]) && sector[key] >= 0),
          )
        )
          throw new Error('Invalid economy save');
        this.state = saved;
      }
    }
    delete this.state.supervision;
    // FREE-09: a save without plots/garage vehicles keeps the original district (shared/city.ts). Malformed blocks throw.
    this.state.city = normalizeCity(this.state.city);
    if (!this.state.office) {
      // Existing desks and workers survive an upgrade. New cities start with four funded seats.
      if (!existsSync(this.file + '.v2-office-backup')) writeFileSync(this.file + '.v2-office-backup', readFileSync(this.file), { mode: 0o600 });
      this.state.office = { floors: 1, workstations: 16 };
      this.flush();
    }
    const office = this.state.office;
    if (!Number.isSafeInteger(office.floors) || office.floors < 1 || !Number.isSafeInteger(office.workstations) || office.workstations < 1 || office.workstations > office.floors * DESKS_PER_FLOOR)
      throw new Error('Invalid headquarters capacity in empire save');
    this.reportMinute = Math.floor(this.state.minutes / 30);
  }
  deskAvailable(id: string) { return fundedDesk(id, this.state.office.workstations); }
  private report(sector: string, text: string) {
    this.state.reports.unshift({ at: Date.now(), sector, text });
    this.state.reports = this.state.reports.slice(0, 80);
  }
  /** Only the current appointment may retry a manager task, including legacy job keys. */
  managerTaskRetryBlocker(task: QueueTask): string | undefined {
    if (!task.jobKey?.startsWith('empire-manager-')) return;
    if (!this.state.sectors.some(s => s.manager?.jobKey === task.jobKey))
      return 'This manager startup has been superseded. Recover the current assignment from Management instead.';
  }
  action(action: EmpireAction, queue?: Pick<TaskQueue, 'state' | 'retry' | 'managerRetryBlocker'>): string | undefined {
    const error = action.kind === 'retry-manager'
      ? this.retryManager(action.site, queue)
      : applyCityAction(this.state, action, Date.now(), SERVER_TEXT, (sector, text) => this.report(sector, text));
    if (error) return error;
    this.flush();
    this.changed(this.state);
  }
  /** Host-only: requeue a manager's startup through the task queue under its existing appointment. */
  private retryManager(siteId: SiteId, queue?: Pick<TaskQueue, 'state' | 'retry' | 'managerRetryBlocker'>): string | undefined {
    const site = SITES.find((s) => s.id === siteId),
      sector = this.state.sectors.find((s) => s.id === siteId);
    if (!site || !sector) return 'Unknown site';
    if (!sector.built || !sector.manager) return 'No manager assignment';
    if (!['offline', 'pending'].includes(sector.manager.status)) return 'Manager already assigned or queued';
    if (!queue) return 'Manager recovery requires the task queue';
    const manager = sector.manager;
    const blocked = queue.managerRetryBlocker(manager.jobKey, manager.workerId);
    if (blocked) return blocked;
    const task = queue.state().tasks.find(t => t.jobKey === manager.jobKey);
    if (task) {
      // Both Management and Requeue recover the same logical task/reward identity.
      // Creating a new job key here leaves the old task independently retryable.
      const error = queue.retry(task.id);
      if (error) return error;
      const retried = queue.state().tasks.find(t => t.id === task.id)!;
      Object.assign(manager, { status: 'queued', taskId: retried.id, workerId: retried.workerId, attempt: retried.attempt ?? manager.attempt + 1, error: retried.error });
    } else {
      // Removed failed history can be dispatched again under the existing appointment key.
      // Recovery guards above still check its last worker and any older sibling attempts.
      Object.assign(manager, { status: 'pending', taskId: undefined, workerId: undefined, error: undefined });
    }
  }
  /** A stable queue key makes recovery safe if the process stops between the two file writes. */
  dispatchManagers(queue: Pick<TaskQueue, 'add' | 'state'>, founder: string) {
    let changed = false;
    for (const sector of this.state.sectors) {
      const m = sector.manager;
      if (!m || m.status !== 'pending' || !this.state.setup.completed) continue;
      const prompt = managerStartupPrompt(sector.id, m.name, 'server');
      const error = queue.add(prompt, founder, `${m.name}: startup brief`, undefined, m.jobKey);
      m.error = error;
      if (!error) {
        const task = queue.state().tasks.find((t) => t.jobKey === m.jobKey);
        m.taskId = task?.id;
        if (m.status === 'pending') m.status = 'queued';
      }
      changed = true;
    }
    if (changed) {
      this.flush();
      this.changed(this.state);
    }
  }
  tick(workers: WorkerInfo[], queue: QueueState, seconds = 5) {
    if (!Number.isFinite(seconds)) return;
    const conflictingChiefLinks = chiefLinksConflict(this.state, queue);
    this.state.minutes += Math.max(0, Math.min(seconds, 60));
    const attention = workers.filter(w => w.kind === 'agent' && w.status === 'needs_input');
    const newAttention = attention.some(w => !this.attentionIds.has(w.id));
    this.attentionIds = new Set(attention.map(w => w.id));
    this.state.workforce = {
      working: workers.filter((w) => w.kind === 'agent' && (w.status === 'working' || w.status === 'starting')).length,
      attention: workers.filter((w) => w.kind === 'agent' && w.status === 'needs_input').length,
      done: workers.filter((w) => w.kind === 'agent' && w.status === 'done').length,
      queued: queue.tasks.filter((t) => t.status === 'queued').length,
    };
    for (const sector of this.state.sectors) {
      sector.service = serviceCoverage(sector);
      const m = sector.manager;
      if (!m) continue;
      const task = queue.tasks.find((t) => t.jobKey === m.jobKey);
      if (!task) {
        if (m.status === 'queued' || m.status === 'working' || m.status === 'needs_input') {
          m.status = 'offline';
          m.error = 'Manager task is no longer in the queue';
        }
        continue;
      }
      const old = m.status,
        worker = workers.find((w) => w.id === task.workerId);
      m.taskId = task.id;
      m.workerId = task.workerId;
      m.attempt = Math.max(m.attempt, task.attempt ?? 1);
      m.error = task.error;
      m.status =
        task.status === 'queued'
          ? 'queued'
          : task.status === 'done'
            ? task.outcome === 'done'
              ? 'ready'
              : 'offline'
            : worker?.status === 'needs_input'
              ? 'needs_input'
              : worker && !['offline', 'exited'].includes(worker.status)
                ? 'working'
                : 'offline';
      if (old !== m.status && ['ready', 'offline', 'needs_input'].includes(m.status))
        this.report(
          'Chief of staff',
          `${m.name}: ${m.status === 'ready' ? 'startup turn ended; brief not yet verified' : m.status === 'offline' ? 'startup needs attention; review the worker before retrying' : 'needs your input in the worker terminal'}.`,
        );
    }
    if (this.state.setup.completed) {
      const economy = this.state.economy;
      for (const task of queue.tasks) {
        if (
          task.status !== 'done' ||
          task.outcome !== 'done' ||
          !task.workerId ||
          !task.finishedAt ||
          task.finishedAt < economy.startedAt ||
          economy.rewardedTasks.includes(task.id)
        )
          continue;
        economy.rewardedTasks.push(task.id);
        const site = SITES.find((s) => task.prompt.startsWith(`Sector: ${s.sector} / ${s.name}\n`)) ?? SITES[0];
        const sector = this.state.sectors.find((s) => s.id === site.id)!;
        const managerJob = task.jobKey?.startsWith('empire-manager-') && sector.manager;
        creditTaskReward(this.state, Date.now(), {
          site: site.id,
          payeeId: managerJob ? managerJob.id : `agent-${task.workerId}`,
          payeeName: managerJob ? managerJob.name : (task.workerName ?? 'AI worker'),
          role: managerJob ? 'manager' : 'agent',
          label: `Completed AI task: ${task.title}`,
        });
        this.report(
          'Chief of staff',
          `Completed task credited: ${task.title}. ${TASK_REWARD.revenue} city credits earned; ${TASK_REWARD.wages} paid to the worker and ${TASK_REWARD.dividend} to the founder.`,
        );
      }
      const hour = Math.floor(this.state.minutes / 60);
      if (hour > economy.lastHour) {
        economy.lastHour = hour;
        const settled = settleOperatingHour(this.state, Date.now());
        for (const name of settled.paused) this.report('Treasury', `${name} paused for this hour: payroll cannot be funded.`);
        if (settled.revenue || settled.wages || settled.upkeep) {
          this.report(
            'Treasury',
            `Hourly close: ${settled.revenue} revenue − ${settled.wages} wages − ${settled.upkeep} upkeep. Founder dividend ${settled.dividend}; treasury ${this.state.funds.toLocaleString()} credits.`,
          );
        }
      }
    }
    if (newAttention)
      this.report(
        'Chief of staff',
        `${this.state.workforce.attention} AI worker(s) need your input. Open their terminals; approval remains with you.`,
      );
    const period = Math.floor(this.state.minutes / 30);
    if (period > this.reportMinute && this.state.setup.completed) {
      this.reportMinute = period;
      for (const sector of this.state.sectors.filter((s) => s.built && s.id !== 'home')) {
        const site = SITES.find((s) => s.id === sector.id)!;
        this.report(
          site.sector,
          `${site.name}: ${sector.manager?.name ?? 'No manager'} · ${sector.manager?.status ?? 'unassigned'} · ${sector.staff}/${site.capacity} staff · ${sector.service}% coverage.`,
        );
      }
    }
    this.state.supervision = projectSupervision(this.state, workers, queue, this.serverRunId, Date.now());
    // Reconciliation updates legacy appointment links, but must not hide a conflict observed
    // during this pass. Keep the current joined IDs and expose the uncertainty for this snapshot.
    if (conflictingChiefLinks) {
      this.state.supervision.chief.phase = 'unknown';
      this.state.supervision.chief.reason = 'Chief assignment and queue links conflicted during this monitoring pass.';
    }
    this.flush();
    this.changed(this.state);
  }
  flush() {
    this.state.updatedAt = Date.now();
    const { supervision: _runtimeEvidence, ...saved } = this.state;
    writeFileSync(this.file + '.tmp', JSON.stringify(saved, null, 2), {
      mode: 0o600,
    });
    renameSync(this.file + '.tmp', this.file);
  }
}
