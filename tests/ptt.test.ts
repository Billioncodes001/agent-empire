// FREE-05 client push-to-talk helpers: the mobile apps keep the microphone off; WAV encoding round-trips to the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetEndpointForTests } from '../src/client/endpoint.js';
import { encodeWav16, micUnavailableReason, resample } from '../src/client/ptt.js';
import { decodeWav } from '../src/server/voice.js';

test('the iOS and Android apps keep the microphone off; push-to-talk explains and points to text', () => {
  for (const platform of ['ios', 'android'] as const) {
    resetEndpointForTests({ host: 'https://office.example', token: 't', platform });
    assert.match(micUnavailableReason() ?? '', /keeps the microphone off.*Type/);
  }
  resetEndpointForTests(null);
  // Node has no navigator.mediaDevices: the browser path reports that, rather than trying.
  assert.match(micUnavailableReason() ?? '', /no microphone access/);
  resetEndpointForTests(undefined);
});

test('client WAV at 16 kHz decodes on the office host; resampling keeps duration', async () => {
  const src = new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5);
  const down = resample(src, 48000, 16000);
  assert.equal(down.length, 16000);
  const blob = encodeWav16(down, 16000);
  const back = decodeWav(Buffer.from(await blob.arrayBuffer()));
  assert.equal(back.sampleRate, 16000);
  assert.equal(back.samples.length, 16000);
  assert.ok(Math.abs(back.samples[100] - down[100]) < 1e-3);
});
