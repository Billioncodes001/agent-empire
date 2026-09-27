export const DEFAULT_KEYS = {
  forward: 'ArrowUp',
  backward: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  run: 'ShiftLeft',
  jump: 'Space',
  interact: 'KeyE',
  task: 'KeyP',
  resume: 'KeyR',
  dismiss: 'KeyX',
  shell: 'KeyB',
  changes: 'KeyC',
  open: 'KeyO',
  chat: 'KeyT',
  voice: 'KeyV',
  mute: 'KeyM',
  help: 'KeyH',
  decorate: 'KeyF',
  map: 'KeyG',
  camera: 'KeyN',
};
export type Action = keyof typeof DEFAULT_KEYS;
export type KeyBindings = Record<Action, string>;
export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward',
  backward: 'Move backward',
  left: 'Turn and move left',
  right: 'Turn and move right',
  run: 'Run / accelerate',
  jump: 'Jump',
  interact: 'Interact',
  task: 'Assign task',
  resume: 'Resume worker',
  dismiss: 'Send worker home',
  shell: 'Open shell',
  changes: 'View changes',
  open: 'Open',
  chat: 'Chat',
  voice: 'Join voice',
  mute: 'Mute',
  help: 'Help',
  decorate: 'Decorate',
  map: 'Expand map',
  camera: 'First / third person',
};
export const validKey = (code: string) => /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right))$/.test(code);
export function sanitizeKeys(saved: unknown): KeyBindings {
  const keys = { ...DEFAULT_KEYS };
  if (!saved || typeof saved !== 'object') return keys;
  const oldActions = Object.keys(keys).filter((k) => k !== 'map' && k !== 'camera');
  if (oldActions.some((k) => !(k in saved))) return keys;
  const record = saved as Record<string, unknown>;
  const candidate = { ...keys };
  const occupied = new Set<string>();
  for (const action of oldActions as Action[]) {
    const value = record[action];
    if (typeof value !== 'string' || !validKey(value) || occupied.has(value)) return keys;
    candidate[action] = value;
    occupied.add(value);
  }
  for (const action of ['map', 'camera'] as const) {
    const value =
      record[action] ?? [keys[action], 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyY', 'Digit1', 'Digit2'].find((v) => !occupied.has(v));
    if (typeof value !== 'string' || !validKey(value) || occupied.has(value)) return keys;
    candidate[action] = value;
    occupied.add(value);
  }
  return candidate;
}
export function keyLabel(code: string): string {
  return (
    (
      {
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        Space: 'Space',
        ShiftLeft: 'Left Shift',
        ShiftRight: 'Right Shift',
      } as Record<string, string>
    )[code] ?? code.replace(/^Key|^Digit/, '')
  );
}
/** Translate configured bindings to the established office action codes. */
export function officeCode(code: string, keys: KeyBindings): string {
  const action = (Object.keys(keys) as Action[]).find((a) => keys[a] === code);
  return action ? DEFAULT_KEYS[action] : code === 'Enter' ? code : '';
}
