/**
 * CHAR-02: the animation state machine with the extra CC0 clips (jump phases, stairs, car seat) and its fallback when
 * a clip is missing, plus the provenance of every shipped clip file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { jumpPhase, selectMotion, stairsState, EXTRA_CLIPS, type MotionInput } from '../src/client/world/anim-state';

const ALL = new Set(['idle_neutral_01', 'walk_neutral', 'run_neutral', 'sit_chair_idle_neutral_01', 'sit_down_chair_01', 'airborne_flight', ...EXTRA_CLIPS]);
const BASE = new Set(['idle_neutral_01', 'walk_neutral', 'run_neutral', 'sit_chair_idle_neutral_01', 'airborne_flight']);
const input = (o: Partial<MotionInput> = {}, clips = ALL): MotionInput => ({
  speed: 0, previous: 'idle_neutral_01', turnRate: 0, seated: false, driving: false, transition: null,
  jump: null, stairs: null, reducedMotion: false, has: (n) => clips.has(n), ...o,
});

// ---- Jump phases ------------------------------------------------------------------------------------------------
test('jump phases: a rising take-off, then airborne, then a landing after a real fall', () => {
  assert.equal(jumpPhase({ flying: true, airTime: 0.05, vy: 4.5, landing: 0 }), 'takeoff');
  assert.equal(jumpPhase({ flying: true, airTime: 0.2, vy: 2, landing: 0 }), 'takeoff');
  assert.equal(jumpPhase({ flying: true, airTime: 0.45, vy: 0.5, landing: 0 }), 'air', 'past the take-off window');
  assert.equal(jumpPhase({ flying: true, airTime: 0.1, vy: -2, landing: 0 }), 'air', 'stepping off a ledge never plays a take-off');
  assert.equal(jumpPhase({ flying: false, airTime: 0, vy: 0, landing: 0.2 }), 'land');
  assert.equal(jumpPhase({ flying: false, airTime: 0, vy: 0, landing: 0 }), null);
});

test('jump clips: take-off, airborne and landing use the CC0 clips', () => {
  assert.equal(selectMotion(input({ jump: 'takeoff' })), 'jump_start');
  assert.equal(selectMotion(input({ jump: 'air', previous: 'jump_start' })), 'jump_air');
  assert.equal(selectMotion(input({ jump: 'land', previous: 'jump_air' })), 'jump_land');
  // Moving off a landing returns to the stride straight away instead of finishing a standing crouch.
  assert.equal(selectMotion(input({ jump: 'land', speed: 3, previous: 'jump_air' })), 'run_neutral');
});

test('jump clips fall back to the held run-flight frame and the procedural dip when missing', () => {
  assert.equal(selectMotion(input({ jump: 'takeoff' }, BASE)), 'airborne_flight');
  assert.equal(selectMotion(input({ jump: 'air' }, BASE)), 'airborne_flight');
  assert.equal(selectMotion(input({ jump: 'land' }, BASE)), 'idle_neutral_01');
  // And without even the flight action (a bare body), locomotion never breaks.
  assert.equal(selectMotion(input({ jump: 'air', speed: 2 }, new Set(['idle_neutral_01', 'walk_neutral']))), 'walk_neutral');
});

test('reduced motion keeps the calm CHAR-01 jump (held frame, small dip), never the wide-armed clips', () => {
  assert.equal(selectMotion(input({ jump: 'takeoff', reducedMotion: true })), 'airborne_flight');
  assert.equal(selectMotion(input({ jump: 'air', reducedMotion: true })), 'airborne_flight');
  assert.equal(selectMotion(input({ jump: 'land', reducedMotion: true })), 'idle_neutral_01');
});

// ---- Stairs -----------------------------------------------------------------------------------------------------
test('stairs state from grounded vertical speed, with hysteresis', () => {
  assert.equal(stairsState(null, 1.6, 0.6), 'up');
  assert.equal(stairsState(null, 1.6, -0.6), 'down');
  assert.equal(stairsState(null, 1.6, 0.2), null, 'a gentle slope is not a staircase');
  assert.equal(stairsState('up', 1.6, 0.2), 'up', 'stays on the stairs between steps');
  assert.equal(stairsState('up', 1.6, 0.05), null);
  assert.equal(stairsState(null, 0.1, 0.8), null, 'standing still (a lift, a landing) is not climbing');
  assert.equal(stairsState('down', 0, -0.5), null);
});

test('on stairs the stride clip plays (no stair clip exists in the free libraries), seated and driving win', () => {
  assert.equal(selectMotion(input({ stairs: 'up', speed: 1.6 })), 'walk_neutral');
  assert.equal(selectMotion(input({ stairs: 'down', speed: 1.6 })), 'walk_neutral');
  assert.equal(selectMotion(input({ stairs: 'up', speed: 1.6, seated: true })), 'sit_chair_idle_neutral_01');
});

// ---- Car seat ---------------------------------------------------------------------------------------------------
test('car seat: driving uses the CC0 driving pose, falls back to the chair sit; entry/exit transitions win', () => {
  assert.equal(selectMotion(input({ driving: true, seated: true })), 'drive_seated');
  assert.equal(selectMotion(input({ driving: true, seated: true }, BASE)), 'sit_chair_idle_neutral_01');
  assert.equal(selectMotion(input({ driving: true, seated: true, transition: 'sit_down_chair_01' })), 'sit_down_chair_01');
  assert.equal(selectMotion(input({ seated: true })), 'sit_chair_idle_neutral_01', 'a desk chair is not a car seat');
});

test('a missing transition clip falls back to the idle, never a T-pose', () => {
  assert.equal(selectMotion(input({ transition: 'sit_down_chair_01' }, BASE)), 'idle_neutral_01');
});

// ---- Provenance -------------------------------------------------------------------------------------------------
const AVATARS = new URL('../src/client/public/models/avatars/', import.meta.url);
test('every shipped clip file is listed with its licence and checksum', async () => {
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  const extra = JSON.parse(await readFile(new URL('clips-extra.json', AVATARS), 'utf8'));
  const sources = JSON.parse(await readFile(new URL('../tools/avatars/sources.json', import.meta.url), 'utf8'));
  const files = (await readdir(AVATARS)).filter((f) => /^clips-.*\.glb$/.test(f)).sort();
  assert.deepEqual(files, ['clips-extra-female.glb', 'clips-extra-male.glb', 'clips-female.glb', 'clips-male.glb']);
  for (const file of files) {
    assert.ok(notices.includes(file), `${file} named in THIRD_PARTY_NOTICES.md`);
    if (!file.startsWith('clips-extra-')) continue; // Rocketbox MIT clips: built by build-avatars from pinned rigs.
    const entry = extra.files[file];
    assert.ok(entry, `${file} in clips-extra.json`);
    const bytes = await readFile(new URL(file, AVATARS));
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'), `${file} checksum`);
    assert.equal(entry.bytes, bytes.byteLength);
    assert.equal(entry.licence, 'CC0-1.0');
    const pack = sources.packs[entry.pack];
    assert.ok(pack && /^[0-9a-f]{64}$/.test(pack.sha256) && pack.zip.startsWith('https://'), `${file}: source archive pinned`);
    assert.ok(notices.includes(pack.sha256), `${file}: archive checksum in THIRD_PARTY_NOTICES.md`);
    assert.ok(bytes.byteLength < 100 * 1024, `${file} stays small (${bytes.byteLength} bytes)`);
    for (const name of EXTRA_CLIPS) assert.ok(entry.clips[name], `${file} has ${name}`);
  }
  assert.ok(!/mixamo/i.test(JSON.stringify(sources)), 'no Mixamo source');
  assert.equal(sources.licence, 'CC0-1.0');
});
