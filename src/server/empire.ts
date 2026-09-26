import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { initialEmpire, SITES, type EmpireAction, type EmpireState } from '../shared/empire.js';
import type { WorkerInfo, QueueState } from '../shared/protocol.js';

/** Server-owned simulation. No invented AI completion: workforce metrics come from real workers. */
export class Empire {
  state: EmpireState;
  private file: string;
  private reportMinute = 0;
  constructor(dataDir: string, private changed: (state: EmpireState) => void) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'empire.json');
    this.state = initialEmpire();
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.sectors) || !Number.isFinite(saved.funds) || !Number.isFinite(saved.minutes)) throw new Error('Invalid empire save; preserve empire.json and restore a valid backup.');
      for (const site of SITES) if (!saved.sectors.some((s: any) => s.id === site.id && typeof s.built === 'boolean' && Number.isInteger(s.staff) && s.staff >= 0 && s.staff <= site.capacity)) throw new Error('Invalid sector in empire save');
      this.state = saved;
    }
    this.reportMinute = Math.floor(this.state.minutes / 30);
  }
  private report(sector: string, text: string) {
    this.state.reports.unshift({ at: Date.now(), sector, text });
    this.state.reports = this.state.reports.slice(0, 80);
  }
  action(action: EmpireAction): string | undefined {
    if (action.kind === 'delegate') {
      if (typeof action.enabled !== 'boolean') return 'Invalid delegation setting';
      this.state.delegated = action.enabled;
      this.report('Executive', action.enabled ? 'Chief of staff is monitoring operations and escalating worker requests. Existing task queue continues under its configured budget.' : 'CEO resumed direct oversight.');
    } else if (action.kind === 'build' || action.kind === 'hire') {
      const site = SITES.find(s => s.id === action.site);
      const sector = this.state.sectors.find(s => s.id === action.site);
      if (!site || !sector) return 'Unknown site';
      if (action.kind === 'build') {
        if (sector.built) return 'Already built';
        if (this.state.funds < site.cost) return 'Insufficient simulation credits';
        this.state.funds -= site.cost;
        sector.built = true;
        this.report(site.sector, `${site.name} opened. Recruit a service team to begin operations.`);
      } else {
        if (!sector.built) return 'Build this site first';
        if (sector.staff >= site.capacity) return 'Team is at capacity';
        if (this.state.funds < 1200) return 'Hiring requires 1,200 simulation credits';
        this.state.funds -= 1200;
        sector.staff++;
        this.report(site.sector, `Service team at ${site.name}: ${sector.staff}/${site.capacity}. These are simulated staff, separate from AI workers.`);
      }
    } else return 'Unknown operation';
    this.flush();
    this.changed(this.state);
  }
  tick(workers: WorkerInfo[], queue: QueueState, seconds = 5) {
    this.state.minutes += Math.max(0, Math.min(seconds, 60));
    const previousAttention = this.state.workforce.attention;
    this.state.workforce = {
      working: workers.filter(w => w.status === 'working' || w.status === 'starting').length,
      attention: workers.filter(w => w.status === 'needs_input').length,
      done: workers.filter(w => w.status === 'done').length,
      queued: queue.tasks.filter(t => t.status === 'queued').length,
    };
    for (const sector of this.state.sectors) {
      const site = SITES.find(s => s.id === sector.id)!;
      sector.service = sector.built ? Math.round(sector.staff / site.capacity * 100) : 0;
    }
    if (this.state.delegated && previousAttention !== this.state.workforce.attention && this.state.workforce.attention > 0) this.report('Chief of staff', `${this.state.workforce.attention} AI worker(s) need your input. Open their terminals; approval remains with you.`);
    const period = Math.floor(this.state.minutes / 30);
    if (period > this.reportMinute) {
      this.reportMinute = period;
      for (const sector of this.state.sectors.filter(s => s.built)) {
        const site = SITES.find(s => s.id === sector.id)!;
        this.report(site.sector, `${site.name}: ${sector.staff}/${site.capacity} staff, ${sector.service}% service coverage.${sector.staff === 0 ? ' Recruitment needed.' : ''}`);
      }
    }
    this.flush();
    this.changed(this.state);
  }
  flush() {
    this.state.updatedAt = Date.now();
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
}
