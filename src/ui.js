// UI: menus, HUD, toasts, banner, dialogs and settings persistence. DOM only - no game logic.
//
// DOM contract (index.html). Ids the integrator relies on:
//   body[data-layout]  'portrait' | 'landscape' | 'square' - set by ui.applyLayout()
//   #app               full-screen grid (data-screen = 'menu' | 'game')
//   #hud               scoreboard: .player[data-p=0|1], .score, #tray (pocketed balls), #pause-btn
//   #table-wrap        the grid cell left for the table. Size canvas#table to its
//                      clientWidth/clientHeight x dpr and call layout.computeView(w, h).
//                      The canvas is absolutely positioned, so it never feeds back into the size.
//                      Also holds non-interactive overlays: #hint, #toast, #banner, #thinking.
//   canvas#table       the game surface (input.js listens here)
//   #controls          display:contents wrapper of #power, #fine, #spin (input.js owns them)
//   #menu              title screen (pages: main / pvp / howto)
//   #settings          settings sheet          #pause      pause sheet (+ inline confirm)
//   #dialog            generic dialog (illegal-break decision, ui.dialog())
//   #rackover          rack-over / match-over panel
//   #spinpad           big cue-ball face for picking spin (input.js owns the interaction)
//   #hint              persistent prompt pill ("Ball in hand", "Call a pocket for the 8")
//   #toast             stacked toasts (max 3, 1.6 s)
//   #banner            turn banner (1.2 s)
//   #thinking          CPU thinking indicator
//
// Callbacks (all optional): onStart(config), onResume(), onPause(paused), onRestartRack(),
//   onConcede(), onQuit(), onDecision(option), onNextRack(), onRematch(), onSettings(settings),
//   onLayout(mode).
//   - onResume() is the menu's "Resume match" (continue the saved match).
//   - The HUD pause button opens the pause sheet and calls onPause(true); the sheet's "Resume"
//     closes it and calls onPause(false).
//   - "Quit to menu" calls onQuit() and shows the menu.

import { layoutMode } from './layout.js';
import { BALL_COLORS, isStripe } from './constants.js';

const SETTINGS_KEY = 'pool8.settings.v1';
const DEFAULT_SETTINGS = Object.freeze({
  aimGuide: true,
  sound: true,
  cloth: 'green',
  raceTo: 3,
  level: 'medium',
  names: Object.freeze(['Player 1', 'Player 2']),
});
const UI_LEVELS = ['easy', 'medium', 'hard', 'pro'];
const UI_LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', pro: 'Pro' };
const TOAST_MS = 1600;
const TOAST_MAX = 3;
const BANNER_MS = 1200;

const REASON_TEXT = {
  EIGHT_LEGAL: '8-ball in the called pocket',
  EIGHT_EARLY: '8-ball pocketed early',
  EIGHT_WITH_LAST: '8-ball went down with the last group ball',
  EIGHT_FOUL: 'Foul on the 8-ball',
  EIGHT_WRONG_POCKET: '8-ball in the wrong pocket',
  EIGHT_OFF_TABLE: '8-ball off the table',
  CONCEDE: 'Rack conceded',
};

const DECISION_TEXT = {
  illegalBreak: {
    title: 'Illegal break',
    text: 'A legal break needs a ball pocketed or four balls driven to a cushion.',
  },
};

function uiLoadSettings() {
  const s = { ...DEFAULT_SETTINGS, names: [...DEFAULT_SETTINGS.names] };
  try {
    const raw = window.localStorage && localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        if (typeof v.aimGuide === 'boolean') s.aimGuide = v.aimGuide;
        if (typeof v.sound === 'boolean') s.sound = v.sound;
        if (v.cloth === 'green' || v.cloth === 'blue') s.cloth = v.cloth;
        if ([1, 3, 5].includes(v.raceTo)) s.raceTo = v.raceTo;
        if (UI_LEVELS.includes(v.level)) s.level = v.level;
        if (Array.isArray(v.names)) {
          for (let i = 0; i < 2; i++) {
            if (typeof v.names[i] === 'string' && v.names[i].trim()) s.names[i] = v.names[i].trim().slice(0, 14);
          }
        }
      }
    }
  } catch {
    // private mode / blocked storage: defaults
  }
  return s;
}

function uiEsc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Mini ball markup (HUD / tray). gone = drawn as an empty socket.
function uiBall(id, gone = false) {
  if (gone) return '<i class="mb gone"></i>';
  if (id === 0) return '<i class="mb cue"></i>';
  if (id === 8) return '<i class="mb e8"></i>';
  return `<i class="mb${isStripe(id) ? ' st' : ''}" style="--c:${BALL_COLORS[id]}"></i>`;
}

function uiPlural(name) {
  return name === 'You';
}

export class UI {
  constructor(root, callbacks = {}) {
    this.root = root || document;
    this.cb = callbacks;
    this.settings = uiLoadSettings();
    this._lastHud = null;
    this._hudKeys = {};
    this._toasts = [];
    this._bannerTimer = 0;
    this._confirmFn = null;
    this._settingsFrom = null;
    this._dialogResolve = null;
    this._resume = false;
    this._mode = 'cpu';
    this._config = null;

    const q = (sel) => this.root.querySelector(sel);
    this.el = {
      app: q('#app'),
      hud: q('#hud'),
      players: [q('#hud .player[data-p="0"]'), q('#hud .player[data-p="1"]')],
      s0: q('#hud .score .s0'),
      s1: q('#hud .score .s1'),
      race: q('#hud .score-race'),
      tray: q('#tray'),
      pauseBtn: q('#pause-btn'),
      hint: q('#hint'),
      toast: q('#toast'),
      banner: q('#banner'),
      bannerText: q('#banner .banner-text'),
      thinking: q('#thinking'),
      thinkingText: q('#thinking .th-text'),
      spin: q('#spin'),
      menu: q('#menu'),
      settings: q('#settings'),
      pause: q('#pause'),
      dialog: q('#dialog'),
      rackover: q('#rackover'),
      spinpad: q('#spinpad'),
      name0: q('#name0'),
      name1: q('#name1'),
    };

    this._onClick = this._onClick.bind(this);
    this._onKey = this._onKey.bind(this);
    this._scheduleLayout = this._scheduleLayout.bind(this);
    this.root.addEventListener('click', this._onClick);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._scheduleLayout);
    window.addEventListener('orientationchange', this._scheduleLayout);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._scheduleLayout);
    // iOS: block pinch-zoom gestures and double-tap zoom on the game surface.
    const block = (e) => e.preventDefault();
    document.addEventListener('gesturestart', block, { passive: false });
    document.addEventListener('gesturechange', block, { passive: false });
    document.addEventListener('dblclick', (e) => {
      if (!(e.target instanceof HTMLElement) || !e.target.closest('input')) e.preventDefault();
    }, { passive: false });

    for (const inp of [this.el.name0, this.el.name1]) {
      if (!inp) continue;
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (inp === this.el.name0 && this.el.name1) this.el.name1.focus();
        else this._startPvp();
      });
    }

    this._syncSettingsUi();
    this.applyLayout();
  }

  // ------------------------------------------------------------------ layout
  applyLayout() {
    this._layoutRaf = 0;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const mode = layoutMode(w, h);
    const body = document.body;
    if (body.dataset.layout !== mode) body.dataset.layout = mode;
    if (this.cb.onLayout) this.cb.onLayout(mode);
    return mode;
  }

  _scheduleLayout() {
    if (this._layoutRaf) return;
    this._layoutRaf = requestAnimationFrame(() => this.applyLayout());
  }

  get layout() {
    return document.body.dataset.layout;
  }

  // ------------------------------------------------------------------ settings
  _saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore
    }
  }

  _changeSetting(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this._saveSettings();
    this._syncSettingsUi();
    if (this.cb.onSettings) this.cb.onSettings({ ...this.settings, names: [...this.settings.names] });
  }

  _syncSettingsUi() {
    const s = this.settings;
    this.root.querySelectorAll('.switch[data-set]').forEach((b) => {
      b.setAttribute('aria-checked', String(!!s[b.dataset.set]));
    });
    this.root.querySelectorAll('.seg[data-seg]').forEach((seg) => {
      const cur = String(s[seg.dataset.seg]);
      seg.querySelectorAll('button[data-v]').forEach((b) => {
        const on = b.dataset.v === cur;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.setAttribute('role', 'radio');
      });
    });
    this.root.querySelectorAll('[data-bind="raceTo"]').forEach((n) => (n.textContent = String(s.raceTo)));
    // Default names stay as placeholders so the field is ready to type into.
    [this.el.name0, this.el.name1].forEach((inp, i) => {
      if (inp && document.activeElement !== inp) inp.value = s.names[i] === DEFAULT_SETTINGS.names[i] ? '' : s.names[i];
    });
  }

  // ------------------------------------------------------------------ menu
  showMenu(page = 'main') {
    this.hideOverlays();
    this.setThinking(false);
    this._syncSettingsUi();
    this._menuPage(page);
    this._open(this.el.menu, true);
    if (this.el.app) this.el.app.dataset.screen = 'menu';
  }

  hideMenu() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this._open(this.el.menu, false);
    if (this.el.app) this.el.app.dataset.screen = 'game';
  }

  setResumeAvailable(on) {
    this._resume = !!on;
    this.root.querySelectorAll('[data-act="resume"]').forEach((b) => (b.hidden = !on));
  }

  _menuPage(name) {
    if (!this.el.menu) return;
    this.el.menu.querySelectorAll('.menu-page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
    const sc = this.el.menu.querySelector('.menu-scroll');
    if (sc) sc.scrollTop = 0;
  }

  _startCpu() {
    const level = this.settings.level;
    const config = {
      mode: 'cpu',
      level,
      players: [
        { name: 'You', kind: 'human', level: null },
        { name: 'CPU', kind: 'cpu', level },
      ],
      raceTo: this.settings.raceTo,
    };
    this._mode = 'cpu';
    this._config = config;
    this.hideMenu();
    if (this.cb.onStart) this.cb.onStart(config);
  }

  _startPvp() {
    const names = [this.el.name0, this.el.name1].map((inp, i) => {
      const v = inp ? inp.value.trim().slice(0, 14) : '';
      return v || DEFAULT_SETTINGS.names[i];
    });
    if (names[0].toLowerCase() === names[1].toLowerCase()) names[1] = `${names[1]} 2`;
    this.settings.names = names;
    this._saveSettings();
    const config = {
      mode: 'pvp',
      level: null,
      players: [
        { name: names[0], kind: 'human', level: null },
        { name: names[1], kind: 'human', level: null },
      ],
      raceTo: this.settings.raceTo,
    };
    this._mode = 'pvp';
    this._config = config;
    this.hideMenu();
    if (this.cb.onStart) this.cb.onStart(config);
  }

  // ------------------------------------------------------------------ click routing
  _onClick(e) {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t) return;
    if (t.closest('#pause-btn')) {
      this.showPause();
      if (this.cb.onPause) this.cb.onPause(true);
      return;
    }
    const segBtn = t.closest('.seg[data-seg] button[data-v]');
    if (segBtn) {
      const key = segBtn.closest('.seg').dataset.seg;
      const raw = segBtn.dataset.v;
      this._changeSetting(key, key === 'raceTo' ? Number(raw) : raw);
      return;
    }
    const sw = t.closest('.switch[data-set]');
    if (sw) {
      this._changeSetting(sw.dataset.set, !this.settings[sw.dataset.set]);
      return;
    }
    // Tap on a sheet backdrop closes it (settings / pause).
    if (t === this.el.settings) return this._closeSettings();
    if (t === this.el.pause && !this.el.pause.classList.contains('confirming')) return this._unpause();

    const actEl = t.closest('[data-act]');
    if (!actEl || actEl.closest('#spinpad')) return; // spin pad belongs to input.js
    const act = actEl.dataset.act;
    switch (act) {
      case 'play-cpu': return this._startCpu();
      case 'pvp': return this._menuPage('pvp');
      case 'start-pvp': return this._startPvp();
      case 'howto': return this._menuPage('howto');
      case 'back': return this._menuPage('main');
      case 'resume':
        this.hideMenu();
        if (this.cb.onResume) this.cb.onResume();
        return;
      case 'settings': return this._openSettings(actEl.closest('#pause') ? 'pause' : 'menu');
      case 'settings-done': return this._closeSettings();
      case 'unpause': return this._unpause();
      case 'restart':
        return this._confirm('Restart rack?', 'The balls are re-racked and the same player breaks.', 'Restart', () => {
          this.hideOverlays();
          if (this.cb.onRestartRack) this.cb.onRestartRack();
        });
      case 'concede':
        return this._confirm('Concede this rack?', 'Your opponent wins the rack.', 'Concede', () => {
          this.hideOverlays();
          if (this.cb.onConcede) this.cb.onConcede();
        });
      case 'quit':
        this.hideOverlays();
        if (this.cb.onQuit) this.cb.onQuit();
        this.showMenu();
        return;
      case 'confirm-no':
        this.el.pause.classList.remove('confirming');
        this._confirmFn = null;
        return;
      case 'confirm-yes': {
        const fn = this._confirmFn;
        this._confirmFn = null;
        this.el.pause.classList.remove('confirming');
        if (fn) fn();
        return;
      }
      case 'next-rack':
        this._open(this.el.rackover, false);
        if (this.cb.onNextRack) this.cb.onNextRack();
        return;
      case 'rematch':
        this._open(this.el.rackover, false);
        if (this.cb.onRematch) this.cb.onRematch();
        return;
      case 'ro-menu':
        this._open(this.el.rackover, false);
        if (this.cb.onQuit) this.cb.onQuit();
        this.showMenu();
        return;
      default:
        if (act.startsWith('dlg:')) this._dialogPick(act.slice(4));
    }
  }

  _onKey(e) {
    if (e.key !== 'Escape') return;
    if (this._isOpen(this.el.settings)) return this._closeSettings();
    if (this._isOpen(this.el.pause)) return this._unpause();
    if (this._isOpen(this.el.menu) || this._isOpen(this.el.dialog) || this._isOpen(this.el.rackover)) return;
    this.showPause();
    if (this.cb.onPause) this.cb.onPause(true);
  }

  // ------------------------------------------------------------------ overlays
  _open(el, on) {
    if (!el) return;
    el.classList.toggle('open', !!on);
    el.setAttribute('aria-hidden', String(!on));
  }

  _isOpen(el) {
    return !!el && el.classList.contains('open');
  }

  _openSettings(from) {
    this._settingsFrom = from;
    this._syncSettingsUi();
    this._open(this.el.settings, true);
  }

  _closeSettings() {
    this._open(this.el.settings, false);
    this._settingsFrom = null;
  }

  showPause() {
    if (!this.el.pause) return;
    this.el.pause.classList.remove('confirming');
    this._confirmFn = null;
    this._open(this.el.pause, true);
  }

  _unpause() {
    this._open(this.el.pause, false);
    this.el.pause.classList.remove('confirming');
    if (this.cb.onPause) this.cb.onPause(false);
  }

  _confirm(title, text, ok, fn) {
    const p = this.el.pause;
    p.querySelector('.confirm-title').textContent = title;
    p.querySelector('.confirm-text').textContent = text;
    p.querySelector('.confirm-ok').textContent = ok;
    this._confirmFn = fn;
    p.classList.add('confirming');
  }

  // Hides every modal overlay (menu, settings, pause, dialog, rack-over, spin pad).
  hideOverlays() {
    for (const k of ['menu', 'settings', 'pause', 'dialog', 'rackover', 'spinpad']) this._open(this.el[k], false);
    if (this.el.pause) this.el.pause.classList.remove('confirming');
    this._confirmFn = null;
    if (this._dialogResolve) {
      const r = this._dialogResolve;
      this._dialogResolve = null;
      r(null);
    }
    if (this.el.app) this.el.app.dataset.screen = 'game';
  }

  // Generic dialog. opts {title, text, badge, buttons:[{label, value, kind:'primary'|'secondary'|'ghost'}]}
  // Resolves with the picked value (null if dismissed by hideOverlays).
  dialog(opts = {}) {
    const d = this.el.dialog;
    if (!d) return Promise.resolve(null);
    if (this._dialogResolve) this._dialogResolve(null);
    d.querySelector('.dlg-title').textContent = opts.title || '';
    d.querySelector('.dlg-text').textContent = opts.text || '';
    const badge = d.querySelector('.dlg-badge');
    if (badge) badge.textContent = opts.badge || '!';
    const buttons = Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons : [{ label: 'OK', value: 'ok' }];
    d.querySelector('.dlg-buttons').innerHTML = buttons
      .map((b, i) => {
        const kind = b.kind || (i === 0 ? 'primary' : 'secondary');
        return `<button class="btn ${kind}" type="button" data-act="dlg:${uiEsc(b.value)}"><span>${uiEsc(b.label)}</span></button>`;
      })
      .join('');
    this._open(d, true);
    return new Promise((resolve) => (this._dialogResolve = resolve));
  }

  _dialogPick(value) {
    const r = this._dialogResolve;
    this._dialogResolve = null;
    this._open(this.el.dialog, false);
    if (r) r(value);
  }

  // decision: {type:'illegalBreak', chooser, options:[...], cueInHand} (+ optional title/text/labels)
  showDecision(decision) {
    const dec = decision || {};
    const names = this._names();
    const chooser = dec.chooser === 1 ? 1 : 0;
    const offender = 1 - chooser;
    const meta = DECISION_TEXT[dec.type] || { title: 'Your decision', text: '' };
    const labels = {
      acceptTable: 'Play from here',
      rerackBreak: `Re-rack & ${uiPlural(names[chooser]) ? 'break' : `${names[chooser]} breaks`}`,
      rerackOpponentBreaks: `Re-rack, ${names[offender]} ${uiPlural(names[offender]) ? 'break' : 'breaks'} again`,
      ...(dec.labels || {}),
    };
    const options = Array.isArray(dec.options) && dec.options.length ? dec.options : ['acceptTable'];
    const who = uiPlural(names[chooser]) ? 'Your choice' : `${names[chooser]} to choose`;
    const text = dec.text || `${meta.text} ${who}:`.trim();
    const p = this.dialog({
      title: dec.title || meta.title,
      text,
      badge: '!',
      buttons: options.map((o, i) => ({
        value: o,
        label: labels[o] || String(o).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
        kind: i === 0 ? 'primary' : 'secondary',
      })),
    });
    p.then((opt) => {
      if (opt != null && this.cb.onDecision) this.cb.onDecision(opt);
    });
    return p;
  }

  // info: {winner:0|1, reason, score:[a,b], raceTo?, names?, title?, text?}
  showRackOver(info) {
    this._showResult(info || {}, false);
  }

  // info: {winner:0|1, score:[a,b], raceTo?, names?, title?, text?}
  showMatchOver(info) {
    this._showResult(info || {}, true);
  }

  _showResult(info, match) {
    const ro = this.el.rackover;
    if (!ro) return;
    const names = Array.isArray(info.names) ? info.names : this._names();
    const w = info.winner === 0 || info.winner === 1 ? info.winner : null;
    const wn = w === null ? '' : names[w];
    const youGame = names.includes('You');
    const win = w !== null && (!youGame || wn === 'You');
    const loss = youGame && w !== null && wn !== 'You';
    const score = Array.isArray(info.score) ? info.score : (this._lastHud && this._lastHud.score) || [0, 0];
    const raceTo = info.raceTo || (this._lastHud && this._lastHud.raceTo) || this.settings.raceTo;
    let title = info.title;
    if (!title) {
      if (w === null) title = match ? 'Match over' : 'Rack over';
      else if (match) title = uiPlural(wn) ? 'You win the match!' : `${wn} wins the match!`;
      else title = uiPlural(wn) ? 'You win the rack!' : `${wn} wins the rack`;
    }
    const reason = info.text != null ? info.text : match ? `Final score ${score[0]}–${score[1]}` : REASON_TEXT[info.reason] || '';
    ro.classList.toggle('match', match);
    ro.classList.toggle('win', win);
    ro.classList.toggle('loss', loss);
    ro.querySelector('.ro-kicker').textContent = match ? 'Match over' : `Rack over`;
    ro.querySelector('.ro-title').textContent = title;
    ro.querySelector('.ro-reason').textContent = reason;
    ro.querySelector('.ro-race').textContent = String(raceTo);
    ro.querySelectorAll('.ro-side').forEach((side) => {
      const p = Number(side.dataset.p);
      side.querySelector('.ro-name').textContent = names[p];
      side.querySelector('.ro-num').textContent = String(score[p] ?? 0);
      side.classList.toggle('won', w === p);
    });
    this._open(this.el.dialog, false);
    this._open(ro, true);
  }

  // ------------------------------------------------------------------ HUD
  _names() {
    const ps = this._lastHud && Array.isArray(this._lastHud.players) ? this._lastHud.players : [];
    return [0, 1].map((i) => (ps[i] && ps[i].name) || (this._mode === 'cpu' ? ['You', 'CPU'][i] : this.settings.names[i]));
  }

  // hud: {players:[{name, group, remaining:[ids]}], turn, phase, ballInHand, onEight, score:[a,b],
  //       raceTo, pocketed:[ids], banner, hint?}. Every field is optional.
  updateHud(hud) {
    const h = hud && typeof hud === 'object' ? hud : {};
    this._lastHud = h;
    const players = Array.isArray(h.players) ? h.players : [];
    const turn = h.turn === 0 || h.turn === 1 ? h.turn : -1;
    const over = h.phase === 'rackOver' || h.phase === 'matchOver';
    const onEightArr = Array.isArray(h.onEight) ? h.onEight : null;

    for (let p = 0; p < 2; p++) {
      const el = this.el.players[p];
      if (!el) continue;
      const pl = players[p] || {};
      const name = pl.name || (this._mode === 'cpu' ? ['You', 'CPU'][p] : this.settings.names[p]);
      const group = pl.group === 'solids' || pl.group === 'stripes' ? pl.group : null;
      const remaining = Array.isArray(pl.remaining) ? pl.remaining.filter((n) => Number.isInteger(n)) : null;
      const onEight = onEightArr ? !!onEightArr[p] : group !== null && remaining !== null && remaining.length === 0;
      const gkey = group ? (onEight ? 'eight' : group) : 'open';
      const key = `${name}|${gkey}|${remaining ? remaining.join(',') : '-'}`;
      if (this._hudKeys[`p${p}`] !== key) {
        this._hudKeys[`p${p}`] = key;
        el.dataset.group = gkey;
        el.querySelector('.pl-name').textContent = name;
        el.querySelector('.pl-group').textContent = group === 'solids' ? 'Solids' : group === 'stripes' ? 'Stripes' : '';
        let balls = '';
        if (gkey === 'eight') balls = `${uiBall(8)}<span class="pl-note">On the 8</span>`;
        else if (gkey === 'open') balls = '<span class="pl-note">Open table</span>';
        else if (group) {
          const ids = group === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
          const rem = remaining ? new Set(remaining) : null;
          balls = ids.map((id) => uiBall(id, rem ? !rem.has(id) : false)).join('');
        }
        el.querySelector('.pl-balls').innerHTML = balls;
      }
      el.classList.toggle('active', turn === p && !over);
    }

    const score = Array.isArray(h.score) ? h.score : [0, 0];
    const raceTo = h.raceTo || this.settings.raceTo;
    const skey = `${score[0] ?? 0}|${score[1] ?? 0}|${raceTo}`;
    if (this._hudKeys.score !== skey) {
      this._hudKeys.score = skey;
      this.el.s0.textContent = String(score[0] ?? 0);
      this.el.s1.textContent = String(score[1] ?? 0);
      this.el.race.textContent = `Race to ${raceTo}`;
    }

    const pocketed = Array.isArray(h.pocketed) ? h.pocketed.filter((n) => Number.isInteger(n) && n > 0) : [];
    const tkey = pocketed.join(',');
    if (this._hudKeys.tray !== tkey && this.el.tray) {
      const prev = this._hudKeys.tray ? this._hudKeys.tray.split(',').length : 0;
      // Append only the new balls when the list grew (keeps the drop-in animation on new ones).
      if (this._hudKeys.tray && tkey.startsWith(this._hudKeys.tray + ',')) {
        this.el.tray.insertAdjacentHTML('beforeend', pocketed.slice(prev).map((id) => uiBall(id)).join(''));
      } else {
        this.el.tray.innerHTML = pocketed.map((id) => uiBall(id)).join('');
      }
      this._hudKeys.tray = tkey;
    }

    // Prompt pill.
    const curOnEight = onEightArr ? !!onEightArr[turn] : !!h.onEight;
    // Long text for portrait; short text for horizontal tables (the pill sits between pockets).
    let hint = h.hint != null ? String(h.hint) : null;
    let short = hint;
    let kind = '';
    if (hint == null) {
      if (h.ballInHand) {
        const kitchen = h.ballInHand === 'kitchen';
        hint = kitchen ? 'Ball in hand — behind the head string' : 'Ball in hand — drag the cue ball';
        short = kitchen ? 'Ball in hand · kitchen' : 'Ball in hand';
        kind = 'k-hand';
        if (curOnEight) {
          hint += ' · call the 8';
          short += ' · call the 8';
        }
      } else if (curOnEight) {
        hint = 'Call a pocket for the 8 — tap a pocket';
        short = 'Call a pocket for the 8';
        kind = 'k-eight';
      } else hint = short = h.banner || '';
    }
    const showHint = !!hint && (h.phase == null || h.phase === 'aim' || h.phase === 'decision');
    const hkey = `${showHint}|${hint}|${short}|${kind}`;
    if (this._hudKeys.hint !== hkey && this.el.hint) {
      this._hudKeys.hint = hkey;
      if (showHint) {
        this.el.hint.innerHTML = `<span class="hl">${uiEsc(hint)}</span><span class="hs">${uiEsc(short)}</span>`;
        this.el.hint.className = `hint show ${kind}`.trim();
      } else this.el.hint.classList.remove('show');
    }
  }

  // ------------------------------------------------------------------ toasts, banner, thinking
  toast(text, kind = 'info') {
    if (!text || !this.el.toast) return;
    const k = ['info', 'good', 'foul', 'win', 'loss'].includes(kind) ? kind : 'info';
    const el = document.createElement('div');
    el.className = `toast t-${k}`;
    el.textContent = text;
    this.el.toast.appendChild(el);
    const item = { el, timer: 0 };
    this._toasts.push(item);
    while (this._toasts.length > TOAST_MAX) this._dropToast(this._toasts[0], true);
    void el.offsetWidth; // start the enter transition from the initial state
    el.classList.add('in');
    item.timer = setTimeout(() => this._dropToast(item, false), TOAST_MS);
  }

  _dropToast(item, now) {
    const i = this._toasts.indexOf(item);
    if (i < 0) return;
    this._toasts.splice(i, 1);
    clearTimeout(item.timer);
    if (now) {
      item.el.remove();
      return;
    }
    item.el.classList.remove('in');
    item.el.classList.add('out');
    setTimeout(() => item.el.remove(), 240);
  }

  banner(text, ms = BANNER_MS) {
    if (!this.el.banner || !text) return;
    this.el.bannerText.textContent = text;
    this.el.banner.classList.remove('show');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => this.el.banner.classList.remove('show'), ms);
  }

  setThinking(on, text) {
    if (!this.el.thinking) return;
    if (text) this.el.thinkingText.textContent = text;
    else if (on) {
      const cfg = this._config && Array.isArray(this._config.players) ? this._config.players : null;
      const idx = cfg ? cfg.findIndex((p) => p && p.kind === 'cpu') : 1;
      const name = idx >= 0 ? this._names()[idx] : 'CPU';
      this.el.thinkingText.textContent = `${name && name !== 'You' ? name : 'CPU'} is thinking`;
    }
    this.el.thinking.classList.toggle('show', !!on);
  }

  // Spin indicator dot on #spin; spin = {x, y} fractions of R (x right, y up = follow).
  setSpinIndicator(spin) {
    const s = spin || { x: 0, y: 0 };
    if (!this.el.spin) return;
    this.el.spin.style.setProperty('--sx', String(+s.x || 0));
    this.el.spin.style.setProperty('--sy', String(+s.y || 0));
  }

  get levelLabel() {
    return UI_LEVEL_LABEL[this.settings.level] || 'Medium';
  }
}
