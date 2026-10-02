/**
 * When the update prompt may appear (docs/team/RELEASE_PLAN.md): never during a modal, while typing, or mid-jump, and
 * not before the game has finished loading. Pure, so tests/in-app-updates.test.ts covers every case; ui.ts feeds it
 * from the DOM and the player.
 */
export interface GateContext {
  /** document.documentElement.dataset.boot: the splash is done only at 'ready' or 'forced'. */
  boot: string | undefined;
  modalOpen: boolean;
  /** Focus is in a text field, text area, editable element or terminal. */
  typing: boolean;
  /** The player is in the air (jumping or falling). */
  airborne: boolean;
  /** The page is hidden (backgrounded app). */
  hidden: boolean;
}

export type GateVerdict = 'show' | 'wait';

export function promptGate(c: GateContext): GateVerdict {
  if (c.boot !== 'ready' && c.boot !== 'forced') return 'wait';
  if (c.modalOpen || c.typing || c.airborne || c.hidden) return 'wait';
  return 'show';
}

export function isTextEntry(el: Element | null): boolean {
  if (!el || !(el as HTMLElement).tagName) return false;
  const h = el as HTMLElement;
  const tag = h.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || h.isContentEditable || !!h.closest?.('.xterm');
}
