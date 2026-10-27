// UI: HUD, menus, sheets, scorecard, decision dialog, toasts and settings persistence.
// DOM only - no game logic. main.js drives it; it never reads game state itself.
//
// ---------------------------------------------------------------------------------- UI API
//   const ui = new UI(root = document)
//   ui.on(evt, fn) -> unsubscribe      button events (fn gets no args unless noted):
//       'new-round' 'resume' 'next-hole' 'club-prev' 'club-next' 'read' 'map' 'flyover'
//       'putt-range+' 'putt-range-' 'pause' 'unpause' 'restart' 'quit'
//       'settings-changed' (settings, key)    'decision' (id)    'layout' (mode)
//     The UI hides its own overlay before emitting: new-round/resume hide #menu (and #scorecard,
//     #pause), next-hole hides #scorecard, unpause/restart/quit hide #pause, pause shows #pause.
//     quit also shows #menu with the last canResume; main may call showMenu() again to correct it.
//   ui.layout                         'portrait' | 'landscape' | 'square' (body[data-layout])
//   ui.applyLayout()                  re-measure (automatic on resize / orientation change)
//   ui.padRect                        {x,y,w,h} CSS px, same as InputController.padRect
//
//   ui.showMenu({canResume=false, courseName?, courseSub?}) / ui.hideMenu()
//   ui.showPause({title?}) / ui.hidePause()       ui.showSettings() ui.showHowTo()
//   ui.setLoading(on, text='Loading')             ui.showNoGL()
//   ui.showHud(on=true)
//   ui.setHud({hole, par, yards | lengthM, si, strokes, toPar, distToPin, playsLike, lieLabel,
//              lieSurface?, windSpeed, windRelAngle, units?})   partial updates merge.
//       yards: hole length in yards (number); lengthM: the same in metres (preferred).
//       distToPin, playsLike: metres (numbers) or ready-made strings; playsLike null hides it.
//       Distances under 20 m show in feet (yd mode) via fmtDist(..., {short:true}).
//       toPar: number (0 -> 'E', -2 -> '−2' in red, +3 -> '+3').
//       lieLabel: 'Fairway' | 'Rough · Uphill' | ...; the chip colour comes from lieSurface (a
//       SURF id or name) or else the label's first word.
//       windSpeed: m/s at 10 m. windRelAngle: radians, the wind's direction of travel relative
//       to the camera's view yaw, CCW positive; 0 = blowing straight away from the camera
//       (helping, arrow points up the screen).
//       units: 'yd' | 'm' (defaults to the units setting).
//   ui.setClub({name, carry, total, sub?})       carry/total in metres (numbers) or strings;
//       sub overrides the second line (e.g. 'Range 30 ft' for the putter).
//   ui.setPower({power, overswing, carryText} | null)   live swing gauge; null = idle (hint).
//       power 0..1.1 (above 1 = overswing, drawn red); carryText like '158 yd' or '12 ft'.
//   ui.setHint(text | null)                       pad hint (null = default for full/putt)
//   ui.setControls({phase, putt, canRead, read, map, puttRange})   all optional, merge:
//       phase: game phase; club picker, tools and swing pad show only in 'address'.
//       putt: bool (putt hint, putt range control). canRead: Read button (default = putt).
//       read / map: bool, highlights the tool and hides the swing controls.
//       puttRange: display string, e.g. '30 ft'.
//   ui.showIntro({hole, name, par, yards | lengthM, si}) / ui.hideIntro()   hole lower third
//   ui.toast(text, ms=2600)    'A · B · C' renders A as a bold tab (shot toast format)
//   ui.banner(title, sub='', {tone:'under'|'par'|'over'|'ace', ms=2400})
//   ui.showScorecard(card, {final=false, current, title?, kicker?}) / ui.hideScorecard()
//       card: {holes:[{n?, par, lengthM? | yards?, strokes|null, putts?, fir?: bool|null,
//              gir?: bool|null}]} or the holes array itself. current: 0-based hole to
//       highlight. final shows Play again ([data-act="new-round"]) + Menu ([data-act="quit"])
//       instead of Next hole ([data-act="next-hole"]).
//   ui.showDecision(opts) -> Promise<id>
//       opts: ['drop', 'replay'] or {kicker?, title?, text?, options:[id | {id, label, detail?}]}.
//       The first option is the default (primary). Resolves with the chosen id.
//   ui.settings (copy)  ui.getSetting(k)  ui.setSetting(k, v)  ui.onChange(fn) -> unsubscribe
//       {units:'yd'|'m', wind:'off'|'light'|'breezy', difficulty:'easy'|'normal'|'pro',
//        handed:'R'|'L', sound:bool, quality:'auto'|'low'}  persisted in golf.settings.v1.
//   UI.DEFAULT_SETTINGS
//
// DOM contract (index.html): canvas#gl, #hud (#topbar, #pause-btn, #infocard, #tools, #club,
// #putt-range, #pad, #toast, #banner, #intro, #read-hint), #menu, #pause, #settings, #howto,
// #scorecard, #decision, #loading, #nogl. Values live in [data-f="..."] elements.

import { fmtDist, fmtWind, mToYd, SURF_NAMES } from './constants.js';
import { padRectFor, readSafeInsets, layoutMode } from './input.js';

const SETTINGS_KEY = 'golf.settings.v1';
const DEFAULTS = Object.freeze({ units: 'yd', wind: 'light', difficulty: 'normal', handed: 'R', sound: true, quality: 'auto' });
const CHOICES = {
  units: ['yd', 'm'],
  wind: ['off', 'light', 'breezy'],
  difficulty: ['easy', 'normal', 'pro'],
  handed: ['R', 'L'],
  sound: [true, false],
  quality: ['auto', 'low'],
};
const HINT_FULL = 'Drag down, then swipe up';
const HINT_PUTT = 'Drag down, then release';
const TOAST_MS = 2600;
const TOAST_MAX = 2;

// Power arc geometry (viewBox 240): centre (120,120), r 100, a 240° sweep from lower left (150°)
// clockwise over the top to lower right (30°). pathLength 110: 0..100 is power 0..1, 100..110 is
// the overswing zone.
const ARC_R = 100;
const ARC_START = 150;
const ARC_SWEEP = 240;
const arcPt = (deg, r = ARC_R) => {
  const a = (deg * Math.PI) / 180;
  return [120 + r * Math.cos(a), 120 + r * Math.sin(a)];
};

const DECISION_LABELS = {
  drop: { label: 'Drop', detail: '+1 stroke · relief near where it went in' },
  replay: { label: 'Replay', detail: '+1 stroke · from where you last played' },
};

// Plain, not imported from rules.js, so the shell has no dependency on game modules.
function scoreName(strokes, par) {
  if (strokes === 1) return 'Hole in one!';
  const d = strokes - par;
  return ['Albatross', 'Eagle', 'Birdie', 'Par', 'Bogey', 'Double Bogey', 'Triple Bogey'][d + 3] || (d < -3 ? 'Condor' : `+${d}`);
}

export function fmtToPar(d) {
  if (!d) return 'E';
  return d > 0 ? `+${d}` : `−${-d}`;
}

function surfKey(lieSurface, label) {
  if (typeof lieSurface === 'number') return (SURF_NAMES[lieSurface] || '').split(' ')[0].toLowerCase() || 'fairway';
  if (typeof lieSurface === 'string' && lieSurface) return lieSurface.toLowerCase();
  const w = String(label || '').split(/[\s·]/)[0].toLowerCase();
  if (w === 'sand') return 'bunker';
  if (w === 'out') return 'oob';
  return w || 'fairway';
}

function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') {
      for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(v[k])) s[k] = v[k];
    }
  } catch {
    // private mode / blocked storage: defaults
  }
  return s;
}

export class UI {
  static DEFAULT_SETTINGS = DEFAULTS;

  constructor(root = document) {
    this.doc = root.ownerDocument || root;
    this.root = root;
    const $ = (sel) => root.querySelector(sel);
    this.$ = $;
    this.el = {
      gl: $('#gl'), hud: $('#hud'), menu: $('#menu'), pause: $('#pause'), settings: $('#settings'),
      howto: $('#howto'), scorecard: $('#scorecard'), decision: $('#decision'), loading: $('#loading'),
      nogl: $('#nogl'), pad: $('#pad'), toast: $('#toast'), banner: $('#banner'), intro: $('#intro'),
      windArrow: $('.wind-arrow'), wind: $('.wind'), lie: $('[data-f="lie"]'),
    };
    this.f = {};
    for (const n of root.querySelectorAll('[data-f]')) this.f[n.dataset.f] = n;

    this._handlers = new Map();
    this._settings = loadSettings();
    this._hud = { units: null };
    this._controls = { phase: 'address', putt: false, canRead: null, read: false, map: false };
    this._canResume = false;
    this._decision = null;
    this.padRect = { x: 0, y: 0, w: 1, h: 1 };

    this._buildArc();
    this._syncSettingsUI();
    this.setPower(null);

    root.addEventListener('click', (e) => this._onClick(e));
    this.doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.el.pause.hidden) this._act('unpause');
      else if (!this.el.hud.hidden && this.el.menu.hidden) this._act('pause');
    });
    const relayout = () => this._scheduleLayout();
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    if (globalThis.visualViewport) visualViewport.addEventListener('resize', relayout);
    this.applyLayout();
  }

  // ------------------------------------------------------------------ events
  on(evt, fn) {
    if (!this._handlers.has(evt)) this._handlers.set(evt, new Set());
    this._handlers.get(evt).add(fn);
    return () => this._handlers.get(evt).delete(fn);
  }

  emit(evt, ...args) {
    const hs = this._handlers.get(evt);
    if (!hs) return;
    for (const fn of [...hs]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`ui ${evt} handler`, err);
      }
    }
  }

  _onClick(e) {
    const dec = e.target.closest('[data-dec]');
    if (dec) {
      this._resolveDecision(dec.dataset.dec);
      return;
    }
    const seg = e.target.closest('.seg button');
    if (seg) {
      const key = seg.parentElement.dataset.setting;
      let v = seg.dataset.v;
      if (key === 'sound') v = v === 'on';
      this.setSetting(key, v);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled) this._act(b.dataset.act, b);
  }

  _act(act, btn) {
    switch (act) {
      case 'pause':
        this.showPause();
        break;
      case 'unpause':
      case 'restart':
        this.hidePause();
        break;
      case 'quit':
        this.hidePause();
        this.hideScorecard();
        this.showMenu({ canResume: this._canResume });
        break;
      case 'new-round':
        this.hideMenu();
        this.hideScorecard();
        this.hidePause();
        break;
      case 'resume':
        this.hideMenu();
        break;
      case 'next-hole':
        this.hideScorecard();
        break;
      case 'settings':
        this.showSettings();
        return;
      case 'howto':
        this.showHowTo();
        return;
      case 'close': {
        const ov = btn && btn.closest('.overlay');
        if (ov) ov.hidden = true;
        return;
      }
      default:
        break;
    }
    this.emit(act);
  }

  // ------------------------------------------------------------------ layout
  get layout() {
    return this.doc.body.dataset.layout;
  }

  _scheduleLayout() {
    if (this._layoutRaf) return;
    this._layoutRaf = requestAnimationFrame(() => this.applyLayout());
  }

  applyLayout() {
    this._layoutRaf = 0;
    const c = this.el.gl;
    const w = (c && c.clientWidth) || window.innerWidth;
    const h = (c && c.clientHeight) || window.innerHeight;
    const mode = layoutMode(w, h);
    const body = this.doc.body;
    const changed = body.dataset.layout !== mode;
    if (changed) body.dataset.layout = mode;
    this.setPadRect(padRectFor(w, h, readSafeInsets()));
    if (changed) this.emit('layout', mode);
  }

  // Mirror the swing pad (InputController.padRect) into CSS so the arc and the club picker line
  // up with the touch region. Called by applyLayout; main may call it with input.padRect.
  setPadRect(r) {
    this.padRect = { ...r };
    const s = this.el.hud.style;
    s.setProperty('--pad-x', `${r.x}px`);
    s.setProperty('--pad-y', `${r.y}px`);
    s.setProperty('--pad-w', `${r.w}px`);
    s.setProperty('--pad-h', `${r.h}px`);
    const arc = Math.round(Math.min(r.w * 0.82, r.h * 0.78, 300));
    s.setProperty('--arc', `${arc}px`);
  }

  // ------------------------------------------------------------------ screens
  showMenu({ canResume = false, courseName, courseSub } = {}) {
    this._canResume = !!canResume;
    const resume = this.$('#menu [data-act="resume"]');
    resume.hidden = !canResume;
    if (courseName) this.f.courseName.textContent = courseName;
    if (courseSub) this.f.courseSub.textContent = courseSub;
    this.el.menu.hidden = false;
  }

  hideMenu() {
    this.el.menu.hidden = true;
    this.el.settings.hidden = true;
    this.el.howto.hidden = true;
  }

  showPause({ title } = {}) {
    if (title) this.f.pauseTitle.textContent = title;
    else if (this._hud.hole) this.f.pauseTitle.textContent = `Hole ${this._hud.hole} · Par ${this._hud.par ?? ''}`.trim();
    this.el.pause.hidden = false;
  }

  hidePause() {
    this.el.pause.hidden = true;
    this.el.settings.hidden = true;
    this.el.howto.hidden = true;
  }

  get paused() {
    return !this.el.pause.hidden;
  }

  showSettings() {
    this._syncSettingsUI();
    this.el.settings.hidden = false;
  }

  showHowTo() {
    this.el.howto.hidden = false;
  }

  setLoading(on, text = 'Loading') {
    this.f.loadText.textContent = text;
    this.el.loading.hidden = !on;
  }

  showNoGL() {
    for (const k of ['menu', 'pause', 'loading', 'scorecard', 'decision']) this.el[k].hidden = true;
    this.el.hud.hidden = true;
    this.el.nogl.hidden = false;
  }

  showHud(on = true) {
    this.el.hud.hidden = !on;
  }

  // ------------------------------------------------------------------ HUD
  setHud(p = {}) {
    const h = Object.assign(this._hud, p);
    const units = h.units || this._settings.units;
    const f = this.f;
    if (h.hole != null) f.hole.textContent = h.hole;
    if (h.par != null) f.par.textContent = `Par ${h.par}`;
    if (h.lengthM != null) f.yards.textContent = fmtDist(h.lengthM, units);
    else if (h.yards != null) f.yards.textContent = units === 'm' ? `${Math.round(h.yards * 0.9144)} m` : `${Math.round(h.yards)} yd`;
    if (h.si != null) f.si.textContent = h.si;
    if (h.strokes != null) f.strokes.textContent = h.strokes;
    if (h.toPar != null) {
      f.toPar.textContent = typeof h.toPar === 'number' ? fmtToPar(h.toPar) : h.toPar;
      f.toPar.dataset.sign = typeof h.toPar === 'number' ? String(Math.sign(h.toPar)) : '0';
    }
    if (h.distToPin != null) {
      const s = typeof h.distToPin === 'number' ? fmtDist(h.distToPin, units, { short: true }) : String(h.distToPin);
      const m = s.match(/^([\d.,]+)\s*(.*)$/);
      f.dist.textContent = m ? m[1] : s;
      f.distUnit.textContent = m ? m[2] : '';
    }
    if ('playsLike' in p) {
      const pl = h.playsLike;
      f.playsWrap.hidden = pl == null;
      if (pl != null) f.plays.textContent = typeof pl === 'number' ? fmtDist(pl, units, { short: true }) : pl;
    }
    if (h.lieLabel != null) {
      f.lie.textContent = h.lieLabel;
      f.lie.dataset.surf = surfKey(h.lieSurface, h.lieLabel);
    }
    if (h.windSpeed != null) {
      const calm = h.windSpeed < 0.45;
      f.wind.textContent = calm ? 'Calm' : fmtWind(h.windSpeed, units);
      this.el.wind.dataset.calm = calm ? '1' : '0';
    }
    if (h.windRelAngle != null) {
      // CSS rotates clockwise; yaw is counter-clockwise positive.
      this.el.windArrow.style.transform = `rotate(${(-h.windRelAngle * 180) / Math.PI}deg)`;
    }
  }

  setClub({ name, carry, total, sub } = {}) {
    const units = this._hud.units || this._settings.units;
    const num = (v) => (typeof v === 'number' ? (units === 'm' ? Math.round(v) : Math.round(mToYd(v))) : v);
    if (name != null) this.f.clubName.textContent = name;
    const carryEl = this.f.clubCarry;
    const totalEl = this.f.clubTotal;
    if (sub != null) {
      carryEl.textContent = sub;
      totalEl.textContent = '';
      totalEl.previousElementSibling.hidden = true;
    } else {
      carryEl.textContent = carry != null ? `Carry ${num(carry)}` : '';
      totalEl.textContent = total != null ? `Total ${num(total)} ${units}` : '';
      totalEl.previousElementSibling.hidden = carry == null || total == null;
    }
  }

  setPower(p) {
    const pad = this.el.pad;
    if (!p) {
      pad.dataset.state = 'idle';
      pad.dataset.over = '0';
      this._arcFill.style.strokeDasharray = '0 400';
      this._arcOver.style.strokeDasharray = '0 400';
      return;
    }
    const power = Math.max(0, Math.min(1.1, p.power || 0));
    const over = p.overswing ?? power > 1;
    pad.dataset.state = 'swing';
    pad.dataset.over = over ? '1' : '0';
    this._arcFill.style.strokeDasharray = `${Math.min(power, 1) * 100} 400`;
    this._arcOver.style.strokeDasharray = power > 1 ? `0 100 ${(power - 1) * 100} 400` : '0 400';
    const text = p.carryText || '';
    const m = text.match(/^([\d.,]+)\s*(.*)$/);
    this.f.carryNum.textContent = m ? m[1] : text;
    this.f.carryUnit.textContent = m ? `${m[2]} ${this._controls.putt ? 'roll' : 'carry'}` : '';
    this.f.powerPct.textContent = over ? `Overswing ${Math.round(power * 100)}%` : `${Math.round(power * 100)}%`;
  }

  setHint(text) {
    this._hint = text || null;
    this.f.hint.textContent = this._hint || (this._controls.putt ? HINT_PUTT : HINT_FULL);
  }

  setControls(c = {}) {
    const s = Object.assign(this._controls, c);
    const hud = this.el.hud;
    if (s.phase) hud.dataset.phase = s.phase;
    hud.dataset.putt = s.putt ? '1' : '0';
    hud.dataset.read = s.read ? '1' : '0';
    hud.dataset.map = s.map ? '1' : '0';
    const canRead = s.canRead == null ? s.putt : s.canRead;
    const readBtn = this.$('#tools [data-act="read"]');
    readBtn.style.display = canRead ? 'flex' : 'none';
    readBtn.setAttribute('aria-pressed', s.read ? 'true' : 'false');
    this.$('#tools [data-act="map"]').setAttribute('aria-pressed', s.map ? 'true' : 'false');
    if (s.puttRange != null) this.f.puttRange.textContent = s.puttRange;
    this.$('#read-hint').textContent = s.map ? 'Tap the course to aim there' : 'Drag to look around the green';
    if (s.phase !== 'address') this.setPower(null);
    this.setHint(this._hint);
  }

  showIntro({ hole, name, par, yards, lengthM, si } = {}) {
    const units = this._hud.units || this._settings.units;
    if (hole != null) this.f.introHole.textContent = hole;
    this.f.introName.textContent = name || '';
    if (par != null) this.f.introPar.textContent = `Par ${par}`;
    if (lengthM != null) this.f.introYards.textContent = fmtDist(lengthM, units);
    else if (yards != null) this.f.introYards.textContent = units === 'm' ? `${Math.round(yards * 0.9144)} m` : `${Math.round(yards)} yd`;
    this.f.introSi.textContent = si != null ? `SI ${si}` : '';
    this.el.hud.dataset.intro = '1';
  }

  hideIntro() {
    this.el.hud.dataset.intro = '0';
  }

  toast(text, ms = TOAST_MS) {
    const box = this.el.toast;
    while (box.children.length >= TOAST_MAX) box.firstElementChild.remove();
    const t = this.doc.createElement('div');
    t.className = 'toast';
    const parts = String(text).split(' · ');
    parts.forEach((part, i) => {
      const n = this.doc.createElement(i === 0 && parts.length > 1 ? 'b' : 'span');
      n.textContent = part;
      t.appendChild(n);
    });
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, ms);
    return t;
  }

  banner(title, sub = '', { tone = 'par', ms = 2400 } = {}) {
    const b = this.el.banner;
    b.querySelector('.banner-t').textContent = title;
    b.querySelector('.banner-s').textContent = sub;
    b.dataset.tone = tone;
    b.classList.remove('show', 'out');
    void b.offsetWidth; // restart the entry animation
    b.classList.add('show');
    clearTimeout(this._bannerT);
    clearTimeout(this._bannerT2);
    this._bannerT = setTimeout(() => b.classList.add('out'), Math.max(0, ms - 400));
    this._bannerT2 = setTimeout(() => b.classList.remove('show', 'out'), ms);
  }

  // ------------------------------------------------------------------ scorecard
  showScorecard(card, { final = false, current = null, title, kicker } = {}) {
    const holes = (Array.isArray(card) ? card : (card && card.holes) || []).map((h, i) => ({
      n: h.n ?? i + 1,
      par: h.par ?? 4,
      lengthM: h.lengthM ?? (h.yards != null ? h.yards * 0.9144 : null),
      strokes: h.strokes ?? null,
      putts: h.putts ?? null,
      fir: h.fir ?? null,
      gir: h.gir ?? null,
    }));
    const units = this._hud.units || this._settings.units;
    const played = holes.filter((h) => h.strokes != null);
    const sum = (arr, k) => arr.reduce((a, h) => a + (h[k] || 0), 0);
    const toPar = sum(played, 'strokes') - sum(played, 'par');
    const firHoles = played.filter((h) => h.fir != null);
    const doc = this.doc;

    const table = this.$('#scorecard table.sc');
    table.textContent = '';
    const row = (cls, label, cells, tot) => {
      const tr = doc.createElement('tr');
      tr.className = cls;
      const th = doc.createElement('th');
      th.textContent = label;
      tr.appendChild(th);
      cells.forEach((c, i) => {
        const td = doc.createElement('td');
        if (i === current) td.classList.add('cur');
        if (c && typeof c === 'object') td.appendChild(c);
        else td.textContent = c ?? '';
        tr.appendChild(td);
      });
      const td = doc.createElement('td');
      td.className = 'tot';
      td.textContent = tot ?? '';
      tr.appendChild(td);
      table.appendChild(tr);
    };
    const lengthNum = (m) => (m == null ? '' : Math.round(units === 'm' ? m : mToYd(m)));
    row('r-hole', 'Hole', holes.map((h) => h.n), 'Out');
    row('r-yds', units === 'm' ? 'M' : 'Yds', holes.map((h) => lengthNum(h.lengthM)),
      holes.every((h) => h.lengthM != null) ? lengthNum(sum(holes, 'lengthM')) : '');
    row('r-par', 'Par', holes.map((h) => h.par), sum(holes, 'par'));
    row('r-score', 'Score', holes.map((h) => {
      if (h.strokes == null) return '';
      const d = h.strokes - h.par;
      const mk = doc.createElement('span');
      mk.className = `mk${d <= -2 ? ' circ2' : d === -1 ? ' circ' : d === 1 ? ' sq' : d >= 2 ? ' sq2' : ''}`;
      mk.textContent = h.strokes;
      return mk;
    }), played.length ? sum(played, 'strokes') : '');
    row('r-putts', 'Putts', holes.map((h) => (h.strokes == null ? '' : h.putts ?? '')), played.length ? sum(played, 'putts') : '');

    const last = current != null ? holes[current] : played[played.length - 1];
    this.f.cardKicker.textContent = kicker || (final ? 'Round complete' : this.f.courseName.textContent);
    this.f.cardTitle.textContent =
      title || (final ? `${sum(played, 'strokes')} strokes` : last && last.strokes != null ? `Hole ${last.n} · ${scoreName(last.strokes, last.par)}` : 'Scorecard');
    this.f.cardTotal.textContent = fmtToPar(toPar);
    this.f.cardTotal.dataset.sign = String(Math.sign(toPar));
    this.f.statFir.textContent = `${firHoles.filter((h) => h.fir).length}/${firHoles.length}`;
    this.f.statGir.textContent = `${played.filter((h) => h.gir).length}/${played.length}`;
    this.f.statPutts.textContent = String(sum(played, 'putts'));
    this.el.scorecard.dataset.final = final ? '1' : '0';
    this.el.scorecard.hidden = false;
  }

  hideScorecard() {
    this.el.scorecard.hidden = true;
  }

  // ------------------------------------------------------------------ decision
  showDecision(opts) {
    const o = Array.isArray(opts) ? { options: opts } : opts || {};
    const options = (o.options || ['drop', 'replay']).map((x) => (typeof x === 'string' ? { id: x } : x));
    this.f.decKicker.textContent = o.kicker || 'Penalty · 1 stroke';
    this.f.decTitle.textContent = o.title || 'Ball in the water';
    this.f.decText.textContent = o.text || 'Choose how to take relief.';
    const box = this.$('#decision .dec-opts');
    box.textContent = '';
    options.forEach((op, i) => {
      const d = DECISION_LABELS[op.id] || {};
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = `btn${i === 0 ? ' primary' : ''}`;
      b.dataset.dec = op.id;
      b.textContent = op.label || d.label || op.id;
      const detail = op.detail ?? d.detail;
      if (detail) {
        const sm = this.doc.createElement('small');
        sm.textContent = detail;
        b.appendChild(sm);
      }
      box.appendChild(b);
    });
    if (this._decision) this._decision(null); // a newer dialog supersedes an open one
    this.el.decision.hidden = false;
    return new Promise((resolve) => {
      this._decision = resolve;
    });
  }

  _resolveDecision(id) {
    this.el.decision.hidden = true;
    const r = this._decision;
    this._decision = null;
    if (r) r(id);
    if (id != null) this.emit('decision', id);
  }

  // ------------------------------------------------------------------ settings
  get settings() {
    return { ...this._settings };
  }

  getSetting(k) {
    return this._settings[k];
  }

  setSetting(k, v) {
    if (!(k in CHOICES) || !CHOICES[k].includes(v)) throw new Error(`ui: bad setting ${k}=${v}`);
    if (this._settings[k] === v) return;
    this._settings[k] = v;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings));
    } catch {
      // storage full or blocked: keep the in-memory value
    }
    this._syncSettingsUI();
    if (k === 'units') this.setHud({});
    this.emit('settings-changed', this.settings, k);
  }

  onChange(fn) {
    return this.on('settings-changed', fn);
  }

  _syncSettingsUI() {
    for (const seg of this.root.querySelectorAll('#settings .seg')) {
      const k = seg.dataset.setting;
      const cur = k === 'sound' ? (this._settings.sound ? 'on' : 'off') : this._settings[k];
      for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === cur ? 'true' : 'false');
    }
  }

  // ------------------------------------------------------------------ power arc
  _buildArc() {
    const svg = this.el.pad.querySelector('svg.arc');
    const [x0, y0] = arcPt(ARC_START);
    const [x1, y1] = arcPt(ARC_START + ARC_SWEEP);
    const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${ARC_R} ${ARC_R} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    for (const p of svg.querySelectorAll('path')) p.setAttribute('d', d);
    const ticks = svg.querySelector('.arc-ticks');
    const NS = 'http://www.w3.org/2000/svg';
    // Notches across the track at 25/50/75%, and a longer white mark at full power where the
    // red overswing zone starts.
    for (const pw of [0.25, 0.5, 0.75, 1]) {
      const deg = ARC_START + ARC_SWEEP * ((pw * 100) / 110);
      const [ax, ay] = arcPt(deg, ARC_R - (pw === 1 ? 10 : 5));
      const [bx, by] = arcPt(deg, ARC_R + (pw === 1 ? 10 : 5));
      const ln = this.doc.createElementNS(NS, 'line');
      ln.setAttribute('x1', ax.toFixed(2));
      ln.setAttribute('y1', ay.toFixed(2));
      ln.setAttribute('x2', bx.toFixed(2));
      ln.setAttribute('y2', by.toFixed(2));
      if (pw === 1) ln.setAttribute('class', 'max');
      ticks.appendChild(ln);
    }
    this._arcFill = svg.querySelector('.arc-fill');
    this._arcOver = svg.querySelector('.arc-over');
  }
}

