/** Installation and service-worker registration. The worker only provides an offline explanation page. */
import { isAppMode } from '../endpoint';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  | { kind: 'installed' }
  | { kind: 'available' }
  | { kind: 'ios' }
  | { kind: 'insecure' }
  | { kind: 'browser-menu' };

let deferred: InstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function onInstallChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installState(): InstallState {
  // A bundled app is already installed; there is nothing to add to a home screen.
  if (isAppMode()) return { kind: 'installed' };
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (standalone || installedNow) return { kind: 'installed' };
  if (!window.isSecureContext) return { kind: 'insecure' };
  if (deferred) return { kind: 'available' };
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return { kind: 'ios' };
  return { kind: 'browser-menu' };
}

export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  notify();
  return outcome === 'accepted';
}

export function setupPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    notify();
  });
  // Development builds skip it so Vite's live reload never meets a stale worker.
  // The app bundle is already offline, and a custom-scheme page can't register a worker.
  if (import.meta.env.PROD && !isAppMode() && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('Offline page unavailable:', err));
  }
}
