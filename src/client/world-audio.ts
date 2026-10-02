import type { VehicleMotion } from './vehicle';

export type Surface = 'wood' | 'concrete' | 'carpet' | 'grass';
export type CarCue = 'door-open' | 'door-close' | 'engine-start' | 'engine-stop';
type Point = { x: number; y: number; z: number };
export function footSurface(x: number, z: number): Surface {
  if (z < 30) return z > 7 && Math.abs(x) < 4 ? 'concrete' : 'wood';
  if (Math.abs(x - 24) < 8 && Math.abs(z - 50) < 5) return 'wood';
  if (Math.abs(x + 24) < 8 && Math.abs(z - 134) < 5) return 'carpet';
  return 'concrete';
}
export const AUDIO_FILES = [
  ...(['wood', 'concrete', 'carpet', 'grass'] as const).flatMap(s => Array.from({ length: 5 }, (_, i) => `step-${s}-${i}`)),
  'engine-idle', 'engine-load', 'road-roll', 'engine-start', 'engine-stop', 'door-open', 'door-close',
];

/** Locally shipped foley. No oscillators are used for footsteps, doors or vehicle propulsion. */
export class WorldAudio {
  private buffers = new Map<string, AudioBuffer>();
  private output: GainNode;
  private engine: BiquadFilterNode;
  private enginePosition: PannerNode;
  private loops = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();
  private lastStep = new Map<Surface, number>();
  private failed = 0;
  private ignition = 0;
  readonly played: Record<string, number> = {};
  constructor(private ctx: AudioContext, destination: AudioNode) {
    this.output = ctx.createGain(); this.output.connect(destination);
    this.engine = ctx.createBiquadFilter(); this.engine.type = 'lowpass';
    this.enginePosition = this.panner({ x: 5, y: .5, z: 45 });
    this.engine.connect(this.enginePosition).connect(this.output);
    void Promise.allSettled(AUDIO_FILES.map(async name => {
      try {
        const response = await fetch(`/audio/${name}.wav`);
        if (!response.ok) throw new Error(String(response.status));
        this.buffers.set(name, await ctx.decodeAudioData(await response.arrayBuffer()));
      } catch { this.failed++; console.warn(`Sound unavailable: ${name}`); }
    }));
  }
  get status() { return `${this.buffers.size}/${AUDIO_FILES.length}${this.failed ? ` (${this.failed} failed)` : ''}`; }
  visibility(hidden: boolean) { this.output.gain.setTargetAtTime(hidden ? 0 : 1, this.ctx.currentTime, .08); }
  private panner(at: Point) {
    const p = this.ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = 3; p.rolloffFactor = .9; p.maxDistance = 65;
    p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z;
    return p;
  }
  private one(name: string, gain: number, rate = 1, at?: Point) {
    const buffer = this.buffers.get(name);
    if (!buffer || this.ctx.state !== 'running' || document.hidden) return;
    const source = this.ctx.createBufferSource(), volume = this.ctx.createGain();
    source.buffer = buffer; source.playbackRate.value = rate; volume.gain.value = gain;
    source.connect(volume);
    const p = at ? this.panner(at) : null;
    if (p) volume.connect(p).connect(this.output); else volume.connect(this.output);
    source.onended = () => { source.disconnect(); volume.disconnect(); p?.disconnect(); };
    source.start(); this.played[name] = (this.played[name] ?? 0) + 1;
  }
  step(surface: Surface, running = false, landing = false, at?: Point) {
    // Never repeat the last take. Tiny pitch differences retain the recording's natural timbre.
    const old = this.lastStep.get(surface) ?? -1;
    let take = Math.floor(Math.random() * 4); if (take >= old && old >= 0) take++;
    this.lastStep.set(surface, take);
    this.one(`step-${surface}-${take}`, at ? .45 : landing ? .65 : running ? .48 : .31, landing ? .88 : .97 + Math.random() * .06, at);
  }
  cue(name: CarCue, at: Point) {
    if (name === 'engine-start') this.ignition = this.ctx.currentTime + .9;
    this.one(name, name.startsWith('door') ? .75 : .62, 1, at);
  }
  vehicle(m: VehicleMotion, running: boolean, at: Point, cabin: boolean) {
    const now = this.ctx.currentTime;
    this.enginePosition.positionX.setTargetAtTime(at.x, now, .03);
    this.enginePosition.positionY.setTargetAtTime(at.y + .5, now, .03);
    this.enginePosition.positionZ.setTargetAtTime(at.z, now, .03);
    this.engine.frequency.setTargetAtTime(cabin ? 1300 : 5200, now, .15);
    const active = running && now >= this.ignition;
    const speed = Math.abs(m.speed), rev = Math.max(0, Math.min(1, (m.rpm - 780) / 2500));
    const settings: [string, number, number][] = [
      ['engine-idle', active ? .5 * (1 - rev * .7) : 0, .85 + rev * .7],
      ['engine-load', active ? (.12 + rev * .5) * (.55 + m.throttle * .45) : 0, .75 + rev * .8],
      ['road-roll', active ? Math.min(.75, speed / 22) : 0, .75 + Math.min(speed, 18) / 30],
    ];
    for (const [name, gain, rate] of settings) {
      let layer = this.loops.get(name);
      if (!layer && active && this.buffers.has(name)) {
        const source = this.ctx.createBufferSource(), volume = this.ctx.createGain();
        source.buffer = this.buffers.get(name)!; source.loop = true; volume.gain.value = 0;
        source.connect(volume).connect(this.engine); source.start();
        layer = { source, gain: volume }; this.loops.set(name, layer);
      }
      if (!layer) continue;
      layer.gain.gain.setTargetAtTime(gain, now, .16);
      layer.source.playbackRate.setTargetAtTime(rate, now, .12);
      if (!running) {
        layer.source.stop(now + .65);
        const retired = layer;
        layer.source.onended = () => { retired.source.disconnect(); retired.gain.disconnect(); };
        this.loops.delete(name);
      }
    }
  }
}
