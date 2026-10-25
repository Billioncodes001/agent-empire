import { isTextEntry, isTouchDevice, trackKeyboard } from '../keyboard';
import { trackListener } from './reconcile';

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript helper: h('div.card', { onclick }, 'text', child) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}`, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name) as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
      trackListener(el, k.slice(2), v as EventListener);
    }
    else if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

// ------------------------------------------------------------------------------------------------

export interface Modal {
  el: HTMLElement;
  backdrop: HTMLElement;
  close(): void;
}

const stack: Modal[] = [];
// Dialogs shrink to the area above the on-screen keyboard while a field in them is focused (html.ae-kb).
if (typeof document !== 'undefined') trackKeyboard();
const listeners = new Set<(open: boolean) => void>();

export function onModalChange(fn: (open: boolean) => void) {
  listeners.add(fn);
}

export function modalOpen(): boolean {
  return stack.length > 0;
}

/** Closes every dialog stacked above `modal`, so it is in front again (and takes focus back). */
export function bringToFront(modal: Modal) {
  if (!stack.includes(modal)) return;
  while (stack[stack.length - 1] !== modal) stack[stack.length - 1].close();
  if (!modal.el.contains(document.activeElement)) (focusables(modal.el)[0] ?? modal.el).focus({ preventScroll: true });
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], .hidden') && el.getClientRects().length > 0);
}

/**
 * Opens a modal. Esc closes it unless `escCloses` is false (for dialogs you mustn't skip).
 * `dirty` says whether closing now would lose something typed: then a backdrop click is ignored
 * and Esc has to be pressed twice.
 */
export function openModal(content: HTMLElement, opts: { escCloses?: boolean; onClose?: () => void; backdropCloses?: boolean; dirty?: () => boolean; onEscape?: () => boolean } = {}): Modal {
  const backdrop = h('div.backdrop', {}, content);
  const root = document.getElementById('modal-root')!;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Only keyboard focus is handed back; a clicked HUD button would otherwise catch the next Space (jump).
  const restore = opener && opener.id !== 'scene' && opener !== document.body && opener.matches(':focus-visible') ? opener : null;
  if (content.getAttribute('role') === 'dialog') content.setAttribute('aria-modal', 'true');
  if (!content.hasAttribute('tabindex')) content.tabIndex = -1;
  root.append(backdrop);
  let closed = false;
  let escArmed = 0;
  const onKey = (e: KeyboardEvent) => {
    if (stack[stack.length - 1] !== modal) return;
    if (e.key === 'Escape' && opts.onEscape?.()) {
      // An inner view (e.g. a report inside a card) handled Esc by stepping back; the dialog stays open.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape' && opts.escCloses !== false) {
      // Stop it here so the Esc that closes a terminal isn't also typed into it.
      e.preventDefault();
      e.stopPropagation();
      if (opts.dirty?.() && Date.now() - escArmed > 2000) {
        escArmed = Date.now();
        toast('Press Esc again to discard what you typed');
        return;
      }
      modal.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const active = document.activeElement as HTMLElement | null;
    // xterm uses Tab for shell completion.
    if (active?.closest('.xterm')) return;
    const items = focusables(content);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0], last = items[items.length - 1];
    if (!active || !content.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else {
      // Safari's default Tab skips buttons, so the last natively tabbable field (not `last`) can hand focus to the
      // page or the browser. Wrap it back once the browser has moved focus (DEVTEST-02, WebKit).
      const back = e.shiftKey ? last : first;
      setTimeout(() => { if (!closed && stack[stack.length - 1] === modal && !content.contains(document.activeElement)) back.focus(); }, 0);
    }
  };
  const modal: Modal = {
    el: content,
    backdrop,
    close() {
      if (closed) return;
      closed = true;
      backdrop.remove();
      window.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(modal);
      if (i >= 0) stack.splice(i, 1);
      opts.onClose?.();
      const below = stack[stack.length - 1];
      if (restore?.isConnected && (!below || below.el.contains(restore))) restore.focus({ preventScroll: true });
      else if (below && !below.el.contains(document.activeElement)) focusables(below.el)[0]?.focus({ preventScroll: true });
      listeners.forEach((fn) => fn(stack.length > 0));
    },
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && opts.backdropCloses !== false && !opts.dirty?.()) modal.close();
  });
  window.addEventListener('keydown', onKey, true);
  stack.push(modal);
  listeners.forEach((fn) => fn(true));
  // Callers may focus their own field (or xterm, after it mounts); only fill in when nothing inside has focus.
  requestAnimationFrame(() => {
    if (closed || stack[stack.length - 1] !== modal || content.contains(document.activeElement) || content.querySelector('.xterm')) return;
    const preferred = content.querySelector<HTMLElement>('[autofocus], [aria-selected="true"][role="tab"]');
    const target = preferred ?? focusables(content)[0] ?? content;
    // On touch a text field would open the keyboard over the dialog: the dialog itself takes focus instead.
    (isTouchDevice() && isTextEntry(target) ? content : target).focus({ preventScroll: true });
  });
  return modal;
}

export function closeAllModals() {
  while (stack.length) stack[stack.length - 1].close();
}

const SIDE_MIN = 260;
let watched: Element | null = null;
const resizeWatch = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => placeToasts()) : null;

/**
 * Toasts must never cover an open dialog's header, tabs or footer (DEVTEST-02 review). With room beside the dialog they
 * sit there (top-right, outside its box); otherwise just above its footer. In that narrow case an interactive toast
 * (the update toast) is held back until the dialog closes, so it can't block the dialog's controls.
 */
export function placeToasts() {
  const box = document.getElementById('toasts');
  if (!box?.dataset || !box.style) return; // test doubles of #toasts are bare elements
  delete box.dataset.tight;
  const top = stack[stack.length - 1];
  if (watched !== (top?.el ?? null)) {
    if (watched) resizeWatch?.unobserve(watched);
    watched = top?.el ?? null;
    if (watched) resizeWatch?.observe(watched);
  }
  if (!top) {
    delete box.dataset.place;
    box.style.cssText = '';
    return;
  }
  const r = top.el.getBoundingClientRect();
  const gap = 12;
  const side = window.innerWidth - r.right - gap * 2;
  if (side >= SIDE_MIN) {
    box.dataset.place = 'side';
    box.style.cssText = `position: fixed; left: ${Math.round(r.right + gap)}px; top: ${Math.round(Math.max(r.top, gap))}px; bottom: auto; width: ${Math.round(Math.min(side, 360))}px; transform: none; align-items: stretch;`;
  } else {
    const footer = top.el.querySelector(':scope > footer');
    const edge = footer ? footer.getBoundingClientRect().top : r.bottom;
    // The header and step tabs sit above the dialog's body: on short screens the stack is clipped to the space below
    // them, keeping the newest toast (flex-end) and dropping older ones off the top.
    const body = top.el.querySelector(':scope > .body');
    const ceiling = body ? body.getBoundingClientRect().top : r.top;
    const room = Math.max(0, Math.round(edge - 8 - ceiling - 8));
    box.dataset.place = 'above-footer';
    box.style.cssText = `position: fixed; top: auto; bottom: ${Math.round(window.innerHeight - edge + 8)}px; max-width: min(560px, calc(100vw - 32px)); max-height: ${room}px; overflow: hidden; justify-content: flex-end;`;
    // When two toasts don't fit, show only the newest rather than a half-clipped older one.
    // (Overflow past the top of a flex-end box isn't scrollable, so measure the two newest shown toasts directly.)
    const shown = [...box.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.offsetHeight > 0).slice(-2);
    const need = shown.reduce((sum, c) => sum + c.offsetHeight, 0) + 8 * Math.max(0, shown.length - 1);
    if (need > room) box.dataset.tight = '';
  }
}
if (typeof window !== 'undefined') {
  listeners.add(() => requestAnimationFrame(placeToasts));
  window.addEventListener('resize', () => placeToasts());
}

export function toast(text: string, level: 'info' | 'warn' | 'error' = 'info', ms = 3500) {
  const el = h('div.toast', { class: level }, text);
  document.getElementById('toasts')!.append(el);
  placeToasts();
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function timeAgo(iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STATUS_LABEL: Record<string, string> = {
  starting: 'starting',
  idle: 'ready',
  working: 'working',
  needs_input: 'needs input',
  done: 'done',
  exited: 'exited',
  offline: 'asleep',
};
