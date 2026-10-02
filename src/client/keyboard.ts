/**
 * Touch devices and the on-screen keyboard.
 *
 * On a phone, focusing a text field opens the keyboard, which in landscape covers most of the screen. So:
 *  - dialogs never focus a text field by themselves on touch devices (`autoFocus`); desktop keeps its autofocus;
 *  - handing over from one screen to the next closes the keyboard (`dismissKeyboard`);
 *  - while a field is focused on touch, fixed overlays (setup, dialog backdrops) shrink to the visible area above
 *    the keyboard (`trackKeyboard`: `html.ae-kb`, `--ae-vvt`, `--ae-vvh` from visualViewport), and the focused field
 *    is scrolled into view inside its own scroll box, so it and the dialog's footer (the primary action) stay visible.
 *
 * Shared by the first-launch setup and the game; it imports nothing else, so the setup chunk stays small.
 */

const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** A phone or tablet driven by touch. Tests can force it with ?touch=1 / ?touch=0, like the touch controls. */
export function isTouchDevice(): boolean {
  const force = new URLSearchParams(location.search).get('touch');
  if (force === '1') return true;
  if (force === '0') return false;
  return coarse();
}

/** Fields that open the on-screen keyboard. */
export function isTextEntry(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
}

/**
 * Focus for a dialog that just opened. On touch, a text field is not focused (that would open the keyboard over the
 * dialog); `fallback` (usually the dialog itself) takes focus instead, so screen readers and the focus trap still
 * start inside it. Elsewhere `target` is focused as before.
 */
export function autoFocus(target: HTMLElement | null | undefined, fallback?: HTMLElement | null) {
  if (!target) return;
  if (isTouchDevice() && isTextEntry(target)) {
    if (fallback && !fallback.contains(document.activeElement)) fallback.focus({ preventScroll: true });
    return;
  }
  target.focus();
}

/** Closes the on-screen keyboard (blurs the focused field) when one screen hands over to the next. */
export function dismissKeyboard() {
  const active = document.activeElement;
  if (isTextEntry(active)) active.blur();
}

/** Nearest ancestor that scrolls vertically. */
function scrollBox(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Scrolls `field` (and its label, when there is room) into the middle of its own scroll box, never the page. */
function reveal(field: HTMLElement) {
  const box = scrollBox(field);
  if (!box) return;
  const b = box.getBoundingClientRect();
  const f = (field.closest('label, .su-field, .field') as HTMLElement | null ?? field).getBoundingClientRect();
  const r = f.height < b.height - 16 ? f : field.getBoundingClientRect();
  if (r.top >= b.top + 4 && r.bottom <= b.bottom - 4) return;
  box.scrollTop += r.top - b.top - Math.max(8, (b.height - r.height) / 2);
}

let tracking = false;

/** Installs the keyboard-aware layout once per page. Safe to call again. */
export function trackKeyboard() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  const root = document.documentElement;
  const vv = window.visualViewport;
  // The page height without a keyboard. iOS keeps the layout viewport and shrinks only the visual one; the Android app
  // shrinks the whole WebView above the keyboard, so the height before a field took focus is the reference.
  let full = innerHeight;
  let fullWidth = innerWidth;
  let raf = 0;
  const update = () => {
    raf = 0;
    const active = document.activeElement;
    const height = vv ? vv.height : innerHeight;
    const top = vv ? vv.offsetTop : 0;
    if (innerWidth !== fullWidth || !isTextEntry(active)) {
      full = Math.max(innerHeight, height);
      fullWidth = innerWidth;
    } else full = Math.max(full, innerHeight);
    // The keyboard is open when a field has focus and the visible area is clearly shorter than the full page.
    const open = isTouchDevice() && isTextEntry(active) && full - height > 60;
    root.classList.toggle('ae-kb', open);
    if (open) {
      root.style.setProperty('--ae-vvh', `${Math.round(height)}px`);
      root.style.setProperty('--ae-vvt', `${Math.round(top)}px`);
      reveal(active as HTMLElement);
    } else {
      root.style.removeProperty('--ae-vvh');
      root.style.removeProperty('--ae-vvt');
      // The page never scrolls (full-screen game and setup); WebKit can leave it shifted after the keyboard closes.
      if (!isTextEntry(active) && (scrollX || scrollY)) scrollTo(0, 0);
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  addEventListener('resize', schedule);
  document.addEventListener('focusin', (e) => {
    if (!isTouchDevice() || !isTextEntry(e.target as Element)) return;
    schedule();
    // The keyboard animates in over ~250 ms and WebKit may scroll the page meanwhile: settle again afterwards.
    setTimeout(schedule, 120);
    setTimeout(schedule, 420);
  });
  document.addEventListener('focusout', () => setTimeout(schedule, 60));
}
