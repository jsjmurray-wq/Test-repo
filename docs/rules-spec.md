# Adaptations for this project (read first)

This spec was written before the final geometry was fixed. Where it disagrees with the points
below, these win:

- **Table:** 7-ft bar table, not 9-ft. All geometry comes from `src/constants.js` and
  `src/table.js` (`TABLE.pockets[i] = {id, x, y, captureR, ...}`, `TABLE.headStringX`,
  `TABLE.footSpot`, `TABLE.HL`, `TABLE.HW`, `TABLE.R`). Do not hard-code dimensions.
- **Ruleset:** v1 ships the Casual ruleset only. You may keep `callShot:'all'` paths if they are
  cheap, but the UI never exposes them. Pro-mode tests C01–C04 are optional.
- **Shot:** `Shot = {angle, power, spin:{x,y}, call: null | {pocket}}`. `elevation` is not used.
- **Physics events:** physics emits the `ShotRecord.log` event types in this spec, plus
  `{type:'strike'}` and a `v` (impact speed) field on events. `summarize` must ignore unknown types.
- **Random numbers:** use `mulberry32` from `src/rng.js`. Store its state (`rng.state()`) in
  `MatchState.rng` so a saved game resumes deterministically.
- **Coin toss:** `Game` starts in phase `'toss'` for 1.2 s, emits `'toss'` with the breaker, then
  moves to `'aim'`.
- **Group helper:** `groupOf(id)` lives in `src/constants.js`. Import it rather than redefining it.
- **Module style:** follow the module style rule in `docs/architecture.md`.

---

# 8-Ball Rules Engine and Game State Machine Spec (`src/rules.js`, `src/game.js`)

## 0. Scope and module boundaries

| Module | Purity | Responsibility |
|---|---|---|
| `src/rules.js` | Pure. No DOM, no `Math.random`, no clock, never mutates its inputs | Racking, shot legality, fouls, the 8-ball, group assignment, ball-in-hand, spotting, placement checks, HUD message text |
| `src/game.js` | No DOM. Emits events | Match and rack state machine. Owns the physics world, calls rules, handles match flow, saves state |
| `src/rng.js` | Pure | `mulberry32(seed)`. Its state is a single uint32 kept in the match state |
| `src/table.js` | Constants | The geometry that rules reads (owned by the physics spec; listed below) |

Rules reads only `table.js` and `rng.js`. The AI imports rules and calls `evaluateShot` on simulated shots, so it has to be fast. When the AI passes `{messages:false}`, no strings are built.

### Geometry the rules need (from `table.js`)
Origin is at the table centre. x runs along the long axis: the head rail (break end) is at `x = -HL` and the foot rail at `x = +HL`. y runs across the table, with `|y| ≤ HW`.
- `HL, HW`: half the playing-surface length and width. A 9 ft table is 1.27 m × 0.635 m. A 7 ft table is 0.9906 m × 0.4953 m.
- `R`: ball radius, 0.028575 m (57.15 mm ball).
- `HEAD_STRING_X = -HL/2`, `FOOT_SPOT = {x:+HL/2, y:0}`. The long string runs from the foot spot to the middle of the foot rail, along y=0 for x ∈ [HL/2, HL].
- `POCKETS[0..5]`: `{x, y, captureR}`. Pocket ids are opaque integers 0–5 that the physics, UI and rules all share.

### Ids
Ball ids: `0` is the cue ball, `1–7` solids, `8` the 8-ball, `9–15` stripes.
`groupOf(id)` returns `'cue' | 'solids' | 'eight' | 'stripes'`.

---

## 1. Rule decisions (current WPA World Standardized 8-ball rules vs this game)

| Topic | WPA | This game (default, "Casual") |
|---|---|---|
| Calling | Call shot: ball and pocket for every non-obvious shot. On an open table the group goes to whoever legally pockets their called ball | **Only the 8 is called (pocket only).** Any ball of your group that drops lets you keep shooting ("slop counts"). Optional `callShot:'all'` (Pro) follows WPA |
| First break | Lag | Animated coin toss (seeded RNG). A lag could be added in v2 |
| Later racks | Format is up to the event; alternate break is the usual pro format | **Alternate break** (`'winner'` and `'loser'` are options) |
| Legal break | Pocket a ball, or drive at least 4 object balls to a cushion. Any ball may be hit first | Same |
| Illegal break | Foul. Incoming player chooses: accept the table, re-rack and break, or re-rack and make the offender break again | Same, as a 3-button prompt. The CPU always picks "re-rack & break" |
| Scratch or foul on a legal break | Balls stay down, table open, incoming player gets ball in hand behind the head string, and may not hit a ball behind the string without the cue ball first crossing it | Same, including the kitchen-shot rule (`kitchenRule:true`). Every break foul, including object ball off the table, gives kitchen ball-in-hand, for consistency |
| 8 on the break | Breaker chooses: spot and keep shooting, or re-rack. If the breaker also scratched, the incoming player chooses: re-rack, or spot plus kitchen ball-in-hand | **Always spot** (one of the WPA options, and it needs no prompt). With no foul the breaker continues. With a foul the opponent gets kitchen ball-in-hand. Option: `eightOnBreak:'choose'` |
| Groups on an open table | Table is always open after the break. Any object ball **except the 8** may be hit first | Same. **Hitting the 8 first on an open table is a foul** (old BCA rules only took away the turn; WPA and players of mobile pool expect a foul) |
| Group assignment | Called ball pocketed legally | First ball to drop (lowest event `seq`) on a legal, non-break shot. Balls pocketed on the break never assign groups |
| Fouls | Standard fouls; cue-ball-in-hand anywhere; pocketed balls stay down | Same. Physical fouls (touched ball, double hit, push, foot on floor, shot clock) don't apply |
| Three fouls in a row | **Not in 8-ball** (only 9-ball and 10-ball) | Not used. Foul counts are kept for stats only |
| Jumped object balls | Foul. Never spotted, except the 8 on the break | Same (the code path exists even if physics never jumps a ball) |
| Losing | Fouling while pocketing the 8; pocketing the 8 with the last ball of your group; 8 off the table at any time; 8 in an uncalled pocket; pocketing the 8 when it isn't your legal object ball | Same. **Scratching on an 8-ball shot without pocketing the 8 is only a foul** (bar rules differ; we follow WPA) |
| Stalemate | Referee re-racks; the same player breaks | After 10 turns in a row with nothing pocketed, a "Re-rack?" button appears. The CPU accepts |

```js
export const RULESET_CASUAL = Object.freeze({
  callShot: 'eight',          // 'eight' | 'all'
  breakFoulBallInHand: 'kitchen', // 'kitchen' | 'anywhere'
  kitchenRule: true,
  eightOnBreak: 'spot',       // 'spot' | 'rerack' | 'choose'
  illegalBreak: 'choose',     // 'choose' | 'rerack' (auto: incoming player breaks)
  breakRotation: 'alternate', // 'alternate' | 'winner' | 'loser'
  raceTo: 3,                  // 1,3,5,7
  stalemateOfferAfter: 10,
});
export const RULESET_PRO = Object.freeze({ ...RULESET_CASUAL, callShot: 'all', eightOnBreak: 'choose' });
```

---

## 2. Data structures (plain JSON so they can be saved and restored; no Set or Map)

```js
/** Rack state: what rules reads and writes */
GameState = {
  v: 1,
  ruleset,                         // as above
  players: [{name:'You', kind:'human'}, {name:'CPU', kind:'cpu', level:2}],
  rackNo: 1,
  breaker: 0,                      // who broke this rack
  turn: 0,                         // the shooter
  isBreakShot: true,
  groups: [null, null],            // or ['solids','stripes'] / ['stripes','solids']
  ballInHand: 'kitchen',           // null | 'kitchen' | 'anywhere' (applies to `turn`)
  balls: [{id, x, y, on:true}],    // length 16, positions at rest; on=false when pocketed or off the table
  pocketed: [{ball, pocket, shot, by}], // pocket = -1 for off-table
  pendingDecision: null,           // {type:'illegalBreak', chooser, options:[...], cueInHand}
  shotNo: 0,
  fouls: [0, 0],                   // per rack (stats only)
  dryTurns: 0,                     // turns in a row with no ball pocketed
  history: [],                     // ShotSummary[], capped at 400
  winner: null, endReason: null,
}

MatchState = { config:{mode:'cpu'|'pvp', players, ruleset}, score:[0,0], racks:[{winner, reason, breaker, shots}],
               firstBreaker, winner:null, rng:uint32, game:GameState }

/** What the shooter submits */
Shot = { angle, power, spin:{x,y}, elevation, call: null | {pocket:0..5} | {ball, pocket} | {safety:true} }
```

### Shot record contract (physics must produce this)
Every event has a strictly increasing `seq` (a global counter across sub-steps) and sim time `t` in seconds.
```js
ShotRecord = {
  call,                                  // copied from Shot
  log: [
    {type:'ball',    seq, t, a, b},              // ball-ball collision (a<b; cue is 0)
    {type:'cushion', seq, t, ball, frozen},      // frozen=true if the ball was within 0.5 mm of this cushion at shot start and has not moved away more than 1 mm since
    {type:'pocket',  seq, t, ball, pocket},
    {type:'offTable',seq, t, ball},
    {type:'cross',   seq, t, ball:0, dir},       // cue centre crossed x=HEAD_STRING_X; dir +1 = leaving the kitchen
  ],
  final: [{id, x, y, on}],               // positions at rest (16 entries)
}
```
Physics rules:
- Emit `cushion` only for impacts with normal speed above 5 mm/s, so resting contact doesn't generate noise.
- If the cue ball starts frozen against a ball and its initial velocity points into that ball, emit the `ball` event at the first step.
- Cap each shot at 60 s of sim time, then force all balls to rest.

### `summarize(log, state)`: one pass, O(events)
```js
{ first, firstSeq,            // first ball event involving 0; null if none
  railAfterFirst,             // any non-frozen cushion event (any ball, cue included) with seq > firstSeq
  railBalls,                  // distinct OBJECT balls with a non-frozen cushion event, plus object balls off the table (break only)
  pocketedObj,                // object ids in seq order
  pocketOf,                   // Int8Array(16), -1 = not pocketed
  cuePocketed, cueOffTable, offTableObj,
  cueLeftKitchenFirst }       // a cross event with dir +1 and seq < firstSeq
```
**Split hits:** if two cue contacts happen within `SPLIT_WINDOW = 0.5 ms` of each other and either ball is a legal target, `first` is the legal one. This gives the shooter the benefit of the doubt, as referees do.

---

## 3. `rules.js` API

```js
export function createRack(rng, geom) -> {balls: Ball[16]}      // cue at default kitchen spot
export function newGameState({players, ruleset, breaker, rng}) -> GameState
export function getShotRequirements(state) -> {
  shooter, isBreak, ballInHand,          // null|'kitchen'|'anywhere'
  legalTargets: number[],                // highlight these
  kitchenBlocked: number[],              // can't be hit directly (kitchen rule)
  onEight: boolean, mustCallPocket: boolean, mustCallBall: boolean,
  canCallSafety: boolean }
export function validateShot(state, shot) -> {ok:true} | {ok:false, error:'MISSING_CALL'|'BAD_POCKET'|'PENDING_DECISION'|'BALL_IN_HAND_UNPLACED'}
export function evaluateShot(state, record, opts={messages:true}) -> Outcome
export function applyOutcome(state, record, outcome) -> GameState   // new object; input unchanged
export function applyDecision(state, option, rng) -> GameState
export function defaultDecision(decision) -> option                 // used by the CPU
export function validateCuePlacement(state, {x,y}) -> {ok, reason?:'bounds'|'pocket'|'overlap'|'kitchen'}
export function nearestValidPlacement(state, {x,y}) -> {x,y}
export function spotPosition(balls, ballId, geom) -> {x,y}
export function isOnEight(state, p) -> boolean
export function hudInfo(state) -> {players:[{name, group, remaining:number[]}], banner}
```

```js
Outcome = {
  fouls: FoulCode[],          // detection order; [] = legal
  primaryFoul: FoulCode|null,
  isBreak, breakLegal: boolean|null,
  pocketed: number[], credited: number[],
  continueTurn: boolean, nextPlayer: 0|1,
  ballInHand: null|'kitchen'|'anywhere',          // for nextPlayer
  groupAssigned: null | {player, group},
  respot: [{ball:8, x, y}],
  decision: null | {type:'illegalBreak', chooser, options, cueInHand},
  gameOver: boolean, winner: null|0|1,
  reason: ReasonCode,
  messages: [{text, kind:'info'|'good'|'foul'|'win'|'loss'}],
}
FoulCode   = 'SCRATCH'|'CUE_OFF_TABLE'|'NO_CONTACT'|'WRONG_BALL_FIRST'|'EIGHT_FIRST_OPEN'|'KITCHEN'|'NO_RAIL'|'OBJECT_OFF_TABLE'|'ILLEGAL_BREAK'
ReasonCode = 'BREAK_POT'|'BREAK_DRY'|'BREAK_ILLEGAL'|'BREAK_FOUL'|'EIGHT_ON_BREAK'|'POT'|'MISS'|'OPP_BALL_ONLY'|'FOUL'
           | 'EIGHT_LEGAL'|'EIGHT_EARLY'|'EIGHT_WITH_LAST'|'EIGHT_FOUL'|'EIGHT_WRONG_POCKET'|'EIGHT_OFF_TABLE'|'CONCEDE'
```
Primary-foul priority, used for the message: `SCRATCH > CUE_OFF_TABLE > NO_CONTACT > EIGHT_FIRST_OPEN > WRONG_BALL_FIRST > KITCHEN > NO_RAIL > OBJECT_OFF_TABLE`. When a shot has several fouls, only one penalty applies.

---

## 4. Helper predicates

```js
remaining(st, g)  = st.balls.filter(b => b.on && groupOf(b.id) === g).length
isOnEight(st, p)  = st.groups[p] ? remaining(st, st.groups[p]) === 0
                  : remaining(st,'solids') === 0 && remaining(st,'stripes') === 0  // open table with 14 balls gone
legalTargets(st)  = isBreakShot ? all object balls on the table
                  : isOnEight(st, p) ? [8]
                  : groups[p] ? own group's balls on the table
                  : object balls on the table except 8
inKitchen(ball)   = ball.x < HEAD_STRING_X        // a ball exactly on the string can be hit
```
Every predicate is evaluated on the state at the **start** of the shot.

---

## 5. Racking: `createRack(rng)`

- Row spacing `dx = √3·(R + g/2)`, lateral spacing `dy = 2R + g`. `g = RACK_GAP` comes from physics; suggested 0.02 mm.
- Slot (i, j), with i = 0..4 and j = 0..i: `x = FOOT_SPOT.x + i·dx`, `y = (j − i/2)·dy`. The apex (0,0) sits on the foot spot and the rows run toward the foot rail.
- Slot (2,1) is the 8-ball.
- Back corners (4,0) and (4,4) get one random solid and one random stripe. Which corner gets which is also random.
- The other 12 balls are Fisher–Yates shuffled into the remaining 12 slots using `rng`.
- Optional seeded jitter of up to ±0.03 mm per ball, which must never cause an overlap.
- The cue ball starts on in-hand at `(HEAD_STRING_X − 2R, 0)`. `ballInHand = 'kitchen'` and `isBreakShot = true`.

---

## 6. Break evaluation (`isBreakShot === true`)

```js
const eightDown = S.pocketOf[8] >= 0 || S.offTableObj.includes(8);
const legal     = S.pocketedObj.length > 0 || S.railBalls >= 4;
const cueFoul   = S.cuePocketed || S.cueOffTable;
if (!legal) {
  fouls = ['ILLEGAL_BREAK', ...(cueFoul ? ['SCRATCH'] : [])];
  decision = {type:'illegalBreak', chooser:o,
              options:['acceptTable','rerackBreak','rerackOpponentBreaks'],
              cueInHand: cueFoul ? 'kitchen' : null};
  // If ruleset.illegalBreak==='rerack', skip the prompt and apply 'rerackBreak' automatically.
  return {..., nextPlayer:o, continueTurn:false, reason:'BREAK_ILLEGAL'};
}
fouls = [cueFoul codes..., any object ball off table (8 included) -> 'OBJECT_OFF_TABLE'];
respot = eightDown ? [{ball:8, ...spotPosition(finalWithout(8, cueFoul ? 0 : null), 8)}] : [];
if (fouls.length) -> {nextPlayer:o, ballInHand: ruleset.breakFoulBallInHand, reason: eightDown?'EIGHT_ON_BREAK':'BREAK_FOUL'}
else              -> {continueTurn: S.pocketedObj.length>0,          // the 8 alone counts
                      nextPlayer: continueTurn ? p : o, ballInHand:null,
                      reason: eightDown?'EIGHT_ON_BREAK': continueTurn?'BREAK_POT':'BREAK_DRY'}
// groups stay null; balls pocketed on the break are never credited
```

`applyDecision` options:
- `acceptTable`: the chooser shoots. `isBreakShot = false`, the table stays open, and the cue ball stays where it is, or goes in hand behind the head string if it scratched. Any 8 that left the table is spotted.
- `rerackBreak`: new rack, the chooser breaks.
- `rerackOpponentBreaks`: new rack, the offender breaks again.

None of these changes the score.

---

## 7. Normal-shot evaluation (in order)

1. **Contact checks.**
   - `S.cuePocketed` adds `SCRATCH`. `S.cueOffTable` adds `CUE_OFF_TABLE`.
   - `S.first == null` adds `NO_CONTACT`. In that case the no-rail check is skipped.
   - If the first ball is not a legal target, add `EIGHT_FIRST_OPEN` when the table is open and the first ball is the 8; otherwise add `WRONG_BALL_FIRST`.
   - If `ballInHand === 'kitchen'`, `kitchenRule` is on, the first ball was in the kitchen at shot start, and `!S.cueLeftKitchenFirst`, add `KITCHEN`.
   - If no object ball was pocketed and `!S.railAfterFirst`, add `NO_RAIL`. A cushion before contact (a kick) doesn't count, and neither do frozen-cushion events.
   - Any object ball other than the 8 off the table adds `OBJECT_OFF_TABLE`. That ball stays off the table permanently.
2. **The 8 is down** (pocketed or off the table), checked in this order:
   - `EIGHT_OFF_TABLE`.
   - Otherwise, if the shooter was not on the 8 at shot start: `EIGHT_WITH_LAST` if their own group went from more than 0 to 0 on this shot, else `EIGHT_EARLY`. This includes any 8 pocketed on an open table.
   - Otherwise, if there are any fouls: `EIGHT_FOUL`.
   - Otherwise, if `pocketOf[8] !== call.pocket`: `EIGHT_WRONG_POCKET`.
   - Otherwise `EIGHT_LEGAL`. The shooter wins; for every other reason the opponent wins.
   - Result: `gameOver = true`. Other balls pocketed on the same shot don't matter.
3. **Foul with the 8 still up:** `continueTurn = false`, `nextPlayer = o`, `ballInHand = 'anywhere'`, no group assignment, all pocketed balls stay down, `fouls[p]++`.
4. **Legal shot:**
   - **`'eight'` mode, groups assigned:** `credited` = pocketed balls of the shooter's own group.
   - **`'eight'` mode, open table:** `credited` = all pocketed object balls (the 8 can't be among them by this point). If any were pocketed, `groupAssigned = {player:p, group: groupOf(S.pocketedObj[0])}`. Because `seq` is unique, the first ball to drop is never a tie. The other player gets the other group.
   - **`'all'` mode:** `credited` = the called ball, if it went into the called pocket and `!call.safety`. On an open table the group comes from the called ball.
   - `continueTurn = credited.length > 0`. Reason is `POT`, `OPP_BALL_ONLY` (only opponent balls dropped) or `MISS`.
   - A legal shot on the 8 that doesn't pocket it gives `MISS`, and the turn passes.
5. **Bookkeeping:** `dryTurns` resets to 0 if any ball was pocketed and otherwise increases by 1. Add a history entry `{n, shooter, call, first, pocketed, fouls, reason}`.

An evaluation that receives no `call` while the shooter is on the 8 (which `validateShot` should prevent) adds no foul. Any 8 pocketed on that shot counts as `EIGHT_WRONG_POCKET`.

---

## 8. Ball-in-hand and spotting

### `validateCuePlacement(state, p)`
Checks run in this order:
1. **bounds:** `|x| ≤ HL − R` and `|y| ≤ HW − R`.
2. **pocket:** for every pocket, `dist(p, pocket) ≥ captureR + R + 1 mm`.
3. **overlap:** for every ball on the table except the cue, `dist ≥ 2R + 0.1 mm`.
4. **kitchen** (when `ballInHand === 'kitchen'`): `x < HEAD_STRING_X` strictly.

### `nearestValidPlacement(state, p)`
Used by the UI while the player drags the cue ball. It must be deterministic.
1. Clamp to the allowed rectangle (the kitchen sets `x ≤ HEAD_STRING_X − 1e-6`).
2. Up to 8 times: push the point straight out from the deepest overlapping ball to `2R + 0.2 mm`, then clamp again.
3. If it is still invalid, search rings of radius `k·R/2` for k = 1..40, at 16 angles each (0°, 22.5°, …). Return the first valid point.

Default start positions: after a scratch with ball-in-hand anywhere, the head spot `(HEAD_STRING_X, 0)`. After a non-scratch foul, wherever the cue ball stopped. For the kitchen, `(HEAD_STRING_X − 2R, 0)`. Each default goes through `nearestValidPlacement`.

### `spotPosition(balls, 8)` (follows the WPA spotting rule)
1. For each ball on the table with `|by| < 2R + ε`, block the x-interval `bx ± √((2R+ε)² − by²)`. Use `ε = 0.05 mm` for object balls (the 8 may end up frozen to one) and `ε = 1 mm` for the cue ball (never frozen to it).
2. Merge the intervals.
3. The answer is the smallest free x in `[FOOT_SPOT.x, HL − R]`, i.e. on the long string behind the foot spot.
4. If there is none, take the largest free x ≤ `FOOT_SPOT.x`, in front of the spot toward the head rail.
5. Always use y = 0.

---

## 9. Calling the pocket: contract between UI and rules

- Before every shot the UI calls `getShotRequirements(state)`. When `mustCallPocket` is true (shooter on the 8 in `'eight'` mode), the HUD shows "Tap a pocket to call the 8-ball", the 6 pockets get tap rings at least 44 pt across, and the shoot control is disabled until `call.pocket` is set.
- Convenience: if the predicted path of the 8 (ghost ball plus line) ends inside one pocket's capture zone, that pocket is pre-selected and labelled "Called". The player can tap another pocket.
- The call is cleared after every shot. The called pocket stays highlighted while the balls roll.
- The CPU sets `call` itself. `game.shoot()` runs `validateShot` and refuses an invalid shot with an error code.
- In `'all'` mode the player first taps a ball, then a pocket. A "Safety" toggle sets `call = {safety:true}`.

---

## 10. `game.js`: state machine and match flow

```
setup → coinToss(1.2 s) → startRack(breaker) → AIM ─shoot(shot)→ ROLLING ─atRest→ resolve
resolve → gameOver ? RACK_OVER : decision ? DECISION : AIM
DECISION ─decide(opt)→ AIM | startRack
RACK_OVER ─nextRack()→ (score[w] ≥ raceTo ? MATCH_OVER : startRack(nextBreaker))
MATCH_OVER ─rematch()→ startRack(loser of last match), score [0,0]
```

```js
export class Game {
  constructor({config, physics, seed})
  get phase(); get state(); get match()
  on(evt, fn)   // 'state','message','shotStart','shotEnd'(outcome),'decision','rackOver','matchOver','cpuTurn'
  requirements()
  placeCue(x, y) -> {ok, x, y, reason}    // AIM phase with ballInHand only; snaps via nearestValidPlacement
  shoot(shot) -> {ok, error?}
  update(dt)       // feeds the physics fixed-step accumulator; resolves the shot when all balls are at rest
  decide(option); concede(); acceptStalemate(); nextRack(); rematch()
  serialize() -> string; static restore(json, physics) -> Game
}
```

- `nextBreaker`:
  - `alternate`: whoever did not break the last rack.
  - `winner` / `loser`: the winner or loser of the last rack.
- Rematch: the loser of the match breaks first.
- On resolve:
  - Copy `record.final` into the state and apply `respot`.
  - Cue ball pocketed or off the table: set `on = false` until it is placed.
  - Emit messages: the primary toast stays on screen for 1.6 s; at most 3 messages per shot.
  - Autosave to `localStorage['pool8.save.v1']` (wrapped in try/catch).
  - On the CPU's turn, emit `cpuTurn` after a 600 ms pause.
- `concede()` ends the rack with `CONCEDE` and the opponent wins it.
- `acceptStalemate()` is allowed when `dryTurns ≥ stalemateOfferAfter`. It re-racks with the same breaker and no score change.
- The score and rack history stay in `MatchState`. The rack-over panel reads, for example, "You win the rack — 8-ball in the called pocket · 2–1 · [Next rack]".
- Pass-and-play has no hidden information, so there is no hand-off screen, just a 1.2 s banner such as "Player 2 — your shot". Flipping the table view for each player is a UI option.

---

## 11. HUD message templates

Name helpers: `N` is the shooter, `O` the opponent. "You" takes plural verbs: "You are" / "CPU is", "You win" / "CPU wins".

| Code | Text |
|---|---|
| turn | "Your shot" / "Player 2's shot" (+ " — ball in hand" / " — ball in hand behind the head string") |
| BREAK_POT | "Good break — {N} shoot(s) again. Table is open" |
| BREAK_DRY | "Legal break — table is open. {O}'s shot" |
| BREAK_ILLEGAL | "Illegal break — needs a ball pocketed or 4 balls to a cushion ({k} hit)". Buttons: "Play from here" / "Re-rack & break" / "Re-rack, {N} break(s) again" |
| BREAK_FOUL | "Scratch on the break — {O} has ball in hand behind the head string" |
| EIGHT_ON_BREAK | "8-ball down on the break — re-spotted" |
| groupAssigned | "{N} {is/are} Solids · {O} {is/are} Stripes" |
| SCRATCH | "Foul: scratch — {O} has ball in hand" |
| CUE_OFF_TABLE | "Foul: cue ball off the table — ball in hand" |
| NO_CONTACT | "Foul: no ball hit — ball in hand" |
| WRONG_BALL_FIRST | "Foul: hit the {n}-ball first — ball in hand" |
| EIGHT_FIRST_OPEN | "Foul: can't hit the 8 first on an open table — ball in hand" |
| KITCHEN | "Foul: shoot out of the kitchen first — ball in hand" |
| NO_RAIL | "Foul: no cushion after contact — ball in hand" |
| OBJECT_OFF_TABLE | "Foul: ball off the table — ball in hand" |
| OPP_BALL_ONLY | "Pocketed {O}'s ball — turn over" |
| on the 8 | "{N} {is/are} on the 8 — call a pocket" |
| EIGHT_LEGAL | "{N} win(s) the rack!" |
| EIGHT_EARLY | "8-ball pocketed early — {O} win(s) the rack" |
| EIGHT_WITH_LAST | "8-ball went down with the last {group} — {O} win(s)" |
| EIGHT_FOUL | "Scratched on the 8 — {O} win(s)" (if the primary foul is not a scratch: "Fouled on the 8 — …") |
| EIGHT_WRONG_POCKET | "8-ball in the wrong pocket — {O} win(s)" |
| EIGHT_OFF_TABLE | "8-ball off the table — {O} win(s)" |
| match | "{N} win(s) the match {a}–{b}!" |

---

## 12. Required tests (`tests/rules.test.js`, `node --test`)

Fixtures:
- `mkState({groups, on:[ids], turn, ballInHand, isBreak, pos:{id:[x,y]}})`
- Log builders `hit(b)`, `rail(b, {frozen})`, `pot(b, pocket)`, `off(b)`, `cross(dir)`. Each builder takes the next `seq` automatically.
- Every state is passed through `deepFreeze`, so any mutation throws.

**Break**
- B01 `break.pot.continues`: pocketing a solid lets the breaker continue; the table stays open and no group is assigned.
- B02 `break.fourRails.passes`: 4 distinct balls to a cushion, nothing pocketed. The opponent shoots with no ball-in-hand.
- B03 `break.bothGroups.open`: balls of both groups pocketed; the table stays open.
- B04 `break.threeRails.illegal`: `ILLEGAL_BREAK`, with a decision for the opponent offering 3 options.
- B05 `break.sameBallTwice.countsOnce`: 2 balls producing 5 cushion events is an illegal break.
- B06 `break.cueRails.dontCount`.
- B07 `break.totalMiss.illegal`.
- B08 `break.illegal.scratch.acceptGivesKitchen`.
- B09 `decision.acceptTable`: the cue ball stays where it lies and `isBreakShot` becomes false.
- B10 `decision.rerackBreak`: the chooser breaks.
- B11 `decision.rerackOpponentBreaks`.
- B12 `break.scratch.legal`: kitchen ball-in-hand for the opponent, pocketed balls stay down, table open.
- B13 `break.eight.spotted.continue`: the 8 goes back on the foot spot exactly.
- B14 `break.eight.footSpotBlocked`: the 8 goes behind the spot on the long string, gap ≤ 0.1 mm.
- B15 `break.eight.longStringBlocked`: the 8 goes in front of the foot spot.
- B16 `break.eight.cueBlocks`: gap to the cue ball ≥ 1 mm.
- B17 `break.eight.scratch`: the 8 is spotted, the opponent gets kitchen ball-in-hand, and nobody loses.
- B18 `break.eight.offTable`: spotted, counts as a foul, kitchen ball-in-hand.
- B19 `break.objectOffTable`: foul; the ball is not spotted.
- B20 `break.onlyEight.continues`.

**Open table**
- O01 `open.stripe.assigns`: the shooter gets stripes, the opponent solids, the shooter continues, and the message appears.
- O02 `open.combo.solidToStripe.legal`.
- O03 `open.bothGroups.firstDropWins`.
- O04 `open.eightFirst.foul`: pocketed balls stay down, the table stays open, ball-in-hand anywhere.
- O05 `open.scratch.noAssign`.
- O06 `open.miss.passes`.
- O07 `open.eightPocketed.loss`: reason `EIGHT_EARLY`.
- O08 `open.onlyEightLeft.callAndWin`.
- O09 `assign.groupAlreadyCleared.onEight`.
- O10 `kitchen.directShot.foul`.
- O11 `kitchen.leaveAndReturn.legal`.
- O12 `kitchen.ballOnString.hittable`.

**Group play**
- G01 `own.pot.continue`.
- G02 `own.plusOpp.continue`.
- G03 `oppOnly.passes.noFoul`.
- G04 `wrongFirst.ownPotted.foul`: the own ball stays down.
- G05 `eightFirst.groupRemains.foul`.
- G06 `noContact.foul`.
- G07 `noRail.foul`.
- G08 `kick.railBeforeOnly.foul`.
- G09 `kick.objectHitsRail.legal`.
- G10 `cueRailAfter.legal`.
- G11 `frozenRail.noLeave.foul`.
- G12 `scratch.withOwnPot.noContinue`.
- G13 `cueOffTable.foul`.
- G14 `objectOff.permanent.reducesGroup`.
- G15 `multiFoul.singlePenalty.primaryScratch`.
- G16 `oppPotsMyLast.onFoul.BIHandCall`.
- G17 `clearGroup.requirementsEightAndCall`.
- G18 `splitHit.legalWins`.

**The 8-ball**
- E01 `eight.calledPocket.win`.
- E02 `eight.wrongPocket.loss`.
- E03 `eight.scratch.loss`.
- E04 `eight.wrongFirst.loss`.
- E05 `eight.scratchNoPot.foulOnly`.
- E06 `eight.miss.foul`.
- E07 `eight.noRail.foul`.
- E08 `eight.withOppBall.win`.
- E09 `eight.withLastBall.loss`.
- E10 `eight.comboEarly.loss`.
- E11 `eight.offTable.loss`.
- E12 `validate.missingCall`.
- E13 `eight.cueOff.loss`.

**Placement and racking**
- P01 `place.valid`.
- P02 `place.overlap`.
- P03 `place.bounds`.
- P04 `place.kitchen`.
- P05 `place.pocket`.
- P06 `nearest.validDeterministic`.
- R01 `rack.layout`: the 8 in the centre slot, apex on the foot spot, one solid and one stripe in the back corners, no overlaps.
- R02 `rack.seedDeterminism`.

**Match**
- M01 `match.alternateBreak`.
- M02 `match.winnerBreaks`.
- M03 `match.raceToEnds`.
- M04 `match.rematchLoserBreaks`.
- M05 `concede`.
- M06 `stalemate.offerAndRerack`.
- M07 `state.jsonRoundTrip`.
- M08 `evaluate.pureDeterministic`.
- M09 `fouls.counted.noThreeFoulLoss`.

**Pro mode**
- C01 `all.calledPot.continue`.
- C02 `all.uncalledOwnPot.passes`.
- C03 `all.safety.passes`.
- C04 `all.openAssignByCalled`.

---

## 13. Implementation notes and pitfalls
- Read "on the 8", the shooter's group and kitchen membership from the state **before** the shot, never after it.
- `seq` must be unique and strictly increasing across all sub-steps. Rail-after-contact and first-to-drop both depend on it.
- `evaluateShot` should make one pass over the log and allocate nothing beyond the outcome. The AI target is 2,000 evaluations in under 5 ms on an iPhone.
- `applyOutcome` copies the 16-entry balls array and never mutates its input.
- `validateShot` refuses to shoot while `pendingDecision` is set, or while the cue ball is in hand and `on = false`.

I made several calls without checking the WPA text, so please confirm them:
- Hitting the 8 first on an open table is a foul. That follows the current WPA wording; older BCA rules only took away the turn.
- After a scratch on the break the opponent gets ball-in-hand behind the head string, with the kitchen-shot restriction.
- A ball frozen to a cushion doesn't count as reaching that cushion unless it leaves and comes back.
- Splitting a simultaneous hit in the shooter's favour is a referee convention, not a written rule.

If any of these turns out wrong, change the ruleset flag or the single line of logic that implements it.
