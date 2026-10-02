/**
 * Tells the shell this game bundle booted (update.bootOk), so it marks the bundle known-good and cancels its 20 s
 * rollback timer (REL-04). Sent once per page load, as soon as the page's own code is running: the setup screen is
 * shown, or the game module evaluated. Not tied to model loading, which can take longer than 20 s on a slow network.
 * Lightweight on purpose: boot.ts imports it before the game bundle.
 */
import { NativeBridge, native } from '../native';

let sent = false;

export function reportBootOk() {
  if (sent) return;
  sent = true;
  const n = native();
  if (!(n instanceof NativeBridge) || !n.available) return;
  n.call('update.bootOk', {}).catch(() => {
    // An older shell without update.* refuses the method; nothing to roll back there.
  });
}
