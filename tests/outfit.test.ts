import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { AVATARS, AVATAR_IDS, CEO_AVATARS, WORKER_AVATARS, avatarDef, ceoAvatar, chiefAvatar, sanitizeOutfit, workerAvatar, workerOutfit } from '../src/shared/outfit';
import { sharedLoad, tintedMaterial, type AvatarExtras } from '../src/client/world/avatars';
import { WorkerManager, type WorkerRuntime } from '../src/server/workers';
import type { Ledger } from '../src/server/usage';
import type { WorkerInfo } from '../src/shared/protocol';

test('the CEO picks from the six suits and keeps the body a saved profile had', () => {
  assert.deepEqual(CEO_AVATARS, ['business-m01', 'business-f01', 'business-m02', 'business-f04', 'business-m03', 'business-f03']);
  for (let style = 0; style < 7; style++) {
    // Before suits, an even style was the male founder rig and an odd one the female rig.
    assert.equal(avatarDef(ceoAvatar(style)).body, style % 2 ? 'female' : 'male', `style ${style}`);
  }
  assert.equal(ceoAvatar(-1), CEO_AVATARS[5], 'never out of range');
});

test('the chief of staff wears the taupe skirt suit, or the navy suit when the CEO is a woman, never the CEO’s', () => {
  for (const ceo of CEO_AVATARS) {
    const chief = chiefAvatar(ceo);
    assert.equal(chief, avatarDef(ceo).body === 'female' ? 'business-m02' : 'business-f03');
    assert.notEqual(chief, ceo);
  }
});

test('workers get a stable default from the worker list unless an outfit was chosen', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `worker-${i}`);
  for (const id of ids) {
    assert.ok(WORKER_AVATARS.includes(workerAvatar(id)));
    assert.equal(workerAvatar(id), workerAvatar(id), 'stable');
    assert.deepEqual(workerOutfit({ id }), { avatar: workerAvatar(id) });
  }
  assert.equal(new Set(ids.map(workerAvatar)).size, WORKER_AVATARS.length, 'every default appears');
  assert.deepEqual(workerOutfit({ id: 'x', outfit: { avatar: 'business-f04', suit: '#112233' } }), { avatar: 'business-f04', suit: '#112233' });
  assert.deepEqual(workerOutfit({ id: 'x', outfit: { avatar: 'nope' } as never }), { avatar: workerAvatar('x') }, 'an unknown avatar falls back to the default');
});

test('outfits from the wire are sanitized: known avatar, #rrggbb colours, tie only where one is worn', () => {
  assert.equal(sanitizeOutfit(undefined), undefined);
  assert.equal(sanitizeOutfit({ avatar: 'business-x9' }), undefined);
  assert.equal(sanitizeOutfit('business-m01'), undefined);
  assert.deepEqual(sanitizeOutfit({ avatar: 'business-m01', suit: '#ABCDEF', shirt: 'red', tie: '#123456', extra: 1 }), { avatar: 'business-m01', suit: '#abcdef', tie: '#123456' });
  assert.deepEqual(sanitizeOutfit({ avatar: 'business-f01', suit: '#000000', tie: '#ff0000' }), { avatar: 'business-f01', suit: '#000000' }, 'no tie on a tieless suit');
  assert.deepEqual(sanitizeOutfit({ avatar: 'business-m01', suit: '#12345' }), { avatar: 'business-m01' });
  assert.equal(AVATARS.length, AVATAR_IDS.length);
});

function manager(dir: string) {
  const runtime: WorkerRuntime = {
    taskNaming: false,
    resolveCommand: () => '/fixture/claude',
    processExists: () => false,
    spawn: (() => ({ pid: 9001, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} })) as unknown as WorkerRuntime['spawn'],
  };
  const events = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };
  return new WorkerManager(dir, dir, 'claude', [], { url: 'http://127.0.0.1:1', token: '' }, events, { get hiringPaused() { return undefined; }, add() {} } as unknown as Ledger, () => 4, runtime);
}

test('a hired worker keeps its chosen outfit across a restart; legacy and tampered saves fall back safely', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-outfit-test-'));
  try {
    writeFileSync(path.join(dir, 'workers.json'), '[]');
    const first = manager(dir);
    const hired = first.spawn('desk-1', 'Owner', 'fixture task', false, 'agent', false, { avatar: 'business-m03', suit: '#1f2c4a', tie: '#c19a35' }) as WorkerInfo;
    assert.deepEqual(hired.outfit, { avatar: 'business-m03', suit: '#1f2c4a', tie: '#c19a35' });
    const plain = first.spawn('desk-2', 'Owner', 'fixture task') as WorkerInfo;
    assert.equal(plain.outfit, undefined, 'no choice: the client derives the stable default');
    first.shutdown();
    const saved = JSON.parse(readFileSync(path.join(dir, 'workers.json'), 'utf8')) as Record<string, unknown>[];
    assert.deepEqual(saved.find((w) => w.id === hired.id)?.outfit, hired.outfit);
    // Tamper with the save: a bad outfit is dropped instead of failing the restore.
    saved.find((w) => w.id === plain.id)!.outfit = { avatar: 'business-zz', suit: 'javascript:alert(1)' };
    writeFileSync(path.join(dir, 'workers.json'), JSON.stringify(saved));
    const second = manager(dir);
    assert.deepEqual(second.get(hired.id)?.outfit, hired.outfit);
    assert.equal(second.get(plain.id)?.outfit, undefined);
    second.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the recolour shader hooks into three’s standard material chunks', () => {
  // No DOM here: the mask texture is a placeholder (the shader wiring is what is under test).
  const load = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  test.after(() => { THREE.TextureLoader.prototype.load = load; });
  const source = new THREE.MeshStandardMaterial({ name: 'body' });
  const extras = { regions: { suit: { lum: 0.01, color: '#111111', area: 0.5 }, shirt: { lum: 0.3, color: '#999999', area: 0.03 }, tie: { lum: 0.05, color: '#702020', area: 0.01 } } } as unknown as AvatarExtras;
  const material = tintedMaterial(source, { avatar: 'business-m01', suit: '#1f2c4a', tie: '#c19a35' }, extras);
  assert.notEqual(material, source, 'a copy: the shared default material is untouched');
  assert.equal(material.name, 'body');
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  assert.match(shader.fragmentShader, /uniform sampler2D outfitMask/);
  assert.match(shader.fragmentShader, /outfitSuit \* shade\.x \* region\.r/);
  const uniforms = shader.uniforms as Record<string, { value: unknown }>;
  assert.deepEqual((uniforms.outfitOn.value as THREE.Vector3).toArray(), [1, 0, 1], 'shirt keeps its fabric when no colour was chosen');
  assert.equal(material.customProgramCacheKey(), tintedMaterial(source, { avatar: 'business-m02', shirt: '#ffffff' }, extras).customProgramCacheKey(), 'one program for every recoloured body');
});

test('a failed avatar download is forgotten so the next body retries, while one in flight is shared', async () => {
  const cache = new Map<string, Promise<string>>();
  let calls = 0;
  const failing = () => { calls++; return Promise.reject(new Error('network dropped')); };
  await assert.rejects(sharedLoad(cache, 'clips-male', failing), /network dropped/);
  assert.equal(cache.has('clips-male'), false, 'a rejected load must not stay cached');
  const ok = () => { calls++; return Promise.resolve('clips'); };
  const [a, b] = [sharedLoad(cache, 'clips-male', ok), sharedLoad(cache, 'clips-male', ok)];
  assert.equal(a, b, 'concurrent callers share one request');
  assert.equal(await a, 'clips');
  assert.equal(calls, 2);
  assert.equal(await sharedLoad(cache, 'clips-male', failing), 'clips', 'a successful load stays cached');
});
