import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  initialEmpire,
  newSector,
  SITES,
  STARTER_SITES,
  MANAGER_NAMES,
  managerStartupPrompt,
  hourlyRates,
  upgradeCost,
  officeFloorCost, workstationCost,
  type EmpireAction,
  type EmpireState,
  type SectorState,
  type SiteId,
} from '../shared/empire.js';
import type { WorkerInfo, QueueState, QueueTask } from '../shared/protocol.js';
import type { TaskQueue } from './queue.js';
import { DESKS_PER_FLOOR, fundedDesk } from '../shared/layout.js';
import { randomBytes } from 'node:crypto';
import { chiefLinksConflict, projectSupervision } from './supervision.js';

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
  private manager(sector: SectorState) {
    if (sector.id === 'home' || sector.manager) return;
    sector.manager = {
      id: `manager-${sector.id}`,
      name: MANAGER_NAMES[sector.id],
      status: 'pending',
      attempt: 1,
      jobKey: `empire-manager-${sector.id}-1`,
    };
  }
  /** Only the current appointment may retry a manager task, including legacy job keys. */
  managerTaskRetryBlocker(task: QueueTask): string | undefined {
    if (!task.jobKey?.startsWith('empire-manager-')) return;
    if (!this.state.sectors.some(s => s.manager?.jobKey === task.jobKey))
      return 'This manager startup has been superseded. Recover the current assignment from Management instead.';
  }
  action(action: EmpireAction, queue?: Pick<TaskQueue, 'state' | 'retry' | 'managerRetryBlocker'>): string | undefined {
    const beforeFunds = this.state.funds;
    if (action.kind === 'found') {
      if (this.state.setup.completed) return 'Founding setup is already complete';
      if (
        !Array.isArray(action.sites) ||
        action.sites.length > STARTER_SITES.length ||
        new Set(action.sites).size !== action.sites.length ||
        action.sites.some((id) => !STARTER_SITES.some((s) => s.id === id))
      )
        return 'Choose valid starting buildings';
      for (const sector of this.state.sectors) {
        if (action.sites.includes(sector.id)) {
          sector.built = true;
          sector.owned = true;
        }
        if (sector.built) {
          this.manager(sector);
          if (!['hq', 'home'].includes(sector.id)) sector.staff = Math.max(1, sector.staff);
        }
      }
      this.state.setup = {
        completed: true,
        selected: [...action.sites],
        completedAt: Date.now(),
      };
      this.state.delegated = true;
      this.state.economy.startedAt = Date.now();
      this.state.economy.lastHour = Math.floor(this.state.minutes / 60);
      this.report(
        'Chief of staff',
        `Founding plan confirmed: ${this.state.sectors.filter((s) => s.built).length} buildings. Managers have been appointed; their real startup work will use the agent queue.`,
      );
    } else if (action.kind === 'office-floor' || action.kind === 'office-workstation') {
      if (!this.state.setup.completed) return 'Complete founding setup first';
      const office = this.state.office;
      const floor = action.kind === 'office-floor';
      if (!floor && office.workstations >= office.floors * DESKS_PER_FLOOR) return 'Build another floor before adding workstations';
      const cost = floor ? officeFloorCost(office) : workstationCost(office);
      if (!Number.isSafeInteger(cost) || this.state.funds < cost) return 'Insufficient simulation credits';
      this.state.funds -= cost;
      if (floor) office.floors++;
      else office.workstations++;
      this.report('Headquarters', floor
        ? `Floor ${office.floors} constructed. Take the elevator upstairs; furnish workstations before hiring.`
        : `Workstation ${office.workstations} installed with a computer. A new worker can now be employed.`);
    } else if (action.kind === 'delegate') {
      if (typeof action.enabled !== 'boolean') return 'Invalid delegation setting';
      this.state.delegated = action.enabled;
      this.report(
        'Executive',
        action.enabled
          ? 'Delegated oversight requested. The server continues rule-based monitoring; this does not start an AI supervisor.'
          : 'CEO resumed direct oversight. The server continues rule-based monitoring.',
      );
    } else if (action.kind === 'reinvest') {
      if (this.state.economy.ownerBalance <= 0) return 'No founder earnings available';
      this.state.funds += this.state.economy.ownerBalance;
      this.report('Treasury', `Founder reinvested ${this.state.economy.ownerBalance.toLocaleString()} credits into the city.`);
      this.state.economy.ownerBalance = 0;
    } else if (['build', 'hire', 'buy-land', 'upgrade', 'retry-manager'].includes(action.kind) && 'site' in action) {
      const site = SITES.find((s) => s.id === action.site),
        sector = this.state.sectors.find((s) => s.id === action.site);
      if (!site || !sector) return 'Unknown site';
      if (action.kind === 'buy-land') {
        if (sector.owned) return 'Land already owned';
        if (this.state.funds < site.landCost) return 'Insufficient simulation credits';
        this.state.funds -= site.landCost;
        sector.owned = true;
        this.report(
          'Expansion',
          `${site.name} parcel acquired for ${site.landCost.toLocaleString()} credits. Construction is now available.`,
        );
      } else if (action.kind === 'build') {
        if (sector.built) return 'Already built';
        if (!sector.owned) return 'Buy this land first';
        if (this.state.funds < site.cost) return 'Insufficient simulation credits';
        this.state.funds -= site.cost;
        sector.built = true;
        sector.staff = 1;
        this.manager(sector);
        this.report(site.sector, `${site.name} constructed with a manager assignment and one service employee.`);
      } else if (action.kind === 'hire') {
        if (sector.id === 'hq') return 'Employ AI workers at a furnished headquarters workstation';
        if (!sector.built) return 'Build this site first';
        if (sector.staff >= site.capacity) return 'Team is at capacity';
        if (this.state.funds < 1200) return 'Hiring requires 1,200 simulation credits';
        this.state.funds -= 1200;
        sector.staff++;
        this.report(
          site.sector,
          `${site.name}: ${sector.staff}/${site.capacity} service employees. Each earns 18 credits per operating hour.`,
        );
      } else if (action.kind === 'upgrade') {
        if (sector.id === 'hq') return 'Expand headquarters through floors and workstations';
        if (!sector.built) return 'Build this site first';
        if (sector.id === 'home' || sector.level >= 3) return 'No further upgrades available';
        const cost = upgradeCost(sector);
        if (this.state.funds < cost) return 'Insufficient simulation credits';
        this.state.funds -= cost;
        sector.level++;
        this.report(site.sector, `${site.name} upgraded to level ${sector.level}; service revenue increases 30% per level.`);
      } else {
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
    } else return 'Unknown operation';
    if (this.state.funds !== beforeFunds) {
      const capital = beforeFunds - this.state.funds;
      this.state.funds = beforeFunds;
      const site = 'site' in action ? SITES.find((s) => s.id === action.site)?.name : '';
      const label =
        (
          {
            'buy-land': 'Land purchase',
            build: 'Construction',
            hire: 'Recruitment',
            upgrade: 'Building upgrade',
            reinvest: 'Founder reinvestment',
            'office-floor': 'Headquarters floor construction',
            'office-workstation': 'Workstation installation',
          } as Record<string, string>
        )[action.kind] ?? action.kind;
      this.ledger(`${label}${site ? ' · ' + site : ''}`, 0, 0, 0, 0, capital);
    }
    this.flush();
    this.changed(this.state);
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
  private pay(id: string, name: string, site: SiteId, role: 'manager' | 'service' | 'agent', amount: number) {
    const account = (this.state.economy.employees[id] ??= {
      name,
      site,
      role,
      earned: 0,
    });
    account.earned += amount;
  }
  private ledger(label: string, revenue: number, wages: number, upkeep: number, dividend: number, capital = 0) {
    const e = this.state.economy;
    e.revenue += revenue;
    e.wages += wages;
    e.upkeep += upkeep;
    e.dividends += dividend;
    e.ownerBalance += dividend;
    e.capital += capital;
    this.state.funds += revenue - wages - upkeep - dividend - capital;
    e.ledger.unshift({
      at: Date.now(),
      minute: this.state.minutes,
      label,
      revenue,
      wages,
      upkeep,
      dividend,
      capital,
      balance: this.state.funds,
    });
    e.ledger = e.ledger.slice(0, 100);
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
      const site = SITES.find((s) => s.id === sector.id)!;
      sector.service = sector.built ? Math.min(100, Math.round((sector.staff / site.capacity) * 100 * (1 + (sector.level - 1) * 0.3))) : 0;
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
        this.pay(
          managerJob ? managerJob.id : `agent-${task.workerId}`,
          managerJob ? managerJob.name : (task.workerName ?? 'AI worker'),
          site.id,
          managerJob ? 'manager' : 'agent',
          50,
        );
        sector.revenue += 500;
        sector.wages += 50;
        this.ledger(`Completed AI task: ${task.title}`, 500, 50, 0, 90);
        this.report(
          'Chief of staff',
          `Completed task credited: ${task.title}. 500 city credits earned; 50 paid to the worker and 90 to the founder.`,
        );
      }
      const hour = Math.floor(this.state.minutes / 60);
      if (hour > economy.lastHour) {
        economy.lastHour = hour;
        let revenue = 0,
          wages = 0,
          upkeep = 0;
        for (const sector of this.state.sectors) {
          const rate = hourlyRates(sector);
          if (!rate.wages) continue;
          if (this.state.funds + revenue + rate.revenue - wages - upkeep < rate.wages + rate.upkeep) {
            this.report('Treasury', `${SITES.find((s) => s.id === sector.id)!.name} paused for this hour: payroll cannot be funded.`);
            continue;
          }
          revenue += rate.revenue;
          wages += rate.wages;
          upkeep += rate.upkeep;
          sector.revenue += rate.revenue;
          sector.wages += rate.wages;
          sector.upkeep += rate.upkeep;
          this.pay(sector.manager!.id, sector.manager!.name, sector.id, 'manager', sector.id === 'hq' ? 60 : 40);
          for (let i = 0; i < sector.staff; i++)
            this.pay(`service-${sector.id}-${i}`, `Service employee ${i + 1}`, sector.id, 'service', 18);
        }
        const dividend = Math.floor(Math.max(0, revenue - wages - upkeep) * 0.2);
        if (revenue || wages || upkeep) {
          this.ledger('Hourly sector operations', revenue, wages, upkeep, dividend);
          this.report(
            'Treasury',
            `Hourly close: ${revenue} revenue − ${wages} wages − ${upkeep} upkeep. Founder dividend ${dividend}; treasury ${this.state.funds.toLocaleString()} credits.`,
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
