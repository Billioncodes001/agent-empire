/**
 * DEVICE-BUGS-03: the setup's non-secret progress in localStorage (model.ts progressSnapshot / restoreProgress), so a
 * reload, a WebView restart or a killed app resumes where the player was. Storage can be missing or throw (private
 * windows, blocked site data); the setup then simply starts at the beginning.
 */
import { PROGRESS_KEY, progressSnapshot, type SetupState } from './model';

export function saveProgress(s: SetupState): void {
  try {
    if (s.step === 'welcome') localStorage.removeItem(PROGRESS_KEY);
    else localStorage.setItem(PROGRESS_KEY, JSON.stringify(progressSnapshot(s)));
  } catch {}
}

export function readProgress(): unknown {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw && raw.length < 20_000 ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The setup finished (or the player changed setup): nothing to resume. */
export function clearProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {}
}
