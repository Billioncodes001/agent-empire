// Keyed DOM reconciliation for panels that re-render on every server broadcast.
//
// Rebuilding a list with replaceChildren() throws away the button a keyboard or screen-reader user is on (focus
// falls to <body>) and swaps the element under a mouse pointer between press and release. morphChildren() instead
// patches the existing nodes in place from a freshly built tree: rows are matched by a stable key (data-key,
// data-task, data-approval, data-report, data-role or id), other nodes by position and tag. Text and attributes are
// updated, listeners registered through h()'s on* attributes are swapped for the new ones, and only rows that
// appeared or disappeared are inserted or removed. When nothing changed, the DOM is not touched at all.

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

function sameKind(a: Node, b: Node) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

/**
 * Brings `parent`'s children in line with `next` (a freshly built list of nodes, as you would pass to
 * replaceChildren), reusing the existing nodes wherever they match. Keyboard focus inside `parent` is kept.
 */
export function morphChildren(parent: Element, next: Node[]) {
  const active = parent.ownerDocument.activeElement;
  const hadFocus = active instanceof HTMLElement && parent.contains(active) ? active : null;

  const old = [...parent.childNodes];
  const keyed = new Map<string, Node>();
  const unkeyed: Node[] = [];
  for (const n of old) {
    const k = keyOf(n);
    if (k !== null && !keyed.has(k)) keyed.set(k, n);
    else unkeyed.push(n);
  }
  const used = new Set<Node>();
  let cursor = 0;
  const result = next.map((n) => {
    const k = keyOf(n);
    let match: Node | undefined;
    if (k !== null) {
      match = keyed.get(k);
    } else if (cursor < unkeyed.length && sameKind(unkeyed[cursor], n)) {
      match = unkeyed[cursor++];
    }
    if (!match || used.has(match)) return n;
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
