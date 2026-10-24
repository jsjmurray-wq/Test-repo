// Pointer input: aim / fine aim / power / spin / ball-in-hand placement / pocket call.
// Pointer Events only (touch, pen and mouse). Screen units are CSS px relative to the canvas.
//
//   const input = new InputController({canvas, powerEl, spinEl, spinPadEl, fineEl, getView,
//                                      renderer, callbacks});
//   callbacks: onAim(angle), onPower(power), onShoot({angle,power,spin}), onCancel(),
//              onPlace(x,y), onPlaceEnd(x,y), onCallPocket(id), onSpin({x,y}),
//              onSpinPad(open)  (optional, e.g. to pause CPU timers / sound)
//   input.setMode({enabled, ballInHand, cue:{x,y}, mustCallPocket})   (partial updates merge)
//   input.angle / input.power / input.spin   getters + setters (setters do not emit callbacks)
//
// Gestures
//   canvas   drag anywhere: rotate the aim by the change of the pointer's angle around the cue
//            ball's screen position (x0.25 within 60 px of the ball); quick tap aims at the point.
//            Ball in hand: a press within max(36 px, 2.5R) of the cue ball drags it instead.
//            Pocket call: a tap on a pocket (renderer.pocketAtScreen) calls it.
//   #fine    0.05 deg per px; right / up = clockwise on screen. Ribs scroll with the finger.
//   #power   press, drag DOWN to pull back (power = dy / (0.9 * bar height), or the distance left
//            to the screen bottom if that is shorter), release to shoot; back to the top
//            (power <= 0.03) cancels.
//   #spin    opens #spinpad; drag the tip mark (clamped to MAX_TIP); double-tap centres.

import { BALL_R, HL, HW, MAX_TIP } from './constants.js';
import { normalizeAngle, clamp } from './vec.js';

const TAP_MS = 250;
const TAP_PX = 8;
const NEAR_CUE_PX = 60;
const NEAR_DAMP = 0.25;
const FINE_RAD_PER_PX = (0.05 * Math.PI) / 180;
const POCKET_SLOP_PX = 12;
const SHOOT_MIN = 0.03;
const POWER_DEAD_PX = 10; // finger drift on the power bar below this never arms a shot
const DOUBLE_TAP_MS = 320;

function inSpinLabel(s) {
  const parts = [];
  if (s.y > 0.08) parts.push(s.y > 0.3 ? 'Strong follow' : 'Follow');
  else if (s.y < -0.08) parts.push(s.y < -0.3 ? 'Strong draw' : 'Draw');
  if (s.x > 0.08) parts.push('right english');
  else if (s.x < -0.08) parts.push('left english');
  if (!parts.length) return 'Centre ball';
  const t = parts.join(' · ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export class InputController {
  constructor({ canvas, powerEl, spinEl, spinPadEl, fineEl, getView, renderer, callbacks } = {}) {
    this.canvas = canvas;
    this.powerEl = powerEl || null;
    this.spinEl = spinEl || null;
    this.spinPadEl = spinPadEl || null;
    this.fineEl = fineEl || null;
    this.getView = getView || (() => null);
    this.renderer = renderer || null;
    this.cb = callbacks || {};

    this._angle = 0;
    this._power = 0;
    this._spin = { x: 0, y: 0 };
    this.mode = { enabled: true, ballInHand: false, cue: { x: -HL / 2, y: 0 }, mustCallPocket: false };

    this._g = null; // canvas gesture
    this._pg = null; // power gesture
    this._fg = null; // fine-wheel gesture
    this._sg = null; // spin-pad gesture
    this._rib = 0;
    this._lastPadTap = null;
    this._releaseTimer = 0;
    this._listeners = [];

    this._padFace = this.spinPadEl ? this.spinPadEl.querySelector('.spinpad-face') : null;
    this._padLabel = this.spinPadEl ? this.spinPadEl.querySelector('.spinpad-label') : null;
    this._powerTrack = this.powerEl ? this.powerEl.querySelector('.pw-track') || this.powerEl : null;
    this._powerLabel = this.powerEl ? this.powerEl.querySelector('.pw-label') : null;

    const on = (el, type, fn, opts) => {
      if (!el) return;
      const h = fn.bind(this);
      el.addEventListener(type, h, opts);
      this._listeners.push([el, type, h, opts]);
    };
    const nonPassive = { passive: false };

    on(canvas, 'pointerdown', this._down, nonPassive);
    on(canvas, 'pointermove', this._move, nonPassive);
    on(canvas, 'pointerup', this._up);
    on(canvas, 'pointercancel', this._up);
    on(canvas, 'lostpointercapture', this._up);
    on(canvas, 'contextmenu', (e) => e.preventDefault());

    on(this.powerEl, 'pointerdown', this._powerDown, nonPassive);
    on(this.powerEl, 'pointermove', this._powerMove, nonPassive);
    on(this.powerEl, 'pointerup', this._powerUp);
    on(this.powerEl, 'pointercancel', this._powerUp);
    on(this.powerEl, 'lostpointercapture', this._powerUp);

    on(this.fineEl, 'pointerdown', this._fineDown, nonPassive);
    on(this.fineEl, 'pointermove', this._fineMove, nonPassive);
    on(this.fineEl, 'pointerup', this._fineUp);
    on(this.fineEl, 'pointercancel', this._fineUp);
    on(this.fineEl, 'lostpointercapture', this._fineUp);

    on(this.spinEl, 'click', this._spinClick);
    on(this.spinPadEl, 'click', this._padClick);
    on(this._padFace, 'pointerdown', this._padDown, nonPassive);
    on(this._padFace, 'pointermove', this._padMove, nonPassive);
    on(this._padFace, 'pointerup', this._padUp);
    on(this._padFace, 'pointercancel', this._padUp);
    on(this._padFace, 'lostpointercapture', this._padUp);

    this._renderPower();
    this._renderSpin();
    this._renderEnabled();
  }

  destroy() {
    for (const [el, type, h, opts] of this._listeners) el.removeEventListener(type, h, opts);
    this._listeners = [];
    clearTimeout(this._releaseTimer);
  }

  // ------------------------------------------------------------------ public state
  get angle() {
    return this._angle;
  }
  set angle(a) {
    if (Number.isFinite(a)) this._angle = normalizeAngle(a);
  }
  get power() {
    return this._power;
  }
  set power(p) {
    this._power = clamp(+p || 0, 0, 1);
    this._renderPower();
  }
  get spin() {
    return { x: this._spin.x, y: this._spin.y };
  }
  set spin(s) {
    this._spin = this._clampSpin(s && +s.x, s && +s.y);
    this._renderSpin();
  }

  setMode(m = {}) {
    const prevEnabled = this.mode.enabled;
    if (m.enabled !== undefined) this.mode.enabled = !!m.enabled;
    if (m.ballInHand !== undefined) this.mode.ballInHand = !!m.ballInHand;
    if (m.mustCallPocket !== undefined) this.mode.mustCallPocket = !!m.mustCallPocket;
    if (m.cue && Number.isFinite(m.cue.x) && Number.isFinite(m.cue.y)) this.mode.cue = { x: m.cue.x, y: m.cue.y };
    if (prevEnabled && !this.mode.enabled) this.cancelGestures();
    if (!this.mode.ballInHand && this._g && this._g.kind === 'place') this._endPlace(this._g);
    this._renderEnabled();
  }

  // Abort every gesture in progress (e.g. the turn ended). Emits onCancel if the cue was pulled.
  cancelGestures() {
    if (this._g) {
      const g = this._g;
      this._g = null;
      if (g.kind === 'place') this._endPlace(g);
      this._release(this.canvas, g.id);
    }
    if (this._pg) {
      const id = this._pg.id;
      this._pg = null;
      this._release(this.powerEl, id);
      if (this.powerEl) this.powerEl.classList.remove('is-active');
      if (this._power > 0) {
        this.power = 0;
        if (this.cb.onCancel) this.cb.onCancel();
      }
    }
    if (this._fg) {
      const id = this._fg.id;
      this._fg = null;
      this._release(this.fineEl, id);
      if (this.fineEl) this.fineEl.classList.remove('is-active');
    }
    this.closeSpinPad();
  }

  // ------------------------------------------------------------------ helpers
  _release(el, id) {
    try {
      if (el && el.hasPointerCapture && el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      // already released
    }
  }

  _capture(el, id) {
    try {
      el.setPointerCapture(id);
    } catch {
      // synthetic events in tests may not be capturable
    }
  }

  _emitAim() {
    if (this.cb.onAim) this.cb.onAim(this._angle);
  }

  // Rotate the aim by dS radians in SCREEN space (positive = clockwise on screen).
  _rotateScreen(dS, view) {
    if (!dS) return;
    const v = view || this.getView();
    if (v && v.angleToScreen) this._angle = normalizeAngle(v.angleToWorld(v.angleToScreen(this._angle) + dS));
    else this._angle = normalizeAngle(this._angle - dS);
    this._emitAim();
  }

  _renderEnabled() {
    const dis = !this.mode.enabled;
    for (const el of [this.powerEl, this.fineEl, this.spinEl]) if (el) el.classList.toggle('is-disabled', dis);
    if (this.canvas) this.canvas.style.cursor = dis ? 'default' : '';
  }

  // ------------------------------------------------------------------ canvas: aim / place / call
  _down(e) {
    // While the cue is being pulled back the aim is locked: a stray second finger can't swing it.
    if (!this.mode.enabled || this._g || this._pg) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const view = this.getView();
    if (!view) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cue = this.mode.cue;
    const cs = cue ? view.toScreen(cue.x, cue.y) : null;
    const g = { id: e.pointerId, rect, view, x0: sx, y0: sy, x: sx, y: sy, t0: performance.now(), moved: 0, kind: 'aim', cs };

    if (this.mode.ballInHand && cs) {
      const grab = Math.max(36, 2.5 * BALL_R * view.scale);
      if (Math.hypot(sx - cs.x, sy - cs.y) <= grab) {
        g.kind = 'place';
        g.offX = cs.x - sx;
        g.offY = cs.y - sy;
        g.last = { x: cue.x, y: cue.y };
        this.canvas.classList.add('placing');
      }
    }
    if (g.kind === 'aim' && this.mode.mustCallPocket && this.renderer && this.renderer.pocketAtScreen) {
      const id = this.renderer.pocketAtScreen(sx, sy);
      if (id !== null && id !== undefined) {
        g.kind = 'pocket';
        g.pocket = id;
      }
    }
    if (cs) g.prevA = Math.atan2(sy - cs.y, sx - cs.x);
    this._g = g;
    this._capture(this.canvas, e.pointerId);
  }

  _move(e) {
    const g = this._g;
    if (!g || e.pointerId !== g.id) return;
    e.preventDefault();
    const sx = e.clientX - g.rect.left;
    const sy = e.clientY - g.rect.top;
    g.moved = Math.max(g.moved, Math.hypot(sx - g.x0, sy - g.y0));
    g.x = sx;
    g.y = sy;
    if (g.kind === 'place') {
      g.last = this._placeWorld(g, sx, sy);
      if (this.cb.onPlace) this.cb.onPlace(g.last.x, g.last.y);
      return;
    }
    if (g.kind === 'pocket') {
      if (g.moved <= POCKET_SLOP_PX) return;
      g.kind = 'aim'; // turned into a drag: aim from here on
    }
    if (!g.cs) return;
    const dx = sx - g.cs.x;
    const dy = sy - g.cs.y;
    const r = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    const prev = g.prevA;
    g.prevA = a;
    if (r < 4 || prev === undefined) return; // angle is meaningless on top of the ball
    let d = normalizeAngle(a - prev);
    if (r < NEAR_CUE_PX) d *= NEAR_DAMP;
    this._rotateScreen(d, g.view);
  }

  _up(e) {
    const g = this._g;
    if (!g || e.pointerId !== g.id) return;
    this._g = null;
    this._release(this.canvas, g.id);
    const done = e.type === 'pointerup';
    if (g.kind === 'place') {
      this._endPlace(g);
      return;
    }
    if (!done) return;
    if (g.kind === 'pocket') {
      if (this.cb.onCallPocket) this.cb.onCallPocket(g.pocket);
      return;
    }
    const quick = performance.now() - g.t0 < TAP_MS && g.moved < TAP_PX;
    if (quick && g.cs) {
      const dx = g.x0 - g.cs.x;
      const dy = g.y0 - g.cs.y;
      if (Math.hypot(dx, dy) > 6) {
        this._angle = normalizeAngle(g.view.angleToWorld(Math.atan2(dy, dx)));
        this._emitAim();
      }
    }
  }

  _endPlace(g) {
    this.canvas.classList.remove('placing');
    if (g.ended) return;
    g.ended = true;
    const p = g.last || this.mode.cue;
    if (this.cb.onPlaceEnd) this.cb.onPlaceEnd(p.x, p.y);
  }

  _placeWorld(g, sx, sy) {
    const w = g.view.toWorld(sx + g.offX, sy + g.offY);
    return { x: clamp(w.x, -(HL - BALL_R), HL - BALL_R), y: clamp(w.y, -(HW - BALL_R), HW - BALL_R) };
  }

  // ------------------------------------------------------------------ power bar
  _powerDown(e) {
    if (!this.mode.enabled || this._pg) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    // Pulling back locks the aim: end any aim drag still in progress on the table.
    if (this._g && this._g.kind === 'aim') {
      this._release(this.canvas, this._g.id);
      this._g = null;
    }
    // Full power = a pull of 0.9 x bar height after a small dead zone (so a tap that drifts a
    // few pixels never fires). If the finger lands so low that this would run off the bottom of
    // the screen, shrink the travel so 100% stays reachable.
    const h = this._powerTrack.getBoundingClientRect().height;
    const reach = (window.innerHeight || h) - 4 - e.clientY - POWER_DEAD_PX;
    const travel = Math.max(24, Math.min(h * 0.9, reach));
    this._pg = { id: e.pointerId, y0: e.clientY, travel, armed: false };
    clearTimeout(this._releaseTimer);
    this.powerEl.classList.remove('release');
    this.powerEl.classList.add('is-active');
    this._capture(this.powerEl, e.pointerId);
  }

  _powerMove(e) {
    const pg = this._pg;
    if (!pg || e.pointerId !== pg.id) return;
    e.preventDefault();
    const dy = e.clientY - pg.y0;
    if (!pg.armed && dy < POWER_DEAD_PX) return;
    pg.armed = true;
    const p = clamp((dy - POWER_DEAD_PX) / pg.travel, 0, 1);
    if (p === this._power) return;
    this.power = p;
    if (this.cb.onPower) this.cb.onPower(p);
  }

  _powerUp(e) {
    const pg = this._pg;
    if (!pg || e.pointerId !== pg.id) return;
    this._pg = null;
    this._release(this.powerEl, pg.id);
    this.powerEl.classList.remove('is-active');
    const p = this._power;
    if (e.type === 'pointerup' && pg.armed && p > SHOOT_MIN && this.mode.enabled) {
      const shot = { angle: this._angle, power: p, spin: { x: this._spin.x, y: this._spin.y } };
      // Snap the cue forward in the bar.
      this.powerEl.classList.add('release');
      this.power = 0;
      this._releaseTimer = setTimeout(() => this.powerEl.classList.remove('release'), 160);
      if (this.cb.onShoot) this.cb.onShoot(shot);
    } else {
      this.power = 0;
      if (this.cb.onCancel) this.cb.onCancel();
    }
  }

  _renderPower() {
    if (!this.powerEl) return;
    const p = this._power;
    this.powerEl.style.setProperty('--p', p.toFixed(4));
    const pct = Math.round(p * 100);
    this.powerEl.setAttribute('aria-valuenow', String(pct));
    if (this._powerLabel) this._powerLabel.textContent = p > 0 ? `${pct}%` : 'PULL';
  }

  // ------------------------------------------------------------------ fine wheel
  _fineDown(e) {
    if (!this.mode.enabled || this._fg) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const r = this.fineEl.getBoundingClientRect();
    this._fg = { id: e.pointerId, x: e.clientX, y: e.clientY, vertical: r.height > r.width };
    this.fineEl.classList.add('is-active');
    this._capture(this.fineEl, e.pointerId);
  }

  _fineMove(e) {
    const fg = this._fg;
    if (!fg || e.pointerId !== fg.id) return;
    e.preventDefault();
    const dx = e.clientX - fg.x;
    const dy = e.clientY - fg.y;
    fg.x = e.clientX;
    fg.y = e.clientY;
    const along = fg.vertical ? dy : dx; // the ribs follow the finger
    if (!along) return;
    this._rib += along;
    this.fineEl.style.setProperty('--rib', `${this._rib.toFixed(1)}px`);
    const d = fg.vertical ? -dy : dx; // right / up = clockwise
    this._rotateScreen(d * FINE_RAD_PER_PX);
  }

  _fineUp(e) {
    const fg = this._fg;
    if (!fg || e.pointerId !== fg.id) return;
    this._fg = null;
    this._release(this.fineEl, fg.id);
    this.fineEl.classList.remove('is-active');
  }

  // ------------------------------------------------------------------ spin
  _clampSpin(x, y) {
    let sx = Number.isFinite(x) ? x : 0;
    let sy = Number.isFinite(y) ? y : 0;
    const l = Math.hypot(sx, sy);
    if (l > MAX_TIP) {
      sx *= MAX_TIP / l;
      sy *= MAX_TIP / l;
    }
    return { x: sx, y: sy };
  }

  _renderSpin() {
    const { x, y } = this._spin;
    for (const el of [this.spinEl, this._padFace]) {
      if (!el) continue;
      el.style.setProperty('--sx', x.toFixed(4));
      el.style.setProperty('--sy', y.toFixed(4));
    }
    if (this._padLabel) this._padLabel.textContent = inSpinLabel(this._spin);
  }

  _setSpin(x, y) {
    const s = this._clampSpin(x, y);
    if (Math.abs(s.x - this._spin.x) < 1e-5 && Math.abs(s.y - this._spin.y) < 1e-5) return;
    this._spin = s;
    this._renderSpin();
    if (this.cb.onSpin) this.cb.onSpin({ x: s.x, y: s.y });
  }

  get spinPadOpen() {
    return !!this.spinPadEl && this.spinPadEl.classList.contains('open');
  }

  openSpinPad() {
    if (!this.spinPadEl || this.spinPadOpen) return;
    this._renderSpin();
    this.spinPadEl.classList.add('open');
    this.spinPadEl.setAttribute('aria-hidden', 'false');
    if (this.cb.onSpinPad) this.cb.onSpinPad(true);
  }

  closeSpinPad() {
    if (!this.spinPadEl || !this.spinPadOpen) return;
    this.spinPadEl.classList.remove('open');
    this.spinPadEl.setAttribute('aria-hidden', 'true');
    if (this._sg) {
      this._release(this._padFace, this._sg.id);
      this._sg = null;
    }
    if (this._padFace) this._padFace.classList.remove('dragging');
    if (this.cb.onSpinPad) this.cb.onSpinPad(false);
  }

  _spinClick(e) {
    e.preventDefault();
    if (!this.mode.enabled) return;
    this.openSpinPad();
  }

  _padClick(e) {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t) return;
    if (t === this.spinPadEl) return this.closeSpinPad(); // tap outside the card
    const act = t.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'close') this.closeSpinPad();
    else if (act.dataset.act === 'reset') this._setSpin(0, 0);
  }

  _padPoint(e) {
    const r = this._padFace.getBoundingClientRect();
    const R = r.width / 2 || 1;
    return { x: (e.clientX - (r.left + R)) / R, y: -(e.clientY - (r.top + r.height / 2)) / R };
  }

  _padDown(e) {
    if (this._sg) return;
    e.preventDefault();
    const now = performance.now();
    const last = this._lastPadTap;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24) {
      this._lastPadTap = null;
      this._setSpin(0, 0);
      return;
    }
    this._lastPadTap = { t: now, x: e.clientX, y: e.clientY };
    this._sg = { id: e.pointerId };
    this._padFace.classList.add('dragging');
    this._capture(this._padFace, e.pointerId);
    const p = this._padPoint(e);
    this._setSpin(p.x, p.y);
  }

  _padMove(e) {
    const sg = this._sg;
    if (!sg || e.pointerId !== sg.id) return;
    e.preventDefault();
    const p = this._padPoint(e);
    this._setSpin(p.x, p.y);
  }

  _padUp(e) {
    const sg = this._sg;
    if (!sg || e.pointerId !== sg.id) return;
    this._sg = null;
    this._release(this._padFace, sg.id);
    this._padFace.classList.remove('dragging');
  }
}
