export const DEFAULT_KEYS = {
  forward: 'ArrowUp', backward: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  run: 'ShiftLeft', jump: 'Space', interact: 'KeyE', task: 'KeyP', resume: 'KeyR',
  dismiss: 'KeyX', shell: 'KeyB', changes: 'KeyC', open: 'KeyO', chat: 'KeyT',
  voice: 'KeyV', mute: 'KeyM', help: 'KeyH', decorate: 'KeyF',
};
export type Action = keyof typeof DEFAULT_KEYS;
export type KeyBindings = Record<Action, string>;
export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward', backward: 'Move backward', left: 'Move left', right: 'Move right',
  run: 'Run / accelerate', jump: 'Jump', interact: 'Interact', task: 'Assign task', resume: 'Resume worker',
  dismiss: 'Send worker home', shell: 'Open shell', changes: 'View changes', open: 'Open', chat: 'Chat',
  voice: 'Join voice', mute: 'Mute', help: 'Help', decorate: 'Decorate',
};
export const validKey = (code: string) => /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right))$/.test(code);
export function sanitizeKeys(saved: unknown): KeyBindings {
  const keys = { ...DEFAULT_KEYS };
  if (!saved || typeof saved !== 'object') return keys;
  const candidate = saved as KeyBindings;
  const values = Object.keys(keys).map(k => candidate[k as Action]);
  if (values.every(v => typeof v === 'string' && validKey(v)) && new Set(values).size === values.length) return { ...candidate };
  return keys;
}
export function keyLabel(code: string): string {
  return ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift' } as Record<string,string>)[code] ?? code.replace(/^Key|^Digit/, '');
}
/** Translate configured bindings to the established office action codes. */
export function officeCode(code: string, keys: KeyBindings): string {
  const action = (Object.keys(keys) as Action[]).find(a => keys[a] === code);
  return action ? DEFAULT_KEYS[action] : code === 'Enter' ? code : '';
}
