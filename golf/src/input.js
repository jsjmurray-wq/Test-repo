// Pointer input for the golf canvas: aim drag, swing-pad recording, read-mode orbit, map taps
// and tap-to-skip. Pointer Events only (touch, pen and mouse). Coordinates are CSS px relative to
// the canvas. No UI knowledge: the HUD only mirrors padRect (ui.js imports padRectFor).
//
//   const input = new InputController(canvas, {onAim, onSwingStart, onSwingProgress, onSwing,
//                                              onSwingCancel, onOrbit, onTap, onSkip});
//   input.mode = 'full'|'putt'|'read'|'map'|'intro'|'watch'|'disabled'   (setMode(m) also works)
//   input.padRect -> {x, y, w, h}  (CSS px, canvas-relative)   input.padRefH -> padRect.h
//   input.resize()   recompute padRect (automatic on canvas/window resize)
//   input.destroy()
//
// Gestures by mode
//   full / putt  press in the aim zone (above padRect) and drag horizontally -> onAim(dyaw).
//                Drag right turns the aim right (clockwise from above), so dyaw < 0.
//                press in the swing pad -> onSwingStart({x, y}), then every move
//                onSwingProgress({depth, maxDepth, power, overswing, phase}), and on release
//                onSwing(samples) with samples [{t (ms), x, y}] from pointerdown to pointerup.
//                pointercancel -> onSwingCancel().
//   read         drag anywhere -> onOrbit(dyaw) (grab-the-world: drag right orbits clockwise).
//   map          tap -> onTap(sx, sy); a horizontal drag still aims (onAim) for fine tuning.
//   intro/watch  tap anywhere -> onSkip() (not within SKIP_GUARD_MS of entering the mode).
//   disabled     nothing.
// Only the first pointer is tracked; extra fingers are ignored until it lifts.

import { clamp } from './vec3.js';

// Swing depth (px) for full power, as a fraction of padRefH (see architecture.md section 4).
export const FULL_POWER_FRAC = 0.32;
export const PUTT_POWER_FRAC = 0.3;
export const MAX_POWER = 1.1;

const AIM_RAD_PER_PX = 0.0022; // ~0.13 deg/px for slow, precise drags
const AIM_FAST_PX_S = 900; // drags faster than this get up to 3x gain for big turns
const ORBIT_RAD_PER_PX = 0.007;
const TAP_PX = 10;
const TAP_MS = 350;
const DOWN_SLOP_PX = 6; // finger must climb this far above its lowest point to count as the downswing
// Taps to skip are ignored this long after the input enters 'intro' or 'watch': the second tap of
// a double tap on an overlay button ("Next hole", "Resume") lands on the canvas once the overlay
// has closed, and must not skip the flyover or fast-forward the shot.
export const SKIP_GUARD_MS = 350;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------ pure helpers (unit-tested)

// Layout of the canvas for the swing pad: 'portrait' | 'landscape' | 'square' (same thresholds
// as ui.applyLayout()).
export function layoutMode(w, h) {
  const a = w / Math.max(1, h);
  if (a >= 1.25) return 'landscape';
  if (a <= 0.8) return 'portrait';
  return 'square';
}

// The swing pad for a w x h canvas with safe-area insets {top, right, bottom, left}.
//   portrait / square: the lower 40% of the area above the bottom safe inset, full width.
//   landscape: the lower 72% of the height on the right 40% of the width (a 40% strip along the
//   bottom of a 390 px tall screen leaves too little travel for the backswing).
export function padRectFor(w, h, insets = {}) {
  const sb = insets.bottom || 0;
  const sr = insets.right || 0;
  const usableH = Math.max(1, h - sb);
  if (layoutMode(w, h) === 'landscape') {
    const pw = Math.round(w * 0.4);
    const ph = Math.round(usableH * 0.72);
    return { x: w - sr - pw, y: usableH - ph, w: pw, h: ph };
  }
  const ph = Math.round(usableH * 0.4);
  return { x: 0, y: usableH - ph, w, h: ph };
}

export function inRect(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// Live swing state from the samples so far. The touchdown y is the impact line; depth is how
// far below it the finger is now, maxDepth the bottom of the backswing. Power follows maxDepth so
// the gauge holds the backswing while the finger travels up. phase: 'back' while the finger is
// still at (or near) its lowest point, 'down' once it climbs back up.
export function swingProgress(samples, padRefH, kind = 'full') {
  if (!samples || samples.length === 0) return { depth: 0, maxDepth: 0, power: 0, overswing: false, phase: 'back' };
  const y0 = samples[0].y;
  let maxDepth = 0;
  for (const s of samples) maxDepth = Math.max(maxDepth, s.y - y0);
  const depth = Math.max(0, samples[samples.length - 1].y - y0);
  const frac = kind === 'putt' ? PUTT_POWER_FRAC : FULL_POWER_FRAC;
  const power = clamp(maxDepth / (frac * Math.max(1, padRefH)), 0, MAX_POWER);
  const phase = maxDepth - depth > DOWN_SLOP_PX ? 'down' : 'back';
  return { depth, maxDepth, power, overswing: power > 1, phase };
}

// Aim yaw change for a horizontal drag of dx px over dtMs. Faster drags turn more per pixel.
// Dragging right turns the aim clockwise (yaw is counter-clockwise positive), hence the minus.
export function aimDelta(dx, dtMs) {
  const speed = Math.abs(dx) / Math.max(1, dtMs) * 1000;
  const gain = 1 + 2 * clamp((speed - 150) / AIM_FAST_PX_S, 0, 1);
  return -dx * AIM_RAD_PER_PX * gain;
}

export function orbitDelta(dx) {
  return -dx * ORBIT_RAD_PER_PX;
}

export function isTap(down, up) {
  return Math.hypot(up.x - down.x, up.y - down.y) <= TAP_PX && up.t - down.t <= TAP_MS;
}

// Safe-area insets in CSS px from the --sat/--sar/--sab/--sal tokens set in style.css.
export function readSafeInsets() {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  try {
    const cs = getComputedStyle(document.documentElement);
    out.top = parseFloat(cs.getPropertyValue('--sat')) || 0;
    out.right = parseFloat(cs.getPropertyValue('--sar')) || 0;
    out.bottom = parseFloat(cs.getPropertyValue('--sab')) || 0;
    out.left = parseFloat(cs.getPropertyValue('--sal')) || 0;
  } catch {
    // no DOM (tests) - keep zeros
  }
  return out;
}

const MODES = ['full', 'putt', 'read', 'map', 'intro', 'watch', 'disabled'];
const noop = () => {};

// ------------------------------------------------------------------ controller (DOM)

export class InputController {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.onAim = callbacks.onAim || noop;
    this.onSwingStart = callbacks.onSwingStart || noop;
    this.onSwingProgress = callbacks.onSwingProgress || noop;
    this.onSwing = callbacks.onSwing || noop;
    this.onSwingCancel = callbacks.onSwingCancel || noop;
    this.onOrbit = callbacks.onOrbit || noop;
    this.onTap = callbacks.onTap || noop;
    this.onSkip = callbacks.onSkip || noop;
    this._mode = 'disabled';
    this.padRect = { x: 0, y: 0, w: 1, h: 1 };
    this._g = null; // active gesture {id, kind:'aim'|'swing'|'orbit'|'tap', down, last, samples}
    this._off = [];

    const on = (el, type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      this._off.push(() => el.removeEventListener(type, fn, opts));
    };
    on(canvas, 'pointerdown', (e) => this._down(e));
    on(canvas, 'pointermove', (e) => this._move(e));
    on(canvas, 'pointerup', (e) => this._up(e, false));
    on(canvas, 'pointercancel', (e) => this._up(e, true));
    on(canvas, 'lostpointercapture', (e) => this._up(e, true));
    // iOS: stop long-press magnifier / callout and double-tap zoom on the game surface.
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'touchstart', (e) => e.preventDefault(), { passive: false });
    const onResize = () => this.resize();
    on(window, 'resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(onResize);
      this._ro.observe(canvas);
      this._off.push(() => this._ro.disconnect());
    }
    this.resize();
  }

  get mode() {
    return this._mode;
  }

  set mode(m) {
    this.setMode(m);
  }

  // Changing mode abandons any gesture in progress (a swing being recorded is cancelled).
  setMode(m) {
    if (!MODES.includes(m)) throw new Error(`InputController: unknown mode ${m}`);
    if (m === this._mode) return;
    if (this._g && this._g.kind === 'swing') this.onSwingCancel();
    this._g = null;
    this._mode = m;
    if (m === 'intro' || m === 'watch') this._skipGuard = now() + SKIP_GUARD_MS;
  }

  get padRefH() {
    return this.padRect.h;
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    this.padRect = padRectFor(w, h, readSafeInsets());
  }

  destroy() {
    for (const off of this._off) off();
    this._off = [];
    this._g = null;
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { t: e.timeStamp || performance.now(), x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (this._g || this._mode === 'disabled') return;
    if (e.button !== undefined && e.button > 0) return; // mouse: left button only
    const p = this._pt(e);
    let kind;
    switch (this._mode) {
      case 'full':
      case 'putt':
        kind = inRect(this.padRect, p.x, p.y) ? 'swing' : 'aim';
        break;
      case 'read':
        kind = 'orbit';
        break;
      case 'map':
        kind = 'map';
        break;
      default: // intro / watch
        if (now() < (this._skipGuard || 0)) return; // the tail of a double tap on a closing overlay
        kind = 'tap';
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests have no active pointer
    }
    this._g = { id: e.pointerId, kind, down: p, last: p, samples: [p] };
    if (kind === 'swing') {
      this.onSwingStart({ x: p.x, y: p.y });
      this.onSwingProgress(swingProgress(this._g.samples, this.padRefH, this._mode));
    }
    e.preventDefault();
  }

  _move(e) {
    const g = this._g;
    if (!g || e.pointerId !== g.id) return;
    // Coalesced events give the full 120 Hz touch trace on iOS even when rAF runs at 60 Hz;
    // the swing interpreter needs it for the flick speed and curvature.
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const evs = list && list.length ? list : [e];
    for (const ev of evs) {
      const p = this._pt(ev);
      if (p.t < g.last.t) p.t = g.last.t; // coalesced timestamps can be coarse; keep monotonic
      if (g.kind === 'swing') {
        g.samples.push(p);
      } else if (g.kind === 'aim' || g.kind === 'map') {
        const dx = p.x - g.last.x;
        if (dx !== 0 && (g.kind === 'aim' || Math.abs(p.x - g.down.x) > TAP_PX)) this.onAim(aimDelta(dx, p.t - g.last.t));
      } else if (g.kind === 'orbit') {
        const dx = p.x - g.last.x;
        if (dx !== 0) this.onOrbit(orbitDelta(dx));
      }
      g.last = p;
    }
    if (g.kind === 'swing') this.onSwingProgress(swingProgress(g.samples, this.padRefH, this._mode));
    e.preventDefault();
  }

  _up(e, cancelled) {
    const g = this._g;
    if (!g || e.pointerId !== g.id) return;
    this._g = null;
    const p = this._pt(e);
    if (g.kind === 'swing') {
      if (cancelled) {
        this.onSwingCancel();
        return;
      }
      if (p.t >= g.last.t && (p.x !== g.last.x || p.y !== g.last.y)) g.samples.push(p);
      this.onSwing(g.samples);
    } else if (!cancelled && isTap(g.down, p)) {
      if (g.kind === 'map') this.onTap(p.x, p.y);
      else if (g.kind === 'tap') this.onSkip();
    }
  }
}
