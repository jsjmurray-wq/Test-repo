// UI: HUD, menus, sheets, scorecard, decision dialog, toasts and settings persistence.
// DOM only - no game logic. main.js drives it; it never reads game state itself.
//
// ---------------------------------------------------------------------------------- UI API
//   const ui = new UI(root = document)
//   ui.on(evt, fn) -> unsubscribe      button events (fn gets no args unless noted):
//       'new-round' 'resume' 'next-hole' 'club-prev' 'club-next' 'read' 'map' 'flyover'
//       'putt-range+' 'putt-range-' 'pause' 'unpause' 'restart' 'quit' 'shots' 'shots-closed'
//       'settings-changed' (settings, key)    'decision' (id)    'layout' (mode)
//       'course' (id: a course card was picked)   'shot' (id: a shot was picked in the sheet)
//       'golfer' (the Golfer button on the menu or the pause sheet: main opens customiser.js;
//                 while it is open body[data-customiser="1"] and Escape is the customiser's)
//     The UI hides its own overlay before emitting: new-round/resume hide #menu (and #scorecard,
//     #pause), next-hole hides #scorecard, unpause/restart/quit hide #pause, pause shows #pause.
//     quit also shows #menu with the last canResume; main may call showMenu() again to correct it.
//   ui.layout                         'portrait' | 'landscape' | 'square' (body[data-layout])
//   ui.applyLayout()                  re-measure (automatic on resize / orientation change)
//   ui.padRect                        {x,y,w,h} CSS px, same as InputController.padRect
//
//   ui.showMenu({canResume=false, courseName?, courseSub?, courses?, selected?, resumeSub?}) /
//       ui.hideMenu()
//       courses: [{id, name, tagline, theme, par, lengthM, holes?, mixed?, best?: {strokes, toPar}|null}]
//       builds the course picker (cards with a theme-gradient thumbnail, name, tagline, par and
//       length, best round); selected: the highlighted id (its name and par fill the title). A
//       card tap selects it and emits 'course' (id). resumeSub: small line under Resume round.
//       The mixed entries (random holes from every course: mixed true, lengthM null; 'mixed' with
//       9 holes, 'mixed18' with 18) share one wide card ([data-course="mixed"]) under the others,
//       with a four-theme thumbnail, "Par 36 · New holes every round" and a "9 holes | 18 holes"
//       switch ([data-mix="mixed" | "mixed18"]); a tap on it selects that size and emits 'course'
//       with its id, a tap on the card selects the size picked last. A mixed best reads "Best +3".
//   ui.selectedCourse                 id of the highlighted course (a mixed card: 'mixed' | 'mixed18')
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
//   ui.setPower({power, overswing, full?, carryText, target?} | null)   live swing gauge;
//       null = idle (hint). power 0..1.1 (above 1 = overswing, drawn red); full: in the full-power
//       detent (the 100% tick lights up); carryText like '158 yd' or '12 ft'. target (optional,
//       0..1.1 or null) moves the target notch, see setTarget; the notch glows and the readout
//       says "On target" while the power is within TARGET_GLOW (3%) of the full-power travel of it
//       (input.js onTarget: the same width under the thumb anywhere on the arc).
//   ui.setTarget(power | null)   the target notch on the arc (the power that reaches the pin or
//       the aim point, from main.js); it shows dimmed while idle too. null hides it.
//   ui.setHint(text | null)                       pad hint (null = default for full/putt and the
//       swing control: swipe 'Drag down, then swipe up', tap 'Tap to start · tap again to hit')
//   ui.setControls({phase, putt, canRead, read, map, puttRange})   all optional, merge:
//       phase: game phase; club picker, tools and swing pad show only in 'address'.
//       putt: bool (putt hint, putt range control). canRead: Read button (default = putt).
//       read / map: bool, highlights the tool and hides the swing controls.
//       puttRange: display string, e.g. '30 ft'.
//   ui.showIntro({hole, name, par, yards | lengthM, si, course?}) / ui.hideIntro()   hole lower
//       third; course: the course name above the hole name
//   ui.setShot({id, name, special?, show?})   the shot chip beside the club picker ('Shot ·
//       Normal ▾'): special (a special shot is selected) tints it gold; show false hides it
//       (putts). Tapping it emits 'shots'; main answers with showShots.
//   ui.showShots({shots:[{id, name, blurb, carry?, total?}], current, handed, kicker}) /
//       ui.hideShots() / ui.shotsOpen   the shot sheet: one row per eligible shot with a tiny
//       flight-shape icon (side view; draw and cut seen from above, mirrored for a left-hander),
//       its blurb and carry/total (m). A pick hides the sheet and emits 'shot' (id); closing it
//       (x, or a tap outside the panel) emits 'shots-closed'.
//   ui.toast(text, ms=2600)    'A · B · C' renders A as a bold tab (shot toast format)
//   ui.banner(title, sub='', {tone:'under'|'par'|'over'|'ace', ms=2400})
//   ui.showScorecard(card, {final=false, current, title?, kicker?, course?}) / ui.hideScorecard()
//       The header's first line is the course name (course, else card.course), then the kicker.
//       card: {holes:[{n?, par, lengthM? | yards?, strokes|null, putts?, fir?: bool|null,
//              gir?: bool|null, from?: {name, theme, n}}]} or the holes array itself. Holes with
//              from (a mixed round) get a Course row: a theme-coloured chip with the course's
//              initial per hole. current: 0-based hole to
//       highlight. final shows Play again ([data-act="new-round"]) + Menu ([data-act="quit"])
//       instead of Next hole ([data-act="next-hole"]). Up to nine holes: one block with an Out
//       total. Eighteen (Mixed Eighteen): #scorecard[data-holes="18"]; in portrait and square
//       two blocks (holes 1-9 | Out, then 10-18 | In | Tot; data-card-layout="split"), in
//       landscape one row (1-9 | Out | 10-18 | In | Tot; "row"); re-rendered on rotation.
//   ui.showDecision(opts) -> Promise<id>
//       opts: ['drop', 'replay'] or {kicker?, title?, text?, options:[id | {id, label, detail?}]}.
//       The first option is the default (primary). Resolves with the chosen id.
//   ui.settings (copy)  ui.getSetting(k)  ui.setSetting(k, v)  ui.onChange(fn) -> unsubscribe
//       {units:'yd'|'m', wind:'off'|'light'|'breezy', difficulty:'easy'|'normal'|'pro',
//        handed:'R'|'L', sound:bool, quality:'auto'|'low', swing:'swipe'|'tap'}  persisted in
//       golf.settings.v1 (swing: Settings "Swing control: Swipe / Tap meter").
//   UI.DEFAULT_SETTINGS
//
// DOM contract (index.html): canvas#gl, #hud (#topbar, #pause-btn, #infocard, #tools, #club-row
// (#club, #shot), #putt-range, #pad, #toast, #banner, #intro, #read-hint), #menu (.course-pick),
// #shots, #pause, #settings, #howto, #scorecard, #decision, #loading, #nogl. Values live in
// [data-f="..."] elements.

import { fmtDist, fmtWind, mToYd, SURF_NAMES } from './constants.js';
import { padRectFor, readSafeInsets, layoutMode, onTarget, MAX_POWER } from './input.js';

const SETTINGS_KEY = 'golf.settings.v1';
const DEFAULTS = Object.freeze({ units: 'yd', wind: 'light', difficulty: 'normal', handed: 'R', sound: true, quality: 'auto', swing: 'swipe', puttAid: 'auto' });
const CHOICES = {
  units: ['yd', 'm'],
  wind: ['off', 'light', 'breezy'],
  difficulty: ['easy', 'normal', 'pro'],
  handed: ['R', 'L'],
  sound: [true, false],
  quality: ['auto', 'low'],
  swing: ['swipe', 'tap'],
  puttAid: ['auto', 'full', 'partial', 'off'], // putt preview line (section 8.9)
};
const HINTS = {
  swipe: { full: 'Drag down, then swipe up', putt: 'Drag down, release · slide back to cancel' },
  tap: { full: 'Tap to start · tap again to hit', putt: 'Tap to start · tap again to putt' },
};
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
const arcDeg = (power) => ARC_START + ARC_SWEEP * ((power * 100) / 110);

// Flight-shape icons for the shot sheet (viewBox 44 x 30). Side views over a ground line (g), with
// the roll dashed (r); draw and cut are seen from above, bending off the dashed target line (t),
// and are mirrored for a left-hander.
const SHOT_ICONS = {
  normal: '<path class="g" d="M2 26H42"/><path d="M5 26Q20 -2 35 26"/><path class="r" d="M35 25.5h4"/>',
  draw: '<path class="t" d="M22 28V2"/><path d="M22 28C22.5 17 21 9 11 3"/>',
  cut: '<path class="t" d="M22 28V2"/><path d="M22 28C21.5 17 23 9 33 3"/>',
  stinger: '<path class="g" d="M2 26H42"/><path d="M4 26C10 17 18 15.5 26 24"/><path class="r" d="M26 25.5H41"/>',
  punch: '<path class="g" d="M2 26H42"/><path d="M4 26Q15 11 27 25"/><path class="r" d="M27 25.5h8"/>',
  flop: '<path class="g" d="M2 26H42"/><path d="M11 26Q19 -12 28 26"/>',
  bump: '<path class="g" d="M2 26H42"/><path d="M4 26Q8.5 19 13 25"/><path class="r" d="M13 25.5H41"/>',
};
const SVG_NS = 'http://www.w3.org/2000/svg';

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

// Course length for the menu cards: "3,314 yd" / "3,030 m".
function fmtLength(m, units) {
  const n = Math.round(units === 'm' ? m : mToYd(m));
  return `${n.toLocaleString('en-US')} ${units === 'm' ? 'm' : 'yd'}`;
}

// The menu card's best-round badge: strokes, or for a mixed round (a new draw every time) to par.
function bestBadge(c) {
  if (!c.best) return '';
  return c.mixed ? `Best ${fmtToPar(c.best.toPar)}` : `Best ${c.best.strokes}`;
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
      shots: $('#shots'), shot: $('#shot'), coursePick: $('#menu .course-pick'),
      readcard: $('#readcard'), readCams: $('#read-cams'), slopeTags: [...root.querySelectorAll('.slope-tag')],
    };
    this.f = {};
    for (const n of root.querySelectorAll('[data-f]')) this.f[n.dataset.f] = n;

    this._handlers = new Map();
    this._settings = loadSettings();
    this._hud = { units: null };
    this._controls = { phase: 'address', putt: false, canRead: null, read: false, map: false };
    this._canResume = false;
    this._readCard = null;
    this._tagKeys = ['', ''];
    this._decision = null;
    this._target = null;
    this._courses = [];
    this._course = null;
    this.padRect = { x: 0, y: 0, w: 1, h: 1 };

    this._buildArc();
    this._syncSettingsUI();
    this.setPower(null);

    root.addEventListener('click', (e) => this._onClick(e));
    this.doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.doc.body.dataset.customiser === '1') return; // the Golfer customiser closes itself
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
    const opt = e.target.closest('.shot-opt[data-shot]');
    if (opt) {
      this.hideShots();
      this.emit('shot', opt.dataset.shot);
      return;
    }
    // A tap on the shot sheet's backdrop (outside the panel) closes it.
    if (e.target === this.el.shots) {
      this._closeShots();
      return;
    }
    const cam = e.target.closest('[data-cam]');
    if (cam) {
      this.emit('read-cam', cam.dataset.cam);
      return;
    }
    const mix = e.target.closest('[data-mix]');
    if (mix) {
      this._mixSel = mix.dataset.mix;
      this._selectCourse(mix.dataset.mix);
      this.emit('course', mix.dataset.mix);
      return;
    }
    const card = e.target.closest('[data-course]');
    if (card) {
      // The mixed card stands for the size its switch shows.
      const id = card.dataset.course === 'mixed' && this._mixSel ? this._mixSel : card.dataset.course;
      this._selectCourse(id);
      this.emit('course', id);
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
        this.hideShots();
        this.showMenu({ canResume: this._canResume });
        break;
      case 'new-round':
        this.hideMenu();
        this.hideScorecard();
        this.hidePause();
        this.hideShots();
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
      case 'close-shots':
        this._closeShots();
        return;
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
    // An open 18-hole scorecard switches between two blocks (portrait) and one row (landscape).
    if (changed && this._sc && this.el.scorecard && !this.el.scorecard.hidden) this._renderScorecard();
    if (changed) this.emit('layout', mode);
  }

  // Mirror the swing pad (InputController.padRect) into CSS so the arc and the club picker line
  // up with the touch region. Called by applyLayout; main may call it with input.padRect.
  setPadRect(r) {
    this.padRect = { ...r };
    const s = this.el.hud.style;
    // Also on the root, for overlays outside #hud (the shot sheet keeps clear of the pad).
    const root = this.doc.documentElement.style;
    for (const st of [s, root]) {
      st.setProperty('--pad-x', `${r.x}px`);
      st.setProperty('--pad-y', `${r.y}px`);
      st.setProperty('--pad-w', `${r.w}px`);
      st.setProperty('--pad-h', `${r.h}px`);
    }
    // (Landscape: a little smaller, centred low in the pad, so its top stays under the target.)
    const land = this.doc.body.dataset.layout === 'landscape';
    const arc = Math.round(Math.min(r.w * 0.82, r.h * (land ? 0.7 : 0.78), 300));
    s.setProperty('--arc', `${arc}px`);
    this._arcRect = null; // re-measured for setGolferBox
  }

  // The golfer's body on screen at address (CSS px {x0, y0, x1, y1}, or null): the power arc fades
  // where it crosses him (an SVG mask over the track, fill and ticks; the target notch stays), so
  // the gauge never hides his swing. Cheap per frame: the DOM changes only when the box moves.
  setGolferBox(b) {
    const hole = this._arcHole;
    if (!hole) return;
    if (!b) {
      if (this._arcHoleKey) {
        hole.setAttribute('width', '0');
        hole.setAttribute('height', '0');
        this._arcHoleKey = '';
      }
      return;
    }
    let r = this._arcRect;
    if (!r) {
      const bb = this._arcSvg.getBoundingClientRect();
      if (!(bb.width > 0)) return;
      r = this._arcRect = { x: bb.left, y: bb.top, k: 240 / bb.width };
    }
    // (A left-hander's arc is mirrored: style.css scaleX(-1).)
    const mirror = this.el.hud.dataset.golfer === 'L';
    let u0 = (b.x0 - r.x) * r.k;
    let u1 = (b.x1 - r.x) * r.k;
    if (mirror) [u0, u1] = [240 - u1, 240 - u0];
    const v0 = (b.y0 - r.y) * r.k;
    const v1 = (b.y1 - r.y) * r.k;
    const pad = 5;
    const x = Math.round(u0 - pad);
    const y = Math.round(v0 - pad);
    const w = Math.max(0, Math.round(u1 - u0 + 2 * pad));
    const h = Math.max(0, Math.round(v1 - v0 + 2 * pad));
    const key = `${x},${y},${w},${h}`;
    if (key === this._arcHoleKey) return;
    this._arcHoleKey = key;
    hole.setAttribute('x', String(x));
    hole.setAttribute('y', String(y));
    hole.setAttribute('width', String(w));
    hole.setAttribute('height', String(h));
  }

  // ------------------------------------------------------------------ screens
  showMenu({ canResume = false, courseName, courseSub, courses, selected, resumeSub } = {}) {
    this._canResume = !!canResume;
    const resume = this.$('#menu [data-act="resume"]');
    resume.hidden = !canResume;
    this.f.resumeSub.textContent = resumeSub || '';
    if (courses) {
      this._courses = courses.map((c) => ({ ...c }));
      this._renderCourses();
      this._selectCourse(selected ?? (this._courses[0] && this._courses[0].id));
    }
    if (courseName) this.f.courseName.textContent = courseName;
    if (courseSub) this.f.courseSub.textContent = courseSub;
    this.el.menu.hidden = false;
  }

  get selectedCourse() {
    return this._course;
  }

  // Course picker cards: a theme thumbnail (CSS gradient by data-theme) with the best round on it,
  // then the name, the tagline and par / length. The mixed entries share one card (a div: it holds
  // the 9 | 18 switch's buttons), filled in for the selected size by _selectCourse.
  _renderCourses() {
    const box = this.el.coursePick;
    const doc = this.doc;
    const units = this._settings.units;
    box.textContent = '';
    const mixes = this._courses.filter((c) => c.mixed);
    let mixDone = false;
    for (const c of this._courses) {
      if (c.mixed && mixDone) continue;
      const b = doc.createElement(c.mixed ? 'div' : 'button');
      if (c.mixed) {
        mixDone = true;
        b.tabIndex = 0;
      } else b.type = 'button';
      b.className = c.mixed ? 'course-card cc-mixed' : 'course-card';
      b.dataset.course = c.mixed ? 'mixed' : c.id;
      b.dataset.theme = c.theme || 'parkland';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      const thumb = doc.createElement('span');
      thumb.className = 'cc-thumb';
      if (c.best || c.mixed) {
        const best = doc.createElement('span');
        best.className = 'cc-best';
        best.textContent = bestBadge(c);
        best.hidden = !c.best;
        thumb.appendChild(best);
      }
      const body = doc.createElement('span');
      body.className = 'cc-body';
      const name = doc.createElement('b');
      name.className = 'cc-name';
      name.textContent = c.name;
      const tag = doc.createElement('span');
      tag.className = 'cc-tag';
      tag.textContent = c.tagline || '';
      const meta = doc.createElement('span');
      meta.className = 'cc-meta';
      meta.textContent = c.lengthM == null ? `Par ${c.par} · New holes every round` : `Par ${c.par} · ${fmtLength(c.lengthM, units)}`;
      body.append(name, tag, meta);
      b.append(thumb, body);
      if (c.mixed && mixes.length > 1) {
        const seg = doc.createElement('span');
        seg.className = 'cc-holes';
        seg.setAttribute('role', 'radiogroup');
        seg.setAttribute('aria-label', 'Holes');
        for (const m of mixes) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.dataset.mix = m.id;
          btn.textContent = `${m.holes || 9} holes`;
          btn.setAttribute('aria-pressed', 'false');
          seg.appendChild(btn);
        }
        b.appendChild(seg);
      }
      box.appendChild(b);
    }
  }

  // Highlights a course card and puts its name, par, length and best round in the menu title.
  _selectCourse(id) {
    const c = this._courses.find((k) => k.id === id) || this._courses[0];
    if (!c) return;
    this._course = c.id;
    const cardId = c.mixed ? 'mixed' : c.id;
    for (const b of this.el.coursePick.querySelectorAll('[data-course]')) b.setAttribute('aria-checked', b.dataset.course === cardId ? 'true' : 'false');
    if (c.mixed) {
      this._mixSel = c.id;
      // The shared mixed card shows the selected size: name, tagline, par, best and the switch.
      const card = this.el.coursePick.querySelector('[data-course="mixed"]');
      if (card) {
        card.querySelector('.cc-name').textContent = c.name;
        card.querySelector('.cc-tag').textContent = c.tagline || '';
        card.querySelector('.cc-meta').textContent = `Par ${c.par} · New holes every round`;
        const badge = card.querySelector('.cc-best');
        if (badge) {
          badge.textContent = bestBadge(c);
          badge.hidden = !c.best;
        }
        for (const btn of card.querySelectorAll('[data-mix]')) btn.setAttribute('aria-pressed', btn.dataset.mix === c.id ? 'true' : 'false');
      }
    }
    this.f.courseName.textContent = c.name;
    const best = !c.best ? '' : c.mixed ? ` · Best ${fmtToPar(c.best.toPar)}` : ` · Best ${c.best.strokes} (${fmtToPar(c.best.toPar)})`;
    this.f.courseSub.textContent = `${c.holes || 9} holes · Par ${c.par}${best}`;
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
    for (const k of ['menu', 'pause', 'loading', 'scorecard', 'decision', 'shots']) this.el[k].hidden = true;
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
    if (p && 'target' in p) this.setTarget(p.target);
    if (!p) {
      pad.dataset.state = 'idle';
      pad.dataset.over = '0';
      pad.dataset.full = '0';
      pad.dataset.hit = '0';
      this._arcFill.style.strokeDasharray = '0 400';
      this._arcOver.style.strokeDasharray = '0 400';
      this._arcTarget.classList.remove('hit');
      return;
    }
    const power = Math.max(0, Math.min(MAX_POWER, p.power || 0));
    const over = p.overswing ?? power > 1;
    const full = !over && (p.full ?? (power === 1 && !this._controls.putt));
    const hit = this._target != null && onTarget(power, this._target, this._controls.putt ? 'putt' : 'full');
    pad.dataset.state = 'swing';
    pad.dataset.over = over ? '1' : '0';
    pad.dataset.full = full ? '1' : '0';
    pad.dataset.hit = hit ? '1' : '0';
    this._arcTarget.classList.toggle('hit', hit);
    this._arcFill.style.strokeDasharray = `${Math.min(power, 1) * 100} 400`;
    this._arcOver.style.strokeDasharray = power > 1 ? `0 100 ${(power - 1) * 100} 400` : '0 400';
    const text = p.carryText || '';
    const m = text.match(/^([\d.,]+)\s*(.*)$/);
    this.f.carryNum.textContent = m ? m[1] : text;
    this.f.carryUnit.textContent = m ? `${m[2]} ${this._controls.putt ? 'roll' : 'carry'}` : '';
    const pct = `${Math.round(power * 100)}%`;
    this.f.powerPct.textContent = over ? `Overswing ${pct}` : hit ? `On target · ${pct}` : full ? `Full · ${pct}` : pct;
  }

  // Target notch on the power arc: the power that reaches the target (null hides it).
  setTarget(power) {
    const t = Number.isFinite(power) && power > 0 && power <= MAX_POWER ? power : null;
    this._target = t;
    const g = this._arcTarget;
    g.style.display = t == null ? 'none' : '';
    if (t != null) g.setAttribute('transform', `rotate(${arcDeg(t).toFixed(2)} 120 120)`);
    if (t == null) g.classList.remove('hit');
  }

  setHint(text) {
    this._hint = text || null;
    const h = HINTS[this._settings.swing] || HINTS.swipe;
    this.f.hint.textContent = this._hint || (this._controls.putt ? h.putt : h.full);
  }

  // ------------------------------------------------------------------ green reading (8.9)
  // The caddie's read card under the info card: null hides it; {pending: true} shows "Reading the
  // green…"; else {line1, line2, canAim} (canAim shows the "Aim at read" button). DOM writes only
  // on change.
  setReadCard(r) {
    const el = this.el.readcard;
    if (!el) return;
    const key = r ? JSON.stringify(r) : '';
    if (key === this._readCard) return;
    this._readCard = key;
    el.hidden = !r;
    this.el.hud.dataset.readcard = r ? '1' : '0';
    if (!r) return;
    el.dataset.pending = r.pending ? '1' : '0';
    this.f.read1.textContent = r.pending ? 'Reading the green…' : r.line1 || '';
    this.f.read2.textContent = r.pending ? '' : r.line2 || '';
    this.f.read2.hidden = r.pending || !r.line2;
    el.querySelector('[data-act="aim-read"]').hidden = !!r.pending || !r.canAim;
  }

  // Active read camera button ('orbit' lights none).
  setReadCam(v) {
    const box = this.el.readCams;
    if (!box) return;
    for (const b of box.querySelectorAll('[data-cam]')) b.setAttribute('aria-pressed', b.dataset.cam === v ? 'true' : 'false');
  }

  // Slope tags near the ball and the cup: [{x, y (CSS px), text, angle (screen rad, 0 = right,
  // clockwise positive: the downhill arrow), band 0..3}] (at most two; missing ones hide).
  setSlopeTags(list) {
    const tags = this.el.slopeTags || [];
    for (let i = 0; i < tags.length; i++) {
      const t = list && list[i];
      const el = tags[i];
      const key = t ? `${Math.round(t.x)},${Math.round(t.y)},${t.text},${Math.round(t.angle * 20)},${t.band}` : '';
      if (key === this._tagKeys[i]) continue;
      this._tagKeys[i] = key;
      el.hidden = !t;
      if (!t) continue;
      el.style.transform = `translate(${Math.round(t.x)}px, ${Math.round(t.y)}px) translate(-50%, -50%)`;
      el.dataset.band = String(t.band);
      el.querySelector('span').textContent = t.text;
      el.querySelector('i').style.transform = `rotate(${((t.angle * 180) / Math.PI).toFixed(1)}deg)`;
    }
  }

  setControls(c = {}) {
    const s = Object.assign(this._controls, c);
    const hud = this.el.hud;
    if (s.phase !== 'address' || s.putt || s.read || s.map) this._closeShots();
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

  showIntro({ hole, name, par, yards, lengthM, si, course } = {}) {
    const units = this._hud.units || this._settings.units;
    if (hole != null) this.f.introHole.textContent = hole;
    this.f.introCourse.textContent = course || '';
    this.f.introCourse.hidden = !course;
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
    // The first segment is a bold tab; the rest wrap inside their own box on a narrow screen.
    const body = this.doc.createElement('div');
    body.className = 'tb';
    parts.forEach((part, i) => {
      const n = this.doc.createElement(i === 0 && parts.length > 1 ? 'b' : 'span');
      n.textContent = part;
      (n.tagName === 'B' ? t : body).appendChild(n);
    });
    t.appendChild(body);
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

  // ------------------------------------------------------------------ shots
  setShot({ id = 'normal', name = 'Normal', special, show = true } = {}) {
    const chip = this.el.shot;
    this.f.shotName.textContent = name;
    chip.dataset.cur = id;
    chip.dataset.special = (special ?? id !== 'normal') ? '1' : '0';
    chip.dataset.show = show ? '1' : '0';
    chip.setAttribute('aria-label', `Shot: ${name}`);
  }

  showShots({ shots = [], current = 'normal', handed = 'R', kicker = '' } = {}) {
    const doc = this.doc;
    const units = this._hud.units || this._settings.units;
    const list = this.$('#shots .shot-list');
    list.textContent = '';
    this.f.shotsKicker.textContent = kicker;
    for (const s of shots) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'shot-opt';
      b.dataset.shot = s.id;
      b.setAttribute('aria-pressed', s.id === current ? 'true' : 'false');
      const ico = doc.createElementNS(SVG_NS, 'svg');
      ico.setAttribute('class', 'shot-ico');
      ico.setAttribute('viewBox', '0 0 44 30');
      ico.setAttribute('aria-hidden', 'true');
      const g = doc.createElementNS(SVG_NS, 'g');
      // Static markup from SHOT_ICONS (no user text). Draw and cut bend the other way for a lefty.
      g.innerHTML = SHOT_ICONS[s.id] || SHOT_ICONS.normal;
      if (handed === 'L' && (s.id === 'draw' || s.id === 'cut')) g.setAttribute('transform', 'translate(44 0) scale(-1 1)');
      ico.appendChild(g);
      const body = doc.createElement('span');
      body.className = 'so-body';
      const name = doc.createElement('b');
      name.textContent = s.name;
      const blurb = doc.createElement('small');
      blurb.textContent = s.blurb || '';
      body.append(name, blurb);
      b.append(ico, body);
      if (s.carry != null) {
        const d = doc.createElement('span');
        d.className = 'so-dist';
        const num = (m) => Math.round(units === 'm' ? m : mToYd(m));
        // Carry/total, as the toasts write it ("106/107 yd").
        d.textContent = s.total != null ? `${num(s.carry)}/${num(s.total)}` : `${num(s.carry)}`;
        const u = doc.createElement('small');
        u.textContent = units;
        d.appendChild(u);
        b.appendChild(d);
      }
      list.appendChild(b);
    }
    this.el.shots.hidden = false;
  }

  hideShots() {
    this.el.shots.hidden = true;
  }

  get shotsOpen() {
    return !this.el.shots.hidden;
  }

  _closeShots() {
    if (this.el.shots.hidden) return;
    this.hideShots();
    this.emit('shots-closed');
  }

  // ------------------------------------------------------------------ scorecard
  showScorecard(card, opts = {}) {
    this._sc = { card, opts };
    this._renderScorecard();
  }

  _renderScorecard() {
    const { card, opts } = this._sc;
    const { final = false, current = null, title, kicker, course } = opts;
    const holes = (Array.isArray(card) ? card : (card && card.holes) || []).map((h, i) => ({
      n: h.n ?? i + 1,
      par: h.par ?? 4,
      lengthM: h.lengthM ?? (h.yards != null ? h.yards * 0.9144 : null),
      strokes: h.strokes ?? null,
      putts: h.putts ?? null,
      fir: h.fir ?? null,
      gir: h.gir ?? null,
      from: h.from || null,
    }));
    const units = this._hud.units || this._settings.units;
    const played = holes.filter((h) => h.strokes != null);
    const sum = (arr, k) => arr.reduce((a, h) => a + (h[k] || 0), 0);
    const toPar = sum(played, 'strokes') - sum(played, 'par');
    const firHoles = played.filter((h) => h.fir != null);
    const doc = this.doc;

    const table = this.$('#scorecard table.sc');
    table.textContent = '';
    const lengthNum = (m) => (m == null ? '' : Math.round(units === 'm' ? m : mToYd(m)));
    // Columns: a hole {i}, a total {label, from, to} over holes [from, to), or a blank spacer.
    const range = (a, b) => Array.from({ length: b - a }, (_, k) => ({ i: a + k }));
    const eighteen = holes.length > 9;
    const split = eighteen && this.layout !== 'landscape';
    const OUT = { label: 'Out', from: 0, to: Math.min(9, holes.length) };
    const IN = { label: 'In', from: 9, to: holes.length };
    const TOT = { label: 'Tot', from: 0, to: holes.length };
    const blocks = !eighteen
      ? [[...range(0, holes.length), OUT]]
      : split
        ? [[...range(0, 9), OUT, { blank: true }], [...range(9, holes.length), IN, TOT]]
        : [[...range(0, 9), OUT, ...range(9, holes.length), IN, TOT]];
    const rows = [{ cls: 'r-hole', label: 'Hole', cell: (h) => h.n, tot: (t) => t.label }];
    if (holes.some((h) => h.from)) {
      // Mixed round: which course each hole comes from (initial on the course's theme colour).
      rows.push({ cls: 'r-from', label: 'Course', cell: (h) => {
        if (!h.from) return '';
        const chip = doc.createElement('span');
        chip.className = 'from-chip';
        chip.dataset.theme = h.from.theme || 'parkland';
        chip.textContent = (h.from.name || '?').charAt(0);
        chip.title = `${h.from.name} ${h.from.n}`;
        return chip;
      }, tot: () => '' });
    }
    rows.push(
      { cls: 'r-yds', label: units === 'm' ? 'M' : 'Yds', cell: (h) => lengthNum(h.lengthM), tot: (t, hs) => (hs.every((h) => h.lengthM != null) ? lengthNum(sum(hs, 'lengthM')) : '') },
      { cls: 'r-par', label: 'Par', cell: (h) => h.par, tot: (t, hs) => sum(hs, 'par') },
      { cls: 'r-score', label: 'Score', cell: (h) => {
        if (h.strokes == null) return '';
        const d = h.strokes - h.par;
        const mk = doc.createElement('span');
        mk.className = `mk${d <= -2 ? ' circ2' : d === -1 ? ' circ' : d === 1 ? ' sq' : d >= 2 ? ' sq2' : ''}`;
        mk.textContent = h.strokes;
        return mk;
      }, tot: (t, hs, pl) => (pl.length ? sum(pl, 'strokes') : '') },
      { cls: 'r-putts', label: 'Putts', cell: (h) => (h.strokes == null ? '' : h.putts ?? ''), tot: (t, hs, pl) => (pl.length ? sum(pl, 'putts') : '') },
    );
    blocks.forEach((cols, bi) => {
      // Nine holes: rows straight in the table (as before); two blocks: a tbody each.
      const parent = split ? doc.createElement('tbody') : table;
      if (split) {
        parent.className = bi ? 'sc-back' : 'sc-front';
        table.appendChild(parent);
      }
      for (const r of rows) {
        const tr = doc.createElement('tr');
        tr.className = r.cls;
        const th = doc.createElement('th');
        th.textContent = r.label;
        tr.appendChild(th);
        for (const col of cols) {
          const td = doc.createElement('td');
          let c = '';
          if (col.blank) td.className = 'gap';
          else if (col.label) {
            td.className = 'tot';
            const hs = holes.slice(col.from, col.to);
            c = r.tot(col, hs, hs.filter((h) => h.strokes != null));
          } else {
            if (col.i === current) td.classList.add('cur');
            c = r.cell(holes[col.i]);
          }
          if (c && typeof c === 'object') td.appendChild(c);
          else td.textContent = c ?? '';
          tr.appendChild(td);
        }
        parent.appendChild(tr);
      }
    });
    this.el.scorecard.dataset.holes = String(holes.length);
    this.el.scorecard.dataset.cardLayout = split ? 'split' : 'row';

    const last = current != null ? holes[current] : played[played.length - 1];
    // Header: the course name first, then what the card is ("Red Mesa · Round complete").
    const courseName = course || (card && !Array.isArray(card) && card.course) || '';
    const what = kicker || (final ? 'Round complete' : '');
    this.f.cardKicker.textContent = [courseName, what].filter(Boolean).join(' · ') || this.f.courseName.textContent;
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
    this._sc = null;
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
    if (k === 'units') {
      this.setHud({});
      if (this._courses.length) {
        this._renderCourses();
        this._selectCourse(this._course);
      }
    }
    if (k === 'swing') this.setHint(this._hint);
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
      const deg = arcDeg(pw);
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
    // The golfer's mask (setGolferBox): the track, zone, ticks, fill and overswing fade to ~35%
    // inside a rounded box round his body.
    {
      const mask = this.doc.createElementNS(NS, 'mask');
      mask.setAttribute('id', 'arc-golfer-mask');
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      for (const [k, v] of [['x', -40], ['y', -40], ['width', 320], ['height', 320]]) mask.setAttribute(k, String(v));
      const all = this.doc.createElementNS(NS, 'rect');
      for (const [k, v] of [['x', -40], ['y', -40], ['width', 320], ['height', 320], ['fill', '#fff']]) all.setAttribute(k, String(v));
      const hole = this.doc.createElementNS(NS, 'rect');
      for (const [k, v] of [['x', 0], ['y', 0], ['width', 0], ['height', 0], ['rx', 14], ['fill', '#000'], ['fill-opacity', 0.62]]) hole.setAttribute(k, String(v));
      mask.append(all, hole);
      const grp = this.doc.createElementNS(NS, 'g');
      grp.setAttribute('mask', 'url(#arc-golfer-mask)');
      for (const el of svg.querySelectorAll('.arc-track, .arc-zone, .arc-ticks, .arc-fill, .arc-over')) grp.appendChild(el);
      svg.append(mask, grp);
      this._arcSvg = svg;
      this._arcHole = hole;
      this._arcHoleKey = '';
    }
    // Target notch, drawn at angle 0 (pointing along +x from the centre) and rotated into place
    // by setTarget: a bar across the track and a small pointer just outside it.
    const tg = this.doc.createElementNS(NS, 'g');
    tg.setAttribute('class', 'arc-target');
    const bar = this.doc.createElementNS(NS, 'line');
    bar.setAttribute('x1', String(120 + ARC_R - 11));
    bar.setAttribute('y1', '120');
    bar.setAttribute('x2', String(120 + ARC_R + 11));
    bar.setAttribute('y2', '120');
    const tip = this.doc.createElementNS(NS, 'path');
    const r0 = 120 + ARC_R + 14;
    tip.setAttribute('d', `M ${r0} 120 L ${r0 + 9} 114 L ${r0 + 9} 126 Z`);
    tg.append(bar, tip);
    svg.appendChild(tg);
    this._arcTarget = tg;
    this.setTarget(null);
  }
}

