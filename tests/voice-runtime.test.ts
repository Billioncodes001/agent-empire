import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sherpaEngines, VoiceError } from '../src/server/voice';
import { SHERPA_INSTALL } from '../src/shared/voice';

// A real round trip on 2026-10-24: sherpa-onnx-node 2.0.0 installed and verified the Kokoro archive but failed every
// reply ("No lexicon available"); 1.13.8 spoke and transcribed 17/17 words. Detection must say which version to install.
const fakeModule = { OfflineRecognizer: class {}, OfflineTts: class {} };

test('voice runtime: 2.x is refused with the version to install, before any model loads', async () => {
  let loaded = false;
  const engines = sherpaEngines(() => { loaded = true; return fakeModule; }, () => '2.0.0');
  const d = await engines.detect();
  assert.equal(d.available, false);
  assert.match(d.detail, /2\.0\.0/);
  assert.ok(d.detail.includes(`npm install ${SHERPA_INSTALL}`), d.detail);
  await assert.rejects(engines.tts({ id: 'kokoro-en-int8', kind: 'tts', family: 'kokoro' } as never, '/nonexistent'), (e) => e instanceof VoiceError && e.status === 409);
  assert.equal(loaded, false, 'the 2.x module is never loaded');
});

test('voice runtime: the supported 1.x release is accepted, and a missing runtime names the pinned install', async () => {
  assert.equal((await sherpaEngines(() => fakeModule, () => '1.13.8').detect()).available, true);
  const missing = await sherpaEngines(() => { throw new Error('Cannot find module'); }, () => undefined).detect();
  assert.equal(missing.available, false);
  assert.ok(missing.detail.includes(`npm install ${SHERPA_INSTALL}`), missing.detail);
});
