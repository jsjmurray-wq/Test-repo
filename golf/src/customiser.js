// Golfer customiser (docs/architecture.md section 9, Customiser): the full-screen "Golfer" screen opened from
// the main menu's Golfer button and from the pause sheet. DOM module. index.html holds the
// skeleton (#customiser: a transparent stage over the game canvas, where main.js draws the live 3D
// preview with the real Renderer, and a control panel); this module builds the controls from
// golfer.js (OPTIONS, palettes, PRESETS), keeps the working look, saves it on Done (golf.golfer.v1
// through golfer.js saveLook, with its in-memory fallback) and turns gestures on the stage into
// the preview camera state (cz.view) that main.js reads every frame.
//
// API
//   const cz = new Customiser(root = document, {onChange(look, key), onClub(id), onTry(), onDone(look),
//                                               onCancel(look), onOpen(), onClose()})   (all optional)
//   cz.open(look = loadLook(), {from: 'menu' | 'pause'})   shows it; body[data-customiser="1"]
//       hides #menu, #hud and #pause underneath (their own hidden state is untouched)
//   cz.close()                 hides it (no callbacks)      cz.isOpen   cz.from
//   cz.look                    the working look (normalized; changes apply live to the preview)
//   cz.saved                   the look it was opened with (Cancel goes back to it)
//   cz.club                    preview club id: 'D' | '7i' | 'SW' | 'P' (PREVIEW_CLUBS)
//   cz.set(partial, {live})    change look fields as the controls do: normalize, refresh, emit
//                              onChange (live: a slider drag, emitted at most every SLIDER_MS)
//   cz.applyPreset(id)  cz.randomise(rng = Math.random)  cz.setClub(id)  cz.setTab(id)
//   cz.done()                  saves (saveLook) -> onDone(look) and closes
//   cz.cancel()                reverts -> onCancel(saved) and closes (also Escape)
//   cz.view                    {yaw, zoom, pitch}: the preview camera, eased by cz.stepView(dt)
//       (allocation-free). yaw: radians round the golfer from face-on (+ toward his target side);
//       zoom: -0.4 wide .. 0 full body .. 1 face; pitch: an offset (radians, + looks down).
//       Drag turns (with inertia), a vertical drag tilts, pinch / wheel zoom, double-tap toggles
//       face / full body; each tab eases to its own framing (Hair & Face: the face).
//   cz.frameRect               {x, y, w, h} CSS px: where the golfer is framed (between the
//                              stage's title and its buttons, inside the safe area; cached)
//   cz.setSwinging(on)         the Try swing buttons show a swing in progress
// Also exported: avatarSVG(look) (a small flat bust in the look's colours), renderAvatars(root,
// look) (fills every [data-golfer-avatar], [data-golfer-name] and [data-golfer-sub]), lookSummary(look),
// PREVIEW_CLUBS, TABS, SLIDER_MS.

import { OPTIONS, OPTION_NAMES, SKIN_TONES, HAIR_COLORS, CLOTH_COLORS, PRESETS, normalizeLook, randomLook, lookKey, hexToRgb, loadLook, saveLook } from './golfer.js';

export const PREVIEW_CLUBS = [
  { id: 'D', name: 'Driver' },
  { id: '7i', name: '7 Iron' },
  { id: 'SW', name: 'Wedge' },
  { id: 'P', name: 'Putter' },
];
// Tabs and the preview framing each one eases to (yaw from face-on, zoom).
export const TABS = [
  { id: 'body', name: 'Body', yaw: 0.5, zoom: 0 },
  { id: 'face', name: 'Hair & Face', yaw: 0.38, zoom: 1 },
  { id: 'clothes', name: 'Clothes', yaw: -0.45, zoom: 0 },
  { id: 'swing', name: 'Swing', yaw: 0.12, zoom: -0.3 },
];
export const SLIDER_MS = 110; // a slider drag rebuilds the preview at most this often
const ZOOM_MIN = -0.4;
const ZOOM_MAX = 1;
const PITCH_MAX = 0.32;

const SWING_INFO = {
  classic: 'Full turn, balanced finish',
  compact: 'Three-quarter backswing, brisk tempo',
  bigfinish: 'High hands, reverse-C finish',
  smooth: 'Unhurried, flowing tempo',
};
// Little swing-arc pictures (viewBox 64 x 40): the hands' path from the top of the backswing
// (left) through the ball (bottom) to the finish (right).
const SWING_ICONS = {
  classic: '<path class="a" d="M14 7C3 20 14 35 32 35S61 20 50 7"/><circle cx="14" cy="7" r="2.6"/><circle cx="50" cy="7" r="2.6"/>',
  compact: '<path class="a" d="M10 18C8 28 18 35 32 35S61 20 50 7"/><circle cx="10" cy="18" r="2.6"/><circle cx="50" cy="7" r="2.6"/>',
  bigfinish: '<path class="a" d="M14 7C3 20 14 35 32 35S62 22 56 3"/><circle cx="14" cy="7" r="2.6"/><circle cx="56" cy="3" r="2.6"/>',
  smooth: '<path class="a s" d="M14 7C3 20 14 35 32 35S61 20 50 7"/><circle cx="14" cy="7" r="2.6"/><circle cx="50" cy="7" r="2.6"/>',
};

const ICON = {
  dice: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.4"/><circle cx="15.5" cy="8.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="8.5" cy="15.5" r="1.4"/><circle cx="15.5" cy="15.5" r="1.4"/></svg>',
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------ avatar
const shade = (hex, k) => {
  const c = hexToRgb(hex);
  const h = (v) => Math.round(clamp(v * k, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
};

// A small flat bust of the look (viewBox 48 x 48; the container rounds and clips it): shirt,
// skin, hair, facial hair, sunglasses and headwear in the look's colours.
export function avatarSVG(look) {
  const L = normalizeLook(look);
  const skin = SKIN_TONES[L.skin].hex;
  const hair = L.hairColor;
  const shirt = L.shirtColor;
  const s2 = L.shirtColor2;
  const hat = L.hatColor;
  const fem = L.body === 'female';
  const p = [];
  // Long hair falls behind the shoulders.
  if (L.hair === 'long') p.push(`<path fill="${shade(hair, 0.85)}" d="M14.6 21C14 10 19 7.6 24 7.6S34 10 33.4 21L35 37.5C31.5 39 28 38 27 34.5H21C20 38 16.5 39 13 37.5Z"/>`);
  // Shirt.
  const w = L.build === 'heavy' ? 2 : L.build === 'slim' ? -1.2 : L.build === 'athletic' ? 1 : 0;
  p.push(`<path fill="${shirt}" d="M${5 - w} 48C${6 - w} 38 ${13 - w * 0.5} 35.4 24 35.4S${42 + w * 0.5} 38 ${43 + w} 48Z"/>`);
  if (L.shirt === 'striped') p.push(`<path fill="${s2}" d="M8.6 40.2h30.8v2.3H8.6zM7.4 45.2h33.2v2.3H7.4z"/>`);
  if (L.shirt === 'vest') p.push(`<path fill="${s2}" d="M18.2 35.6L24 43.4 29.8 35.6Z"/><path fill="${s2}" d="M${5 - w} 48C${5.6 - w} 42 ${7.5 - w} 39.6 10.4 38.2L12 48Z M${43 + w} 48C${42.4 + w} 42 ${40.5 + w} 39.6 37.6 38.2L36 48Z"/>`);
  p.push(`<path fill="none" stroke="${shade(L.shirt === 'vest' ? s2 : shirt, 0.72)}" stroke-width="1.2" stroke-linejoin="round" d="M19.6 35.4L22.2 39.2 24 36.6 25.8 39.2 28.4 35.4"/>`);
  // Neck, ears, head.
  p.push(`<rect x="20.4" y="28.5" width="7.2" height="8.4" rx="2.4" fill="${shade(skin, 0.86)}"/>`);
  p.push(`<ellipse cx="15.9" cy="22" rx="1.7" ry="2.5" fill="${shade(skin, 0.92)}"/><ellipse cx="32.1" cy="22" rx="1.7" ry="2.5" fill="${shade(skin, 0.92)}"/>`);
  p.push(`<ellipse cx="24" cy="21" rx="${fem ? 7.7 : 8.2}" ry="9.8" fill="${skin}"/>`);
  // Brows, eyes, mouth.
  const dark = '#1d1712';
  p.push(`<path fill="none" stroke="${shade(hair, 0.9)}" stroke-width="1.1" stroke-linecap="round" d="M19.2 18.2h3.2M25.6 18.2h3.2"/>`);
  p.push(`<circle cx="20.9" cy="20.7" r="0.95" fill="${dark}"/><circle cx="27.1" cy="20.7" r="0.95" fill="${dark}"/>`);
  p.push(`<path fill="none" stroke="${fem ? '#a44a4a' : shade(skin, 0.6)}" stroke-width="${fem ? 1.3 : 1}" stroke-linecap="round" d="M21.9 26.6Q24 27.6 26.1 26.6"/>`);
  // Facial hair.
  if (L.facialHair === 'stubble') p.push(`<path fill="${hair}" opacity="0.32" d="M16.3 22.5C16.8 29 20 31 24 31S31.2 29 31.7 22.5C30.4 27.4 27.6 28.2 24 28.2S17.6 27.4 16.3 22.5Z"/>`);
  if (L.facialHair === 'beard') p.push(`<path fill="${hair}" d="M15.9 21.5C16 30 19.6 32.6 24 32.6S32 30 32.1 21.5C31 25.8 29.2 27.7 26.8 27.4Q24 26.2 21.2 27.4C18.8 27.7 17 25.8 15.9 21.5Z"/>`);
  if (L.facialHair === 'moustache' || L.facialHair === 'beard') p.push(`<path fill="${hair}" d="M20.4 25.9C22 24.7 23 25 24 25.5 25 25 26 24.7 27.6 25.9 26 26.9 22 26.9 20.4 25.9Z"/>`);
  // Hair on top (a hat covers most of it).
  const topHair = {
    short: 'M15.6 20C15 11 19 8.4 24 8.4S33 11 32.4 20C31 15.4 28 14 24 14.4S17 15.4 15.6 20Z',
    sidepart: 'M15.6 20C15 11 19 8.4 24 8.4S33 11 32.4 20C31.6 16.6 30.4 14.4 28.6 13.6 25.6 15.6 20.4 15.4 15.6 20Z',
    long: 'M15.4 22C15 11 19 8.2 24 8.2S33 11 32.6 22C31.6 16.4 29 14.2 26.6 13.6 23 16 19 15.4 15.4 22Z',
    ponytail: 'M15.6 20C15 11 19 8.4 24 8.4S33 11 32.4 20C31 15.4 28 14 24 14.4S17 15.4 15.6 20Z',
  }[L.hair];
  if (L.hair === 'ponytail') p.push(`<path fill="${shade(hair, 0.85)}" d="M31 14.6C37.6 16.4 37.8 26 34.2 31.6 33.4 27 32.4 22.4 30 18.8Z"/>`);
  if (topHair) p.push(`<path fill="${hair}" d="${topHair}"/>`);
  if (L.hair === 'buzz') p.push(`<path fill="${hair}" opacity="0.62" d="M15.9 19C15.6 11.6 19.4 9.4 24 9.4S32.4 11.6 32.1 19C30.6 15.6 28 14.6 24 14.8S17.4 15.6 15.9 19Z"/>`);
  if (L.hair === 'curly') {
    for (const [x, y, r] of [[17.2, 15.2, 3.2], [20.2, 11.6, 3.4], [24.2, 10.4, 3.6], [28.2, 11.6, 3.4], [31, 15.2, 3.2], [16, 19, 2.4], [32, 19, 2.4], [22.4, 14.2, 2.6], [26.4, 14.2, 2.6]]) {
      p.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${hair}"/>`);
    }
  }
  if (L.hair === 'bald') p.push(`<path fill="none" stroke="${hair}" stroke-width="1.6" stroke-linecap="round" opacity="0.8" d="M16 18.6C15.8 21 16 23 16.6 24.4M32 18.6C32.2 21 32 23 31.4 24.4"/>`);
  // Sunglasses.
  if (L.sunglasses) p.push('<path fill="#14181d" d="M17.8 19.4h5.4v2.6q0 1.9-2.7 1.9t-2.7-1.9zM24.8 19.4h5.4v2.6q0 1.9-2.7 1.9t-2.7-1.9zM23 19.6h2v1h-2z"/>');
  // Headwear.
  const hd = shade(hat, 0.78);
  if (L.headwear === 'cap') {
    p.push(`<path fill="${hat}" d="M15.2 17.6C15 9.4 19.4 6.8 24 6.8S33 9.4 32.8 17.6Z"/><circle cx="24" cy="7.2" r="1.1" fill="${hd}"/>`);
    p.push(`<path fill="${hd}" d="M13.6 17.4C18 15.4 30 15.4 34.4 17.4 33.4 19.4 14.6 19.4 13.6 17.4Z"/>`);
  } else if (L.headwear === 'visor') {
    p.push(`<path fill="${hat}" d="M15.4 14.6h17.2v3.2H15.4z"/><path fill="${hd}" d="M13.6 17.4C18 15.4 30 15.4 34.4 17.4 33.4 19.4 14.6 19.4 13.6 17.4Z"/>`);
  } else if (L.headwear === 'bucket') {
    p.push(`<path fill="${hat}" d="M16 16.4C16 9 19.6 7.4 24 7.4S32 9 32 16.4Z"/><path fill="${hd}" d="M11.2 17.6C14 14.4 34 14.4 36.8 17.6 34.2 19.8 13.8 19.8 11.2 17.6Z"/>`);
  } else if (L.headwear === 'flatcap') {
    p.push(`<path fill="${hat}" d="M14.8 16.6C15.2 10.8 20 9.2 25.2 9.2S33.4 11.4 33.8 15.2L33.4 17.2C27.4 15.6 20.4 16 14.8 16.6Z"/><path fill="${hd}" d="M14.2 16.6C17 15.2 22 15 26 15.4L25.4 17.4C21.4 17 17.4 17.4 14.4 18.2Z"/>`);
  }
  return `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">${p.join('')}</svg>`;
}

// The look's name: a preset's when it is one exactly, else "Custom golfer".
export function lookSummary(look) {
  const L = normalizeLook(look);
  const key = lookKey(L);
  const pre = PRESETS.find((pp) => lookKey(pp.look) === key);
  const swing = OPTION_NAMES.swing[L.swing];
  return { title: pre ? pre.name : 'Custom golfer', sub: `${swing} swing · ${L.height} cm`, preset: pre ? pre.id : null };
}

// Fills every [data-golfer-avatar] (the bust), [data-golfer-name] (a preset's name or "Custom
// golfer") and [data-golfer-sub] ("Classic swing") under root.
export function renderAvatars(root, look) {
  if (!root || !root.querySelectorAll) return;
  const L = normalizeLook(look);
  const svg = avatarSVG(L);
  const s = lookSummary(L);
  for (const el of root.querySelectorAll('[data-golfer-avatar]')) el.innerHTML = svg;
  for (const el of root.querySelectorAll('[data-golfer-name]')) el.textContent = s.title;
  for (const el of root.querySelectorAll('[data-golfer-sub]')) el.textContent = `${OPTION_NAMES.swing[L.swing]} swing`;
}

const fmtHeight = (cm) => {
  const inch = Math.round(cm / 2.54);
  return `${cm} cm · ${Math.floor(inch / 12)}′${inch % 12}″`;
};

// ------------------------------------------------------------------ the screen
export class Customiser {
  constructor(root = document, handlers = {}) {
    this.doc = root.ownerDocument || root;
    this.root = root;
    this.h = handlers;
    const el = root.querySelector('#customiser');
    this.el = {
      root: el,
      stage: el && el.querySelector('.cz-stage'),
      frame: el && el.querySelector('.cz-frame'),
      hint: el && el.querySelector('.cz-hint'),
      kicker: el && el.querySelector('[data-cz-f="kicker"]'),
      title: el && el.querySelector('[data-cz-f="title"]'),
      presets: el && el.querySelector('.cz-presets'),
      tabs: el && el.querySelector('.cz-tabs'),
      panes: el && el.querySelector('.cz-panes'),
      zoom: el && el.querySelector('[data-cz="zoom"]'),
    };
    this.ok = !!(el && this.el.stage && this.el.panes);
    this.isOpen = false;
    this.from = 'menu';
    this.look = normalizeLook(null);
    this.saved = this.look;
    this.club = 'D';
    this.tab = 'body';
    this.swinging = false;
    this.view = { yaw: TABS[0].yaw, zoom: 0, pitch: 0 };
    this._target = { yaw: TABS[0].yaw, zoom: 0, pitch: 0, yawVel: 0, hasYaw: true };
    this.frameRect = { x: 0, y: 0, w: 1, h: 1 };
    this._live = { t: 0, timer: 0, key: null };
    this._ptr = new Map();
    this._drag = null;
    this._lastTap = { t: -1, x: 0, y: 0 };
    this._opener = null;
    this._measureRaf = 0;
    if (!this.ok) return;
    this._build();
    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('input', (e) => this._onInput(e));
    el.addEventListener('change', (e) => this._onInput(e, true));
    this.doc.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
    });
    this._bindStage();
    const remeasure = () => this._scheduleMeasure();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', remeasure);
      window.addEventListener('orientationchange', remeasure);
    }
    if (typeof ResizeObserver !== 'undefined' && this.el.frame) new ResizeObserver(remeasure).observe(this.el.frame);
  }

  // ---------------------------------------------------------------- open / close
  open(look, { from = 'menu' } = {}) {
    if (!this.ok) return;
    this.saved = normalizeLook(look === undefined ? loadLook() : look);
    this.look = { ...this.saved };
    this.from = from;
    this.isOpen = true;
    this._opener = this.doc.activeElement;
    this.setSwinging(false);
    this.el.root.hidden = false;
    this.doc.body.dataset.customiser = '1';
    this.el.root.dataset.from = from;
    this.setTab(this.tab, { snap: true });
    this._sync();
    this._measure();
    // Scroll the selected swatches into view (rows scroll sideways).
    for (const row of this.el.panes.querySelectorAll('.cz-swatches')) this._revealSelected(row);
    const t = this.el.tabs.querySelector('[aria-selected="true"]');
    if (t && t.focus) t.focus({ preventScroll: true });
    if (this.h.onOpen) this.h.onOpen();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearTimeout(this._live.timer);
    this._live.timer = 0;
    this._ptr.clear();
    this._drag = null;
    this.el.root.hidden = true;
    delete this.doc.body.dataset.customiser;
    const o = this._opener;
    this._opener = null;
    if (o && o.focus && this.doc.contains(o)) o.focus({ preventScroll: true });
    if (this.h.onClose) this.h.onClose();
  }

  done() {
    if (!this.isOpen) return;
    this._flushLive();
    const look = normalizeLook(this.look);
    saveLook(look);
    renderAvatars(this.root, look);
    this.close();
    if (this.h.onDone) this.h.onDone(look);
  }

  cancel() {
    if (!this.isOpen) return;
    clearTimeout(this._live.timer);
    this._live.timer = 0;
    this.look = { ...this.saved };
    this.close();
    if (this.h.onCancel) this.h.onCancel(this.saved);
  }

  // ---------------------------------------------------------------- the look
  set(partial, { live = false } = {}) {
    const next = normalizeLook({ ...this.look, ...partial });
    // A female figure has no facial hair; going back to male restores none (normalizeLook).
    const changed = Object.keys(next).filter((k) => next[k] !== this.look[k]);
    if (!changed.length) return;
    this.look = next;
    this._sync();
    const key = changed.length === 1 ? changed[0] : 'look';
    if (live) this._emitLive(key);
    else {
      clearTimeout(this._live.timer);
      this._live.timer = 0;
      this._live.key = null;
      this._emit(key);
    }
  }

  applyPreset(id) {
    const p = PRESETS.find((pp) => pp.id === id);
    if (p) this.set({ ...p.look });
  }

  randomise(rng = Math.random) {
    this.set(randomLook(rng));
  }

  setClub(id) {
    if (!PREVIEW_CLUBS.some((c) => c.id === id) || id === this.club) return;
    this.club = id;
    this._sync();
    if (this.h.onClub) this.h.onClub(id);
  }

  setSwinging(on) {
    this.swinging = !!on;
    if (!this.ok) return;
    for (const b of this.el.root.querySelectorAll('[data-cz="try"]')) {
      b.dataset.busy = on ? '1' : '0';
      b.setAttribute('aria-disabled', on ? 'true' : 'false');
    }
  }

  _emit(key) {
    if (this.h.onChange) this.h.onChange(this.look, key);
  }

  // Slider drags: the label follows at once, the preview at most every SLIDER_MS (trailing).
  _emitLive(key) {
    const lv = this._live;
    lv.key = key;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const wait = SLIDER_MS - (now - lv.t);
    if (wait <= 0) {
      lv.t = now;
      clearTimeout(lv.timer);
      lv.timer = 0;
      lv.key = null;
      this._emit(key);
    } else if (!lv.timer) {
      lv.timer = setTimeout(() => {
        lv.timer = 0;
        lv.t = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (lv.key && this.isOpen) this._emit(lv.key);
        lv.key = null;
      }, wait);
    }
  }

  _flushLive() {
    const lv = this._live;
    if (lv.timer) {
      clearTimeout(lv.timer);
      lv.timer = 0;
      if (lv.key) this._emit(lv.key);
      lv.key = null;
    }
  }

  // ---------------------------------------------------------------- tabs and view
  setTab(id, { snap = false } = {}) {
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    this.tab = tab.id;
    for (const b of this.el.tabs.querySelectorAll('[data-cz-tab]')) {
      const on = b.dataset.czTab === tab.id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of this.el.panes.querySelectorAll('[data-cz-pane]')) p.hidden = p.dataset.czPane !== tab.id;
    this.el.root.dataset.tab = tab.id;
    const T = this._target;
    T.yaw = tab.yaw;
    T.hasYaw = true;
    T.yawVel = 0;
    T.zoom = tab.zoom;
    T.pitch = 0;
    if (snap) {
      this.view.yaw = tab.yaw;
      this.view.zoom = tab.zoom;
      this.view.pitch = 0;
    }
    this._syncZoomBtn();
    const pane = this.el.panes.querySelector(`[data-cz-pane="${tab.id}"]`);
    if (pane) {
      pane.scrollTop = 0;
      for (const row of pane.querySelectorAll('.cz-swatches')) this._revealSelected(row);
    }
  }

  // Eases the preview camera toward its targets (and coasts after a flick). Allocation-free.
  stepView(dt) {
    const v = this.view;
    const T = this._target;
    const k = 1 - Math.exp(-7 * dt);
    if (!this._drag) {
      if (T.hasYaw) {
        // The shorter way round.
        let d = T.yaw - v.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.yaw += d * k;
        if (Math.abs(d) < 1e-4) T.hasYaw = false;
      } else if (T.yawVel) {
        v.yaw += T.yawVel * dt;
        T.yawVel *= Math.exp(-3.2 * dt);
        if (Math.abs(T.yawVel) < 0.01) T.yawVel = 0;
      }
    }
    v.zoom += (T.zoom - v.zoom) * k;
    v.pitch += (T.pitch - v.pitch) * k;
    return v;
  }

  zoomTo(z) {
    this._target.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
    this._syncZoomBtn();
  }

  turn(dyaw) {
    const T = this._target;
    T.yaw = (T.hasYaw ? T.yaw : this.view.yaw) + dyaw;
    T.hasYaw = true;
    T.yawVel = 0;
  }

  _syncZoomBtn() {
    const b = this.el.zoom;
    if (!b) return;
    const face = this._target.zoom > 0.5;
    b.setAttribute('aria-pressed', face ? 'true' : 'false');
    b.setAttribute('aria-label', face ? 'Show full body' : 'Zoom to face');
  }

  _scheduleMeasure() {
    if (!this.isOpen || this._measureRaf) return;
    this._measureRaf = requestAnimationFrame(() => {
      this._measureRaf = 0;
      this._measure();
    });
  }

  _measure() {
    const f = this.el.frame;
    if (!f) return;
    const r = f.getBoundingClientRect();
    const fr = this.frameRect;
    fr.x = r.left;
    fr.y = r.top;
    fr.w = Math.max(1, r.width);
    fr.h = Math.max(1, r.height);
  }

  // ---------------------------------------------------------------- gestures on the stage
  _bindStage() {
    const st = this.el.stage;
    const ptr = this._ptr;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const pinchDist = () => {
      const [a, b] = [...ptr.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };
    st.addEventListener('pointerdown', (e) => {
      if (!this.isOpen || e.target.closest('button')) return;
      try {
        st.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers */
      }
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const T = this._target;
      T.hasYaw = false;
      T.yawVel = 0;
      if (ptr.size === 1) {
        // Double tap: face <-> full body (timed on the events' own clock).
        const t = e.timeStamp || now();
        const lt = this._lastTap;
        if (t - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 40) {
          this.zoomTo(this._target.zoom > 0.5 ? 0 : 1);
          lt.t = -1;
        } else {
          lt.t = t;
          lt.x = e.clientX;
          lt.y = e.clientY;
        }
        this._drag = { x: e.clientX, y: e.clientY, t, vx: 0, moved: 0, pinch: 0, zoom0: this._target.zoom };
      } else if (ptr.size === 2 && this._drag) {
        this._drag.pinch = pinchDist();
        this._drag.zoom0 = this._target.zoom;
      }
    });
    const move = (e) => {
      const p = ptr.get(e.pointerId);
      const d = this._drag;
      if (!p || !d) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (ptr.size >= 2 && d.pinch) {
        this.zoomTo(d.zoom0 + Math.log(pinchDist() / d.pinch) * 1.7);
        return;
      }
      const t = e.timeStamp || now();
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      const dyaw = -dx * 0.011;
      this.view.yaw += dyaw;
      const dtS = Math.max(0.008, (t - d.t) / 1000);
      d.vx = d.vx * 0.5 + (dyaw / dtS) * 0.5;
      const T = this._target;
      T.pitch = clamp(T.pitch + dy * 0.003, -PITCH_MAX, PITCH_MAX);
      this.view.pitch = T.pitch;
      d.x = e.clientX;
      d.y = e.clientY;
      d.t = t;
      if (d.moved > 12 && this.el.hint) this.el.hint.dataset.done = '1';
    };
    const up = (e) => {
      if (!ptr.has(e.pointerId)) return;
      ptr.delete(e.pointerId);
      const d = this._drag;
      if (ptr.size === 0) {
        if (d && !d.pinch && (e.timeStamp || now()) - d.t < 90) this._target.yawVel = clamp(d.vx, -9, 9);
        this._drag = null;
      } else if (d) {
        // Pinch over: carry on dragging with the finger that is left.
        const [q] = [...ptr.values()];
        d.x = q.x;
        d.y = q.y;
        d.pinch = 0;
        d.vx = 0;
      }
    };
    st.addEventListener('pointermove', move);
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener('lostpointercapture', up);
    st.addEventListener(
      'wheel',
      (e) => {
        if (!this.isOpen) return;
        e.preventDefault();
        this.zoomTo(this._target.zoom - e.deltaY * 0.0022);
      },
      { passive: false },
    );
    // Arrow keys turn the golfer while the stage has focus.
    st.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.turn(-Math.PI / 6);
      else if (e.key === 'ArrowRight') this.turn(Math.PI / 6);
      else return;
      e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- events
  _onClick(e) {
    const t = e.target;
    const btn = t.closest('button');
    if (!btn || !this.el.root.contains(btn)) return;
    const act = btn.dataset.cz;
    if (act) {
      switch (act) {
        case 'done':
          this.done();
          break;
        case 'cancel':
          this.cancel();
          break;
        case 'try':
          if (!this.swinging && this.h.onTry) this.h.onTry();
          break;
        case 'zoom':
          this.zoomTo(this._target.zoom > 0.5 ? (this.tab === 'swing' ? TABS[3].zoom : 0) : 1);
          break;
        case 'turn-l':
          this.turn(-Math.PI / 4);
          break;
        case 'turn-r':
          this.turn(Math.PI / 4);
          break;
        case 'random':
          this.randomise();
          break;
        default:
          break;
      }
      return;
    }
    if (btn.dataset.czTab) {
      this.setTab(btn.dataset.czTab);
      return;
    }
    if (btn.dataset.czPreset) {
      this.applyPreset(btn.dataset.czPreset);
      return;
    }
    if (btn.dataset.czClub) {
      this.setClub(btn.dataset.czClub);
      return;
    }
    const key = btn.dataset.czKey;
    if (key) {
      let v = btn.dataset.czVal;
      if (key === 'skin') v = Number(v);
      else if (key === 'sunglasses') v = v === 'true';
      this.set({ [key]: v });
      // A new swing style plays at once.
      if (key === 'swing' && this.h.onTry) this.h.onTry();
    }
  }

  _onInput(e, final = false) {
    const inp = e.target;
    if (!inp || inp.type !== 'range' || !inp.dataset.czKey) return;
    const key = inp.dataset.czKey;
    const n = Number(inp.value);
    const v = key === 'build' ? OPTIONS.build[clamp(Math.round(n), 0, 3)] : n;
    if (final) {
      this.set({ [key]: v });
      this._flushLive();
    } else this.set({ [key]: v }, { live: true });
  }

  // Tabs: arrow keys move between them (WAI-ARIA tabs pattern).
  _onTabKey(e) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
    if (j < 0) return;
    e.preventDefault();
    this.setTab(TABS[j].id);
    const b = this.el.tabs.querySelector(`[data-cz-tab="${TABS[j].id}"]`);
    if (b) b.focus();
  }

  // ---------------------------------------------------------------- building the controls
  _build() {
    const doc = this.doc;
    const mk = (tag, cls, attrs = {}) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else n.setAttribute(k, v);
      }
      return n;
    };
    // Presets row: Randomise, then the eight presets with a little bust each.
    const pr = this.el.presets;
    pr.textContent = '';
    const rnd = mk('button', 'cz-preset cz-random', { type: 'button', 'data-cz': 'random', 'aria-label': 'Randomise the golfer' });
    rnd.innerHTML = `<span class="cz-av cz-dice">${ICON.dice}</span><span>Random</span>`;
    pr.appendChild(rnd);
    for (const p of PRESETS) {
      const b = mk('button', 'cz-preset', { type: 'button', 'data-cz-preset': p.id, 'aria-pressed': 'false' });
      b.innerHTML = `<span class="cz-av">${avatarSVG(p.look)}</span><span>${p.name}</span>`;
      pr.appendChild(b);
    }
    // Tabs.
    const tabs = this.el.tabs;
    tabs.textContent = '';
    for (const t of TABS) {
      const b = mk('button', 'cz-tab', { type: 'button', role: 'tab', id: `cz-tab-${t.id}`, 'aria-controls': `cz-pane-${t.id}`, 'aria-selected': 'false', 'data-cz-tab': t.id, text: t.name });
      tabs.appendChild(b);
    }
    tabs.addEventListener('keydown', (e) => this._onTabKey(e));
    // Panes.
    const panes = this.el.panes;
    panes.textContent = '';
    const pane = (id) => {
      const p = mk('div', 'cz-pane', { role: 'tabpanel', id: `cz-pane-${id}`, 'aria-labelledby': `cz-tab-${id}`, 'data-cz-pane': id, tabindex: '0' });
      panes.appendChild(p);
      return p;
    };
    const row = (parent, label, key, { value = false } = {}) => {
      const r = mk('div', 'cz-row', { 'data-cz-row': key });
      const head = mk('div', 'cz-row-head');
      const lab = mk('span', 'cz-label', { id: `cz-l-${key}`, text: label, 'data-cz-label': key });
      head.appendChild(lab);
      if (value) head.appendChild(mk('span', 'cz-value', { 'data-cz-value': key }));
      r.appendChild(head);
      parent.appendChild(r);
      return r;
    };
    const chips = (parent, key, list, names, { cls = '' } = {}) => {
      const box = mk('div', `cz-chips ${cls}`.trim(), { role: 'radiogroup', 'aria-labelledby': `cz-l-${key}` });
      for (const v of list) {
        box.appendChild(mk('button', 'cz-chip', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-cz-key': key, 'data-cz-val': String(v), text: names[v] }));
      }
      parent.appendChild(box);
      return box;
    };
    const swatches = (parent, key, palette, { values, fit = false } = {}) => {
      const box = mk('div', fit ? 'cz-swatches cz-fit' : 'cz-swatches', { role: 'radiogroup', 'aria-labelledby': `cz-l-${key}` });
      palette.forEach((c, i) => {
        const b = mk('button', 'cz-sw', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': c.name, title: c.name, 'data-cz-key': key, 'data-cz-val': values ? String(values[i]) : c.hex });
        b.style.setProperty('--c', c.hex);
        if (hexToRgb(c.hex).reduce((a, x) => a + x, 0) > 2.55) b.dataset.light = '1';
        box.appendChild(b);
      });
      parent.appendChild(box);
      return box;
    };
    const N = OPTION_NAMES;

    // Body.
    const body = pane('body');
    chips(row(body, 'Figure', 'body'), 'body', OPTIONS.body, N.body, { cls: 'cz-seg' });
    swatches(row(body, 'Skin tone', 'skin', { value: true }), 'skin', SKIN_TONES, { values: SKIN_TONES.map((_, i) => i), fit: true });
    {
      const r = row(body, 'Height', 'height', { value: true });
      const s = mk('input', 'cz-range', { type: 'range', min: String(OPTIONS.height[0]), max: String(OPTIONS.height[1]), step: '1', 'data-cz-key': 'height', 'aria-labelledby': 'cz-l-height' });
      r.appendChild(s);
      const ends = mk('div', 'cz-range-ends', { 'aria-hidden': 'true' });
      ends.append(mk('span', '', { text: fmtHeight(OPTIONS.height[0]).split(' · ')[1] }), mk('span', '', { text: fmtHeight(OPTIONS.height[1]).split(' · ')[1] }));
      r.appendChild(ends);
    }
    {
      const r = row(body, 'Build', 'build', { value: true });
      const s = mk('input', 'cz-range cz-steps', { type: 'range', min: '0', max: String(OPTIONS.build.length - 1), step: '1', 'data-cz-key': 'build', 'aria-labelledby': 'cz-l-build' });
      r.appendChild(s);
      const stops = mk('div', 'cz-stops');
      for (const b of OPTIONS.build) stops.appendChild(mk('button', 'cz-stop', { type: 'button', 'data-cz-key': 'build', 'data-cz-val': b, tabindex: '-1', text: N.build[b] }));
      r.appendChild(stops);
    }

    // Hair & face.
    const face = pane('face');
    chips(row(face, 'Hairstyle', 'hair'), 'hair', OPTIONS.hair, N.hair);
    swatches(row(face, 'Hair colour', 'hairColor', { value: true }), 'hairColor', HAIR_COLORS);
    chips(row(face, 'Facial hair', 'facialHair'), 'facialHair', OPTIONS.facialHair, N.facialHair);
    chips(row(face, 'Sunglasses', 'sunglasses'), 'sunglasses', [false, true], { false: 'None', true: 'Sunglasses' }, { cls: 'cz-seg' });

    // Clothes.
    const cl = pane('clothes');
    chips(row(cl, 'Headwear', 'headwear'), 'headwear', OPTIONS.headwear, N.headwear);
    swatches(row(cl, 'Hat colour', 'hatColor', { value: true }), 'hatColor', CLOTH_COLORS);
    chips(row(cl, 'Shirt', 'shirt'), 'shirt', OPTIONS.shirt, N.shirt);
    swatches(row(cl, 'Shirt colour', 'shirtColor', { value: true }), 'shirtColor', CLOTH_COLORS);
    swatches(row(cl, 'Stripe colour', 'shirtColor2', { value: true }), 'shirtColor2', CLOTH_COLORS);
    chips(row(cl, 'Legs', 'legwear'), 'legwear', OPTIONS.legwear, N.legwear, { cls: 'cz-seg' });
    swatches(row(cl, 'Trousers colour', 'legColor', { value: true }), 'legColor', CLOTH_COLORS);
    swatches(row(cl, 'Shoes', 'shoeColor', { value: true }), 'shoeColor', CLOTH_COLORS);
    swatches(row(cl, 'Glove', 'gloveColor', { value: true }), 'gloveColor', CLOTH_COLORS);

    // Swing.
    const sw = pane('swing');
    {
      const r = row(sw, 'Swing style', 'swing');
      const box = mk('div', 'cz-styles', { role: 'radiogroup', 'aria-labelledby': 'cz-l-swing' });
      for (const s of OPTIONS.swing) {
        const b = mk('button', 'cz-style', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-cz-key': 'swing', 'data-cz-val': s });
        b.innerHTML = `<svg viewBox="0 0 64 40" aria-hidden="true">${SWING_ICONS[s]}</svg><b>${N.swing[s]}</b><small>${SWING_INFO[s]}</small>`;
        box.appendChild(b);
      }
      r.appendChild(box);
    }
    {
      const r = row(sw, 'Preview club', 'club');
      const box = mk('div', 'cz-chips cz-seg', { role: 'radiogroup', 'aria-labelledby': 'cz-l-club' });
      for (const c of PREVIEW_CLUBS) box.appendChild(mk('button', 'cz-chip', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-cz-club': c.id, text: c.name }));
      r.appendChild(box);
    }
    {
      const r = mk('div', 'cz-row cz-try-row');
      const b = mk('button', 'btn cz-try-btn', { type: 'button', 'data-cz': 'try' });
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>Try swing</span>';
      r.appendChild(b);
      r.appendChild(mk('p', 'cz-note', { text: 'Swing style changes how your golfer looks, never how far or straight the ball goes.' }));
      sw.appendChild(r);
    }
  }

  // Every control's state from this.look (aria-checked, values, which rows apply).
  _sync() {
    const L = this.look;
    const root = this.el.root;
    for (const b of root.querySelectorAll('[data-cz-key][data-cz-val]')) {
      const k = b.dataset.czKey;
      const on = String(L[k]) === b.dataset.czVal;
      if (b.getAttribute('role') === 'radio') b.setAttribute('aria-checked', on ? 'true' : 'false');
      else b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const b of root.querySelectorAll('[data-cz-club]')) b.setAttribute('aria-checked', b.dataset.czClub === this.club ? 'true' : 'false');
    for (const s of root.querySelectorAll('input[type="range"][data-cz-key]')) {
      const k = s.dataset.czKey;
      const v = k === 'build' ? OPTIONS.build.indexOf(L.build) : L[k];
      if (Number(s.value) !== v) s.value = String(v);
      const text = k === 'height' ? fmtHeight(L.height) : OPTION_NAMES.build[L.build];
      s.setAttribute('aria-valuetext', text);
      const min = Number(s.min);
      const max = Number(s.max);
      s.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    }
    const val = (k, text) => {
      const n = root.querySelector(`[data-cz-value="${k}"]`);
      if (n) n.textContent = text;
    };
    const colorName = (hex, pal) => (pal.find((c) => c.hex === hex) || { name: '' }).name;
    val('skin', SKIN_TONES[L.skin].name);
    val('height', fmtHeight(L.height));
    val('build', OPTION_NAMES.build[L.build]);
    val('hairColor', colorName(L.hairColor, HAIR_COLORS));
    for (const k of ['hatColor', 'shirtColor', 'shirtColor2', 'legColor', 'shoeColor', 'gloveColor']) val(k, colorName(L[k], CLOTH_COLORS));
    // Rows that only apply to some looks.
    const show = (k, on) => {
      const r = root.querySelector(`[data-cz-row="${k}"]`);
      if (r) r.hidden = !on;
    };
    show('facialHair', L.body !== 'female');
    show('hatColor', L.headwear !== 'none');
    show('shirtColor2', L.shirt !== 'polo');
    const lab = (k, text) => {
      const n = root.querySelector(`[data-cz-label="${k}"]`);
      if (n) n.textContent = text;
    };
    lab('shirtColor2', L.shirt === 'vest' ? 'Polo underneath' : 'Stripe colour');
    lab('shirtColor', L.shirt === 'vest' ? 'Vest colour' : 'Shirt colour');
    lab('legColor', L.legwear === 'shorts' ? 'Shorts colour' : 'Trousers colour');
    // Header and presets.
    const s = lookSummary(L);
    if (this.el.title) this.el.title.textContent = s.title;
    if (this.el.kicker) this.el.kicker.textContent = `${OPTION_NAMES.swing[L.swing]} swing · ${L.height} cm`;
    for (const b of this.el.presets.querySelectorAll('[data-cz-preset]')) b.setAttribute('aria-pressed', b.dataset.czPreset === s.preset ? 'true' : 'false');
  }

  // Scrolls a swatch row sideways so its selected swatch is in view (no vertical scrolling).
  _revealSelected(row) {
    const sel = row.querySelector('[aria-checked="true"]');
    if (!sel || !row.clientWidth) return;
    const left = sel.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft + 8 || left + sel.offsetWidth > row.scrollLeft + row.clientWidth - 8) row.scrollLeft = Math.max(0, left - row.clientWidth / 2 + sel.offsetWidth / 2);
  }
}
