const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const FIELDS = ['anthropicKey', 'githubToken', 'openaiKey', 'openrouterKey', 'geminiKey', 'groqKey'];
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
  function save(input) {
    if (!available()) throw new Error('Secure operating system storage is unavailable. Credentials were not saved.');
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !FIELDS.includes(k))) throw new Error('Invalid credential settings.');
    const value = read();
    for (const k of FIELDS) {
      if (input[k] === undefined || input[k] === '') continue;
      if (typeof input[k] !== 'string' || input[k].length > 4096 || /[\r\n\0]/.test(input[k])) throw new Error('Invalid credential value.');
      value[k] = input[k].trim();
    }
    fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, encryption.encryptString(JSON.stringify(value)), {mode:0o600,flag:'wx'});
      fs.renameSync(temp,file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return status();
  }
  function status() { const v=read();return {available:available(),anthropic:!!v.anthropicKey,github:!!v.githubToken}; }
  /** Names of the provider keys present, for the engines panel (never values). */
  function names() { const v=read();return Object.fromEntries(FIELDS.map(k=>[k,!!v[k]])); }
  return {read,save,status,names};
}
module.exports = {createVault, HOSTED};
