# Architecture and module contracts

Realistic American 8-ball for iPhone Safari. Vanilla JS ES modules, Canvas 2D, no dependencies,
no external assets. Pure modules (constants, vec, rng, table, aim, physics, rules, game, ai) never
touch the DOM and are unit-tested with `node --test`.

**Module style rule** (needed by `scripts/build-single.mjs`, which inlines everything into one HTML):
only top-of-file `import { a, b } from './x.js';` lines (single or multi-line braces) and
`export function|const|class|let` declarations. No default exports, no `export { }` lists, no
dynamic `import()`, no `import * as`. Top-level names must be unique ACROSS ALL MODULES (they share
one scope after inlining) — prefix private helpers with a module tag if they are generic
(e.g. `phys_clamp`), or keep them inside a class/closure.

## Shared conventions (already implemented — do not change without updating everyone)
- `src/constants.js` — geometry, physics constants, colours, `groupOf`, `isStripe`,
  `shotSpeed(power)`, `powerForSpeed(speed)`.
- `src/table.js` — `TABLE = buildTable()`: `{R, HL, HW, headStringX, headSpot, footSpot,
  cushions:[{id,a,b,n,kind:'rail'|'jaw',pocket}], noses:[{x,y,r,pocket}],
  pockets:[{id,kind:'corner'|'side',x,y,captureR,jaws:[p,p],facings:[p,p],mouth,dir}], diamonds}`.
- `src/vec.js` — vector + quaternion helpers (`quatIntegrate`, `quatRotateInv`, `quatForBall`, …).
- `src/rng.js` — `mulberry32(seed)` (returns fn with `.state()`), `gaussian(rng)`, `randInt`.
- `src/layout.js` — `layoutMode(w,h)`, `computeView(cssW,cssH)` → `View {rotated, scale, ox, oy,
  toScreen(x,y), toWorld(sx,sy), angleToScreen(a), angleToWorld(s)}`.
- `src/aim.js` — `traceAim(balls, cx, cy, angle, pockets)` → ghost ball / object & cue directions /
  predicted pocket; `predictPocket`, `rayCircle`, `rayRails`.

Units SI. Origin table centre; +x toward the FOOT rail (break from the head end at −x); +y to the
left looking from head to foot; +z up. Ball ids 0 cue, 1–7 solids, 8, 9–15 stripes. Pocket ids:
0 head-left corner (−HL,+HW), 1 side-left, 2 foot-left corner, 3 foot-right corner, 4 side-right,
5 head-right corner. World angle 0 = +x.

Spin convention: `spin.x` = horizontal tip offset (+ = right english, as seen by the shooter
looking along the shot), `spin.y` = vertical offset (+ = top/follow, − = draw), both fractions of R,
|spin| ≤ 0.5.

## Physics — `src/physics.js`
```js
export class World {
  constructor(table = TABLE)
  balls          // Ball[16] indexed by id: {id,x,y,vx,vy,wx,wy,wz,q:[w,x,y,z],on,state,pocket}
                 // state: 'rest'|'slide'|'roll'|'spin'|'pocketed'
  t; log         // sim time of the current shot; ShotRecord.log of the current shot
  setBalls(list) // [{id,x,y,on}] — zero velocities; keeps each ball's orientation q
  strike(shot)   // shot {angle, power(0..1), spin:{x,y}}; begins a new shot log (seq resets to 0)
  step(dt=DT)    // advance exactly dt with internal time-of-impact sub-stepping; returns new events
  advance(dt)    // fixed-step accumulator for the render loop; returns events produced
  atRest()       // true when nothing moves
  snapshot()     // [{id,x,y,on}] for all 16
  record()       // {log, final: snapshot()}
}
export function strikeVelocity(shot)                 // {vx,vy,wx,wy,wz,miscue}
export function simulateShot(balls, shot, opts)       // headless: opts {dt=AI_DT? , maxT, table}
                                                     // -> {log, final, t}; deterministic
```
Events (every event has a strictly increasing `seq` and sim time `t`):
```
{type:'strike', seq,t, v, miscue}
{type:'ball',   seq,t, a, b, v}            // a<b, v = relative normal speed (m/s)
{type:'cushion',seq,t, ball, v, frozen, cushion}  // only if normal speed > 5 mm/s
{type:'pocket', seq,t, ball, pocket, v}
{type:'offTable',seq,t, ball}              // never produced in v1 (no jumps), reserved
{type:'cross',  seq,t, ball:0, dir}        // cue centre crossed x = headStringX; +1 = leaving kitchen
```

## Rules — `src/rules.js` and game flow — `src/game.js`
Implement `docs/rules-spec.md` (read its "Adaptations" header first). `Shot = {angle, power,
spin:{x,y}, call: null | {pocket}}`.
```js
export class Game {
  constructor({config:{mode:'cpu'|'pvp', players:[{name,kind:'human'|'cpu',level}], raceTo},
               seed, table = TABLE})
  phase      // 'toss'|'aim'|'rolling'|'decision'|'rackOver'|'matchOver'
  state; match; world   // GameState, MatchState, physics World
  on(evt, fn)           // returns unsubscribe
  requirements()        // rules.getShotRequirements(state)
  cuePosition()         // {x,y} current cue ball (or in-hand placement) position
  placeCue(x,y)         // -> {ok,x,y,reason}
  shoot(shot)           // -> {ok,error}
  update(dt)            // drives toss timer + physics; resolves the shot when at rest
  decide(option); concede(); acceptStalemate(); nextRack(); rematch()
  serialize(); static restore(json)
}
// events: 'state' (), 'toss' ({breaker}), 'message' ({text,kind}), 'shotStart' ({shot,player}),
// 'physics' (Event[]), 'shotEnd' ({outcome}), 'decision' ({decision}),
// 'rackOver' ({winner,reason,score}), 'matchOver' ({winner,score}), 'cpuTurn' ({player,level})
```

## AI — `src/ai.js`
```js
export const LEVELS = { easy:{…}, medium:{…}, hard:{…}, pro:{…} }
export async function planTurn(state, {level, seed, table=TABLE, yieldFn, now, budgetMs})
  // -> {place: {x,y} | null, shot: {angle, power, spin:{x,y}, call}, info}
export function chooseDecision(decision) // option string for 'illegalBreak' prompts
```

## Render — `src/render.js`
```js
export class Renderer {
  constructor(canvas, {table = TABLE, cloth:'green'|'blue'})
  setView(view, dpr)   // view from layout.computeView; rebuilds cached static layers
  setCloth(name)
  onPocket(ev, ball)   // start a drop animation for a pocketed ball (ev from physics)
  reset()              // clear animations (new rack)
  pocketAtScreen(sx, sy) -> pocketId | null   // hit test in CSS px, >= 22px radius
  draw(scene)
}
scene = {
  time,                    // seconds (performance.now()/1000)
  balls,                   // world.balls (uses id,x,y,q,on)
  cue: null | {x, y, angle, pull, stroke, visible},   // pull 0..1 (power), stroke 0..1 (forward anim)
  guide: null | {x, y, angle, length},                // render runs aim.traceAim itself
  ballInHand: null | {x, y, valid, dragging},
  targets: [],             // ball ids to ring subtly (legal targets) — may be empty
  pockets: null | {selectable, called, suggested},    // pocket-call UI highlight
}
```

## DOM, input, UI — `index.html`, `style.css`, `src/ui.js`, `src/input.js`
`input.js` turns pointer events into aim/power/spin/placement/pocket-call intents:
```js
export class InputController {
  constructor({canvas, powerEl, spinEl, spinPadEl, fineEl, getView, renderer, callbacks})
  // callbacks: onAim(angle), onPower(power), onShoot({angle,power,spin}), onCancel(),
  //            onPlace(x,y) (dragging), onPlaceEnd(x,y), onCallPocket(id), onSpin({x,y})
  setMode({enabled, ballInHand, cue:{x,y}, mustCallPocket})
  angle; power; spin
}
```
`ui.js` owns menus, HUD, toasts, dialogs and settings persistence:
```js
export class UI {
  constructor(root, {onStart(config), onResume(), onRestartRack(), onConcede(), onQuit(),
                      onDecision(option), onNextRack(), onRematch(), onSettings(settings)})
  settings                   // {aimGuide:true, sound:true, cloth:'green', raceTo:3, level:'medium',
                             //  names:['Player 1','Player 2']} persisted in localStorage (try/catch)
  showMenu(); hideMenu()
  updateHud(hud)             // hud: rules.hudInfo(state) + {turn, phase, ballInHand, onEight, score, raceTo}
  toast(text, kind)          // kind: info|good|foul|win|loss
  banner(text)
  showDecision(decision); showRackOver(info); showMatchOver(info); showPause(); hideOverlays()
  setThinking(bool)
}
```

## Main loop — `src/main.js`
Boot → UI menu → `new Game(config)` → rAF loop: `game.update(dt)`, feed physics events to audio
and renderer, compose the `scene`, `renderer.draw(scene)`, update HUD on 'state'. On 'cpuTurn' call
`ai.planTurn`, animate the CPU's cue (aim sweep, pull-back) then `placeCue` + `shoot`.
