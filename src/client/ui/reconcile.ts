// Keyed DOM reconciliation for panels that re-render on every server broadcast.
//
// Rebuilding a list with replaceChildren() throws away the button a keyboard or screen-reader user is on (focus
// falls to <body>) and swaps the element under a mouse pointer between press and release. morphChildren() instead
// patches the existing nodes in place from a freshly built tree: rows are matched by a stable key (data-key,
// data-task, data-approval, data-report, data-role or id; keys are per parent, so action buttons carry their action
// as data-key), other nodes by position and tag. Text and attributes are updated, listeners registered through h()'s
// on* attributes are swapped for the new ones, and only rows that appeared or disappeared are inserted or removed.
// A focused or pressed element whose action would change is replaced, never repurposed. When nothing changed, the DOM is not touched at all.

const listeners = new WeakMap<Element, [string, EventListener][]>();

/** Called by h() for each on* attribute, so a patched element can take over the new tree's handlers. */
export function trackListener(el: Element, type: string, fn: EventListener) {
  const list = listeners.get(el);
  if (list) list.push([type, fn]);
  else listeners.set(el, [[type, fn]]);
}

const KEY_ATTRS = ['data-key', 'data-task', 'data-approval', 'data-report', 'data-role', 'id'];

function keyOf(n: Node): string | null {
  if (!(n instanceof Element)) return null;
  for (const a of KEY_ATTRS) {
    const v = n.getAttribute(a);
    if (v !== null) return `${n.nodeName}|${a}=${v}`;
  }
  return null;
}

function patchAttributes(from: Element, to: Element) {
  for (const { name } of [...from.attributes]) {
    // The browser sets <details open> when the user expands it; a re-render must not fold it back.
    if (name === 'open' && from.nodeName === 'DETAILS') continue;
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

function patchListeners(from: Element, to: Element) {
  const old = listeners.get(from);
  const next = listeners.get(to);
  if (!old && !next) return;
  for (const [type, fn] of old ?? []) from.removeEventListener(type, fn);
  for (const [type, fn] of next ?? []) from.addEventListener(type, fn);
  if (next) listeners.set(from, next);
  else listeners.delete(from);
}

/** Makes `from` look like `to`, keeping `from` (and its focus, scroll and hover state) in the document. */
function patch(from: Node, to: Node) {
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  patchAttributes(from as Element, to as Element);
  patchListeners(from as Element, to as Element);
  morphChildren(from as Element, [...to.childNodes]);
}

/** What matching looks at for one child: its key (null for unkeyed nodes) and its node type + name. */
export interface Desc {
  key: string | null;
  kind: string;
}

/**
 * Pure matching step of morphChildren: for each wanted child, the index of the old child to reuse, or null to insert
 * the new one. Keyed children only ever match the old child with the same key (and kind); unkeyed children match the
 * next unused unkeyed old child of the same kind, in order. Every old child is reused at most once.
 */
export function matchPlan(old: Desc[], next: Desc[]): (number | null)[] {
  const keyed = new Map<string, number>();
  const unkeyed: number[] = [];
  old.forEach((d, i) => {
    if (d.key !== null && !keyed.has(d.key)) keyed.set(d.key, i);
    else unkeyed.push(i);
  });
  const used = new Set<number>();
  let cursor = 0;
  return next.map((d) => {
    let match: number | undefined;
    if (d.key !== null) {
      match = keyed.get(d.key);
      if (match !== undefined && old[match].kind !== d.kind) match = undefined;
    } else if (cursor < unkeyed.length && old[unkeyed[cursor]].kind === d.kind) {
      match = unkeyed[cursor++];
    }
    if (match === undefined || used.has(match)) return null;
    used.add(match);
    return match;
  });
}

/**
 * Which action an element with handlers stands for: its handler types plus its key, else its label, else its text.
 * A key or label wins over the text so a row whose "2 min ago" ticks over is still the same action.
 */
function actionSignature(el: Element): string {
  const types = (listeners.get(el) ?? []).map(([t]) => t).join(',');
  return `${types}|${keyOf(el) ?? el.getAttribute('aria-label') ?? el.textContent ?? ''}`;
}

/**
 * Safety net: an element the user is on right now (focused, or pressed) is never turned into a different action. If
 * its handlers would be swapped for ones that do something else, the old element is replaced instead, so a press
 * that started on "Terminal" can never release on "Requeue".
 */
function mustReplace(from: Node, to: Node): boolean {
  if (!(from instanceof Element) || !(to instanceof Element)) return false;
  if (!listeners.has(from) && !listeners.has(to)) return false;
  const engaged = from.ownerDocument.activeElement === from || from.matches(':active');
  return engaged && actionSignature(from) !== actionSignature(to);
}

const describe = (n: Node): Desc => ({ key: keyOf(n), kind: `${n.nodeType}:${n.nodeName}` });

/**
 * Brings `parent`'s children in line with `next` (a freshly built list of nodes, as you would pass to
 * replaceChildren), reusing the existing nodes wherever they match. Keyboard focus inside `parent` is kept.
 */
export function morphChildren(parent: Element, next: Node[]) {
  const active = parent.ownerDocument.activeElement;
  const hadFocus = active instanceof HTMLElement && parent.contains(active) ? active : null;

  const old = [...parent.childNodes];
  const plan = matchPlan(old.map(describe), next.map(describe));
  const used = new Set<Node>();
  const result = next.map((n, i) => {
    const at = plan[i];
    const match = at === null ? undefined : old[at];
    if (!match || mustReplace(match, n)) return n;
    used.add(match);
    patch(match, n);
    return match;
  });

  for (const n of old) if (!used.has(n)) n.remove();
  // Place each node only where it is out of order, so unchanged rows are never detached.
  for (let i = 0; i < result.length; i++) {
    const want = result[i];
    const at = parent.childNodes[i];
    if (at !== want) parent.insertBefore(want, at ?? null);
  }

  // A moved row loses focus in some browsers; hand it back without scrolling.
  if (hadFocus && hadFocus.isConnected && parent.ownerDocument.activeElement !== hadFocus && !hadFocus.hasAttribute('disabled')) {
    hadFocus.focus({ preventScroll: true });
  }
}
