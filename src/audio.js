// Synthesised pool sounds with the Web Audio API (no audio files).
// iOS only lets audio start inside a user gesture, so main.js calls unlock() on the first
// pointer event. All sounds scale with impact speed and the number of live voices is capped.

const MAX_VOICES = 12;

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.enabled = true;
    this.voices = 0;
    this.lastBallAt = 0;
  }

  // Create/resume the context. Safe to call repeatedly (e.g. on every pointerup).
  unlock() {
    try {
      if (!this.ctx) {
        const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 10;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.12;
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.noise = this._makeNoise();
        // A one-sample silent buffer started inside the gesture unlocks iOS output.
        const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const src = this.ctx.createBufferSource();
        src.buffer = silent;
        src.connect(this.ctx.destination);
        src.start(0);
        // WebKit moves the context to 'interrupted' during calls, Siri or alarms.
        this.ctx.onstatechange = () => {
          if (this.ctx.state === 'interrupted' && this.enabled && !document.hidden) this.resume();
        };
      }
      if (this.enabled) this.resume();
      else this.suspend();
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    // A silent but running context still costs battery, so park it while sound is off.
    if (this.enabled) this.resume();
    else this.suspend();
  }

  suspend() {
    // Only suspend a running context: suspending an 'interrupted' one stops WebKit from
    // resuming it automatically when the interruption ends.
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    const st = this.ctx && this.ctx.state;
    if (this.enabled && (st === 'suspended' || st === 'interrupted')) this.ctx.resume().catch(() => {});
  }

  _ready() {
    return this.enabled && !!this.ctx && this.ctx.state === 'running';
  }

  // Map physics events to sounds.
  handle(events) {
    if (!this._ready()) return;
    for (const ev of events) {
      switch (ev.type) {
        case 'strike':
          this.strike(ev.v || 2, ev.miscue);
          break;
        case 'ball':
          this.ball(ev.v || 0);
          break;
        case 'cushion':
          this.cushion(ev.v || 0);
          break;
        case 'pocket':
          this.pocket(ev.v || 1);
          break;
        default:
          break;
      }
    }
  }

  _makeNoise() {
    const len = Math.floor(this.ctx.sampleRate * 1.0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _voice(dur) {
    if (this.voices >= MAX_VOICES) return false;
    this.voices++;
    setTimeout(() => this.voices--, dur * 1000 + 30);
    return true;
  }

  _env(gainNode, t0, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _noiseBurst(t0, { freq, q, type = 'bandpass', peak, attack, decay, offset = Math.random() * 0.8 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this._env(g, t0, peak, attack, decay);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0, offset, attack + decay + 0.02);
  }

  _tone(t0, { freq, freqEnd = freq, peak, attack, decay, type = 'sine' }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== freq) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + attack + decay);
    const g = ctx.createGain();
    this._env(g, t0, peak, attack, decay);
    o.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + attack + decay + 0.02);
  }

  // Phenolic ball-on-ball clack: bright, very short.
  ball(v) {
    if (v < 0.04 || !this._ready()) return;
    const now = this.ctx.currentTime;
    // During a break dozens of contacts land within milliseconds; thin them out.
    if (now - this.lastBallAt < 0.006 && v < 1.5) return;
    if (!this._voice(0.05)) return;
    this.lastBallAt = now;
    const k = Math.min(1, Math.pow(v / 4, 0.75));
    const jitter = 1 + (Math.random() - 0.5) * 0.12;
    this._tone(now, { freq: 2900 * jitter, peak: 0.55 * k, attack: 0.0008, decay: 0.018 });
    this._tone(now, { freq: 5100 * jitter, peak: 0.18 * k, attack: 0.0005, decay: 0.01 });
    this._noiseBurst(now, { freq: 3800, q: 1.4, peak: 0.6 * k, attack: 0.0008, decay: 0.014 });
  }

  // Rubber cushion: soft, low thump.
  cushion(v) {
    if (v < 0.05 || !this._ready()) return;
    if (!this._voice(0.09)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, Math.pow(v / 4, 0.8));
    this._tone(now, { freq: 110, freqEnd: 70, peak: 0.45 * k, attack: 0.003, decay: 0.07 });
    this._noiseBurst(now, { freq: 420, q: 0.8, type: 'lowpass', peak: 0.35 * k, attack: 0.002, decay: 0.05 });
  }

  // Ball dropping into a pocket, then rolling down the return.
  pocket(v) {
    if (!this._ready() || !this._voice(0.9)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, 0.45 + v / 4);
    this._noiseBurst(now, { freq: 900, q: 1.1, peak: 0.35 * k, attack: 0.002, decay: 0.05 });
    this._tone(now + 0.02, { freq: 150, freqEnd: 65, peak: 0.6 * k, attack: 0.004, decay: 0.16 });
    this._noiseBurst(now + 0.18, { freq: 260, q: 0.7, type: 'lowpass', peak: 0.12, attack: 0.08, decay: 0.55 });
    this._tone(now + 0.8, { freq: 2300, peak: 0.07, attack: 0.001, decay: 0.02 });
  }

  // Leather tip on the cue ball.
  strike(v, miscue = false) {
    if (!this._ready() || !this._voice(0.06)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, 0.25 + v / 7);
    if (miscue) {
      this._noiseBurst(now, { freq: 2600, q: 2, peak: 0.5 * k, attack: 0.001, decay: 0.03 });
      this._tone(now, { freq: 1700, peak: 0.25 * k, attack: 0.001, decay: 0.025, type: 'triangle' });
      return;
    }
    this._noiseBurst(now, { freq: 1500, q: 1.2, peak: 0.45 * k, attack: 0.001, decay: 0.022 });
    this._tone(now, { freq: 240, freqEnd: 180, peak: 0.3 * k, attack: 0.002, decay: 0.035 });
  }
}
