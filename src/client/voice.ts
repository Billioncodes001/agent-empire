import type { Net } from './net';
import { store } from './state';

interface Conn {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: HTMLAudioElement;
  audioStream?: MediaStream;
  screen?: MediaStream;
  micSender?: RTCRtpSender;
  screenSender?: RTCRtpSender;
  level: number;
  analyser?: AnalyserNode;
  analyserSrc?: MediaStreamAudioSourceNode;
}

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

/**
 * Mesh WebRTC for voice + screen share. Signaling rides the office WebSocket.
 * Uses the "perfect negotiation" pattern so either side can add tracks at any time.
 */
export class Voice {
  readonly conns = new Map<string, Conn>();
  private mic: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localSrc: MediaStreamAudioSourceNode | null = null;
  private listeners = new Set<() => void>();
  muted = false;
  localLevel = 0;

  constructor(private net: Net) {
    // Often enough for mouths to keep up with syllables.
    setInterval(() => this.sampleLevels(), 40);
  }

  get inVoice() {
    return !!this.mic;
  }

  get sharing() {
    return !!this.screen;
  }

  get localScreen() {
    return this.screen;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  private changed() {
    this.listeners.forEach((fn) => fn());
    this.net.send({ t: 'voice', voice: this.inVoice, muted: this.muted, sharing: this.sharing });
  }

  /** Remote screen shares currently being received, keyed by peer id. */
  remoteScreens(): Map<string, MediaStream> {
    const out = new Map<string, MediaStream>();
    for (const [id, c] of this.conns) {
      const peer = store.peers.get(id);
      if (c.screen && peer?.sharing && c.screen.getVideoTracks().some((t) => t.readyState === 'live')) out.set(id, c.screen);
    }
    return out;
  }

  levelOf(peerId: string): number {
    return peerId === store.you ? this.localLevel : (this.conns.get(peerId)?.level ?? 0);
  }

  async joinVoice(): Promise<string | null> {
    if (this.mic) return null;
    if (!window.isSecureContext) return 'Voice needs HTTPS (or localhost). Ask whoever runs the office to enable TLS.';
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      return `Microphone unavailable: ${(err as Error).message}`;
    }
    this.muted = false;
    this.ensureAudioCtx();
    if (this.audioCtx) {
      this.localSrc = this.audioCtx.createMediaStreamSource(this.mic);
      this.localAnalyser = this.audioCtx.createAnalyser();
      this.localAnalyser.fftSize = 1024;
      this.localSrc.connect(this.localAnalyser);
    }
    const track = this.mic.getAudioTracks()[0];
    // Rejoining reuses the sender from last time, so each round trip doesn't pile up another transceiver.
    for (const c of this.conns.values()) {
      if (c.micSender) void c.micSender.replaceTrack(track).catch(() => {});
      else c.micSender = c.pc.addTrack(track, this.mic);
    }
    this.changed();
    return null;
  }

  leaveVoice() {
    if (!this.mic) return;
    // Keep the sender (just silence it) so rejoining can replaceTrack instead of adding a new one.
    for (const c of this.conns.values()) void c.micSender?.replaceTrack(null).catch(() => {});
    this.mic.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.localSrc?.disconnect();
    this.localSrc = null;
    this.localAnalyser = null;
    this.localLevel = 0;
    this.changed();
  }

  toggleMute() {
    if (!this.mic) return;
    this.muted = !this.muted;
    this.mic.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.changed();
  }

  async startShare(): Promise<string | null> {
    if (this.screen) return null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) return 'Screen sharing needs HTTPS (or localhost).';
    try {
      this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch (err) {
      return (err as Error).name === 'NotAllowedError' ? null : `Could not share: ${(err as Error).message}`;
    }
    const track = this.screen.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => this.stopShare());
    // Like the mic: reuse last share's sender, so each share doesn't pile up another transceiver.
    // Viewers pick the new frames up on the same remote track (it unmutes); no renegotiation needed.
    for (const c of this.conns.values()) {
      if (c.screenSender) void c.screenSender.replaceTrack(track).catch(() => {});
      else c.screenSender = c.pc.addTrack(track, this.screen);
    }
    this.changed();
    return null;
  }

  stopShare() {
    if (!this.screen) return;
    // Keep the sender (just send nothing). Viewers stop showing it because our `sharing` flag goes off.
    for (const c of this.conns.values()) void c.screenSender?.replaceTrack(null).catch(() => {});
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.changed();
  }

  /** Called whenever the set of peers changes. */
  syncPeers() {
    for (const id of store.peers.keys()) if (id !== store.you && !this.conns.has(id)) this.connect(id);
    for (const id of [...this.conns.keys()]) if (!store.peers.has(id)) this.drop(id);
  }

  reset() {
    for (const id of [...this.conns.keys()]) this.drop(id);
  }

  /** Proximity voice: louder when you're close, never fully silent. */
  setVolume(peerId: string, volume: number) {
    const c = this.conns.get(peerId);
    if (c) c.audio.volume = Math.max(0, Math.min(1, volume));
  }

  async handleSignal(from: string, data: Signal) {
    // A late signal from someone who already left would open a connection nothing ever closes.
    if (!this.conns.has(from) && !store.peers.has(from)) return;
    const c = this.conns.get(from) ?? this.connect(from);
    const { pc } = c;
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
        c.ignoreOffer = !c.polite && collision;
        if (c.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.signal(from, { description: pc.localDescription!.toJSON() });
        }
      } else if (data.candidate !== undefined) {
        try {
          await pc.addIceCandidate(data.candidate ?? undefined);
        } catch (err) {
          if (!c.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('rtc signal failed', err);
    }
  }

  private signal(to: string, data: Signal) {
    this.net.send({ t: 'rtc', to, data });
  }

  private ensureAudioCtx() {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new AudioContext();
      } catch {
        this.audioCtx = null;
      }
    }
    void this.audioCtx?.resume();
  }

  private connect(id: string): Conn {
    const pc = new RTCPeerConnection({ iceServers: store.ice });
    const audio = new Audio();
    audio.autoplay = true;
    const c: Conn = { pc, polite: store.you < id, makingOffer: false, ignoreOffer: false, audio, level: 0 };
    this.conns.set(id, c);

    pc.onnegotiationneeded = async () => {
      try {
        c.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(id, { description: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn('rtc negotiation failed', err);
      } finally {
        c.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => this.signal(id, { candidate: candidate ? candidate.toJSON() : null });
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      if (track.kind === 'audio') {
        c.audioStream = stream;
        audio.srcObject = stream;
        void audio.play().catch(() => {
          // Autoplay blocked until the user interacts; retry on the next click.
          window.addEventListener('pointerdown', () => void audio.play().catch(() => {}), { once: true });
        });
        this.ensureAudioCtx();
        if (this.audioCtx) {
          try {
            c.analyserSrc?.disconnect();
            c.analyserSrc = this.audioCtx.createMediaStreamSource(stream);
            c.analyser = this.audioCtx.createAnalyser();
            c.analyser.fftSize = 1024;
            c.analyserSrc.connect(c.analyser);
          } catch {
            // analyser is optional
          }
        }
      } else {
        c.screen = stream;
        track.addEventListener('unmute', () => this.listeners.forEach((fn) => fn()));
        track.addEventListener('mute', () => this.listeners.forEach((fn) => fn()));
        track.addEventListener('ended', () => this.listeners.forEach((fn) => fn()));
      }
      this.listeners.forEach((fn) => fn());
    };

    // Share whatever we're already sending.
    if (this.mic) c.micSender = pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
    if (this.screen) c.screenSender = pc.addTrack(this.screen.getVideoTracks()[0], this.screen);
    return c;
  }

  private drop(id: string) {
    const c = this.conns.get(id);
    if (!c) return;
    c.pc.close();
    c.audio.srcObject = null;
    c.analyserSrc?.disconnect();
    c.analyser?.disconnect();
    this.conns.delete(id);
    this.listeners.forEach((fn) => fn());
  }

  private readonly levelBuf = new Uint8Array(1024);

  private sampleLevels() {
    const buf = this.levelBuf;
    const rms = (a: AnalyserNode) => {
      a.getByteTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += ((v - 128) / 128) ** 2;
      return Math.sqrt(s / buf.length);
    };
    this.localLevel = this.localAnalyser && !this.muted ? rms(this.localAnalyser) : 0;
    for (const c of this.conns.values()) c.level = c.analyser ? rms(c.analyser) : 0;
  }
}
