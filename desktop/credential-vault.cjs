const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const FIELDS = ['anthropicKey', 'githubToken', 'openaiKey', 'openrouterKey', 'geminiKey', 'groqKey', 'telegramToken', 'ntfyToken', 'smtpPassword'];
/** FREE-08 notification secrets, set from the game's onboarding through the local host (validated there first). */
const NOTIFY = ['telegramToken', 'ntfyToken', 'smtpPassword'];
/** Review 12: the same format checks as the server (src/server/secrets.ts invalidSecret), for keys:save too. */
const NOTIFY_SHAPE = { telegramToken: /^\d{5,20}:[A-Za-z0-9_-]{20,}$/, ntfyToken: /^[A-Za-z0-9_-]{8,200}$/, smtpPassword: /^[^\r\n\0]{1,1024}$/ };
/** FREE-01 opt-in free hosted keys: saved only after the user confirms each provider's data-use terms (main.cjs). */
const HOSTED = ['openrouterKey', 'geminiKey', 'groqKey'];
function createVault(file, encryption) {
  const available = () => encryption.isEncryptionAvailable() && (!encryption.getSelectedStorageBackend || encryption.getSelectedStorageBackend() !== 'basic_text');
  function read() {
    if (!fs.existsSync(file)) return {};
    if (!available()) throw new Error('The operating system credential store is locked or unavailable.');
    try {
      const parsed = JSON.parse(encryption.decryptString(fs.readFileSync(file)));
      if (!parsed || typeof parsed !== 'object' || FIELDS.some(k => parsed[k] !== undefined && typeof parsed[k] !== 'string')) throw new Error();
      return Object.fromEntries(FIELDS.filter(k => parsed[k]).map(k => [k, parsed[k]]));
    } catch { throw new Error('Stored provider credentials could not be opened. Unlock the operating system credential store.'); }
  }
  function write(value) {
    fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, encryption.encryptString(JSON.stringify(value)), {mode:0o600,flag:'wx'});
      fs.renameSync(temp,file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function save(input) {
    if (!available()) throw new Error('Secure operating system storage is unavailable. Credentials were not saved.');
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !FIELDS.includes(k))) throw new Error('Invalid credential settings.');
    const value = read();
    for (const k of FIELDS) {
      if (input[k] === undefined || input[k] === '') continue;
      if (typeof input[k] !== 'string' || input[k].length > 4096 || /[\r\n\0]/.test(input[k])) throw new Error('Invalid credential value.');
      if (NOTIFY.includes(k) && !NOTIFY_SHAPE[k].test(input[k].trim())) throw new Error('Invalid credential value.');
      value[k] = input[k].trim();
    }
    write(value);
    return status();
  }
  /** Removes one notification secret (FREE-08 "Remove"); provider keys keep their own flow. */
  function remove(k) {
    if (!NOTIFY.includes(k)) throw new Error('Invalid credential settings.');
    if (!available()) throw new Error('Secure operating system storage is unavailable. Nothing was changed.');
    if (!fs.existsSync(file)) return;
    const value = read();
    if (!(k in value)) return;
    delete value[k];
    write(value);
  }
  /** The server's SecretStore shape (src/server/secrets.ts): names and presence only leave this process. */
  function notifySecrets() {
    return {
      describe: 'Saved in this computer’s operating-system credential store (Keychain, Windows DPAPI or Secret Service), like your API keys.',
      names() { try { const v = read(); return Object.fromEntries(NOTIFY.map(k => [k, !!v[k]])); } catch { return Object.fromEntries(NOTIFY.map(k => [k, false])); } },
      get(k) { if (!NOTIFY.includes(k)) return undefined; try { return read()[k]; } catch { return undefined; } },
      set(k, v) { if (!NOTIFY.includes(k)) throw new Error('Invalid credential settings.'); save({ [k]: v }); },
      delete(k) { remove(k); },
      /** A locked or unreadable vault, so the server refuses re-targeting a channel whose secret it cannot see. */
      error() { try { read(); return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); } },
    };
  }
  function status() { const v=read();return {available:available(),anthropic:!!v.anthropicKey,github:!!v.githubToken}; }
  /** Names of the provider keys present, for the engines panel (never values). */
  function names() { const v=read();return Object.fromEntries(FIELDS.map(k=>[k,!!v[k]])); }
  return {read,save,status,names,remove,notifySecrets};
}
module.exports = {createVault, HOSTED};
