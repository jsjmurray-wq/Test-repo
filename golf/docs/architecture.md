# Golf — architecture and module contracts

A realistic 3D golf game for iPhone Safari (and any modern browser). It is built with vanilla JS
ES modules and a custom WebGL renderer, with no dependencies and no external assets. It lives
entirely in `golf/` and imports nothing from the pool game in the repository root.

The game has 9 hand-designed holes (par 36) and is solo stroke play. You swing by swiping.

**Module style rule** (needed by `golf/scripts/build-single.mjs`, which inlines every module into
one HTML file, each wrapped in its own function scope):
- Only top-of-file `import { a, b as c } from './x.js';` lines (single or multi-line braces).
- Only `export function|async function|const|let|class` declarations.
- No default exports, no `export { }` lists, no re-exports, no dynamic `import()`, no `import * as`,
  and no top-level `await`.
- Relative imports only (`./x.js`), and every module lives directly in `golf/src/`.
- Pure modules never touch the DOM, `window` or `document`. They are unit-tested with `node --test`.

Units are SI internally (m, s, kg, rad/s). The world axes are **+x east, +y north, +z up**.
Each hole is authored in its own local frame, with the tee near the origin.

**Yaw** is in radians: 0 = +x, counter-clockwise positive. Use `yawDir(yaw)` from `vec3.js`.
For a horizontal direction `dir`, the golfer's **right** is `dir × ẑ`. When facing +y, right is +x.

Distances are displayed in **yards** by default, with a metres setting. Putts show in feet (or
metres). Wind shows in mph (or km/h).

## File ownership (parallel build)

| Group | Files |
|---|---|
| Shared (already written) | `src/constants.js`, `src/vec3.js`, `src/rng.js`. Change only with care: add, don't rename |
| Physics | `src/clubs.js`, `src/aero.js`, `src/physics.js`, `scripts/calibrate.mjs`, `tests/clubs.test.js`, `tests/aero.test.js`, `tests/physics.test.js`, `tests/putting.test.js`. May tune numeric values in `SURFACES` in `constants.js` |
| Course | `src/noise.js`, `src/spline.js`, `src/terrain.js`, `src/course.js`, `scripts/course-report.mjs`, `tests/terrain.test.js`, `tests/course.test.js` |
| Render | `src/mat4.js`, `src/gl.js`, `src/shaders.js`, `src/meshes.js`, `src/bake.js`, `src/render.js`, `src/camera.js`, `tests/camera.test.js`, `tests/meshes.test.js`, `tests/visual/render-preview.html` and `.js` |
| Shell/UI | `index.html`, `style.css`, `manifest.webmanifest`, `package.json`, `eslint.config.js`, `scripts/build-single.mjs`, `scripts/make-icons.mjs`, `icons/*`, `src/ui.js`, `src/input.js`, `src/audio.js`, `README.md` |
| Game | `src/lie.js`, `src/swing.js`, `src/caddie.js`, `src/rules.js`, `src/scoring.js`, `src/game.js`, `src/bot.js`, `tests/lie.test.js`, `tests/swing.test.js`, `tests/rules.test.js`, `tests/game.test.js`, `tests/bot.test.js` |
| Integration | `src/main.js`, `tests/e2e.spec.mjs`, `dist/*`, plus fixes anywhere |

## Pure modules

| Module | Responsibility and key exports |
|---|---|
| `constants.js` | `BALL_*`, `G`, `RHO`, `SPIN_TAU`, wind constants, `CUP_R`, `FLAGSTICK_*`, `CLUB_LENGTH`, `DT_AIR`, `DT_GROUND`, `MAX_SHOT_T`, `RECORD_HZ`, `SURF`, `SURF_NAMES`, `SURFACES`, unit helpers (`mToYd`, `ydToM`, `mToFt`, `rpmToRad`, `radToRpm`, `fmtDist(m, units, {short})`, `fmtWind`) |
| `rng.js` | `mulberry32(seed)` returns a function with `.state()`; also `gaussian(rng)` and `randInt` |
| `vec3.js` | `{x,y,z}` helpers: `v3`, `add`, `sub`, `scale`, `dot`, `cross`, `len`, `norm`, `dist`, `dist2d`; out-param `set`, `addTo`, `crossTo`; `clamp`, `lerp`, `smoothstep`, `damp`, `normalizeAngle`, `yawDir`, `yawOf`, `DEG` |
| `mat4.js` | `perspective`, `lookAt`, `multiply`, `invert`, `transformPoint`, `project(viewProj, p, w, h)`, `unproject`. Matrices are column-major `Float32Array(16)` |
| `noise.js` | `hash2(ix,iy,seed)`, `valueNoise2(x,y,seed)`, `fbm2(x,y,{oct,lac,gain,seed})`. Deterministic |
| `spline.js` | Centripetal Catmull–Rom. `buildPath(points)` returns `{length, pointAt(s), tangentAt(s), project(x,y) -> {s, lat, dist}}`. `lat` is + to the right of travel. Uses a dense 1 m polyline plus a bucket grid |
| `clubs.js` | `CLUBS` (array, longest first), `clubById(id)`, `stockLaunch(club, opts)`, `makeLaunch(...)`, `dPlane(club, face, path)`, `PUTTER_ID = 'P'` |
| `aero.js` | `dragCoeff(S)`, `liftCoeff(S)`, `windAt(wind10, zAgl, out?)` (log profile), `windFactor(zAgl)`, `flightAccel(state:{v,w,zAgl}, wind10, out)` |
| `course.js` | `COURSE = {name, holes: [HoleDef × 9]}` (pure data), `holePar(i)`, `coursePar()` |
| `terrain.js` | `buildHole(def, {pinIndex, seed}) -> HoleTerrain` (see below) |
| `physics.js` | `simulateShot(terrain, launch, opts) -> ShotResult`. Exported for tests: `flightStep`, `bounceImpulse`, `rollStep`, `cupCheck`, `treeHit`, `stimpDistance(v0, surf)`, `puttSpeedForDistance(D, surf)` |
| `lie.js` | `lieAt(terrain, pos, aimYaw, {handed}) -> Lie`, `applyLie(launchParams, lie, club)` |
| `swing.js` | `interpretSwing(samples, opts) -> SwingResult`, `swingToLaunch(club, lie, swing, aimYaw, rng, opts) -> Launch` |
| `caddie.js` | `clubTable(terrain, pos, lie, wind)`, `suggestClub(...)`, `playsLike(...)`, `puttRange(dist)` |
| `rules.js` | `resolveShot(ctx, shot) -> Resolution`, `waterRelief(...)`, `scoreName(strokes, par)`, `maxStrokes(par) = 2*par` |
| `scoring.js` | `newCard(course)`, `recordHole(card, i, {strokes, putts, penalties, fir, gir})`, `totals(card)` |
| `game.js` | `Game` state machine, plus `serialize()` and `static restore()` |
| `bot.js` | `planShot(game) -> {clubId, yaw, swing, puttRange?}`, `playBotShot(game)`, `botDecide(game)`: a simulated "decent player" used by `?autoplay` and the playability tests |
| `camera.js` | `CameraRig`, which produces `{eye, target, up, fovY, near, far}` (pure maths) |
| `meshes.js` | Geometry builders that return typed arrays |
| `bake.js` | `bakeTerrainColor(terrain)` and `bakeClouds(seed)` |

DOM and GL modules: `gl.js`, `shaders.js`, `render.js`, `input.js`, `ui.js`, `audio.js`, `main.js`.

---

## 1. Clubs (`clubs.js`)

The table is calibrated to a **good amateur (about 5 handicap)**: driver carry about 240 yd,
total about 260 yd. Each entry has these fields:

```
{id, name, short, kind:'wood'|'hybrid'|'iron'|'wedge'|'putter', loft, spinLoft,
 ballSpeed (m/s, full swing), launch (deg), spinRpm, targetCarryYd}
```

| id | Club | Loft ° | Ball m/s | Launch ° | Spin rpm | Target carry yd |
|---|---|---|---|---|---|---|
| D | Driver | 10.5 | 67.1 | 12.0 | 2800 | 244 |
| 3W | 3 Wood | 15 | 63.0 | 10.5 | 3800 | 228 |
| 5W | 5 Wood | 18 | 59.9 | 11.5 | 4400 | 216 |
| 4H | 4 Hybrid | 22 | 56.8 | 12.5 | 4700 | 203 |
| 5i | 5 Iron | 26 | 53.6 | 13.0 | 5300 | 190 |
| 6i | 6 Iron | 30 | 51.0 | 14.5 | 6100 | 178 |
| 7i | 7 Iron | 34 | 48.3 | 16.5 | 7000 | 165 |
| 8i | 8 Iron | 38 | 45.6 | 18.5 | 7800 | 152 |
| 9i | 9 Iron | 42 | 42.9 | 21 | 8500 | 138 |
| PW | Pitching W | 46 | 39.8 | 24 | 9000 | 123 |
| GW | Gap W | 50 | 36.7 | 27 | 9400 | 108 |
| SW | Sand W | 56 | 33.1 | 31 | 9800 | 91 |
| LW | Lob W | 60 | 29.1 | 34 | 9600 | 74 |
| P | Putter | 3 | – | 0 (starts rolling) | 0 | – |

`spinLoft` runs from about 13° for the driver to about 50° for the LW and is used for the D-plane
curve. `scripts/calibrate.mjs` re-solves `ballSpeed` by bisection so that the simulated carry
matches `targetCarryYd`, then prints the table.

## 2. Ball physics (`aero.js`, `physics.js`)

### Flight

The state is `p`, `v` and `ω` (rad/s), all 3D. The air-relative velocity is `u = v − W(z_agl)`.

```
S   = R·|ω| / |u|                (clamp S to [0, 0.6])
C_D = 0.24 + 0.18·S
C_L = 0.54 · S^0.4
a   = −g ẑ − (ρA/2m)·C_D·|u|·u + (ρA/2m)·C_L·|u|²·(ω̂ × û)
ω  *= exp(−dt/SPIN_TAU)
```

- **Wind** uses a log profile, `W(z) = W10 · ln(max(z_agl, 0.5)/z0) / ln(10/z0)`. The wind object
  is `{x, y}` in m/s at 10 m.
- **Integration** is RK4 at `DT_AIR`. On a sign change of `z − R − h(x,y)`, bisect up to 8 times
  for the time of impact, then bounce.

### Launch vector (`swingToLaunch` builds it; physics consumes it)

```
Launch = {pos:{x,y,z}, vel:{x,y,z}, spin:{x,y,z} (rad/s), mode:'air'|'roll',
          meta:{club, ballSpeed, launchDeg, spinRpm, tiltDeg, startDirDeg}}
```

- `dir` is the horizontal unit vector at `aimYaw + startDir`; `right = dir × ẑ`.
- `v0 = ballSpeed·(cos L·dir + sin L·ẑ)`.
- `ω = spinRad·(cos(tilt)·right − sin(tilt)·ẑ)`.
  - A positive tilt makes the ball curve right (fade or slice for a right-hander).
  - With zero tilt, `ω̂ × v̂ = +ẑ`, i.e. pure backspin lift.
- D-plane: `tan(tilt) = (face − path)/spinLoft` (degrees over degrees), clamped to ±45°.
  `startDir = k·face + (1−k)·path`, with k = 0.85 for woods and 0.75 for irons.
- Putts use `mode:'roll'`: the ball starts on the ground in pure roll.

### Bounce (Penner crater model, 3D, scaled per surface)

1. Get the normal `n`. Crater tilt `θc = 15.4°·(|v|/18.6)·(θ_in/44.4°)·surf.crater`, clamped
   to ≤ 28°. Rotate `n` toward `−v̂_t` by θc to get `n_eff`.
2. Restitution: `e = (vn ≤ 20 ? 0.510 − 0.0375·vn + 0.000903·vn² : 0.12)·surf.e`.
   Normal impulse per unit mass: `Jn = (1+e)·vn`.
3. Slip `s = v_t + ω × (−R n_eff)`. Tangential impulse:
   `Jt = −min(surf.mu·Jn, (2/7)|s|)·ŝ`.
4. Apply `v += Jn·n_eff + Jt` and `ω += (5/(2R))·((−n_eff) × Jt)`. Multiply ω by
   `surf.spinKeep` first.
5. Cap the reverse horizontal speed at `surf.maxBack`.
6. Switch to the ground phase when the outgoing normal speed is below 0.5 m/s.

### Ground phase (`DT_GROUND`)

The ball is constrained to the surface.

- **Skid** while the contact slip exceeds 0.01 m/s: `μS·g` opposes the slip, and ω gets the
  matching torque. This gives check and spin-back.
- **Roll:** `a = (5/7)·g_t − (a0 + kv·|v|)·v̂`, where `g_t` is gravity projected onto the tangent
  plane.
  - Stimp closed form: `D = v0/kv − (a0/kv²)·ln(1 + kv·v0/a0)`. With v0 = 1.83 m/s on the green,
    that gives about 10.2 ft.
- **Rest** when `|v| < 0.01` and `(5/7)·g·|∇h| < a0·1.05`.
- Going over a crest makes the ball airborne again.
- Surface `WATER` under the ball centre gives outcome `'water'`.

### Cup (`cupCheck`, every ground step)

- Swept segment-versus-circle test. The capture speed is `v_cap(b) = 2√(CUP_R²−b²)/√(2R/g)`,
  which is about 1.64 m/s through the centre.
- If `v ≤ v_cap`, the ball is holed.
- Otherwise it deflects by `sign(b)·min(35°, 40°·(|b|/CUP_R)·(v_cap/v))` and its speed is
  multiplied by `(1−0.25·v_cap/v)`. Emit `lipout` when `|b| > 0.4·CUP_R`.
- On the fly, a ball landing within `CUP_R−R` with horizontal speed under 3 m/s is holed.
- A ball at rest within `CUP_R` drops.

### Trees

`terrain.trees` entries look like `{x, y, z, trunkR, trunkH, canopy:{cz, rx, rz}, kind}`.
Use `terrain.treesNear(x, y, r)` to find them.

- **Trunk:** a hard cylinder, e = 0.4.
- **Canopy ellipsoid:** on each traversal, roll `p_hit = 1 − exp(−pathLen/3)` with the shot rng.
  On a hit, multiply v by 0.25–0.45, randomise the direction in a 60° cone (biased down), multiply
  spin by 0.3, and emit a `tree` event.

### `simulateShot` (instant, headless, deterministic)

```js
simulateShot(terrain, launch, {wind = {x:0,y:0}, seed = 1, maxT = MAX_SHOT_T, record = true}) -> {
  path: Float32Array,  // [t,x,y,z]* at RECORD_HZ, for playback, trail and camera
  events: [{type:'launch'|'land'|'bounce'|'tree'|'lipout'|'cup'|'water'|'rest'|'pin', t, x,y,z, surface, v}],
  final: {x,y,z, surface, outcome:'rest'|'holed'|'water'|'ob'},
  carry, total, apex, landing:{x,y,z}|null, waterEntry:{x,y}|null, lastDry:{x,y}|null, t
}
```

- The outcome is `'ob'` when the ball rests on `SURF.OOB` or `terrain.isOOB(x,y)` is true.
- `carry` is the horizontal distance from launch to the first landing. `total` is the horizontal
  distance from launch to the final position.

**Physics implementation notes (as built):**

- `launch.pos` is the ball **centre** (ground + `BALL_R`); a lower z is lifted to ground + R.
- `startDirDeg` and `tiltDeg` are both **+ = right**, so the launch direction is
  `yawDir(aimYaw − startDir)` (yaw is counter-clockwise). `clubs.js` exports
  `makeLaunch({pos, aimYaw, ballSpeed, launchDeg, spinRpm, tiltDeg, startDirDeg, club, mode})`
  and `dPlane(club, faceDeg, pathDeg) -> {tiltDeg, startDirDeg}` for `swingToLaunch` to reuse;
  `stockLaunch(club|id, {pos, aimYaw, speedScale, spinScale, tiltDeg, startDirDeg, faceToPathDeg,
  ballSpeed})` is a full stock swing (putter: `mode:'roll'` with `opts.ballSpeed`).
- `apex` is metres above the launch point. `land`/`bounce` events also carry `angle` (descent,
  deg). Putts (`mode:'roll'`) never "land": `carry = 0`, `landing = null`.
- Extra option `pin` (default `true` unless the launch is a putt) enables flagstick collisions in
  the air (`'pin'` event). Slam dunk and rest-over-the-hole give `'cup'`.
- `waterEntry` is where the path last crossed into `SURF.WATER` (bisected on `surfaceAt`);
  `lastDry` is the last sampled ball position over dry ground. Over water the contact height is
  `max(heightAt, waterAt().level)`.
- Tree `canopy.cz` is the **absolute** world z of the canopy centre (the HoleTerrain convention
  below; the renderer uses it too). `treesNear` is queried with r = 12 m. A canopy hit keeps 25–45% of the speed, re-aims within a 30° half-angle cone
  plus a downward bias, and keeps 30% of the spin.
- `SURFACES` entries may have an optional `plough` (sand: 0.6), the fraction of the outgoing
  tangential speed and spin lost on impact, because the Coulomb cap (2/7 slip) alone lets a ball
  skip out of a bunker.
- Other exports: `rollStep(s, n, surf, dt)`, `cupCheck(p0, p1, v, cup) -> {holed, lipout, b,
  vCap}|null` (b + = ball passes right of centre; mutates v on a lip-out),
  `treeHit(tree, p0, p1)`, `flightStep(s, dt, wind, groundZ)`, `bounceImpulse(v, w, n, surf)`,
  and `planeTerrain({surface, sx, sy, z0, cup, heightFn, surfaceFn, waterFn, oobFn, trees})`, a
  synthetic HoleTerrain for calibration, tests and caddie tables.
- Calibrated green: a0 = 0.45, kv = 0.075 (Stimp 1.83 m/s → 3.10 m ≈ 10.2 ft).

## 3. Course (`course.js`, `terrain.js`)

### HoleDef (authoring format, private to the Course group)

Everything is placed by **(s, off)**: `s` is the arc length along the centreline spline from the
tee, and `off` is the lateral offset (+ = right looking down the hole). Holes may be green-relative
too.

```js
{ n:1, par:4, name:'First Light', si:7,
  path:[[0,0],[4,120],[14,230],[-6,330],[-10,350]],   // last point = green centre
  elev:[[0,2],[150,0],[260,-1],[350,1]],
  tee:{s:0,w:8,l:14,raise:0.4},
  fairway:{from:150,to:335,width:[[150,26],[230,30],[300,22],[335,18]],wobble:2},
  rough:{semi:2.5},
  green:{s:350,off:0,rx:15,ry:12,rot:15,fringe:1.2,slope:[200,1.8],
         tiers:[{angle:90,at:3,h:0.45,w:1.5}],bumps:[[4,-3,5,0.15]],pins:[[-4,3],[3,-4],[0,0]]},
  bunkers:[{s:228,off:19,shape:[[0,0,9,5,30],[5,2,6,4,0]],depth:0.7},{g:[12,-6],shape:[[0,0,6,3.5,-20]],depth:0.9}],
  water:[{kind:'red'|'yellow',level:-1.2,shape:{poly:[[s,off]...]}}],
  trees:[{from:20,to:330,off:-38,gap:9,jitter:4,mix:0.7},{s:260,off:30,cluster:6,spread:10}],
  mounds:[[210,-24,12,1.5]],
  ob:{left:52,right:null},
  bounds:{margin:70} }
```

### The nine holes (par 36, about 3300 yd)

| # | Par | m (yd) | Character |
|---|---|---|---|
| 1 | 4 | 350 (383) | Gentle dogleg right, fairway bunker right at 215–235 m, OB left, two greenside bunkers |
| 2 | 3 | 145 (159) | Tee 8 m above the green, pond (red) short and left, bunker back right |
| 3 | 5 | 470 (514) | Double dogleg, creek (red) crossing at 295–305 m, climbs 6 m to a two-tier green |
| 4 | 4 | 375 (410) | Uphill 7 m, tree-lined, OB left the whole way, pot bunker short left of the green |
| 5 | 4 | 300 (328) | Risk/reward dogleg left around a lake (a 215 m carry cuts the corner), water left of the green |
| 6 | 3 | 175 (191) | Elevated green (+4 m) with a false front, bunkers left and right |
| 7 | 4 | 395 (432) | Tee shot drops 10 m into a valley, uphill approach to a plateau green, cross bunkers at 300 m |
| 8 | 5 | 445 (487) | Reachable in two, water (yellow) along the right of the second half, green tucked right |
| 9 | 4 | 365 (399) | Uphill finishing hole, pond left of the landing area, two-tier green |

### HoleTerrain (the public contract, used by physics, game, renderer and camera)

```js
{
  n, par, name, si, lengthM,                // lengthM = path length tee -> green centre
  bounds:{minX,minY,maxX,maxY},
  tee:{x,y,z}, cup:{x,y,z}, greenCenter:{x,y,z},
  green:{cx,cy,rx,ry,rot},                  // ellipse, for camera/UI ("on or near the green")
  path,                                     // spline from spline.js (pointAt, tangentAt, project)
  heightAt(x,y), gradAt(x,y,out?) -> {x,y}, normalAt(x,y) -> {x,y,z},
  surfaceAt(x,y) -> SURF id,                // anything outside bounds -> SURF.OOB
  isOOB(x,y), waterAt(x,y) -> {kind:'red'|'yellow', level}|null,
  waters:[{kind, level, poly:[{x,y}...]}],  // for rendering flat water planes and for relief
  trees:[...], treesNear(x,y,r) -> [...],
  stakes:[{x,y,z}],                         // OOB stakes for rendering
  raycast(origin, dir, maxT) -> {x,y,z,t}|null,
  aimPoint(from:{x,y}) -> {x,y},            // sensible default target: next dogleg corner within reach, else cup
  grid:{nx, ny, minX, minY, step, heights:Float32Array (nx*ny, row-major y then x)},  // 1 m height grid for meshing
  sgrid:{nx, ny, minX, minY, step, data:Uint8Array},                                  // 0.5 m surface grid
}
```

`heightAt` is exact (analytic) on greens and bilinear elsewhere. It must be continuous.
Pins are at least 4 m inside the fringe, with slope ≤ 2.5% within 2 m of the cup.
Green slopes are ≤ 5%.

Conventions as implemented (Course group):
- `green.rot` is the world angle (radians, CCW from +x) of the `rx` semi-axis; `green.fringe` (m)
  is also provided. Extra fields: `pins:[{x,y,z}×3]`, `pinIndex`, `corners` (dogleg arc lengths).
- Trees: `z` is the ground height at the trunk; `canopy.cz` is the **absolute** world z of the
  canopy ellipsoid centre (horizontal semi-axis `rx`, vertical `rz`); the trunk runs from `z` to
  `z + trunkH`. `treesNear(x,y,r)` returns trees whose trunk is within `r + canopy.rx`.
- `sgrid` cell `(i,j)` covers `[minX+i·step, minX+(i+1)·step) × [minY+j·step, …)` and stores
  `surfaceAt` of its centre; `grid` node `(i,j)` is at `(minX+i, minY+j)`.
- `aimPoint(from)`: the cup when within ~235 m; else the next dogleg corner if within ~260 m; if
  that corner is out of reach, the centreline point ~245 m away; with no corner ahead, the cup.
- `raycast(o, dir, maxT)`: `dir` need not be unit; the hit is `o + dir·t`.
- `waters[].level` is absolute (the HoleDef level is relative to the centreline elevation).
- `noise.js`: `hash2`, `valueNoise2` and `fbm2` all return values in [0, 1).
- `holePar(i)` takes a 0-based hole index.

## 4. Swing, lie, game

### Lie (`lie.js`)

```
Lie = {surface, slopeAlong, slopeAcross (fractions), label:'Fairway' | 'Rough · Uphill' | ...,
       factors:{speed, spin, launch, sdir}}
```

- Uphill or downhill: `launch += 0.6·slopeAngleAlong`. Uphill also scales speed by
  `(1 − 0.4·max(0, slope))`.
- Sidehill (ball above the feet, for a right-hander) pulls the ball left:
  `startDir −= 0.5·slopeAcrossDeg`, clamped to ±4°.
- Bunker with a wood: speed × 0.5. Greenside wedge explosion within 40 m of the green: speed × 0.6,
  spin × 0.5, launch +6°.
- Woods from rough: speed × 0.85.

### Swing gestures (`input.js` records; `swing.js` interprets)

`samples` is an array of `{t (ms), x, y (CSS px)}` for one pointer, from pointerdown to pointerup.

```js
interpretSwing(samples, {padRefH, kind:'full'|'putt', difficulty:'easy'|'normal'|'pro', handed:'R'|'L'}) ->
  {ok, reason?:'cancel'|'tooSlow'|'short', power, overswing, startDir, faceToPath, face, path,
   tempo:'smooth'|'rushed'|'decel', label}
```

**Full swing**

- Touchdown at y0 defines the impact line.
- Dragging down sets `power = clamp(depth / (0.32·padRefH), 0, 1.1)`; anything above 1 is
  overswing, which doubles dispersion.
- A strike fires when the finger crosses y0 going up at 400 px/s or more. Releasing during the
  backswing, or returning slowly, cancels.
- The chord angle α from the backswing bottom to the end gives `startDir`. The curvature κ
  (heading of the last 40% minus the first 60%) gives `faceToPath`.
- Tempo: the ideal downswing time is `0.10 + 0.15·power` s. Under 0.5× is "rushed" (σ_face
  +1.5°). Over 2× is "decel" (speed × 0.92).
- Difficulty gains:

  | Difficulty | G_s | G_c | dzA | dzK |
  |---|---|---|---|---|
  | Easy | 0.15 | 0.05 | 4° | 8° |
  | Normal | 0.25 | 0.08 | 2° | 4° |
  | Pro | 0.35 | 0.12 | 0 | 0 |

  `startDir` is clamped to ±10° and `faceToPath` to ±8°. Left-handed play flips the sign of κ.
- Random contact: σ_dir = 0.6° (× 2 on overswing, plus the lie's `sdir`), σ_speed = 1.5%.
- Speed factor: `0.15 + 0.85·power`. Spin scales with the speed ratio, the lie's spin factor and
  the partial-wedge factor `(0.7+0.3·power)`.

**Putt**

- Drag down: `power = depth/(0.30·padRefH)`, which maps to a flat-roll distance
  `D = power·puttRange`.
- `puttRange` comes from {3, 6, 9, 12, 18, 24, 30} m: the first value that is at least 1.25× the
  distance to the cup.
- Release, or a flick up, strokes the putt. Lateral drift over the last 150 ms × 0.08 gives the
  direction error (clamped to ±3°).
- The putt speed comes from `puttSpeedForDistance(D, SURFACES[GREEN])`.

### Rules (`rules.js`)

Simplified Rules of Golf.

- Each swing adds a stroke. A cancelled swing doesn't count.
- **OB:** stroke and distance. Add 1 and replay from `prevSpot`.
- **Water (red):** drop within 2 club lengths of `waterEntry`, at the nearest dry, non-hazard
  point no nearer the hole.
- **Water (yellow):** drop back on the line from the hole through `waterEntry`, 2 m or more
  behind it, on dry ground.
- The relief dialog offers "Drop (+1)" (the default) or "Replay (+1)".
- **Pick-up:** at `2·par` strokes, the hole is recorded as 2·par.
- `scoreName`: Albatross, Eagle, Birdie, Par, Bogey, Double Bogey, Triple Bogey, or `+n`.
  A hole-in-one is "Hole in one!".
- Statistics: FIR, GIR and putts.

### Game (`game.js`)

```
phases: 'intro' -> 'address' -> 'flight' -> ('address' | 'decision' | 'holed')
        'holed' -> 'scorecard' -> next hole 'intro' ... -> 'roundOver'
```

```js
export class Game {
  constructor({course = COURSE, seed, settings:{wind:'off'|'light'|'breezy', difficulty, units, handed},
               buildHole = buildHole})
  phase; state; terrain; def; shot /* {result, playT, launch} during flight */
  on(evt, fn)            // 'phase','hole','shotStart','shotEvent','shotEnd','decision','holed','roundOver','message'
  loadHole(i, terrain?) ; skipIntro()
  setAim(yaw) ; aimYaw ; setClub(id) ; club ; suggestClub() ; lie ; wind ; distanceToCup()
  ballPos()              // current ball {x,y,z} (during flight: interpolated from shot.path at playT)
  swing(swingResult)     // -> {ok, shot}; runs simulateShot instantly; phase 'flight'
  update(dt)             // advances the playback clock; emits shotEvent as playback passes each event t
  decide(option)         // 'drop'|'replay'
  nextHole() ; serialize() ; static restore(json, opts)
  debugPlace(x, y)       // tests only
}
```

- Wind is seeded per hole: Light is 0–4 m/s, Breezy is 3–8 m/s.
- Autosave happens on `shotEnd` and `nextHole` (from `main.js`).

### Game logic API (Game group, as built)

The header comments of `lie.js`, `swing.js`, `caddie.js`, `rules.js`, `scoring.js`, `game.js` and
`bot.js` are the full reference. Additions and refinements to the contract above:

**Lie** — `lieAt(terrain, pos, aimYaw, {handed='R'})`. `slopeAlong` is + uphill toward the target;
`slopeAcross` is the rise to the RIGHT of the aim line (+ = ball above a right-hander's feet).
Extra fields: `dirOffset` (deg, + = right; the sidehill start shift, which goes the way the ground
falls for either hand), `greenDist` (m to the green edge, 0 on it) and `aimYaw`. Labels: the surface
name plus the dominant slope when ≥ 5% (`' · Uphill'`, `' · Downhill'`, `' · Ball above feet'`,
`' · Ball below feet'`; none on tee or green). `applyLie({ballSpeed, launchDeg, spinRpm,
startDirDeg}, lie, club)` returns a copy with the factors and `dirOffset` applied (putter: unchanged).
The greenside explosion (wedge, bunker, `greenDist ≤ 40`) **replaces** the generic bunker factors;
the wood penalties multiply on top of them. Also `greenEdgeDist(green, x, y)`, `isExplosion(lie, club)`.

**Swing** — `interpretSwing(samples, {padRefH, kind, difficulty, handed, club?})` uses input.js's
`FULL_POWER_FRAC`/`PUTT_POWER_FRAC`/`MAX_POWER` and the deepest point of the trace, exactly like the
live gauge. Result extras: `kind`, and for full swings `alpha`/`kappa` (raw deg) and `downswingS`.
`face`/`path` use the club's D-plane k when `club` is given, else 0.8 (`swingToLaunch` re-splits
with the real club, so the launch's start direction equals `startDir` plus scatter).
- The downswing starts at the last sample at the bottom of the final upward run (3 px jitter
  allowed), so a pause at the top of the backswing does not count as downswing time. The strike
  speed is the mean upward speed over the 50 ms before the crossing. A fast flick lifted within
  50 ms (extrapolated) of the line still strikes.
- Putts: release anywhere, or a flick (≥ 400 px/s), strokes; coming back within 25% of the depth
  slowly cancels. Drift gain 0.08°/px is for Normal and scales with `G_s` (Easy ×0.6, Pro ×1.4)
  with a `dzA`-px dead zone (4/2/0 px).
- `swingToLaunch(club, lie, swing, aimYaw, rng, {pos, puttRange})`; `rng = null` gives the intended
  shot with no scatter (caddie and bot). Scatter: σ_dir = 0.6°·(2 if overswing) + lie.sdir on the
  start direction; σ_face = 0.4°·(2 if overswing) + 1.5° if rushed on the face (it moves the curve
  fully and the start direction by k); σ_speed = 1.5%·(2 if overswing). Putts: σ_speed 1%, σ_dir 0.3°.
  `launch.meta` adds `power`, `faceDeg`, `pathDeg`, `faceToPathDeg` (putts: `puttDistance`, `puttRange`).
- Exports `DIFFICULTY`, `STRIKE_SPEED`, `PUTT_RANGES = [3, 6, 9, 12, 18, 24, 30]`, `swingLabel`.

**Caddie** — `clubTable(terrain, pos, lie, wind, {aimYaw})` → rows `{id, name, short, kind, carry,
total, carry0, total0, apex, landAngle}` (stock full swing with the lie, flat fairway at the ball's
height; `carry0`/`total0` without wind; no putter row). `suggestClub(terrain, pos, lie, wind, {table,
par, teeShot, aimYaw})` → club id: putter on the green and fringe; otherwise (approaches and par-3
tee shots) the shortest club whose carry reaches the plays-like distance (SW from sand when it
reaches); par-4/5 tee shots and lay-ups go by total, longest first, skipping clubs that run > 20 m
past the cup or whose predicted rest (stock shot on the real hole with wind) is water, OB or sand;
no driver off the deck. `playsLike(terrain, pos, target, wind, table)` = distance × (no-wind/wind
carry ratio of the nearest club) + Δz / tan(descent angle). `puttRange(dist)`. Also
`powerCurve(...)`/`curveAt(curve, power)` (carry against power, for the power-arc readout),
`predictShot(...)`, `isSafeRest(res)`.

**Rules** — `resolveShot(ctx, shot)` with `ctx = {terrain, par, strokes (before this shot),
prevSpot, fromTee, fromSurface}` → `{outcome, strokes (after, penalties included), penalty, ball,
reTee, decision: null | {kind:'water', waterKind, options:['drop','replay'], drop, replay,
replayTee, entry}, holed, pickUp, putt, fir, gir, message}`. `waterRelief(terrain, entry, kind,
{cup})`. Red relief: the nearest point within 2.28 m of the entry, no nearer the hole, not water,
bunker or OOB, preferring points with no water within 0.6 m (falls back to back-on-the-line if
nothing qualifies). Yellow relief: back on the line from the hole through the entry, ≥ 2 m behind
it — the first such spot that is dry, ≥ 2 m clear of the water and on ground ≤ 8% (else the first
dry one). FIR is judged on the first stroke of a par 4/5 (fairway, fringe, green or holed); GIR when
the ball rests on the green (or is holed) in ≤ par − 2 strokes, penalties included; a putt is a
stroke played from the green. Pick-up at 2·par takes precedence over relief.

**Scoring** — `newCard(course)` → `{course, holes:[{n, par, si, lengthM, strokes:null, putts,
penalties, fir, gir, pickUp}]}` (the shape `ui.showScorecard` takes); `recordHole(card, i, {...})`;
`totals(card)` → `{played, strokes, par, toPar, coursePar, putts, penalties, fir:{hit, of},
gir:{hit, of}, pickUps}` (par 3s have `fir: null`).

**Game**
- `phase` is `null` until the first `loadHole`. `'holed'` moves to `'scorecard'` after
  `HOLED_HOLD` = 2.5 s of `update()` time (or `skip()`); after the last hole it goes to `'roundOver'`
  instead (show the final card), and `nextHole()` from `'holed'`/`'scorecard'` on the last hole
  also ends the round. A shot resolves `END_HOLD` = 0.8 s after the ball stops.
- Events: `'phase' (phase, prev)`, `'hole' (holeInfo())`, `'shotStart' (shot)`, `'shotEvent'
  (physics event; the launch event also has kind, club, power)`, `'shotEnd' ({shot, resolution})`,
  `'decision' (decision)`, `'holed' ({holeIndex, strokes, par, name, pickUp, toPar, card, totals})`,
  `'roundOver' ({card, totals})`, `'message' ({text, tone:'info'|'over'})`. State is updated before
  `shotEnd`, so an autosave there stores the next lie. A restored game re-announces `'hole'`,
  `'phase'` and `'decision'` on its first `update()`.
- `shot = {result, playT, launch, clubId, seed, resolution, swing, from, next, done}`; it stays
  set after the shot (trail, camera) until the next swing, hole or `debugPlace`.
- Extra members: `skip()` (intro → address, flight → fast-forward, holed → scorecard),
  `holeInfo()`, `table` (club table for this spot), `clubInfo(id?)` → `{id, name, carry, total}` or
  `{..., puttRange}` for the putter, `carryForPower(power)` → `{carry, total}` (putter: total =
  flat roll), `playsLike()` (m, null on the green or with the putter), `puttRange`,
  `setPuttRange(m)`, `stepPuttRange(±1)`, `isPutt`, `totals()`, `setSettings(partial)` (a wind
  change applies at once).
- Every new spot (`loadHole`, rest, relief, `debugPlace`) re-aims at `terrain.aimPoint(ball)` (the
  cup from the green or fringe), sets the caddie's club and the putt range.
- One rng stream (`state.rng`, mulberry32) drives the contact scatter and the per-shot physics seed;
  pins come from the round seed, wind from `windFor(seed, hole, setting)`, trees from `TREE_SEED = 1`
  (the course looks the same every round).
- `serialize()` returns a JSON-safe object (`main.js` stringifies it). During a flight it stores
  the state at the strike plus `pendingShot {launch, seed, clubId, swing}`; `restore(json,
  {buildHole, terrain, course})` re-simulates and resolves it, so quitting mid-flight cannot undo a
  stroke. Restorable phases: intro, address, decision, holed, scorecard, roundOver.

**Bot** — `planShot(game, {rng})` → `{clubId, yaw, swing, puttRange?, target, expected}`;
`playBotShot(game)` applies it (club, aim, putt range) and swings; `botDecide(game)` picks drop or
replay. Candidates are simulated on the real hole with the wind and scored by expected strokes to
hole out from the rest point (penalties weighted a little extra), the best few re-scored with
seeded misses. Putts are read by simulating and correcting aim and pace until the putt drops in
the middle. The swing it returns carries its own seeded execution error (`BOT_SKILL`); it averages
about 1–3 over par for nine holes.

## 5. Rendering and camera

### Renderer (`render.js`)

```js
export class Renderer {
  constructor(canvas, {quality:'auto'|'low', test:false})
  ok                                        // false -> main shows #nogl
  setHole(terrain)                          // upload meshes/textures, keep CPU copies for context restore
  resize(cssW, cssH, dpr)                   // caps dpr at 2, adaptive renderScale
  project(x,y,z) -> {sx, sy, z, visible}    // CSS px
  pickTerrain(sx, sy) -> {x,y,z}|null
  draw(scene)
  stats() -> {drawCalls, tris, renderScale, ms}
  debugPixel(sx, sy) -> [r,g,b,a]           // tests: reads back right after draw
}
scene = { time, cam:{eye,target,up,fovY,near,far}, ball:{x,y,z,visible}, trail:{data:Float32Array([x,y,z]*), count}|null,
          aim:{x,y,z,yaw,carry}|null, pin:{visible}, wind:{x,y}, read:{on}, sunDir? }
```

- GLSL 100 (works on WebGL1 and WebGL2), `highp` fragments, camera-relative positions, and
  25 draw calls or fewer.
- Contents: sky gradient with baked clouds and horizon hills; a chunked terrain with a baked
  colour texture and mowing stripes; fog; a skirt ring to the horizon; water planes with a
  fresnel and sun glint; instanced trees; OOB stakes; tee markers; the pin with a waving flag;
  the cup; the ball (icosphere close up, a minimum-size billboard far away) with a blob shadow;
  the shot trail; the aim line; and the green-read grid and slope tint.
- Context loss is handled by restoring from the CPU copies.
- `scene.aim` may carry `ring` (landing-ring radius, m), `width` (minimum half-width), `lift`
  (height above the turf) and `dash` (dash period, m); main.js uses them for the putt line. The
  flag droops in calm air but never folds flat (it is the target from 200 m), and the horizon
  ridges carry most of the haze so they blend with the fogged skirt instead of reading as a wall.

### Camera (`camera.js`, pure)

```js
export class CameraRig {
  constructor()
  mode                   // 'address'|'putt'|'read'|'flight'|'holed'|'map'|'flyover'
  setMode(mode, ctx)     // ctx: {ball, aimYaw, cup, terrain, shot, aspect}
  update(dt, ctx) -> {eye, target, up, fovY, near, far}
  orbit(dyaw)            // read-mode drag
}
// also: fovForAspect(aspect), addressFraming(aspect) -> {back, h, pitch}, ADDRESS_H, FLYOVER_T
```

- The eye is always ≥ 1 m above the terrain (≥ 0.3 m for putts).
- `fovY` comes from a 55° horizontal FOV, clamped to 40–75°.
- Address (as built): the eye is `ADDRESS_H` = 1.6 m above the ball and behind it along the aim;
  `addressFraming(aspect) -> {back, h, pitch}` solves the distance and downward pitch so that the
  ball projects at NDC y = −0.6 (portrait/square) or −0.7 (landscape), inside the swing arc, and
  the horizon at NDC y = 0.22 / 0.12. That is ~2.4 m back in portrait (vertical FOV 75°) and ~5 m
  in landscape (40°), where a fixed 3.2 m put the ball below the bottom edge. Flight: TV-style
  shot, then a chase cam, then a landing cam (`shot.landing` is known in advance). Flyover: 5 s
  along the spline. Putt: low behind the ball (1.3–4.5 m back, 0.85–2.2 m up with the putt
  length), pitched so the ball sits at NDC y ≈ −0.55. Read: orbit above the green.

## 6. HUD, input, audio, main

- **Top bar:** hole, par, yards, strokes, total versus par, and a pause button (`#pause-btn`;
  the pause sheet's resume button is `[data-act="unpause"]`).
- **Info card:** distance to the pin, "plays like", the lie chip and a wind arrow (relative to
  the camera yaw).
- **Club picker:** ◀ club ▶ with carry and total; it auto-picks on every new lie.
- **Power arc** around the swing pad. Shot toast: "7 Iron · Carry 158 yd · Total 164 yd".
- **Scorecard overlay** (`#scorecard`, with a `[data-act="next-hole"]` button).
- **Menus:** main menu (`[data-act="new-round"]`, `[data-act="resume"]`, settings, how to play),
  pause sheet, settings, and a `#nogl` message.
- **Input regions:**
  - Aim zone (the upper part of the canvas): horizontal drag turns the yaw.
  - Swing pad (the lower about 40%, above the safe area): drag down, then flick up.
  - Read mode: drag orbits. Map: tap a point to aim at it.
  - The canvas uses `touch-action: none`.
- **Audio** (synthesised): whoosh, impact (driver, iron, putter), landing (green, fairway, sand,
  water splash, tree), cup rattle, applause for a birdie or better, ambient wind. The iOS unlock
  pattern is copied from the pool `src/audio.js`.
- **`main.js`:**
  - Boot, rAF loop, resize.
  - Save and resume (`golf.save.v1` with an in-memory fallback), wake lock,
    `visibilitychange`/`pagehide`, and `globalThis.__golf = app`.
  - URL parameters: `?debug=1`, `?autoplay=1`, `?fast=N`, `?nogl=1`, `?hole=N`, `?test=1`,
    `?quality=low`.

### main.js (Integration, as built)

`main.js` has no exports; the header comment is the reference. It owns one `app` object
(`globalThis.__golf`): `{ui, renderer, input, audio, rig, game, view, paused, params, debug, ...}`.

- **Boot:** UI first (settings), then `Renderer(canvas, {quality: ?quality || setting, test:
  ?test})`. `!renderer.ok` shows `#nogl` and stops. `?nogl=1` uses a `NullRenderer` stub (same
  API, draws nothing) so logic, HUD, input and saves still run. The menu backdrop is a slow drone
  shot down hole 1, built behind the `#loading` spinner.
- **Terrain cache:** `Game` gets a caching `buildHole` (last 3 by hole, pin and seed); the next
  hole is prebuilt ~150 ms after the scorecard appears, so "Next hole" only uploads to the GPU.
- **Loop:** dt clamped to 0.1 s; `game.update(dt·fast)`, camera `rig.update(dt·fast)`, scene,
  `renderer.draw`. While paused one frame is drawn and then drawing stops. A frame that throws is
  logged (first 3) and the loop keeps running.
- **Phases → views:** intro = flyover camera + lower third, auto-advances after FLYOVER_T + 1.2 s or
  a tap; address = `'address'` or `'putt'` camera by club (sub-views `read`, `map` — a Map tap
  aims at `renderer.pickTerrain` and returns to the ball after 0.45 s — and `flyover`); flight =
  TV sequence for full shots, the putt camera held at the strike point for putts; holed = cup
  orbit + score banner + applause (par and better); scorecard; roundOver = final card with the
  best round (`golf.best.v1`, completed nines only). Camera moves longer than 60 m after a
  flight/holed/flyover are hard cuts.
- **Input modes:** `full`/`putt` by club, `read`, `map`, `intro` (intro and flyover), `watch`
  (flight fast-forward, holed → scorecard), `disabled` otherwise (menus, dialogs, pause).
- **Swing:** `interpretSwing(samples, {padRefH: input.padRefH, kind, difficulty, handed, club})`;
  a failed swing shows a hint ("Too slow · swipe up faster", "Swing cancelled") and is not a
  stroke. The live arc readout is `game.carryForPower(power)` (carry, or flat roll for putts), and
  the aim ring follows it. The power curve is warmed on every address so the first gauge move
  does not hitch.
- **Scene:** the pin is out for putts (address, flight, holed and scorecard after a holed putt);
  the trail shows full shots in flight/holed/decision; putts get a thin short-dashed line with a
  0.2 m ring (`aimRibbon` options `ring`, `width`, `lift`, `dash`) and a faint read grid.
- **Toasts:** shot result `'7 Iron · Carry 158 yd · Total 164 yd · Push fade'` (the label comes
  from the launch actually played, scatter included, plus `· Rushed`/`· Decel`); putts `'Putter ·
  12 ft · 2 ft left'`; rule messages; "Lip out".
- **Saves:** on every new hole, phase change to intro/address/decision/scorecard, shot end, relief
  choice, pause, `visibilitychange`(hidden) and `pagehide`; cleared at round over. `?autoplay`
  never saves.
- **Settings:** apply at once (wind via `game.setSettings`, quality by rebuilding the hole).
- **`?autoplay=1`:** `playBotShot` after 0.6 s of game time in address (run in a `setTimeout` so
  the frame paints first), `botDecide` for relief, next hole 0.8 s after the scorecard;
  `globalThis.__golfDone = {total, toPar, played, pickUps}` at the end.
- **`?test=1`:** fixed seed 1 (or `?seed=N`), renderer `test` mode (pixel read-back), and
  `app.debug = {placeNearCup(d), skyPixel(), padRect(), state()}`; `app.lastSwing` keeps the last
  swing's samples and result.
- **HUD layout (as built):** in portrait/square the club picker and putt range sit at the bottom
  of the swing pad, below the arc, and the idle hint sits inside the arc where the live readout
  appears, so the middle of the screen (target, cup) stays clear. Landscape is unchanged (club
  bottom left, pad on the right). The arc centre is at 40% of the pad height (44% landscape).

`tests/e2e.spec.mjs` (Playwright, Chromium with SwiftShader WebGL, or `?nogl=1` without WebGL)
drives the real UI with CDP touch events carrying explicit timestamps (SwiftShader frames take up
to a second, and the swing interpreter reads speeds from `event.timeStamp`).

### Input API (`input.js`, Shell/UI group, as built)

```js
const input = new InputController(canvas, {onAim, onSwingStart, onSwingProgress, onSwing,
                                           onSwingCancel, onOrbit, onTap, onSkip}); // all optional
input.mode = 'full'|'putt'|'read'|'map'|'intro'|'watch'|'disabled'   // or setMode(m); starts 'disabled'
input.padRect   // {x,y,w,h} CSS px, canvas-relative       input.padRefH  // = padRect.h, pass to interpretSwing
input.resize(); input.destroy()
// pure, unit-tested: padRectFor(w,h,insets), layoutMode(w,h), swingProgress(samples,padRefH,kind),
// aimDelta(dx,dtMs), orbitDelta(dx), isTap(down,up), inRect(r,x,y), readSafeInsets()
```

- **full / putt:** a press inside `padRect` records a swing: `onSwingStart({x,y})`, then on every
  move `onSwingProgress({depth, maxDepth, power, overswing, phase:'back'|'down'})` (power =
  maxDepth / (0.32 or 0.30 · padRefH), capped at 1.1, held at the backswing peak during the
  downswing), and on release `onSwing(samples)` (`[{t ms, x, y}]`, coalesced events included,
  pointerdown to pointerup). `pointercancel` or a mode change mid-swing calls `onSwingCancel()`.
  Input never decides strike/cancel; `interpretSwing` does.
- A press above/outside the pad aims: `onAim(dyaw)` per move. Dragging right turns the aim
  clockwise (dyaw < 0); ~0.13°/px, up to 3× for fast drags.
- **read:** drag → `onOrbit(dyaw)` (drag right → dyaw < 0). **map:** tap → `onTap(sx, sy)` (CSS px,
  for `renderer.pickTerrain`); a horizontal drag still sends `onAim`. **intro / watch:** a tap →
  `onSkip()` (use 'watch' during flight to fast-forward). Only the first pointer is tracked.
- **Pad rect:** portrait/square = lower 40% of the canvas above the bottom safe inset, full width;
  landscape = right 40% of the width, lower 72% of the height (deviation from "lower 40%": a 40%
  strip of a 390 px tall screen leaves too little backswing travel). Safe insets come from the CSS
  tokens `--sat/--sar/--sab/--sal`.

### UI API (`ui.js`, Shell/UI group, as built)

`const ui = new UI(document)`. The full reference is the header comment of `src/ui.js`. Summary:

- `ui.on(evt, fn) -> unsubscribe`. Events: `'new-round' 'resume' 'next-hole' 'club-prev' 'club-next'
  'read' 'map' 'flyover' 'putt-range+' 'putt-range-' 'pause' 'unpause' 'restart' 'quit'`,
  `'settings-changed' (settings, key)`, `'decision' (id)`, `'layout' (mode)`. The UI hides its own
  overlay before emitting (menu on new-round/resume, scorecard on next-hole, pause sheet on
  unpause/restart/quit; `#pause-btn` opens the pause sheet; quit also re-shows `#menu`).
- Screens: `showMenu({canResume, courseName?, courseSub?})`, `hideMenu()`, `showPause({title?})`,
  `hidePause()`, `paused`, `showSettings()`, `showHowTo()`, `setLoading(on, text)`, `showNoGL()`,
  `showHud(on)` (`#hud` starts hidden).
- HUD: `setHud({hole, par, lengthM | yards, si, strokes, toPar, distToPin, playsLike, lieLabel,
  lieSurface?, windSpeed, windRelAngle, units?})` (partial merge; distances in **metres**, wind in
  m/s; `windRelAngle` = wind travel direction minus camera yaw, CCW +, 0 = arrow up/helping;
  `playsLike: null` hides it). `setClub({name, carry, total, sub?})` (metres).
  `setPower({power, overswing, carryText} | null)`. `setHint(text|null)`.
  `setControls({phase, putt, canRead, read, map, puttRange})` — club picker, tools and swing pad
  are shown only for `phase === 'address'`. `showIntro({hole, name, par, lengthM, si})`,
  `hideIntro()`. `toast(text, ms)` (`'7 Iron · Carry 158 yd · Total 164 yd'`; the first segment is
  a bold tab). `banner(title, sub, {tone:'under'|'par'|'over'|'ace', ms})`.
- `showScorecard(card, {final, current, title?, kicker?})`: `card.holes[i] = {n?, par, lengthM? |
  yards?, strokes|null, putts?, fir?: bool|null, gir?: bool|null}` (or the array itself). Totals,
  FIR/GIR/putt stats, circle (birdie or better) and square (bogey or worse) are computed by the UI.
  `final` swaps `[data-act="next-hole"]` for Play again (`new-round`) and Menu (`quit`).
- `showDecision(['drop','replay'] | {kicker, title, text, options:[id | {id,label,detail}]})
  -> Promise<id>`; the first option is the primary default.
- Settings: `ui.settings` (copy), `getSetting(k)`, `setSetting(k, v)`, `onChange(fn)`;
  `{units:'yd'|'m', wind:'off'|'light'|'breezy', difficulty:'easy'|'normal'|'pro', handed:'R'|'L',
  sound:bool, quality:'auto'|'low'}` in `localStorage['golf.settings.v1']` (try/catch).
- `ui.padRect` / `ui.setPadRect(r)`: the HUD positions the power arc and club picker from the same
  `padRectFor` as input.js; main may pass `input.padRect` to be explicit.

### Audio API (`audio.js`)

`new AudioFX()`: `unlock()` (call on every pointerup; idempotent), `setEnabled(on)`, `suspend()`,
`resume()`, `setWind(mps)` (ambient loop), `whoosh(power)`, `impact(kind, power)` (club kind or
`'driver'`), `land(surface, v)`, `tree(v)`, `pin(v)`, `lipout(v)`, `cup(v)`, `applause(strength)`,
and `handle(eventOrEvents)` for shot events `{type, surface, v, kind?}` (`launch` → impact with
`ev.kind` or `ev.club.kind`, else guessed from speed; `land`/`bounce`/`tree`/`pin`/`lipout`/`cup`/
`water`; also synthetic `{type:'swing', power}` and `{type:'applause', strength}`).
