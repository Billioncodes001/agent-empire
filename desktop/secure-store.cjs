/**
 * Secure storage behind the bridge's secure.get/set/delete: one file encrypted with Electron safeStorage
 * (macOS Keychain, Windows DPAPI, Linux secret service). Only allowlisted keys with valid values are kept, and an
 * unprotected backend ("basic_text") is refused. A file that can't be opened fails closed: reads return nothing,
 * writes are refused, and the file is left as it is.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { KEYS, SESSION_KEYS, invalidValue } = require('./bridge-policy.cjs');

function createSecureStore(file, encryption) {
  const available = () =>
    encryption.isEncryptionAvailable() && (!encryption.getSelectedStorageBackend || encryption.getSelectedStorageBackend() !== 'basic_text');

  function readAll() {
    if (!fs.existsSync(file)) return {};
    if (!available()) throw new Error('The operating system credential store is locked or unavailable.');
    let parsed;
    try {
      parsed = JSON.parse(encryption.decryptString(fs.readFileSync(file)));
    } catch {
      throw new Error('Saved sign-in could not be opened. Unlock the operating system credential store.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved sign-in could not be opened.');
    // Anything outside the allowlist, or no longer valid, is ignored rather than handed to the page.
    return Object.fromEntries(KEYS.filter((k) => typeof parsed[k] === 'string' && !invalidValue(k, parsed[k])).map((k) => [k, parsed[k]]));
  }

  function writeAll(value) {
    if (!available()) throw new Error('Secure operating system storage is unavailable. Nothing was saved.');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, encryption.encryptString(JSON.stringify(value)), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  return {
    available,
    /** Returns the value, or null when absent or unreadable. */
    get(key) {
      if (!KEYS.includes(key)) throw new Error('Key not allowed.');
      return readAll()[key] ?? null;
    },
    set(key, value) {
      const problem = invalidValue(key, value);
      if (problem) throw new Error(problem);
      const all = readAll();
      all[key] = value;
      writeAll(all);
    },
    delete(key) {
      if (!KEYS.includes(key)) throw new Error('Key not allowed.');
      if (!fs.existsSync(file)) return;
      const all = readAll();
      if (!(key in all)) return;
      delete all[key];
      writeAll(all);
    },
    /** Every key, for building the page config. Throws when the store can't be opened. */
    snapshot: readAll,
    /** app.signedOut: drops every credential and the identity bound to it; keeps mode, host and repo. */
    clearSession() {
      if (!fs.existsSync(file)) return;
      const all = readAll();
      for (const key of SESSION_KEYS) delete all[key];
      writeAll(all);
    },
    /** "Change setup": forgets everything on this computer (the Empire itself is untouched). */
    clearAll() {
      if (!fs.existsSync(file)) return;
      writeAll({});
    },
  };
}

module.exports = { createSecureStore };
