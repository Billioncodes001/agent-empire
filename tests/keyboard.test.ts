/**
 * keyboard.ts: dialogs don't open the on-screen keyboard by themselves on touch devices, and screen hand-overs close it.
 * Runs on Node with a minimal DOM stand-in (no DOM library in this repo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  isContentEditable = false;
  focused = 0;
  blurred = 0;
  constructor(public tagName: string, public type = 'text', private inside: FakeElement[] = []) {}
  focus() {
    this.focused++;
    doc.activeElement = this;
  }
  blur() {
    this.blurred++;
    if (doc.activeElement === this) doc.activeElement = null;
  }
  contains(el: unknown) {
    return el === this || this.inside.includes(el as FakeElement);
  }
}
const doc: { activeElement: FakeElement | null } = { activeElement: null };
let coarse = false;
let search = '';
Object.assign(globalThis, {
  HTMLElement: FakeElement,
  document: doc,
  matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false }),
  location: { get search() { return search; } },
});

const { autoFocus, dismissKeyboard, isTextEntry, isTouchDevice } = await import('../src/client/keyboard');
const el = (tag: string, type?: string) => new FakeElement(tag, type) as unknown as HTMLElement;

test('text entry: text-like inputs, textareas and contenteditable; not buttons, checkboxes or ranges', () => {
  assert.equal(isTextEntry(el('INPUT', 'text')), true);
  assert.equal(isTextEntry(el('INPUT', 'password')), true);
  assert.equal(isTextEntry(el('INPUT', 'url')), true);
  assert.equal(isTextEntry(el('TEXTAREA')), true);
  const editable = new FakeElement('DIV');
  editable.isContentEditable = true;
  assert.equal(isTextEntry(editable as unknown as HTMLElement), true);
  for (const type of ['checkbox', 'radio', 'range', 'button', 'submit']) assert.equal(isTextEntry(el('INPUT', type)), false, type);
  assert.equal(isTextEntry(el('BUTTON')), false);
  assert.equal(isTextEntry(null), false);
});

test('touch detection follows pointer: coarse, with the ?touch= override the touch controls use', () => {
  coarse = true;
  search = '';
  assert.equal(isTouchDevice(), true);
  search = '?touch=0';
  assert.equal(isTouchDevice(), false);
  coarse = false;
  search = '?touch=1';
  assert.equal(isTouchDevice(), true);
  search = '';
  assert.equal(isTouchDevice(), false);
});

test('desktop: a dialog focuses its name field as before', () => {
  coarse = false;
  doc.activeElement = null;
  const input = new FakeElement('INPUT', 'text');
  const dialog = new FakeElement('FORM', '', [input]);
  autoFocus(input as unknown as HTMLElement, dialog as unknown as HTMLElement);
  assert.equal(doc.activeElement, input);
  assert.equal(dialog.focused, 0);
});

test('touch: a dialog never focuses a text field by itself; the dialog takes focus instead (no keyboard)', () => {
  coarse = true;
  doc.activeElement = null;
  const input = new FakeElement('INPUT', 'text');
  const dialog = new FakeElement('FORM', '', [input]);
  autoFocus(input as unknown as HTMLElement, dialog as unknown as HTMLElement);
  assert.equal(input.focused, 0);
  assert.equal(doc.activeElement, dialog);
  // A button is still focused on touch: it opens no keyboard.
  const button = new FakeElement('BUTTON');
  autoFocus(button as unknown as HTMLElement, dialog as unknown as HTMLElement);
  assert.equal(doc.activeElement, button);
  coarse = false;
});

test('hand-over closes the keyboard: a focused field is blurred, a focused button is left alone', () => {
  const field = new FakeElement('INPUT', 'password');
  field.focus();
  dismissKeyboard();
  assert.equal(field.blurred, 1);
  assert.equal(doc.activeElement, null);
  const button = new FakeElement('BUTTON');
  button.focus();
  dismissKeyboard();
  assert.equal(button.blurred, 0);
  assert.equal(doc.activeElement, button);
});
