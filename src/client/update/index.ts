/**
 * Wires the update service into the game (main.ts): one service per page, the HUD prompt and menu entry, the Settings
 * section, server-mode and cloud-mode hooks.
 */
import { UpdateService } from './service';
import { updateBridge } from './bridge';
import { mountUpdateUi, updateSettingsSection } from './ui';
import type { KeyValue } from './source';
import type { CloudRepo } from '../cloud/repo';

let service: UpdateService | null = null;

function storage(): KeyValue | null {
  try {
    const ls = window.localStorage;
    return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) };
  } catch {
    return null;
  }
}

/** The bundled coordinator (src/client/setup/cloud-setup.ts COORDINATOR_URL), when this build ships one. */
async function bundledCoordinator(): Promise<string | null> {
  const r = await fetch('cloud/agent-empire-coordinator.mjs', { cache: 'no-store' });
  return r.ok ? r.text() : null;
}

export function startUpdates(opts: { airborne?: () => boolean; cloudRepo?: CloudRepo | null } = {}): UpdateService {
  if (service) return service;
  service = new UpdateService({ bridge: updateBridge(), storage: storage(), bundledCoordinator });
  mountUpdateUi(service, { airborne: opts.airborne });
  if (opts.cloudRepo) service.attachCloud(opts.cloudRepo);
  void service.start();
  return service;
}

export function updates(): UpdateService | null {
  return service;
}

export { updateSettingsSection };
