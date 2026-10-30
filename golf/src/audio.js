// Synthesised golf sounds with the Web Audio API (no audio files).
// iOS only lets audio start inside a user gesture, so main.js calls unlock() on the first
// pointer event (and again on later ones; it is idempotent). The number of live voices is capped.
//
//   const audio = new AudioFX();
//   audio.unlock(); audio.setEnabled(on); audio.suspend(); audio.resume();
//   audio.whoosh(speed01)                 swing whoosh, speed 0..1.1 (swing power)
//   audio.impact(kind, power)             kind: club kind 'wood'|'hybrid'|'iron'|'wedge'|'putter'
//                                         or 'driver'; power 0..1.1
//   audio.land(surface, v)                SURF id or name ('green','fairway','rough','bunker',
//                                         'water','tee','fringe','oob','waste','desert','fescue');
//                                         v = impact speed m/s
//   audio.tree(v, obj?)                   obj: the object's kind (physics 'tree' events carry it):
//                                         trees and palms rustle, rocks clack, a saguaro thuds,
//                                         shrubs and gorse crackle
//   audio.pin(v)  audio.cup(v)  audio.lipout(v)  audio.applause(strength 0..1)
//   audio.setWind(mps)                    ambient wind loop; gain grows with wind speed
//   audio.handle(event | events)          maps physics shot events {type, surface, v, kind?}:
//       launch -> impact (kind from ev.kind / ev.club.kind, else guessed from v)
//       land / bounce -> land(surface)  tree -> tree(v, ev.obj)  pin -> flagstick clank
//       lipout -> rattle  cup -> rattle + plunk  water -> splash  rest -> nothing
//       swing -> whoosh(ev.power)  applause -> applause(ev.strength)
//   Spectators (section 10; the "crowd" section at the end):
//   audio.crowdBed(level 0..1, hush 0..1)  the gallery's murmur loop (level: how near and how big
//                                         the nearest gallery is; hushed while addressing)
//   audio.crowdReact(name, strength, gain) 'clap' (golf applause), 'cheer' (roar, claps and
//                                         whistles), 'ooh' and 'groan' (formant voice choruses);
//                                         gain 0..1 by the camera's distance to the gallery

import { SURF } from './constants.js';

const MAX_VOICES = 16;

const SURF_BY_NAME = {
  tee: SURF.TEE, fairway: SURF.FAIRWAY, rough: SURF.ROUGH, fringe: SURF.FRINGE, green: SURF.GREEN,
  bunker: SURF.BUNKER, sand: SURF.BUNKER, water: SURF.WATER, oob: SURF.OOB,
  waste: SURF.WASTE, desert: SURF.DESERT, fescue: SURF.FESCUE,
};

function surfId(s) {
  if (typeof s === 'number') return s;
  return SURF_BY_NAME[String(s || '').toLowerCase()] || SURF.FAIRWAY;
}

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.enabled = true;
    this.voices = 0;
    this.lastLandAt = 0;
    this.windMps = 0;
    this._wind = null; // {src, filter, gain, lfo}
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
        this.noise = this._makeNoise(2.0);
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
        this._startWind();
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

  // Map shot events (physics.js `events`, replayed by game.update) to sounds.
  handle(events) {
    if (!this._ready() || !events) return;
    const list = Array.isArray(events) ? events : [events];
    for (const ev of list) {
      const v = ev.v || 0;
      switch (ev.type) {
        case 'swing':
          this.whoosh(ev.power ?? 0.8);
          break;
        case 'launch': {
          const kind = ev.kind || (ev.club && ev.club.kind) || (v < 15 ? 'putter' : v > 62 ? 'driver' : 'iron');
          this.impact(kind, ev.power ?? Math.min(1, v / 65));
          break;
        }
        case 'land':
          this.land(ev.surface, v);
          break;
        case 'bounce':
          this.land(ev.surface, v * 0.6);
          break;
        case 'tree':
          this.tree(v, ev.obj);
          break;
        case 'pin':
          this.pin(v);
          break;
        case 'lipout':
          this.lipout(v);
          break;
        case 'cup':
          this.cup(v);
          break;
        case 'water':
          this.land(SURF.WATER, v || 10);
          break;
        case 'applause':
          this.applause(ev.strength ?? 1);
          break;
        default:
          break; // 'rest' and unknown events are silent
      }
    }
  }

  // ------------------------------------------------------------ building blocks
  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
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

  _noiseBurst(t0, { freq, freqEnd, q = 1, type = 'bandpass', peak, attack, decay, offset = Math.random() * 1.5 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + attack + decay);
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

  // ------------------------------------------------------------ swing and strike
  // Club swishing through the air: a band-passed noise sweep whose centre frequency and level
  // rise with club-head speed (a Doppler-like upward glide peaking at impact).
  whoosh(speed = 0.8) {
    if (!this._ready() || !this._voice(0.4)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1.1, Math.max(0.1, speed));
    this._noiseBurst(now, { freq: 300 + 300 * k, freqEnd: 900 + 1600 * k, q: 1.6, peak: 0.12 + 0.3 * k, attack: 0.16, decay: 0.16 });
  }

  // Ball strike. Driver: hollow titanium "ping" (two inharmonic partials). Irons/wedges: a sharp
  // click with a turf thump underneath. Putter: a soft, short wooden "tock".
  impact(kind = 'iron', power = 1) {
    if (!this._ready() || !this._voice(0.3)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, Math.max(0.15, power));
    if (kind === 'driver' || kind === 'wood') {
      const big = kind === 'driver' ? 1 : 0.8;
      this._noiseBurst(now, { freq: 4200, q: 0.9, peak: 0.55 * k, attack: 0.0006, decay: 0.03 });
      this._tone(now, { freq: 1850 * big + 300, freqEnd: 1700, peak: 0.28 * k, attack: 0.001, decay: 0.16, type: 'triangle' });
      this._tone(now, { freq: 3250, peak: 0.12 * k, attack: 0.001, decay: 0.09 });
      this._tone(now, { freq: 160, freqEnd: 90, peak: 0.3 * k, attack: 0.002, decay: 0.06 });
    } else if (kind === 'putter') {
      this._tone(now, { freq: 1050, freqEnd: 900, peak: 0.32 * k + 0.08, attack: 0.0008, decay: 0.035 });
      this._noiseBurst(now, { freq: 2200, q: 2.2, peak: 0.14 * k + 0.04, attack: 0.0006, decay: 0.012 });
    } else {
      // iron / hybrid / wedge: compressed click, then the divot thump.
      const bright = kind === 'wedge' ? 1.15 : kind === 'hybrid' ? 0.9 : 1;
      this._noiseBurst(now, { freq: 3600 * bright, q: 1.3, peak: 0.6 * k, attack: 0.0005, decay: 0.018 });
      this._tone(now, { freq: 2400 * bright, peak: 0.16 * k, attack: 0.0005, decay: 0.025 });
      this._noiseBurst(now + 0.006, { freq: 380, type: 'lowpass', q: 0.7, peak: 0.45 * k, attack: 0.004, decay: 0.09 });
      this._tone(now + 0.004, { freq: 120, freqEnd: 70, peak: 0.35 * k, attack: 0.003, decay: 0.08 });
    }
  }

  // ------------------------------------------------------------ ball meets the course
  land(surface, v = 10) {
    if (!this._ready()) return;
    const now = this.ctx.currentTime;
    if (now - this.lastLandAt < 0.03 && v < 8) return; // rolling micro-bounces: thin them out
    const s = surfId(surface);
    if (s === SURF.WATER) return this._splash(v);
    if (v < 0.4 || !this._voice(0.25)) return;
    this.lastLandAt = now;
    const k = Math.min(1, Math.pow(v / 25, 0.7));
    switch (s) {
      case SURF.GREEN:
      case SURF.FRINGE:
        // Firm, tight turf: a short muted thud with a little click.
        this._tone(now, { freq: 140, freqEnd: 80, peak: 0.5 * k, attack: 0.002, decay: 0.07 });
        this._noiseBurst(now, { freq: 1600, q: 1.4, peak: 0.12 * k, attack: 0.001, decay: 0.015 });
        break;
      case SURF.BUNKER:
        // Sand: a soft broadband "pff" with almost no low end.
        this._noiseBurst(now, { freq: 2600, freqEnd: 900, q: 0.6, peak: 0.4 * k + 0.05, attack: 0.004, decay: 0.16 });
        break;
      case SURF.ROUGH:
      case SURF.OOB:
        this._noiseBurst(now, { freq: 1200, q: 0.8, peak: 0.28 * k, attack: 0.003, decay: 0.09 });
        this._tone(now, { freq: 100, freqEnd: 65, peak: 0.25 * k, attack: 0.003, decay: 0.06 });
        break;
      case SURF.FESCUE:
        // Long links grass: a soft swish that swallows the ball, hardly any thump.
        this._noiseBurst(now, { freq: 2200, freqEnd: 1100, q: 0.6, peak: 0.24 * k, attack: 0.008, decay: 0.14 });
        this._tone(now, { freq: 90, freqEnd: 60, peak: 0.12 * k, attack: 0.004, decay: 0.05 });
        break;
      case SURF.WASTE:
        // Hardpan or beach sand: a gritty crunch over a firm knock.
        this._tone(now, { freq: 130, freqEnd: 75, peak: 0.4 * k, attack: 0.002, decay: 0.06 });
        this._noiseBurst(now, { freq: 3200, freqEnd: 1500, q: 0.9, peak: 0.24 * k, attack: 0.002, decay: 0.08 });
        break;
      case SURF.DESERT:
        // Stony scrub: a sharp click off the stones, then grit.
        this._tone(now, { freq: 1900, freqEnd: 1300, peak: 0.16 * k, attack: 0.0008, decay: 0.03, type: 'triangle' });
        this._noiseBurst(now, { freq: 2800, q: 1.1, peak: 0.26 * k, attack: 0.001, decay: 0.07 });
        this._tone(now, { freq: 120, freqEnd: 70, peak: 0.3 * k, attack: 0.002, decay: 0.05 });
        break;
      default:
        // Fairway / tee: a heavier thump.
        this._tone(now, { freq: 115, freqEnd: 62, peak: 0.6 * k, attack: 0.002, decay: 0.09 });
        this._noiseBurst(now, { freq: 700, type: 'lowpass', q: 0.7, peak: 0.25 * k, attack: 0.002, decay: 0.05 });
    }
  }

  _splash(v) {
    if (!this._voice(0.9)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, 0.4 + v / 30);
    this._tone(now, { freq: 520, freqEnd: 1300, peak: 0.18 * k, attack: 0.004, decay: 0.05 }); // "bloop"
    this._noiseBurst(now, { freq: 1800, freqEnd: 600, q: 0.5, peak: 0.5 * k, attack: 0.006, decay: 0.35 });
    this._noiseBurst(now + 0.12, { freq: 3200, q: 0.8, peak: 0.12 * k, attack: 0.05, decay: 0.45 }); // droplets
  }

  // Leaves rustle, then (if it was a hard hit) a woody clack off a branch. obj (the object's kind)
  // picks another sound for the desert and links objects: a rock clacks, a saguaro thuds and a
  // shrub or gorse bush crackles.
  tree(v = 10, obj = null) {
    if (!this._ready() || !this._voice(0.6)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, 0.3 + v / 30);
    if (obj === 'rock') {
      this._tone(now, { freq: 2300, freqEnd: 1700, peak: 0.32 * k, attack: 0.0006, decay: 0.05, type: 'triangle' });
      this._noiseBurst(now, { freq: 3800, q: 2, peak: 0.3 * k, attack: 0.0006, decay: 0.03 });
      return;
    }
    if (obj === 'saguaro') {
      this._tone(now, { freq: 150, freqEnd: 90, peak: 0.45 * k, attack: 0.002, decay: 0.08 });
      this._noiseBurst(now, { freq: 900, q: 1.2, peak: 0.15 * k, attack: 0.002, decay: 0.05 });
      return;
    }
    if (obj === 'shrub' || obj === 'gorse') {
      this._noiseBurst(now, { freq: 3400, q: 1.1, peak: 0.26 * k, attack: 0.005, decay: 0.18 });
      for (let i = 0; i < 3; i++) this._noiseBurst(now + 0.02 + i * 0.035, { freq: 1800 + 900 * i, q: 3, peak: 0.1 * k, attack: 0.001, decay: 0.02 });
      return;
    }
    this._noiseBurst(now, { freq: 4200, q: 0.7, peak: 0.3 * k, attack: 0.02, decay: 0.4 });
    this._noiseBurst(now + 0.05, { freq: 2600, q: 0.9, peak: 0.18 * k, attack: 0.05, decay: 0.3 });
    if (v > 8) {
      this._tone(now + 0.03, { freq: 620, freqEnd: 480, peak: 0.3 * k, attack: 0.001, decay: 0.05, type: 'triangle' });
      this._noiseBurst(now + 0.03, { freq: 900, q: 3, peak: 0.25 * k, attack: 0.001, decay: 0.03 });
    }
  }

  // Ball off the flagstick: a metallic clank.
  pin(v = 5) {
    if (!this._ready() || !this._voice(0.5)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, 0.3 + v / 15);
    for (const [f, p] of [[1180, 0.25], [2950, 0.14], [4410, 0.08]]) {
      this._tone(now, { freq: f, peak: p * k, attack: 0.0008, decay: 0.35, type: 'triangle' });
    }
  }

  // Ball circling the rim: a quick run of plastic-liner rattles.
  lipout(v = 1) {
    if (!this._ready() || !this._voice(0.4)) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      this._noiseBurst(now + i * 0.045, { freq: 2600 - i * 200, q: 2.5, peak: 0.25 - i * 0.04, attack: 0.001, decay: 0.02 });
    }
  }

  // Into the hole: a short rattle against the liner, then the hollow plunk at the bottom.
  cup(v = 1) {
    if (!this._ready() || !this._voice(0.7)) return;
    const now = this.ctx.currentTime;
    const k = Math.min(1, 0.5 + v / 3);
    for (let i = 0; i < 3; i++) {
      this._noiseBurst(now + i * 0.035, { freq: 2300 + i * 150, q: 2.2, peak: 0.22 * k, attack: 0.001, decay: 0.02 });
    }
    this._tone(now + 0.13, { freq: 330, freqEnd: 190, peak: 0.55 * k, attack: 0.002, decay: 0.12 });
    this._tone(now + 0.13, { freq: 760, freqEnd: 600, peak: 0.16 * k, attack: 0.001, decay: 0.08, type: 'triangle' });
    this._tone(now + 0.3, { freq: 300, freqEnd: 210, peak: 0.12 * k, attack: 0.002, decay: 0.08 });
  }

  // Gallery applause: many short noise "claps" at random times under a crowd swell. Used for a
  // birdie or better (strength 0..1 scales length and loudness).
  applause(strength = 1) {
    if (!this._ready() || !this._voice(3)) return;
    const now = this.ctx.currentTime;
    const s = Math.min(1, Math.max(0.2, strength));
    const dur = 1.6 + 1.6 * s;
    this._noiseBurst(now, { freq: 1500, q: 0.4, peak: 0.12 * s, attack: 0.25, decay: dur, offset: 0 });
    const claps = Math.round(60 + 120 * s);
    for (let i = 0; i < claps; i++) {
      // Density falls off over time like a real ovation.
      const t = now + dur * Math.pow(Math.random(), 1.6);
      this._noiseBurst(t, { freq: 1100 + Math.random() * 1800, q: 1.2, peak: (0.05 + Math.random() * 0.07) * s, attack: 0.001, decay: 0.03 });
    }
  }

  // ------------------------------------------------------------ ambient wind
  // A looping noise bed through a low band-pass whose level follows the wind speed, with a slow
  // LFO on the filter for gusts. Silent (but alive) at 0 m/s so a change is a simple ramp.
  setWind(mps) {
    this.windMps = Math.max(0, mps || 0);
    if (!this._wind || !this.ctx) return;
    const target = Math.min(0.16, 0.006 + 0.016 * this.windMps);
    const t = this.ctx.currentTime;
    this._wind.gain.gain.cancelScheduledValues(t);
    this._wind.gain.gain.setTargetAtTime(target, t, 0.8);
    this._wind.filter.frequency.setTargetAtTime(250 + 45 * this.windMps, t, 0.8);
  }

  _startWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 300;
    filter.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 120;
    lfo.connect(lfoAmt);
    lfoAmt.connect(filter.frequency);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
    lfo.start();
    this._wind = { src, filter, gain, lfo };
    this.setWind(this.windMps);
  }

  // ------------------------------------------------------------ crowd (spectators, section 10)
  // Murmur bed: speech-band noise (two band-passes) with slow swells and a faint chatter
  // flutter, built on first use and ramped to `level` (quieter by `hush`). Silent at level 0.
  crowdBed(level = 0, hush = 0) {
    if (!this.ctx || !this.master) return;
    const target = Math.max(0, Math.min(1, level)) * 0.085 * (1 - 0.82 * Math.max(0, Math.min(1, hush)));
    if (!this._bed) {
      if (target < 0.002) return;
      this._bed = this._makeBed();
    }
    const t = this.ctx.currentTime;
    this._bed.gain.gain.cancelScheduledValues(t);
    this._bed.gain.gain.setTargetAtTime(Math.max(0.0001, target), t, hush > 0.5 ? 0.35 : 0.8);
  }

  _makeBed() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lo = ctx.createBiquadFilter();
    lo.type = 'bandpass';
    lo.frequency.value = 480;
    lo.Q.value = 0.8;
    const hi = ctx.createBiquadFilter();
    hi.type = 'bandpass';
    hi.frequency.value = 1350;
    hi.Q.value = 1.4;
    const hiG = ctx.createGain();
    hiG.gain.value = 0.35;
    const swell = ctx.createGain();
    swell.gain.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    // Swells (a crowd breathes) and a chatter flutter on the upper band.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.31;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.28;
    lfo.connect(lfoAmt);
    lfoAmt.connect(swell.gain);
    const fl = ctx.createOscillator();
    fl.frequency.value = 3.7;
    const flAmt = ctx.createGain();
    flAmt.gain.value = 0.12;
    fl.connect(flAmt);
    flAmt.connect(hiG.gain);
    src.connect(lo);
    src.connect(hi);
    hi.connect(hiG);
    lo.connect(swell);
    hiG.connect(swell);
    swell.connect(gain);
    gain.connect(this.master);
    src.start(0, Math.random() * 1.5);
    lfo.start();
    fl.start();
    return { src, gain, lfo, fl };
  }

  // A reaction of the gallery: 'clap' | 'cheer' | 'ooh' | 'groan'; strength 0..1 (how many join
  // in), gain 0..1 (how near the camera is).
  crowdReact(name, strength = 1, gain = 1) {
    if (!this._ready()) return;
    const s = Math.max(0.15, Math.min(1, strength));
    const g = Math.max(0.03, Math.min(1, gain));
    const now = this.ctx.currentTime;
    if (name === 'clap') {
      if (!this._voice(3)) return;
      this._claps(now + 0.15, 1.3 + 1.7 * s, Math.round(30 + 100 * s), 0.075 * g * (0.6 + 0.4 * s));
    } else if (name === 'cheer') {
      if (!this._voice(5)) return;
      // A roar that swells and dies away, a chorus of "yeah", claps and a whistle or two.
      this._noiseBurst(now + 0.08, { freq: 900, q: 0.45, peak: 0.16 * s * g, attack: 0.35, decay: 2.8 + s, offset: 0 });
      this._chorus(now + 0.05, { voices: 10, f: [[720, 1180], [650, 1080]], dur: 2.2 + 0.8 * s, attack: 0.25, rise: 0.12, fall: 0.18, peak: 0.05 * s * g });
      this._claps(now + 0.3, 2.6 + 1.4 * s, Math.round(80 + 120 * s), 0.07 * g);
      const whistles = s > 0.7 ? 2 : 1;
      for (let i = 0; i < whistles; i++) {
        const t = now + 0.45 + i * 0.5 + Math.random() * 0.3;
        this._tone(t, { freq: 2300 + Math.random() * 400, freqEnd: 3100, peak: 0.035 * g, attack: 0.08, decay: 0.5 });
      }
    } else if (name === 'ooh') {
      if (!this._voice(1.6)) return;
      this._chorus(now + 0.02, { voices: 9, f: [[320, 820], [360, 900]], dur: 1.25, attack: 0.12, rise: 0.16, fall: 0.22, peak: 0.075 * s * g });
    } else if (name === 'groan') {
      if (!this._voice(1.8)) return;
      this._chorus(now + 0.04, { voices: 9, f: [[560, 900], [700, 1100]], dur: 1.45, attack: 0.15, rise: 0.02, fall: 0.3, peak: 0.065 * s * g });
    }
  }

  // n golf claps over dur s (dense at first, thinning out like a real round of applause).
  _claps(t0, dur, n, peak) {
    for (let i = 0; i < n; i++) {
      const t = t0 + dur * Math.pow(Math.random(), 1.5);
      this._noiseBurst(t, { freq: 1000 + Math.random() * 2000, q: 1.1, peak: peak * (0.5 + Math.random() * 0.8), attack: 0.001, decay: 0.022 + Math.random() * 0.015 });
    }
    this._noiseBurst(t0, { freq: 1600, q: 0.5, peak: peak * 0.9, attack: 0.2, decay: dur * 0.8, offset: 0 });
  }

  // A chorus of voices on one vowel: detuned saw voices (men and women, staggered onsets, a pitch
  // that rises then falls) through the vowel's two formants f = [[F1, F2] at the start, at the
  // end], softened by a low-pass.
  _chorus(t0, { voices = 8, f, dur, attack, rise, fall, peak }) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const fs = [0, 1].map((k) => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.Q.value = k ? 9 : 5;
      b.frequency.setValueAtTime(f[0][k], t0);
      b.frequency.linearRampToValueAtTime(f[1][k], t0 + dur);
      const bg = ctx.createGain();
      bg.gain.value = k ? 0.55 : 1;
      b.connect(bg);
      bg.connect(lp);
      return b;
    });
    lp.connect(out);
    out.connect(this.master);
    const end = t0 + dur + 0.3;
    for (let i = 0; i < voices; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = (i % 3 === 2 ? 205 : 118) * (0.85 + Math.random() * 0.35);
      const on = t0 + Math.random() * 0.12;
      o.frequency.setValueAtTime(f0 * 0.94, on);
      o.frequency.linearRampToValueAtTime(f0 * (1 + rise), on + dur * 0.35);
      o.frequency.linearRampToValueAtTime(f0 * (1 - fall), on + dur);
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0.0001, on);
      vg.gain.exponentialRampToValueAtTime(peak / Math.sqrt(voices), on + attack);
      vg.gain.setValueAtTime(peak / Math.sqrt(voices), on + dur * 0.45);
      vg.gain.exponentialRampToValueAtTime(0.0001, on + dur);
      o.connect(vg);
      vg.connect(fs[0]);
      vg.connect(fs[1]);
      o.start(on);
      o.stop(end);
    }
    // Breath: a little noise through the same formants.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const ng = ctx.createGain();
    this._env(ng, t0, peak * 0.5, attack, dur);
    src.connect(ng);
    ng.connect(fs[0]);
    ng.connect(fs[1]);
    src.start(t0, Math.random() * 1.5, dur + 0.3);
  }
}
