# Golf — architecture and module contracts

A realistic 3D golf game for iPhone Safari (and any modern browser). It is built with vanilla JS
ES modules and a custom WebGL renderer, with no dependencies and no external assets. It lives
entirely in `golf/` and imports nothing from the pool game in the repository root.

The game has four hand-designed nine-hole courses (par 36 each; version 1 shipped Hollow Pines alone,
section 8 adds the other three) and is solo stroke play. You swing by swiping (or with a tap meter).

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
| `terrain.js` | `buildHole(def, {pinIndex, seed, course}) -> HoleTerrain` (see below and §8.2) |
| `courses.js` | `COURSES`, `courseById(id)`, `DEFAULT_COURSE_ID`, `courseSummary(course)` (§8.2); mixed rounds of 9 or 18 holes: `drawMixedHoles(seed, n)`, `mixedCourse(seed, picks?, n?)`, `mixedSummary(n)`, `isMixedId`, `mixedId`, `mixedHoles` (§8.7, §8.8) |
| `themes.js` | `THEMES`, `themeFor(id)`: per-theme palettes, data only (§8.3) |
| `shots.js` | `SHOTS`, `shotById`, `shotsFor(club, lie)`, `isEligible`, `applyShot(p, id, club, lie, opts)`, `shotIntent`: special shots (§8.4) |
| `physics.js` | `simulateShot(terrain, launch, opts) -> ShotResult`, `surfaceParams(terrain, surfId)` / `surfaceTable(terrain)` (SURFACES with the course conditions, §8.2). Exported for tests: `flightStep`, `bounceImpulse`, `rollStep`, `cupCheck`, `treeHit`, `stimpDistance(v0, surf)`, `puttSpeedForDistance(D, surf)` |
| `lie.js` | `lieAt(terrain, pos, aimYaw, {handed}) -> Lie`, `applyLie(launchParams, lie, club)` |
| `swing.js` | `interpretSwing(samples, opts) -> SwingResult`, `swingToLaunch(club, lie, swing, aimYaw, rng, opts) -> Launch` |
| `caddie.js` | `clubTable(terrain, pos, lie, wind)`, `suggestClub(...)`, `playsLike(...)`, `puttRange(dist)` |
| `rules.js` | `resolveShot(ctx, shot) -> Resolution`, `waterRelief(...)`, `scoreName(strokes, par)`, `maxStrokes(par) = 2*par` |
| `scoring.js` | `newCard(course)`, `recordHole(card, i, {strokes, putts, penalties, fir, gir})`, `totals(card)` (with `out` / `in` nines, §8.8) |
| `game.js` | `Game` state machine, plus `serialize()` and `static restore()` |
| `bot.js` | `planShot(game) -> {clubId, yaw, swing, puttRange?}`, `playBotShot(game)`, `botDecide(game)`: a simulated "decent player" used by `?autoplay` and the playability tests |
| `camera.js` | `CameraRig`, which produces `{eye, target, up, fovY, near, far}` (pure maths) |
| `meshes.js` | Geometry builders that return typed arrays; themed objects and the sea (`seaSetup`, §8.3 as built) |
| `bake.js` | `bakeTerrainColor(terrain, {theme})`, `bakeWaterDepth(terrain)`, `bakeClouds(seed)`, `bakeNoise(seed)` |
| `golfer.js` | The golfer: skeleton (`BONES`, `B`, `BONE_PARENT`), the LOOK (`DEFAULT_LOOK`, `normalizeLook`, `PRESETS`, `randomLook`, palettes), proportions (`bodyDims`) and club specs (`clubSpec`) (§9) |
| `golfer-mesh.js` | `buildGolferMesh(look, club)`: one rigidly skinned mesh (§9) |
| `swing-anim.js` | Poses, FK/IK, `placeGolfer`, `SwingAnimator`: the visible swing (§9) |

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
| D | Driver | 10.5 | 68.6 | 12.0 | 2800 | 244 |
| 3W | 3 Wood | 15 | 66.0 | 10.5 | 3800 | 228 |
| 5W | 5 Wood | 18 | 63.6 | 11.5 | 4400 | 216 |
| 4H | 4 Hybrid | 22 | 60.7 | 12.5 | 4700 | 203 |
| 5i | 5 Iron | 26 | 58.1 | 13.0 | 5300 | 190 |
| 6i | 6 Iron | 30 | 55.7 | 14.5 | 6100 | 178 |
| 7i | 7 Iron | 34 | 53.0 | 16.5 | 7000 | 165 |
| 8i | 8 Iron | 38 | 50.1 | 18.5 | 7800 | 152 |
| 9i | 9 Iron | 42 | 46.7 | 21 | 8500 | 138 |
| PW | Pitching W | 46 | 42.9 | 24 | 9000 | 123 |
| GW | Gap W | 50 | 39.0 | 27 | 9400 | 108 |
| SW | Sand W | 56 | 34.7 | 31 | 9800 | 91 |
| LW | Lob W | 60 | 30.2 | 34 | 9600 | 74 |
| P | Putter | 3 | – | 0 (starts rolling) | 0 | – |

`spinLoft` runs from about 13° for the driver to about 50° for the LW and is used for the D-plane
curve. `scripts/calibrate.mjs` re-solves `ballSpeed` by bisection so that the simulated carry
matches `targetCarryYd`, then prints the table.

## 2. Ball physics (`aero.js`, `physics.js`)

### Flight

The state is `p`, `v` and `ω` (rad/s), all 3D. The air-relative velocity is `u = v − W(z_agl)`.

```
S   = R·|ω| / |u|                (clamp S to [0, 0.6])
C_D = 0.186 + 0.545·S − 0.42·S² + 0.063·(50/|u| − 1)    (|u| floored at 15 m/s)
C_L = 1.15·S^0.766 / (1 + 1.55·S)
a   = −g ẑ − (ρA/2m)·C_D·|u|·u + (ρA/2m)·C_L·|u|²·(ω̂ × û)
ω  *= exp(−dt/SPIN_TAU)
```

- The C_D/C_L fit reproduces TrackMan's Tour and LPGA carry, apex and descent angle from their
  launch numbers (irons and wedges within ~2°, the driver ~3° steep); `dragCoeff(S, u?)`.
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
- **Rest** when `|v| < 0.01` and `(5/7)·g·sin θ < a0·1.05` (the same downhill pull the roll
  applies, so no slope both refuses rest and gives no net drive). A ball that creeps less than
  1.5 cm in 0.5 s at under 3 cm/s without speeding up also rests (no 45 s creeping).
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

- **Trunk:** a hard cylinder, e = 0.4. A ball falling onto its top (where the limbs fork) glances
  off outward with a small hop; a ball already overlapping it is pushed out radially (no hanging).
- **Canopy ellipsoid:** on each traversal, roll `p_hit = 1 − exp(−pathLen/3)` with the shot rng.
  On a hit, multiply v by 0.25–0.45, randomise the direction in a 60° cone (biased down), multiply
  spin by 0.3, and emit a `tree` event.

### `simulateShot` (instant, headless, deterministic)

```js
simulateShot(terrain, launch, {wind = {x:0,y:0}, seed = 1, maxT = MAX_SHOT_T, record = true}) -> {
  path: Float32Array,  // [t,x,y,z]* at RECORD_HZ, for playback, trail and camera
  events: [{type:'launch'|'land'|'bounce'|'tree'|'lipout'|'cup'|'water'|'rest'|'pin', t, x,y,z, surface, v}],
                       // 'tree' events also carry obj: the object's kind ('pine', 'rock', 'gorse', ...)
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

### The nine holes of Hollow Pines (par 36, about 3300 yd)

(The other courses' holes are listed in the header comments of `course-desert.js`, `course-water.js` and
`course-links.js`; README.md has a summary.)

| # | Par | m (yd) | Character |
|---|---|---|---|
| 1 | 4 | 350 (383) | Gentle dogleg right, fairway bunker right at 215–235 m, OB left, two greenside bunkers |
| 2 | 3 | 145 (159) | Tee 8 m above the green, pond (red) short and left, bunker back right |
| 3 | 5 | 470 (514) | Double dogleg, creek (red) crossing at 295–305 m, climbs 6 m to a two-tier green |
| 4 | 4 | 375 (410) | Uphill 7 m, tree-lined, OB left the whole way, pot bunker short left of the green |
| 5 | 4 | 300 (328) | Risk/reward dogleg left around a lake (a 215 m carry cuts the corner), water left of the green |
| 6 | 3 | 175 (191) | Elevated green (+4 m) with a false front, bunkers left and right |
| 7 | 4 | 395 (432) | Tee shot drops 10 m into a valley, uphill approach to a plateau green, cross bunkers at 300 m |
| 8 | 5 | 445 (487) | Reachable in two, water (red: it runs alongside, so yellow relief would be unusable) along the right of the second half, green tucked right |
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
- Rough: the spin cut grows with loft (the full `×0.55` from the 8-iron up, about ×0.8 for
  woods); woods from rough total speed × 0.85 (slope terms apply).

### Swing gestures (`input.js` records; `swing.js` interprets)

`samples` is an array of `{t (ms), x, y (CSS px)}` for one pointer, from pointerdown to pointerup.

```js
interpretSwing(samples, {padRefH, kind:'full'|'putt', difficulty:'easy'|'normal'|'pro', handed:'R'|'L'}) ->
  {ok, reason?:'cancel'|'tooSlow'|'short', power, overswing, startDir, faceToPath, face, path,
   tempo:'smooth'|'rushed'|'decel', label}
```

**Full swing** (version 1; the power travel, detent, strike recognition and tempo are replaced by
§8.1 and its "as built" notes)

- Touchdown at y0 defines the impact line.
- Dragging down sets `power = clamp(depth / (0.32·padRefH), 0, 1.1)`; anything above 1 is
  overswing, which doubles dispersion.
- A strike fires when the finger crosses y0 going up at 400 px/s or more. Releasing during the
  backswing, or returning slowly, cancels.
- The chord angle α from the backswing bottom to the end gives `startDir`. The curvature κ
  (heading of the last 40% minus the first 60%) gives `faceToPath`.
- Tempo: the ideal downswing time is `0.10 + 0.15·power` s, timed from when the finger starts
  up out of the bottom. Under `RUSHED_FRAC` = 0.18× is "rushed" (about 2400 px/s at full power;
  ordinary 1000–2200 px/s flicks are smooth): σ_face + 0.3° to 0.6° (`RUSHED_FACE`), growing with
  `tempoErr` (0–1, how far under). Over 2× is "decel" (speed × 0.92).
- Difficulty gains:

  | Difficulty | G_s | G_c | dzA | dzK |
  |---|---|---|---|---|
  | Easy | 0.15 | 0.05 | 4° | 8° |
  | Normal | 0.25 | 0.08 | 2° | 4° |
  | Pro | 0.35 | 0.12 | 0 | 0 |

  `startDir` is clamped to ±10° and `faceToPath` to ±8°. Left-handed play flips the sign of κ.
- Random contact: σ_dir = 0.6° (× 2 on overswing, plus the lie's `sdir`), σ_speed = 1.5%.
- Speed factor: `0.15 + 0.85·power`. Spin scales with the speed ratio and the lie's spin factor.
  Partial swings (`partialSwing(club, power)`): wedges launch up to `PARTIAL_LAUNCH.wedge` = 8°
  higher as power drops (irons 2°) and their spin goes with `√speed × (1 − 0.2·(1 − power))`, so
  25–55 yd LW/SW pitches land at 40–47° and release 0–5 yd.

**Putt**

- Drag down: `power = depth/(0.30·padRefH)`, which maps to a flat-roll distance
  `D = power·puttRange`.
- `puttRange` comes from {3, 6, 9, 12, 18, 24, 30} m: the first value that is at least 1.25× the
  distance to the cup.
- Release, or a flick on through the start line, strokes the putt. Sliding back to within 25% of
  the depth of the line (and no more than 12 px past it), at any speed, or more than 60 px
  sideways, cancels; presses under 20 px (`PUTT_MIN_DEPTH_PX`) are slips ('short'). Lateral drift
  over the last 150 ms × 0.08 gives the direction error (clamped to ±3°).
- The putt speed comes from `puttSpeedForDistance(D, SURFACES[GREEN])`.

### Rules (`rules.js`)

Simplified Rules of Golf.

- Each swing adds a stroke. A cancelled swing doesn't count.
- **OB:** stroke and distance. Add 1 and replay from `prevSpot`.
- **Water (red):** drop within 2 club lengths of `waterEntry`, on dry, non-hazard ground no
  nearer the hole that holds the ball (Rule 14.2e), preferring gentle ground; when the relief area
  is all steep bank, back on the line on level ground instead.
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

**Swing** — `interpretSwing(samples, {padRefH, kind, difficulty, handed, club?, target?, padRect?})`
uses input.js's `powerFromDepth` (§8.1) and the deepest point of the trace, exactly like the live
gauge. Result extras: `kind`, and for full swings `strike`, `alpha`/`kappa` (raw deg), `downswingS`
and `upSpeed`. (The strike and tempo bullets below are version 1; see §8.1 as built.)
`face`/`path` use the club's D-plane k when `club` is given, else 0.8 (`swingToLaunch` re-splits
with the real club, so the launch's start direction equals `startDir` plus scatter).
- The downswing starts at the last sample at the bottom of the final upward run (3 px jitter
  allowed), so a pause at the top of the backswing does not count as downswing time. The strike
  speed is the mean upward speed over the 50 ms before the crossing. A fast flick lifted within
  50 ms (extrapolated) of the line still strikes.
- Putts: see above (release or flick through strokes; back to the line or far sideways cancels).
  Drift gain 0.08°/px is for Normal and scales with `G_s` (Easy ×0.6, Pro ×1.4) with a `dzA`-px
  dead zone (4/2/0 px). The downswing start is extrapolated back from the first samples that leave
  the bottom, so a motionless pause (no touch events) does not count as downswing time.
- `swingToLaunch(club, lie, swing, aimYaw, rng, {pos, puttRange, shot, handed})` (special shots: §8.4 as built); `rng = null` gives the intended
  shot with no scatter (caddie and bot). Scatter: σ_dir = 0.6°·(2 if overswing) + lie.sdir on the
  start direction; σ_face = 0.4°·(2 if overswing) + 0.3–0.6° if rushed on the face (it moves the curve
  fully and the start direction by k); σ_speed = 1.5%·(2 if overswing). Putts: σ_speed 1%, σ_dir 0.3°.
  `launch.meta` adds `power`, `faceDeg`, `pathDeg`, `faceToPathDeg` (putts: `puttDistance`, `puttRange`).
- Exports `DIFFICULTY`, `STRIKE_SPEED`, `PUTT_RANGES = [3, 6, 9, 12, 18, 24, 30]`, `swingLabel`,
  `partialSwing`, `PARTIAL_LAUNCH`, `RUSHED_FRAC`, `PUTT_MIN_DEPTH_PX`.

**Caddie** (special shots: `opts.shot`, §8.4 as built) — `clubTable(terrain, pos, lie, wind, {aimYaw})` → rows `{id, name, short, kind, carry,
total, totalG, carry0, total0, apex, landAngle}` (stock full swing with the lie, flat fairway at the
ball's height; `totalG` over a flat green; `carry0`/`total0` without wind; no putter row).
`suggestClub(terrain, pos, lie, wind, {table, par, teeShot, aimYaw})` → club id: putter on the green
and fringe; clubs that a shorter club out-carries are never offered (woods from the rough); otherwise
(approaches and par-3 tee shots) the shortest club whose `expectedFinish` (carry + 0.85 × its green
release) reaches 97% of the plays-like distance (SW from sand when it reaches); par-4/5 tee shots and
lay-ups go by total, longest first, skipping clubs that run > 20 m past the cup or whose predicted
rest (stock shot on the real hole with wind) is water, OB or sand; no driver off the deck. `playsLike(terrain, pos, target, wind, table)` = distance × (no-wind/wind
carry ratio of the nearest club) + Δz / tan(descent angle). `puttRange(dist)`. Also
`powerCurve(...)`/`curveAt(curve, power)` (carry against power, for the power-arc readout),
`predictShot(...)`, `isSafeRest(res)`.

**Rules** — `resolveShot(ctx, shot)` with `ctx = {terrain, par, strokes (before this shot),
prevSpot, fromTee, fromSurface}` → `{outcome, strokes (after, penalties included), penalty, ball,
reTee, decision: null | {kind:'water', waterKind, options:['drop','replay'], drop, replay,
replayTee, entry, relief:'lateral'|'line'}, holed, pickUp, putt, fir, gir, message}`.
`waterRelief(terrain, entry, kind, {cup})`. Red relief: within 2.28 m of the entry, no nearer the
hole, not water, bunker or OOB, on ground that holds a ball (`holdsBall`: (5/7)·g·sin θ < 0.85·a0)
and where a ball released at zero speed stays within 0.3 m; the lowest cost r + 8·slope wins,
spots with water within 0.6 m or slope > 10% only when nothing better exists. When the whole
relief area is steeper than 10%, the other red option (Rule 17.1d(2)) is used if it finds level
ground: back on the line from the hole through the entry, never across the water, up to
6 m + 60 m × (bank slope − 10%) (≤ 30 m) back. Last resort: back on the line as far as it takes. Yellow relief: back on the line from the hole through the entry, ≥ 2 m behind
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

**Bot** — `planShot(game, {rng})` → `{clubId, yaw, swing, puttRange?, target, expected, shot}` (§8.4 as built);
`playBotShot(game)` applies it (club, aim, putt range) and swings; `botDecide(game)` picks drop or
replay. Candidates are simulated on the real hole with the wind and scored by expected strokes to
hole out from the rest point (penalties weighted a little extra), the best few re-scored with
seeded misses. Putts are read by simulating and correcting aim and pace until the putt drops in
the middle. The swing it returns carries its own seeded execution error (`BOT_SKILL`); it averages
about 1–3 over par for nine holes (measured: +2.5 on average over 24 seeded rounds with light wind,
about 1.8 putts per hole).

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
scene = { time, cam:{eye,target,up,fovY,near,far,shiftX?}, ball:{x,y,z,visible,minPx?}, trail:{data:Float32Array([x,y,z]*), count}|null,
          aim:{x,y,z,yaw,carry}|null, pin:{visible}, wind:{x,y}, read:{on}, sunDir?, clearView?,
          golfer?:{visible, mesh | look+club, bones, alpha, fadeNear?} }   // §9.5
```

- GLSL 100 (works on WebGL1 and WebGL2), `highp` fragments, camera-relative positions, and
  25 draw calls or fewer (version 2: 30 or fewer; the themed holes measure 11–22).
- The look follows the hole's course theme (`terrain.theme`, §8.3 as built); `parkland` renders
  Hollow Pines pixel for pixel as version 1.
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
- As built after review: `cam.shiftX` is an NDC lens shift (projection only; `project` and
  `pickTerrain` use the same matrix). `scene.ball.minPx` is the ball's minimum on-screen radius
  (CSS px, default 2.5). The flagstick and flag are drawn after the aim line (the line never paints
  over the pin) with a minimum on-screen size (pole ≥ 40 px, flag ≥ 18 px). Fog adds aerial
  perspective (up to 80% haze from 200 m to 1.4 km) so far woods grade into the hazed ridges.
  Baked tree shadows are a trunk line from the base plus the projected canopy, so a canopy shadow
  thrown 7–11 m by the 42° sun stays tied to its tree. On `webglcontextrestored` the WebGL1
  extensions are fetched again (`contextExtensions(gl, gl2)` in gl.js) before the rebuild.

### Camera (`camera.js`, pure)

```js
export class CameraRig {
  constructor()
  mode                   // 'address'|'putt'|'read'|'flight'|'holed'|'map'|'flyover'|'relief'
  setMode(mode, ctx)     // ctx: {ball, aimYaw, cup, terrain, shot, aspect, carry?, padShift?, relief?}
  update(dt, ctx) -> {eye, target, up, fovY, near, far, shiftX}
  orbit(dyaw)            // read-mode drag
  framing                // last address framing (tests)
}
// also: fovForAspect(aspect), addressFraming(aspect, {dist, dz, h}) -> {back, h, pitch, yBall,
// yTarget, dist}, addressEyeH(dist, aspect), ADDRESS_H, ADDRESS_H_MAX, ADDRESS_NEAR, FLYOVER_T
```

- The eye is always ≥ 1 m above the terrain (≥ 0.3 m for putts).
- `fovY` comes from a 55° horizontal FOV, clamped to 40–75°.
- Address (as built after review): the framed target is the club's carry down the aim line
  (`ctx.carry`, capped at the cup + 10 m). The eye height rises from `ADDRESS_H` = 1.6 m (targets
  within 40 m) by 5 cm per metre (scaled down with the vertical FOV in landscape) up to 9 m, and
  `addressFraming` solves the distance back so the ball projects at NDC y = −0.6 (portrait) or −0.45
  (landscape) and the target at +0.12 / +0.3. If the terrain hides the target (a raised tee over a
  convex bank) the eye climbs 1.5 m at a time until the line of sight clears. In landscape the view
  centre is lens-shifted onto the swing pad (`ctx.padShift` → `shiftX`) for address and putt, so
  the ball sits in the arc on the right. Relief: a raised view of the water entry, the drop spot
  and (within 90 m) the replay spot, in the screen area the decision sheet leaves free. Flight: TV-style
  shot, then a chase cam, then a landing cam (`shot.landing` is known in advance). Flyover: 5 s
  along the spline. Putt: low behind the ball (1.3–4.5 m back, 0.85–2.2 m up with the putt
  length), pitched so the ball sits at NDC y ≈ −0.55. Read: orbit above the green.

## 6. HUD, input, audio, main

- **Top bar:** hole, par, yards, strokes, total versus par, and a pause button (`#pause-btn`;
  the pause sheet's resume button is `[data-act="unpause"]`).
- **Info card:** distance to the pin, "plays like", the lie chip and a wind arrow (relative to
  the camera yaw).
- **Club picker:** ◀ club ▶ with carry and total; it auto-picks on every new lie.
- **Power arc** around the swing pad. Shot toast: "7i · 158/164 yd · Straight".
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
    `?quality=low`, `?course=ID` (§8.5).

### main.js (Integration, as built)

`main.js` has no exports; the header comment is the reference. It owns one `app` object
(`globalThis.__golf`): `{ui, renderer, input, audio, rig, game, view, paused, params, debug, ...}`.

- **Boot:** UI first (settings), then `Renderer(canvas, {quality: ?quality || setting, test:
  ?test})`. `!renderer.ok` shows `#nogl` and stops. `?nogl=1` uses a `NullRenderer` stub (same
  API, draws nothing) so logic, HUD, input and saves still run. The menu backdrop is a slow drone
  shot down hole 1, built behind the `#loading` spinner.
- **Terrain cache:** `Game` gets a caching `buildHole` (last 3 by course, hole, pin and seed); the next
  hole is prebuilt ~150 ms after the scorecard appears, so "Next hole" only uploads to the GPU.
- **Loop:** dt clamped to 0.1 s; `game.update(dt·fast)`, camera `rig.update(dt·fast)`, scene,
  `renderer.draw`. While paused one frame is drawn and then drawing stops. A frame that throws is
  logged (first 3) and the loop keeps running.
- **Phases → views:** intro = flyover camera + lower third, auto-advances after FLYOVER_T + 1.2 s or
  a tap; address = `'address'` or `'putt'` camera by club (sub-views `read`, `map` — a Map tap
  aims at `renderer.pickTerrain` and returns to the ball after 0.45 s — and `flyover`); flight =
  TV sequence for full shots, the putt camera held at the strike point for putts; holed = cup
  orbit + score banner + applause (par and better); scorecard; roundOver = final card with the
  best round on that course (`golf.best.v1`, a per-course map since §8.5; completed nines only). Camera moves longer than 60 m after a
  flight/holed/flyover are hard cuts.
- **Input modes:** `full`/`putt` by club, `read`, `map`, `intro` (intro and flyover), `watch`
  (flight fast-forward, holed → scorecard), `disabled` otherwise (menus, dialogs, pause).
- **Swing:** `interpretSwing(samples, {padRefH: input.padRefH, kind, difficulty, handed, club,
  target, padRect})`; a failed swing shows a toast ("Swing cancelled — swipe up to hit"; putts the
  "Putt cancelled" hint) and is not a stroke. The tap meter and the target notch: §8.1 as built. The live arc readout is `game.carryForPower(power)` (carry, or flat roll for putts), and
  the aim ring follows it. The power curve is warmed on every address so the first gauge move
  does not hitch.
- **Scene:** the pin is out for putts (address, flight, holed and scorecard after a holed putt),
  except that it is attended at address for putts over 9 m and shown in Read; the ball has a
  minimum on-screen size at address (3.5 px), in Read (4.5) and at the relief decision (5), where
  it sits at the drop spot with a dashed line from the water entry; in flight the lie chip reads
  "In the air" / "Rolling"; Read also shows the putt line;
  the trail shows full shots in flight/holed/decision; putts get a thin short-dashed line with a
  0.2 m ring (`aimRibbon` options `ring`, `width`, `lift`, `dash`) and a faint read grid.
- **Toasts:** shot result `'7i · 158/164 yd · Push fade'` (short club name, carry/total; the
  label is the swipe's own shape, and when contact scatter changed the result it says so:
  `'Straight → pull'`; plus `· Rushed`/`· Decel`); putts `'Putter · 12 ft · 2 ft left'`; rule
  messages; "Lip out". The toast wraps onto two lines on a narrow screen; in putt mode it sits at
  the top under the info card (it would cover the cup).
- **Saves:** on every new hole, phase change to intro/address/decision/scorecard, shot end, relief
  choice, pause, `visibilitychange`(hidden) and `pagehide`; cleared at round over. `?autoplay`
  never saves. A failed write removes the stored (stale) copy, and loading takes the newer of the
  stored and in-memory copies (by `savedAt`; the best round by `date`). The resize key includes
  the safe-area insets (a 180° landscape flip moves the pad without a size change).
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
  bottom left, pad on the right). The arc centre is at 40% of the pad height (57% landscape, and the arc
  is a little smaller there, 0.7 × the pad height: §8.7).

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
  move `onSwingProgress({depth, maxDepth, raw, power, overswing, full, phase:'back'|'down'})` (power
  = `powerFromDepth(maxDepth, padRefH, kind)`, §8.1, held at the backswing peak during the
  downswing), and on release `onSwing(samples)` (`[{t ms, x, y}]`, coalesced events included,
  pointerdown to pointerup). `onSwingCancel(reason)`: `'pointercancel'`, `'dragOut'` (§8.1),
  `'mode'`/`'style'` (mode or swing style changed mid-swing). Apart from the live drag-out, input
  never decides strike/cancel; `interpretSwing` does. With `input.swingStyle = 'tap'` a pad press
  calls `onPadTap({x, y, t})` instead (§8.1 tap meter).
- A press above/outside the pad aims: `onAim(dyaw)` per move. Dragging right turns the aim
  clockwise (dyaw < 0); ~0.13°/px, up to 3× for fast drags.
- **read:** drag → `onOrbit(dyaw)` (drag right → dyaw < 0). **map:** tap → `onTap(sx, sy)` (CSS px,
  for `renderer.pickTerrain`); a horizontal drag still sends `onAim`. **intro / watch:** a tap →
  `onSkip()` (use 'watch' during flight to fast-forward), ignored for `SKIP_GUARD_MS` = 350 ms after
  entering the mode (the second tap of a double tap on a closing overlay button). Only the first
  pointer is tracked.
- **Pad rect:** portrait/square = lower 45% (version 2; was 40%) of the canvas above the bottom safe inset, full width;
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
- Screens: `showMenu({canResume, courseName?, courseSub?, courses?, selected?, resumeSub?})` (course picker, §8.5 as
  built), `hideMenu()`, `showPause({title?})`,
  `hidePause()`, `paused`, `showSettings()`, `showHowTo()`, `setLoading(on, text)`, `showNoGL()`,
  `showHud(on)` (`#hud` starts hidden).
- HUD: `setHud({hole, par, lengthM | yards, si, strokes, toPar, distToPin, playsLike, lieLabel,
  lieSurface?, windSpeed, windRelAngle, units?})` (partial merge; distances in **metres**, wind in
  m/s; `windRelAngle` = wind travel direction minus camera yaw, CCW +, 0 = arrow up/helping;
  `playsLike: null` hides it). `setClub({name, carry, total, sub?})` (metres).
  `setPower({power, overswing, full?, carryText, target?} | null)`, `setTarget(power|null)` (§8.1).
  `setHint(text|null)`.
  `setControls({phase, putt, canRead, read, map, puttRange})` — club picker, tools and swing pad
  are shown only for `phase === 'address'`. `showIntro({hole, name, par, lengthM, si, course?})`,
  `hideIntro()`. Shot chip and sheet: `setShot`, `showShots`, `hideShots`, `shotsOpen` (§8.4 as built). `toast(text, ms)` (`'7 Iron · Carry 158 yd · Total 164 yd'`; the first segment is
  a bold tab). `banner(title, sub, {tone:'under'|'par'|'over'|'ace', ms})`.
- `showScorecard(card, {final, current, title?, kicker?, course?})` (the kicker starts with the course name): `card.holes[i] = {n?, par, lengthM? |
  yards?, strokes|null, putts?, fir?: bool|null, gir?: bool|null}` (or the array itself). Totals,
  FIR/GIR/putt stats, circle (birdie or better) and square (bogey or worse) are computed by the UI.
  `final` swaps `[data-act="next-hole"]` for Play again (`new-round`) and Menu (`quit`).
- `showDecision(['drop','replay'] | {kicker, title, text, options:[id | {id,label,detail}]})
  -> Promise<id>`; the first option is the primary default.
- Settings: `ui.settings` (copy), `getSetting(k)`, `setSetting(k, v)`, `onChange(fn)`;
  `{units:'yd'|'m', wind:'off'|'light'|'breezy', difficulty:'easy'|'normal'|'pro', handed:'R'|'L',
  sound:bool, quality:'auto'|'low', swing:'swipe'|'tap'}` in `localStorage['golf.settings.v1']`
  (try/catch).
- `ui.padRect` / `ui.setPadRect(r)`: the HUD positions the power arc and club picker from the same
  `padRectFor` as input.js; main may pass `input.padRect` to be explicit.

### Audio API (`audio.js`)

`new AudioFX()`: `unlock()` (call on every pointerup; idempotent), `setEnabled(on)`, `suspend()`,
`resume()`, `setWind(mps)` (ambient loop), `whoosh(power)`, `impact(kind, power)` (club kind or
`'driver'`), `land(surface, v)` (version 2: also waste, desert and fescue), `tree(v, obj?)` (physics `tree` events
carry `obj`, the object's kind: a rock clacks, a saguaro thuds, shrubs and gorse crackle), `pin(v)`, `lipout(v)`,
`cup(v)`, `applause(strength)`,
and `handle(eventOrEvents)` for shot events `{type, surface, v, kind?}` (`launch` → impact with
`ev.kind` or `ev.club.kind`, else guessed from speed; `land`/`bounce`/`tree`/`pin`/`lipout`/`cup`/
`water`; also synthetic `{type:'swing', power}` and `{type:'applause', strength}`).

---

## 8. Version 2: easier swing, three new courses, special shots (contracts)

Version 2 adds four things to the shipped game (Hollow Pines):
1. A more forgiving swing gesture, plus a tap-meter alternative.
2. Three new 9-hole courses: **desert**, **water** and **links**, chosen from the menu.
3. Course themes in the renderer.
4. Special shots: **draw, cut, stinger, punch, flop, bump & run**.

Everything here is additive. Hollow Pines must play exactly as before unless a section says so.

### 8.1 Swing ease (`input.js`, `swing.js` `interpretSwing`, `ui.js` power arc, `main.js` wiring)

Players reported two problems on a real phone:
- (a) **Power is hard to judge.** Full power was about 100 px of travel, so 10 px changed power by 10%.
- (b) **The swipe is not recognised.** A strike needed the finger to cross the touchdown line upward at 400 px/s or faster.

**Power travel**
- Full power sits at a comfortable thumb distance: `fullPowerPx(padH) = clamp(0.55·padH, 140, 220)` CSS px.
- Putts use their own constant, about 0.5·padH clamped to 110–200 px.
- `swingProgress` and `interpretSwing` must use the same function. Export it from `input.js`.

**Detent at full power**
- Raw power between 0.95 and 1.06 reads as exactly 1.0.
- Overswing (up to 1.1) needs travel past about 1.12× the full-power distance.
- The gauge shows ticks at 25, 50, 75 and 100%.

**Target notch**
- `main.js` computes the power that reaches the target and passes it to `ui.setPower({..., target})`. The target is the pin, or the aim point when the pin is out of reach. The power comes from the inverse of the caddie power curve (`curveAt`/`powerCurve`).
- The arc draws a notch at that power. It glows when the live power is within ±3% of it.
- On Easy, power within ±5% of the target snaps to it.

**Strike recognition** replaces the "cross the impact line at 400 px/s" rule.
- After the deepest point of the backswing, the swing strikes once the finger has climbed by at least `max(24 px, 0.25·depth)` at an average speed of 120 px/s or more.
- It also strikes on release while moving up at 150 px/s or more over the last 80 ms.
- The finger does **not** need to reach the touchdown line.
- A slow but clear upswing strikes with tempo `'decel'` (speed × 0.95) instead of failing as `tooSlow`.
- Cancel only on:
  - release at the bottom with no upward movement (`reason 'cancel'`, toast "Swing cancelled — swipe up to hit");
  - `pointercancel`;
  - dragging more than 90 px sideways out of the pad during the backswing.
- Use pointer capture so leaving the pad never drops a swing.

**Larger pad:** the pad covers the lower 45% of the height in portrait. Keep it clear of the club and shot pickers.

**Tap meter (`settings.swing = 'swipe' | 'tap'`, default `'swipe'`)**
- The first tap in the pad starts a power bar that fills 0 → 1.1 over 1.4 s, then falls back.
- The second tap sets the power and hits.
- Direction and curve are 0. Contact scatter still applies.
- `interpretSwing` is not used. `main.js` builds `{ok:true, kind, power, startDir:0, faceToPath:0, tempo:'smooth', label:'Tap swing'}`.
- Putting works the same way with the putt range.

#### 8.1 as built (swing ease)

- **Power travel** (`input.js`): `fullPowerPx(padH, kind = 'full')` = clamp(0.55·padH, 140, 220) px;
  putts clamp(0.5·padH, 110, 200) px (about 202 px / 184 px on an iPhone 15 in portrait, 147 px in
  landscape). `powerFromRaw(raw, kind)`, `powerFromDepth(depth, padH, kind)` and its inverse
  `depthForPower(power, padH, kind)` are shared by `swingProgress`, `interpretSwing` and the tap
  meter. Full swings (raw = depth / fullPowerPx): power = raw up to 0.8 (25/50/75% of the travel is
  25/50/75% power: the ticks are where the thumb is), a slightly steeper ramp to 1.0 at raw 0.95,
  **exactly 1.0 from 0.95 to 1.12** (the detent: 0.95–1.06 proper plus a margin, since any power
  above 1 is an overswing in `swingToLaunch`), then 1 + (raw − 1.12), capped at 1.1 (raw 1.22).
  Continuous and monotone. Putts are linear (no detent: pace needs every pixel), capped at 1.1.
- **Pad:** portrait/square = lower 45% (`padRectFor`); landscape unchanged (right 40% × lower 72%).
  The club and putt-range pickers stay on the pad's bottom edge, below the arc: they are DOM buttons
  above the canvas, so a press on them never starts a swing, and pointer capture lets a backswing
  run over them.
- **Gauge** (`ui.js`): ticks at 25/50/75/100%. `setPower({power, overswing, full?, carryText,
  target?})`: `full` lights the 100% tick green ("Full · 100%"). `ui.setTarget(power|null)` places
  the gold target notch (also shown, dimmed, while idle); within ±`TARGET_GLOW` (3% of the full-power travel,
  measured in travel since §8.7: `onTarget(power, target, kind)`) of it the notch
  turns white-hot and the readout says "On target · N%". On Easy, `snapPower(power, target,
  difficulty)` (±`EASY_SNAP` = 5%) is applied by the live gauge, by `interpretSwing(…, {target})`
  and by the tap meter alike.
- **Target** (`main.js` `targetPower`, recomputed in `refreshClub`: new lie, club, putt range,
  settings): the "expected finish" (carry + `RELEASE_K` × release, the caddie's own measure) of
  `game.carryForPower` (the caddie power curve, with the wind), inverted by
  `powerForDistance(distAt, dist, maxPower = 1)` (`swing.js`, bisection; null when out of reach).
  The distance is the horizontal distance plus Δz / tan(the club's descent angle), as in plays-like.
  The pin first, up to 1.1 (a notch in the red zone says the pin needs an overswing or more club;
  up to 3% over full reads as full); when the pin is out of reach even then, the course aim point,
  never more than full power, checked on the real hole (integration, 8.6: `playablePower`): when the caddie's
  `predictShot` at that power would land or finish out of play (water, OB, sand, desert, fescue: a forced carry
  short of a dogleg corner gives no release), the notch moves up in 4% steps to the first power that is in play,
  plus one step of margin (§8.7: now "safely in play" at the notch and ±3%, with a 3 m margin for the aim point,
  searched down as well as up, and pin notches checked too). Putts: (distance + 0.35 m) / putt range (the pace that dies a foot
  past on the flat). No notch for a tap-in (< 4%).
- **Strike recognition** (`interpretSwing`, full swings): after the deepest point, strike
  `'climb'` when the highest point reached is at least max(`STRIKE_CLIMB_PX` = 24,
  `STRIKE_CLIMB_FRAC` = 0.25 × depth) above the bottom of its upward run **and** the release is still
  at least half of that above the bottom (a waggle that ends back at the bottom is not a swing);
  else strike `'release'` when lifted while moving up at ≥ `RELEASE_SPEED` = 150 px/s over the last
  `RELEASE_WINDOW_MS` = 80 ms (the window starts no earlier than the move up, so a pause does not
  dilute it; it needs ≥ 10 px of climb, so jitter cannot fake it). Anything else is `reason
  'cancel'` (main: toast "Swing cancelled — swipe up to hit"). The touchdown line is never needed;
  `'tooSlow'` is no longer produced. Clarification of "cancel only on release at the bottom with no
  upward movement": a small climb under the threshold that has stopped before the lift also
  cancels (it is neither a clear upswing nor a flick). On synthetic iPhone traces (60/120 Hz,
  timing and position jitter, coalesced and dropped events, no events while still) a 12 000-swipe
  fuzz strikes 99.6% of human swings (the misses are 50 ms flicks whose only frames were dropped)
  and none of 12 000 hold-and-lifts; `tests/swing.test.js` runs 300 + 300 of them.
- **Tempo:** `'decel'` when the first threshold's worth of the climb averaged under
  `STRIKE_SPEED` = 120 px/s (a slow return, or creeping up before a flick); `'rushed'` when
  power × `TEMPO_REF_PX` (150) / v < `RUSHED_FRAC` × (0.10 + 0.15·power) s, v being the climb to the
  touchdown line (or to the top of the upswing) over the time since the finger left the bottom
  (about 3300 px/s at full power, 2400 at half); else `'smooth'`. The version 1 "over 2× the ideal
  is decel" rule is dropped: a deliberate 200–300 px/s upswing is a normal swing. `DECEL_SPEED` is
  now 0.95 (was 0.92; the `swingToLaunch` code itself is unchanged).
- **Cancels:** `draggedOut(samples, padRect)` = more than `SIDE_OUT_PX` = 90 px beyond the pad's
  left or right edge while the finger is still at or near its lowest point (the backswing); a wide
  follow-through is fine. input.js applies it live (`onSwingCancel('dragOut')`, the rest of the
  touch is ignored) and `interpretSwing` with `opts.padRect`. The portrait pad spans the screen, so
  it only triggers in landscape. `pointercancel` → `onSwingCancel('pointercancel')` (toast "Swing
  cancelled"). `lostpointercapture` no longer cancels: move/up/cancel are heard on `window`, so a
  lost capture can neither drop nor strand a swing.
- **Tap meter:** `settings.swing` (`'swipe'` default | `'tap'`; Settings "Swing control: Swipe / Tap
  meter"; persisted). `input.swingStyle` mirrors it; in tap style a pad press calls
  `onPadTap({x, y, t})` at once (t = event time, so timing does not depend on the frame rate).
  `meterRaw(elapsedS, kind)` / `meterPower(elapsedS, kind)`: the power fills 0 → 1.1 over
  `METER_FILL_S` = 1.4 s through `powerFromRaw` (so it hangs about 0.2 s in the full-power detent),
  falls back the same way and is abandoned after 2.8 s ("Too late · tap to start again"). The second
  tap builds `{ok:true, kind, power, overswing, startDir:0, faceToPath:0, face:0, path:0,
  tempo:'smooth', tempoErr:0, label:'Tap swing'}` for `game.swing`. A club or view change, pause,
  phase change or switching the setting abandons the meter. Hints: "Tap to start · tap again to hit"
  ("… to putt").
- Tests and e2e: `app.debug.depthForPower(power, kind)`; the e2e plays the hole 1 tee shot with a
  short flick that stops well short of the start point (builds without that hook, e.g. a stale
  `dist/`, keep the version 1 swipe), checks that hold-and-lift cancels, and plays a tap-meter shot.

### 8.2 Courses (`courses.js`, `course*.js`, `terrain.js`)

```js
// courses.js
export const COURSES = [PINES, DESERT, WATER, LINKS];   // menu order
export function courseById(id)                           // falls back to COURSES[0]
export const DEFAULT_COURSE_ID = 'pines';
// Course object (each course-*.js exports one; course.js keeps `COURSE` = Hollow Pines and adds id/theme)
{ id:'pines'|'desert'|'water'|'links', name, tagline, theme:'parkland'|'desert'|'tropical'|'links',
  conditions:{ firm: 1.0,          // fairway/rough firmness: >1 = more bounce & roll (links ~1.45, desert ~1.25)
               greenStimpFt: 10.5, // green speed
               wind: 'normal'|'windy' },  // 'windy' adds +3 m/s to the Light/Breezy ranges (links)
  holes:[HoleDef × 9] }
```

- **Files:**
  - `course.js` (Hollow Pines): `COURSE.id = 'pines'`, theme `'parkland'`, conditions `{firm: 1, greenStimpFt: 10.5, wind: 'normal'}`.
  - `course-desert.js` exports `DESERT`, `course-water.js` exports `WATER`, `course-links.js` exports `LINKS`.
- **Building holes:** `buildHole(def, {pinIndex, seed, course})`. HoleTerrain gains `theme`, `conditions` and `courseId`.
  - Without `course`, it defaults to the Hollow Pines values.
- **Physics** takes surface parameters through `surfaceParams(terrain, surfId)` (exported from `physics.js`). It applies `terrain.conditions`:
  - `firm` scales roll resistance `a0`/`kv` by 1/firm on fairway, tee and rough, and raises fairway restitution `e` by `(firm−1)·0.25`. Clamp so the bounce stays physical.
  - `greenStimpFt` rescales the green's `a0`/`kv` so that `stimpDistance(1.83)` matches.
  - Defaults reproduce the current values exactly. All existing tests stay green.

**New surfaces** (append to `SURF`, `SURF_NAMES` and `SURFACES` in `constants.js`):

| id | Surface | Plays like | Lie factors (speed / spin / launch Δ / sdir) |
|---|---|---|---|
| 9 `WASTE` | Desert hardpan, waste sand, beach sand. No penalty, grounding allowed | Firm sand: low bounce, quick stop | 0.93 / 0.75 / +1 / 1.2 |
| 10 `DESERT` | Natural desert scrub with stones | Erratic, dead bounces | 0.75 / 0.5 / +2 / 3.0 |
| 11 `FESCUE` | Links long fescue, marram and gorse edges | Ball stops almost dead | 0.70 / 0.45 / +3 / 3.0 |

- None of the three counts as a penalty area. Lie labels: "Waste area", "Desert", "Fescue".
- `bake.js` and the renderer need colours for them. Each theme may override every surface's colour.

**New HoleDef fields** (all optional; existing holes are unaffected)

- `outside: 'rough'|'desert'|'fescue'|'waste'|'water'`: what lies beyond the rough band.
  - Desert courses use `'desert'`. Links uses `'fescue'`.
  - `'water'` floods everything outside the corridor to a sea or lake level, for island holes and ocean edges.
- `rough: {w}`: half-width of the rough band beyond the fairway edge before `outside` begins (default 18 m).
- `areas: [{surface:'waste'|'desert'|'fescue'|'bunker'|'rough'|'fairway', shape|poly|xy, dz?}]`: free-form surface painting, with an optional height offset. Areas paint before bunkers, water and greens, which still win.
- Bunkers may set `pot: true`: a deep (1.2–1.8 m) round bunker with a steep revetted face. The physics lie stays BUNKER.
- Water may set `sea: true` (renders as ocean with surf and a horizon).
- The `fill: 'outside'` form floods everything outside its polygon, for island greens.
- Object scatter replaces the pine/broad `mix` for themed courses. The old rows still work.
  - `objects: [{kind, from, to, off, gap, jitter} | {kind, s, off, cluster, spread} | {kind, area, density}]`
  - `kind` is `'pine'|'broad'|'palm'|'saguaro'|'shrub'|'rock'|'gorse'|'grass'`.
  - `kind` may also be a weight map such as `{palm: 0.7, broad: 0.3}`.

**HoleTerrain objects** (the `trees` array keeps its name for compatibility). Each entry:

```js
{ kind, x, y, z, trunkR, trunkH, canopy:{cz, rx, rz}|null, hard?:boolean, scale? }
```

- **palm:** thin trunk (0.18 m) about 8–12 m tall, with a canopy ellipsoid at the top.
- **saguaro:** a hard column, trunkR 0.25, trunkH 4–9 m, `canopy: null`. Its arms are visual only.
- **shrub / gorse:** no trunk (`trunkR: 0`), a low canopy (cz about 0.6 m, rx 1–2 m).
  - A ball entering one has a high hit probability and drops nearly dead.
- **rock:** `hard: true`, trunkR is the rock radius and trunkH its height. Collision is a hard cylinder with e = 0.5. No canopy.
- **grass:** dune grass tufts, visual only. Leave them out of `trees`, or give them `trunkR: 0` and `canopy: null`.
- Physics must accept `trunkR: 0` and `canopy: null`.

#### 8.2 as built (course platform)

**Registry** (`courses.js`): `PINES` (= `COURSE`), `COURSES`, `DEFAULT_COURSE_ID`, `courseById(id)` (unknown or
missing id → Hollow Pines) and `courseSummary(course) -> {id, name, tagline, theme, holes, par, lengthM, yards,
conditions}` for menu cards. `constants.js` adds `DEFAULT_CONDITIONS = {firm: 1, greenStimpFt: 10.5, wind:
'normal'}`, `STIMP_REF_FT = 10.5`, `WINDY_EXTRA = 3` and `STONE_E`. `course-desert.js` (`DESERT`, "Red Mesa"),
`course-water.js` (`WATER`, "Coral Cay") and `course-links.js` (`LINKS`, "Kittiwake Links") started as placeholder
holes; the course designers have since replaced them with nine designed holes each (par 36; Red Mesa 3,344 yd, Coral Cay
3,269 yd, Kittiwake Links 3,343 yd as the menu and scorecard total them; the hole-by-hole notes are the header comments of each file, and each course has its
own test file, `tests/course-*.test.js`).

**Conditions** (`physics.js`): `surfaceTable(terrain)` → the whole table, `surfaceParams(terrain, surfId)` → one
entry (unknown ids play as rough). No conditions, or default ones, return `SURFACES` itself (Hollow Pines is
bit-for-bit unchanged); otherwise a derived table is cached per terrain (WeakMap). `simulateShot`, `rules.holdsBall`
and the caddie's flat planes (`planeTerrain({..., conditions})`) all read it.
- (Superseded by §8.7: `a0`, `kv` ÷ firm², crater × firm^−1.5, fairway e + (firm − 1)·0.4, and firm greens.)
  `firm` (clamped 0.6–1.8): `a0`, `kv` ÷ firm on fairway, tee, rough **and OOB** (OOB plays as rough), fairway
  `e` + (firm − 1)·0.25 (clamped 0.8–1.2), and **deviation:** crater tilt × firm^−0.12 on the same surfaces. The
  roll terms alone gave a links 7-iron only +13% release (backspin checks it at the bounce); firm turf dents less,
  and with the crater term it releases +44% (driver +22%).
- `greenStimpFt` (ratio clamped 0.6–1.5): green `a0` and `kv` ÷ k with k = greenStimpFt / 10.5, which scales every
  roll-out on the green by exactly k. **Deviation:** 10.5 is the *nominal* rating of the shipped green, whose
  closed-form Stimp is 10.2 ft; so `stimpDistance(1.83)` is 0.97 × greenStimpFt ft on every course (exact
  match would have changed Hollow Pines).
- Putt pacing: `lieAt()` returns `lie.puttSurf = surfaceParams(terrain, SURF.GREEN)`, and `swingToLaunch` paces putts
  with `puttSpeedForDistance(D, lie.puttSurf || SURFACES[SURF.GREEN])` (since 8.4 as built), so the gauge's flat-roll
  distance holds on every course's green speed (the bot reads putts by simulation either way).

**New surfaces** (`SURFACES`): WASTE e 0.4, plough 0.25, a0 3.4 / kv 1.6 (a driver releases ~3 m instead of 17);
DESERT e 0.45, plough 0.35, a0 4.5 / kv 2, plus `erratic` 0.22 rad (Rayleigh tilt of the impact normal, shot rng)
and `stone` 0.18 (chance per bounce of a stone: tilt 14–34°, e × `STONE_E` 1.6, little friction): mostly dead,
now and then a 5–10 m kick, sideways too; FESCUE e 0.25, crater 2.4, plough 0.75, a0 9 / kv 4 (a 7-iron stops within
0.3 m and holds on any slope). `rules.isDropOk` allows all three; the caddie's `isSafeRest` treats DESERT and
FESCUE like sand (a tee shot is not planned into them). Lie labels come from `SURF_NAMES`.

**Objects** (`terrain.trees`, `physics.js`): `shrub`/`gorse` canopies reach 0.25 m into the ground; a ball in the
air **or rolling** through one is caught with p = 1 − exp(−len/0.5 m) and keeps 3–12% of its speed (dropping at
0.4–1.2 m/s). A shot played from inside a bush (the ball stopped in it) is not caught by that bush again on the way
out (integration: otherwise nearly every shot from there dropped dead in the same bush); other bushes still catch it,
and the lie underneath (desert, fescue, rough) costs the distance. A trunk hit uses e 0.5 and keeps 85% for `hard`
objects (rocks), else e 0.4 / 80% (trees, saguaro columns). A ball dropping onto a rock's top bounces (e 0.5) off a dome normal that leans out with the distance from
the axis and always runs off sideways at ≥ 0.6 m/s (no perching). `treeHit`'s cap result adds `q` (distance from
the axis / (trunkR + R)); hard objects also count trunk hits down to `base − R − rr` (a wide rock on a slope).
Each new-kind entry also has `scale` and `variant` (0–1, for visual variety). Dimensions: palm trunkR 0.18, trunkH
8–12, canopy rx 3–4.4, rz 1.3–1.9 centred 0.2·rz above the trunk top; saguaro 0.25 × 4–9 m; shrub rx 1–2, height
0.9–1.5 (cz = height/2); gorse rx 1.2–2.2, height 1.0–1.6; rock radius 0.35–1.35, height 0.5–1 × radius.
`terrain.decor` holds the grass tufts `{kind:'grass', x, y, z, scale}`; physics never sees them.
`treesNear(x, y, r)` returns objects whose axis is within r + reach (canopy rx, or trunkR without a canopy).

**HoleDef extensions** (`terrain.js` header is the reference). `buildHole(def, {pinIndex, seed, course})`;
HoleTerrain adds `courseId` ('pines' by default), `theme` ('parkland'), `conditions` ({...DEFAULT_CONDITIONS,
...course.conditions}) and `decor`.
- **Corridor:** `outside` applies beyond `rough.w` (default 18 m) of rough round the fairways, `rough.tee` (default
  min(w, 8)) round the tee box and `rough.green` (default w) round green + fringe; the edge wanders by
  `rough.wobble` (2.5 m) and `rough.relief` (desert 0.3, fescue 0.5, waste 0.1 m) roughens the ground outside it.
  The fairway distance is an exact Euclidean distance transform of the fairway mask on the 1 m grid (continuous
  round doglegs); between the tee band and the first fairway is `outside` too (a forced carry).
- **Surface priority:** OOB > water (polygons, then flood) > bunker > green > fringe > tee > areas (later over
  earlier) > fairway > rough band > outside.
- **areas:** `{surface:'waste'|'desert'|'fescue'|'bunker'|'rough'|'fairway', shape (+ s/off or g) | poly ([s, off])
  | xy, dz?, ease? (3 m)}`.
- **Flood:** water entries with `fill:'outside'` together form an archipelago (a point is water when it is outside
  *all* their polygons, so a tee island and a green island make an island par 3); the first one gives kind, level
  (relative, as other water), depth, bank and sea. `outside:'water'` floods everything outside the corridor and its
  areas to `outsideWater {kind:'red', level:-1.2 (relative to the lowest centreline elevation), depth:2, bank:8,
  sea:false}`. `terrain.waters` entries gain `sea` and `fill:'inside'|'outside'`; the one flood entry has `poly` =
  the bounds rectangle (draw one plane; the land above the level hides it) and `islands` (the dry polygons).
  `waterAt` and red/yellow relief work unchanged (island tee shots that come up short drop back on the tee island).
- **Pot bunkers:** `{..., pot:true, r?}` (shape defaults to a circle of r = 2.4): depth clamped 1.2–1.8 (default
  1.5), the face toward the green (down the hole when the green is > 80 m away) ramps over 0.35 m (≈ 55° on the
  1 m grid), the back over min(2.2, 0.9·r) m, lip 0.06 m.
- **objects:** rows `{kind, from, to, off, gap, jitter}`, clusters `{kind, s, off | g:[r, f], cluster, spread}`
  and area scatter `{kind, area, density}` with `area` a surface name (`'desert'`, `'fescue'`, `'waste'`,
  `'rough'`, `'outside'`) or an index into `areas`, and `density` in objects per 100 m² (jittered grid).
  `kind` may be a weight map. `forest.kind` gives the background woodland a kind or weight map. Caps: 5000
  objects, 8000 decor per hole. Objects keep off fairway, tee, green, fringe, water and bunkers.

**Game** (`game.js`): `state.courseId` (serialized); `loadHole`/`restore` call `buildHole(def, {pinIndex, seed,
course})`; `restore(json, {course?})` takes the course from `courseId` (none → Hollow Pines).
`windFor(seed, hole, setting, conditions?)`: a `'windy'` course adds `WINDY_EXTRA` to both ends of the Light and
Breezy ranges (same direction draw; Off stays calm). `holeInfo()` adds `courseId` and `theme`.

**Known gaps for other stages** (all closed since: the bot fix in 8.4 as built, the cache key in 8.5 as built, the
renderer in 8.3 as built): `bot.js` `expectedAt` reads `tr.canopy.rx` and crashes on canopy-null objects
(desert); use `tr.canopy ? tr.canopy.rx : tr.trunkR`, and it should value DESERT/FESCUE rests like rough or worse.
`main.js`'s terrain cache key (`n:pin:seed`) must include the course id. (The renderer now draws the new surfaces and objects: §8.3 as built.)

### 8.3 Themes (`themes.js` data, consumed by `render.js`/`bake.js`/`shaders.js`)

```js
export const THEMES = { parkland, desert, tropical, links };
// theme fields:
{ id, sky:{zenith, horizon, sunColor, sunDir:{x,y,z}, haze}, fog:{color, density}, ambient:{sky, ground},
  surfaceColors:{[SURF.*]: [r,g,b]},  // overrides SURFACES[].color
  water:{deep, shallow, sea?:boolean}, horizon:'hills'|'mountains'|'ocean'|'dunes'|'mesas',
  stripe:1.0 }                       // mowing-stripe strength multiplier (links ~0.4: firmer, browner, fewer stripes)
```

- `parkland` must look exactly like the current Hollow Pines.
- **desert:** hot pale sky, terracotta and tan desert floor, emerald fairways, red mesas and mountains, saguaro, rocks, shrubs.
- **tropical:** deep blue sky, turquoise water with a sandy shallow edge, palms, white beaches (WASTE), lush green.
- **links:** grey-blue overcast sky, a sea horizon, tawny fescue, firm yellow-green fairways, pot bunkers, gorse, dune grass, almost no trees.

**As built (`themes.js`, data only):** `THEMES` and `themeFor(id)` (unknown → parkland). Sky, sun, fog and ambient
colours are linear (as the shaders use them); surface and water-bed colours are albedos like `SURFACES[].color`.
`sky.haze` is the tint `fogCol` applies to the sky just above the horizon (`[0.9, 0.93, 0.95]` shipped);
`fog = {color: null (derive from the sky, as shipped) | rgb, density, aerial}` (aerial = the 0.8 far-haze
strength); `water.deep` is the shader's deep colour, `water.shallow` the bake's shallow-bed colour. Extra fields:
`ridges {far, near}` (horizon silhouettes), `skirt {near, far}` (ground beyond the hole) and `tints` per object kind.
`parkland` copies the shipped constants of `render.js`, `shaders.js` and `bake.js` (and `SURFACES` colours).

#### 8.3 as built (render themes)

`Renderer.setHole(terrain)` takes the look from `themeFor(terrain.theme)`, per hole (a round that mixes courses
switches theme hole by hole); the public Renderer API is unchanged. Hollow Pines (`parkland`) renders bit-identical
to version 1: checked pixel for pixel over 22 views (all nine holes, every camera, both orientations).

**Theme fields added** (`themes.js` header is the reference; all optional for a custom theme): `clouds {cover, shift,
grey}` (cumulus density × cover + shift; grey = overcast deck), `fog.highClear` (the far aerial haze thins with camera
height like the fog, so a map view is not washed out; off for parkland), `revet` (sod colour of pot-bunker faces),
`detail {rake, pebbles, sheen}`, `water {tint (sRGB colour of sunlit shallow water; null = the shipped dark pond),
clarity (m), haze (most haze the sea takes), rough (sea swell: least view cosine, a crisp sea horizon)}`, `land`
(silhouette on the landward side of an `'ocean'` horizon), `seaAz` (sea direction by hole number, degrees from the
tee→green line, for holes without sea water) and `seaHalf`, `skirt {detail, scale, blend}`, `skirtObjects {kinds,
perVertex, grass}` (null = the shipped pine/broad tree line), `trunks {palm, saguaro}`.

**Looks.** desert ('mesas'): deep blue sky with few clouds, pale haze; red flat-topped buttes with talus aprons and
strata over blue-violet ranges; a tan desert floor with iron-red and caliche patches, pebbles and scrub tufts close up;
saguaros, creosote and boulders, also on the skirt. tropical ('ocean' + hills): deep blue sky, fair-weather cumulus;
turquoise shallows over white sand deepening to ocean blue with distance from the shore; surf on the sea's beaches;
palms and broadleaves (palm/broad jungle on the skirt). links ('ocean' + dunes): grey-blue overcast; tawny fescue with
wind-combed wisps and rolling wind sheen; dune-grass tufts; gorse in flower; revetted pot bunkers; faint stripes
(`stripe` 0.4); a steel-grey sea with surf.

**Sea** (`meshes.js` `seaSetup(terrain, theme)` → `{level, dir, cosHalf, full, near, rect}` or null): every `'ocean'`
hole and any hole with sea water has one. Level: the flood's (island and ocean holes: `full`, sea all round), else the
sea polygon's (direction toward it), else 1.5 m under the lowest grid-edge point (direction `seaAz`; `near: false`).
`skirtMesh(grid, {sea, dense})` drops the skirt under the sea toward it: from the grid edge when the sea is the hole's
own water, else with a beach 60–90 m out (a sea off the course does not trace the grid's rectangle); the shelf reaches
−90 m at 4 km; landward rings stay ≥ level + 0.8; nrm.y carries the seaward weight for the beach colour. `waterMesh(waters, pad, {sea, skirt})` puts the
sea on the skirt's own vertices and triangles with a per-vertex depth (level − skirt height), so the surf line lands on
the skirt's shore, plus a ring to 6 km; the hole's sea polygons and flood are clipped to the grid rectangle. The sky
shader draws the open sea below the horizon beyond the far plane (same colour model), and the horizon silhouettes taper
into the sea sector.

**Water shader.** Themes with `water.tint`: colour = tint (lit) over the bed, deepening with depth and with distance
from the shore (`bakeWaterDepth(terrain)`: r = depth / 6 m, g = chamfer distance to dry ground, on the 1 m grid; beyond
the grid the distance keeps growing), alpha 0.42 (shallow) → 0.97; sea water adds rolling foam bands and a lacy fringe
at the waterline. Parkland water is unchanged.

**Ground** (`bake.js`). `bakeTerrainColor(terrain, {sunDir, seed, theme})` paints the theme's surface colours and the
new surfaces (desert patches, waste/beach sand with a damp band at the water, tawny fescue), revetted sod on bunker walls
steeper than gradient 0.88 on the 1 m grid (pot bunkers reach 0.8–1.3; every ordinary bunker on the four courses stays
under 0.75), and per-kind object shadows (palm trunk and crown, saguaro column and arms, bush, rock). Its `detail` (RGBA
mask: desert, waste, fescue, sod; null when the hole has none) drives the terrain shader's close-up texture (pebbles and
scrub, rake lines, fescue wisps and sheen, stacked sod layers). Themed skirts (`skirt.blend`) start as the blurred colour
of the grid edge and turn into their own ground over the first band, with `dense` edges (a vertex per grid node: no
slits along the grid edge), so a hole has no visible border.

**Objects.** One instanced program (`OBJ_VS/FS`) for palm (curved trunk with leaf-scar rings, 11 fronds with cut-out
leaflets, hanging dead fronds; crown sway, frond flutter), saguaro (ribbed column, up to four arms by size), shrub
(open, twiggy creosote) and gorse (dense, yellow-flecked), rock (faceted, strata and lichen), and dune grass (three
clumps of blades from `terrain.decor`, streaming in the wind, faded out beyond 70–120 m). Instance rows are the tree
layout `[x, y, z, h, rx, rz, r, seed]`; colours jitter per instance. Objects standing in the sight line from the
camera to the ball and tall enough to block it dissolve (`scene.clearView: false` turns that off). Triangles: palm 354,
saguaro 556, bush 400, rock 80, tuft 54. Measured: 11–22 draw calls and 160–520 k triangles on the themed holes
(Hollow Pines 16–18, 320–360 k).

### 8.4 Special shots (`shots.js`; hooks in `swing.js`, `caddie.js`, `game.js`, `ui.js`, `main.js`)

```js
export const SHOTS = [ {id:'normal', name:'Normal', blurb}, {id:'draw',...}, {id:'cut',...},
                       {id:'stinger',...}, {id:'punch',...}, {id:'flop',...}, {id:'bump', name:'Bump & run', ...} ];
export function shotsFor(club, lie)                    // eligible shot ids for this club and lie ('normal' always)
export function applyShot(p, shotId, club, lie, opts)  // p = {ballSpeed, launchDeg, spinRpm, startDirDeg, faceToPathDeg}
                                                       // returns a new p; opts {handed:'R'|'L', power}
```

`swingToLaunch(..., opts.shot)` calls `applyShot` after `applyLie` and `partialSwing`, before the D-plane. The intended curve adds to the swipe's own `faceToPath`.

**Eligibility**
- **draw / cut:** every full-swing club except the putter.
- **stinger:** D, 3W, 5W, 4H, 5i and 6i. Not from a bunker or from fescue.
- **punch:** 4H, all irons, PW and GW.
- **flop:** GW, SW and LW. Not from WASTE or DESERT hardpan; a flop needs a cushion of grass.
- **bump:** 7i to SW.

**Target behaviour** (full power, flat, no wind; the tests use these ranges)

| Shot | Change | Result |
|---|---|---|
| Draw (RH) | Path +3° right, face-to-path −4° | 7i finishes 6–15 yd left of a normal shot. Spin −8%, about 3–8 yd more roll |
| Cut (RH) | Path −3° left, face-to-path +4° | 7i finishes 6–15 yd right. Spin +8%, launch +1°, carry −2–4% |
| Stinger | Launch × 0.5, spin × 0.6, ball speed × 0.97 | Driver apex under 15 m, carry 15–25% shorter, roll 2–4× normal; total within −12%…+5% of normal on a firm fairway |
| Punch | Launch × 0.6, spin × 0.75, ball speed × 0.9 | Apex under 60% of normal, carry 80–90%. A 5 m/s headwind costs at most half what it costs the normal shot |
| Flop | Launch +14°, spin × 1.1, ball speed × 0.72 | Landing angle 55° or more; rolls 3 yd or less on the green |
| Bump & run | Launch × 0.45, spin × 0.3, ball speed × 0.85 | Carry is 25–45% of the total |

- Left-handed play mirrors draw and cut.
- `caddie` functions accept `opts.shot`. The aim preview and carry/total readouts must reflect the selected shot, including the curve of a draw or cut.
- **Game:**
  - `game.setShot(id)` and `game.shotType` (default `'normal'`) are serialized.
  - The shot resets to `'normal'` after every stroke, and whenever the club changes to one that isn't eligible.
  - `game.shotsAvailable()` lists the eligible shots.
- **UI:** a shot chip next to the club picker ("Shot: Normal ▾") opens a sheet of the eligible shots, each with a tiny flight-shape icon and a one-line blurb.
  - Shot toasts name the special shot: "7i Stinger · 140/178 yd".

### 8.5 Menu and saves

- The main menu gets a course picker: four cards with name, tagline, par and yards, and a theme-coloured thumbnail (CSS gradient). New round starts the selected course.
- The save (`golf.save.v1`) stores `courseId`. Old saves without it load as Hollow Pines.
- The best round is kept per course: `golf.best.v1` becomes a map `{[courseId]: best}`. An old single value counts as Hollow Pines.
- `?course=desert|water|links|pines` URL parameter (and `mixed`, §8.7; `mixed&holes=18`, §8.8).

#### 8.4 as built (special shots)

**`shots.js`** (pure): `SHOTS` (menu order `normal, draw, cut, stinger, punch, flop, bump`; each `{id, name, short?,
blurb, ...factors, releaseK?, clubs?, notFrom?}`, blurbs one line, ≤ 26 characters), `shotById(id)` (unknown →
normal), `isEligible(id, club, lie)`, `shotsFor(club, lie)` (ids, `'normal'` first; the putter only `['normal']`),
`applyShot(p, id, club, lie, {handed, power})` → a new `p` (normal, unknown ids and the putter: an unchanged copy;
eligibility is the caller's business), `shotIntent(id, club, handed)` → `{startDirDeg, faceToPathDeg}` (the shape the
shot adds: what the toast takes out of the swipe label), `FLOP_MAX_LAUNCH = 60`. Eligibility exactly as the contract
(stinger not from BUNKER or FESCUE, flop not from WASTE or DESERT). A path change `dPath` with a face-to-path change
`dF` moves the start direction by `dPath + k·dF` (k = the club's D-plane split), so a 7-iron draw starts on the line.

**Factors as built** (deviation: the contract's factors are where tuning started; these hold the table's results for
every eligible club with this physics, `tests/shots.test.js`):

| Shot | As built | Measured (full power, flat, still air) |
|---|---|---|
| Draw | path +3°, face-to-path −4°, spin × 0.92, **launch −2.5°**; path and face-to-path × spin loft / 31 (§8.7) | 7i 12.6 yd left, +4.2 yd roll, carry +0.6%; driver 15.9 yd, 3W 17.1 yd |
| Cut | path −3°, face-to-path +4°, spin × 1.08, launch +1°, **ball speed × 0.985** | 7i 11.9 yd right, carry −3.0% |
| Stinger | launch × 0.5, **spin × 0.7**, ball speed × 0.97 | driver apex 8.8 m, carry −21%, roll × 3.5, total −2% (+1% firm links) |
| Punch | launch × 0.6, spin × 0.75, **ball speed × 0.91** | apex 38–42% of normal, carry 82–86%, 5 m/s headwind costs 8–21% of the normal loss |
| Flop | **launch +18°** (≤ 60°), **spin × 0.42**, ball speed × 0.72 | lands 56.6–59.2°, rolls −2.5…+0 yd on a green (partial swings ≤ 2.4 yd) |
| Bump & run | **launch × 0.85, spin × 0.7, ball speed × 0.8** (§8.7; was × 0.3 / × 0.2) | at 15–25 m chips onto a green: carry 15–18% of the total (7i), 18–23% (9i), 35–41% (PW), 54–58% (SW) |

Why: the draw and cut factors alone gave +1 yd of draw roll and −1.3% of cut carry (the closed face delofts, the open
face glances). Stinger at × 0.6 spin carried 25.4% shorter with × 4.04 roll (both just outside). A flop at × 1.1 spin
(10 800 rpm at 25 m/s, landing at 55°) zips back 4–6 yd here, the opposite of "stops dead" (the test asks |roll| ≤ 3
yd); the low spin is what a slow, glancing open-face strike gives. The bump's launch × 0.45 carried 58–62% of the
total on a fairway (it met the range only on a green). `releaseK: 1` on stinger, punch and bump: shots meant to run
count all of their release for the target notch (caddie `releaseK(id)`, else `RELEASE_K`).

**Swing** — `swingToLaunch(club, lie, swing, aimYaw, rng, {pos, puttRange, shot, handed})`: `applyShot` runs on
`{...applyLie(...), faceToPathDeg}` (the swipe's face-to-path plus contact scatter) after the lie and partial-swing
terms, before the D-plane; `launch.meta` adds `shot` and its `faceToPathDeg` includes the shot's. Putts are now paced
with `lie.puttSurf || SURFACES[GREEN]` (closes the 8.2 gap; identical on Hollow Pines).

**Caddie** — `clubTable(t, pos, lie, wind, {aimYaw, shot, handed})`: the shot where the club can play it, else normal;
rows add `side` (landing m across the aim line, + = right) and `shot`. `clubRow(t, pos, lie, wind, clubId, opts)` →
one such row (null for the putter). `powerCurve(t, pos, lie, wind, clubId, aimYaw, {shot, handed})` rows and
`curveAt` add `side` / `sideTotal`. `predictShot(..., power, {shot, handed})`. `shotPreview(t, pos, lie, wind,
clubId, aimYaw, {power, shot, handed})` → `{path [t,x,y,z]*, carry, total, landing, final}` (the intended flight over
flat fairway, recorded). `expectedFinish(row, k = RELEASE_K)`, `releaseK(shotId)`. `suggestClub` and `playsLike` use
the stock table (the caddie picks the club for a normal swing).

**Game** — `state.shotType` (`'normal'`; serialized; restore of an older save → normal), `shotType`, `setShot(id)` →
false unless eligible for the club and lie, `shotsAvailable()` → ids. Reset to normal at the strike (`_strike`, so a
restored mid-flight save matches), on every new spot (`_newLie`), and by `setClub` when the new club cannot play it.
`swing()` plays it (with `settings.handed`); `shot.swing.shot` and `hole.last.shot` record it. `clubInfo(id?, shot?)`
→ adds `landAngle` and `shot` (default: the selected shot for the selected club; special rows cached per spot),
`carryForPower(p)` follows the shot and adds `side`/`sideTotal`, `shotPreview(power)` (cached per spot, club, shot,
aim and power to 0.01; null for the putter). `holeInfo()` adds `courseName`.

**Bot** — plans carry `shot`; `playBotShot` calls `setShot`. Candidates: bump & run (8i, PW) for approaches under
45 m from fairway, fringe, tee or waste; punch with the approach clubs and a stinger with the two longest advance
clubs into a headwind of ≥ 4 m/s. Scored like any candidate, so they win only when they score better (seed 7,
breezy: stingers on the links tees, the odd punch; bumps rarely win). Also: the canopy-less object fix (`tr.canopy ?
tr.canopy.rx : tr.trunkR`), lie costs WASTE +0.1, DESERT +0.4, FESCUE +0.45 strokes, and the flat planning plane
carries the course conditions. Bot rounds (seed 7, breezy): pines +3, desert +2, water +1, links +6.

**UI** — `#club-row` holds the club picker and the shot chip `#shot` ("SHOT / Normal ▾", gold while a special shot is
selected, hidden for putts): `ui.setShot({id, name, special?, show?})`; a tap emits `'shots'`.
`ui.showShots({shots:[{id, name, blurb, carry?, total?}], current, handed, kicker})` opens `#shots`: one row per
eligible shot with a flight-shape icon (side view; draw/cut from above, mirrored left-handed), the blurb and
"carry/total yd"; a pick emits `'shot'` (id), the × or a tap outside emits `'shots-closed'`; `hideShots()`,
`shotsOpen`. The panel sits above the pad in portrait and left of it in landscape (`--pad-*` are mirrored onto
`:root`); input is disabled while it is open, and any phase/putt/read/map change closes it.

**main.js** — the chip opens the sheet with each shot's `clubInfo(club, id)` carry/total; a pick sets the shot,
refreshes the club readout, notch and chip and saves. Target notch: the shot's `landAngle` and `releaseK`. **Aim
preview:** for a draw or cut (`shotIntent` bends) the address scene draws `game.shotPreview(power)` (gauge power,
full while idle) draped 0.1 m over the hole up to the landing as `scene.trail` (gold), and `scene.aim` becomes only
the landing ring there (`carry 0.3`, `ring = max(1.6, 0.035·carry)`). Deviation: the renderer is not this stage's, so
the curve reuses the shot-trail ribbon instead of bending the dashed aim line; other shots keep the straight line
with the shot's carry. Toast: "7i Stinger · 140/178 yd · Straight" (`shotById(id).name` after the short club name;
the label is the swipe's own shape with the shot's intent taken out).

#### 8.5 as built (menu, saves, best rounds)

- **Picker:** `ui.showMenu({canResume, courses:[{...courseSummary(c), best}], selected, resumeSub})` builds
  `.course-pick`: 2 × 2 cards (thumbnail on top in portrait, on the left in landscape) with a CSS-gradient theme
  thumbnail (`data-theme`), the best score on it, name, tagline and "Par 36 · 3,315 yd"; the selected card has a gold
  ring and check, and the title above shows its name and "9 holes · Par 36 · Best 38 (+2)". A tap emits `'course'`
  (id); `ui.selectedCourse`. The choice is stored in `golf.course.v1`; `?course=` overrides it for the visit (not
  stored). The menu backdrop flies over the selected course's first hole (rebuilt 30 ms after a pick).
- **Rounds:** New round plays the selected course; Restart and Play again replay the round's own course. The
  terrain cache key is `courseId:n:pin:seed`, and the scorecard prebuild uses the round's course.
- **Saves:** the wrapper is `{v: 1, savedAt, courseId, game}` (and the game state has `courseId`); `saveCourseId(save)`
  → the wrapper's id, else the game's, else pines. Resume shows "Red Mesa · Hole 4" under its label.
- **Best rounds:** `golf.best.v1` = `{[courseId]: {strokes, toPar, date}}`; `bestMap(raw)` reads an old single record as
  Hollow Pines'; stored and in-memory copies merge per course by date (`mergeBest`); `recordBest(map, courseId,
  totals, holes)` → `{map, best, isNew}` (complete nines only). These helpers and `courseFromParam(value)` are pure
  exports of `game.js` (unit-tested); `main.js` owns the storage.
- **Headers:** the scorecard kicker starts with the course name (`showScorecard(card, {course})`, default
  `card.course`): "Hollow Pines", "Red Mesa · New best round!". The hole intro has the course name above the hole name
  (`showIntro({..., course})`).
- `?autoplay` reports `__golfDone.course`; `app.debug.state()` adds `courseId` and `shotType`.
- **e2e:** after the version 1 flow, quit to the menu, pick Red Mesa, check the intro, open the shot sheet (driver:
  normal, draw, cut, stinger; panel clear of the pad), play a stinger with a flick (apex < 15 m, shot resets), check
  the toast "Driver Stinger", then `?course=links` selects Kittiwake Links and Resume (sub-line "Red Mesa · Hole 1")
  restores the desert round. Then Coral Cay (a draw) and Kittiwake Links (a cut) the same way: picked on the menu,
  intro, theme, the shot sheet, the curved preview, a flick, the toast, reload and resume (8.6). Builds without the
  picker (a stale `dist/`) skip it.

### 8.6 Integration (as built)

All four courses run end to end in the real game (dev and single-file builds), with the version 2 swing, the special
shots, the course picker, per-course saves and best rounds.

- **Physics (bushes):** a shot played from inside a shrub or gorse bush (the ball ran in and stopped there) is not caught
  by that bush again on the way out; other bushes still catch it (8.2 as built, Objects). The course designers had kept
  bushes out of play because of this; a ball that does reach one is now playable.
- **Events and audio:** physics `tree` events carry `obj` (the object's kind); the audio plays a rock clack, a saguaro
  thud and a bush crackle for them, and its own landing sounds for waste/beach sand (gritty crunch), desert scrub
  (stony click) and fescue (soft swish).
- **Target notch (aim point):** found in the play-test: on Red Mesa's 3rd the aim point is the dogleg corner 7 m
  past the start of the first fairway island, and the notch (expected finish, carry plus release) asked for a 64%
  driver that carried into the desert short of it. The aim-point notch is now checked on the real hole (8.1 as built,
  Target). Over 80 aim-point notches in bot rounds on all four courses (breezy) it moved 4 (Red Mesa 3rd and 8th tee
  shots, 0.65 → 0.77 and 0.68 → 0.80; a hybrid from a Kittiwake pot to full), at most 10 ms of simulation.
- **Curved aim preview:** the draw / cut preview drapes on the water surface over lakes and the sea (it ran under the
  water and looked broken across Coral Cay's lagoon).
- **Menu and card yardage:** `courseSummary` sums the per-hole lengths rounded to the metre, like `newCard`, so the
  course card and the scorecard's Out total agree (Hollow Pines 3,315 yd on both).
- **HUD:** in putt mode (portrait and square) the result toast sits left-aligned under the info card and stops short of
  the tool buttons (Read / Map / Flyover reach down past it), wrapping instead of running under them.
- **Course report:** `npm run course [id]` reports every course (or one) with the new surfaces.
- **Play-test** (Chromium + SwiftShader, iPhone 393 × 852 portrait and 852 × 393 landscape, auto quality): the first
  three holes of every course with real touch swipes (short flicks at the target notch ± 4%, putts at the notch ± 6%) and
  a special shot on each course (punch, flop): every swipe struck, no console errors, nothing overlapping except the
  putt-mode toast (fixed above). Scores: portrait Pines 5-3-5, Red Mesa 5-3-7 (the 7 is the notch above, before the
  fix), Coral Cay 5-5-3, Kittiwake 5-4-3; landscape Pines 5-3-5, Red Mesa 5-3-5, Coral Cay 5-5-3, Kittiwake 4-5-4.
- **Renderer budget** (`renderer.stats()`, auto quality, DPR 2 portrait, the address and Map views of every hole): Hollow
  Pines at most 21 draw calls / 502 k triangles, Red Mesa 22 / 498 k, Coral Cay 21 / 534 k (the island par 3: 11 / 66 k),
  Kittiwake Links 20 / 484 k; all within the 30-call budget.
- **e2e** (`tests/e2e.spec.mjs`): the version 1 flow (a short flick that never returns to the start line, a hold-and-lift
  cancel, a tap-meter shot, putts, pause, reload and resume), then the course picker, a Red Mesa stinger, `?course=`,
  the desert resume, and a round each on Coral Cay (a draw) and Kittiwake Links (a cut): card, intro, theme (terrain and
  renderer), shot sheet, curved preview and landing ring, flick, toast, reload and resume on the same hole and stroke.
  `--soak` plays a full autoplay round on every course on both builds (`--courses=` for some, `--soak-only` without the
  UI flow) and checks the peak draw calls against the 30-call budget.
- **Results:** `npm test` 296/296; e2e 474/474 checks (portrait, landscape and foldable on `index.html` and
  `dist/golf.html`); soak 24/24 (a full autoplay round on each course on both builds, no errors, peak 14–16 draw calls
  at `quality=low`; bot scores +1 to +5).

### 8.7 Mixed rounds and the final review fixes (as built)

**Mixed Nine** (the user request "an option to have random holes which mix up the different courses"):
- `courses.js`: `MIXED_ID = 'mixed'`, `MIXED_NAME = 'Mixed Nine'`, `MIXED_TAGLINE`, `drawMixedHoles(seed)` →
  `[{courseId, hole (0-based)} × 9]`: par 36 like every course (two par 3s, five par 4s, two par 5s), two or three
  holes from each of the four courses, opening with a par 4, never two holes of one course in a row (the course with
  the most holes left goes next); deterministic per seed. `mixedCourse(seed, picks?)` → a course object `{id:'mixed',
  name, tagline, theme:'mixed', mixed:true, conditions: DEFAULT_CONDITIONS, picks, holeCourses, holes}` whose `holes`
  are the source courses' own HoleDefs (`picks`: a saved draw, used when it names nine real holes, else drawn from the
  seed). `holeCourse(course, i)` → the course to build hole i with (the course itself for a normal round),
  `mixedSummary()` (menu card: par 36, `lengthM: null`), `isCourseId(id)`, `courseName(id)`.
- `game.js`: `state.mix` (the picks, serialized; `restore` rebuilds the mixed course from `courseId: 'mixed'` and
  `mix`), `courseOf(i = holeIndex)`; each hole is built with its own course (theme, conditions) and its wind uses
  that course's conditions (a Kittiwake hole is windy). `holeInfo()` adds `mixed`, `holeCourseId`,
  `holeCourseName`, `holeN` (the hole's number on its own course); `n` is the round's number (1–9). The terrain
  cache key stays `courseId:n:pin:seed` of the source course, so a mixed hole shares builds with its course.
  `courseFromParam('mixed')`, `saveCourseId` and `bestMap` accept `'mixed'` (one best mixed round: every draw is
  par 36).
- `scoring.newCard` numbers a mixed round's holes 1–9 and adds `from: {courseId, name, theme, n}` per hole;
  `ui.showScorecard` then adds a Course row (a chip with the course's initial on its theme colour).
- UI/main: a fifth, wide card "Mixed Nine · Nine random holes from all four courses · Par 36 · New holes every round"
  under the four (a four-colour thumbnail); New round draws a new nine from the round seed, Restart replays the same
  nine, Play again draws a new one; the intro's course line names the hole's course ("Hollow Pines · No. 7"); the
  menu backdrop for the card is the first hole of `mixedCourse(1)`; Resume reads "Mixed Nine · Hole 4";
  `?course=mixed`; `app.debug.state()` adds `holeCourseId`, `theme`, `mix`. e2e: picked on the menu, intro, theme,
  Course chips, a flick, reload and resume of the same nine; the soak plays a full autoplay mixed round.

**Physics** (`physics.js`, `terrain.js`, `rules.js`):
- Firmness (deviation from §8.2: the review measured links drives running 18 yd like parkland): `a0`, `kv` ÷ firm²,
  crater tilt × firm^−1.5 on fairway, tee, rough and OOB, fairway `e` + (firm − 1)·0.4; greens when firm > 1: crater
  × firm^−0.8, spin kept at the bounce × (1 − 0.3 (firm − 1)), spin-back cap × (1 − 1.2 (firm − 1)). Driver roll on
  the fairway: parkland ~19 yd (unchanged), Red Mesa ~22–29, Kittiwake ~33–37 (real holes, median 33); on Kittiwake's
  greens a 7-iron releases ~7 yd and a full SW stops by its pitch mark (Hollow Pines: 0.5 yd and −3 yd).
- Pot bunkers: the 1 m grid spreads a pot's face up to a cell outside its outline; that steep band (gradient > 0.7
  within 1.1 m) is BUNKER too, and `terrain.potAt(x, y)` reports the pot and its band. Sand steeper than `REVET_GRAD`
  (0.88) is the revetted sod wall: `revetParams` (e 0.25, no crater, plough 0.94, mu 1, a0 3.2), both in the air and
  when a rolling ball runs into it (an impact, not the speed-keeping re-seat); pot sand (`potAt`) ploughs (crater
  0.5, plough 0.8). A 4H or 5i from a pot floor toward the cup stays in ~91% (was 48–52%); the flop gets out; no ball
  rests on a face. `contactParams(terrain, surfId, grad)` (exported) is shared with `rules.holdsBall`.
- Lie (`lie.js`): fescue and desert speed factors fall with loft (`TALL_LIE`: fescue 0.45 for a 3-wood to 0.70 for
  the 9-iron and wedges, desert 0.63 to 0.75), so the club out of them is an iron (fescue 7-iron ~85 yd). A ball
  inside a shrub or gorse bush: `lie.bush`, label "Fescue · In the gorse" / "Desert · In a bush", `BUSH_LIE` (speed ×
  0.5, woods × 0.6 more, spin × 0.4, launch +4°, sdir +4°): a 20–30 yd hack-out.
- Shots (`shots.js`): draw/cut path and face-to-path × min(1.3, spin loft / `SHAPE_LOFT` 31) (the 7-iron unchanged;
  driver 16 yd, 3W 17 yd instead of 36/32); bump & run launch × 0.85, spin × 0.7, speed × 0.8 (table in §8.4).

**Swing and HUD** (`input.js`, `swing.js`, `ui.js`, `style.css`):
- Dialling back: `swingSetPoint(samples, dial = true)` → `{i, y}`, the bottom the power is read from. It follows the
  finger down, and up while the finger eases up slowly (once 6 px above for 100 ms at under `DIAL_SPEED` 90 px/s,
  timed from the first sample clearly above it so a pause never makes a flick look slow; then sample by sample over a
  50 ms window); a rise that once went 150 px/s or faster is the swing and never dials. `swingProgress` (gauge) and
  `interpretSwing` (from the set point on) both use it, so the struck power is the gauge's. Putts do not dial.
  Deviation from §8.1: a climb under 90 px/s is no longer a 'decel' strike but a dial (lifted there, it cancels);
  90–120 px/s is still decel.
- Travel: `swingTravel(padH, kind, y0, padRect)` = fullPowerPx, or less when the touchdown is low in the pad (the
  detent proper must fit above the pad's bottom edge), never under `TRAVEL_MIN_PX` 90; `powerFromDepth` /
  `depthForPower` take it as a 4th argument; `swingProgress(samples, padH, kind, padRect)` returns `travel`;
  `app.debug.depthForPower(power, kind, y0?)`.
- `STRIKE_CLIMB_MAX` = 32 px caps the climb threshold (a 35 px flick that eases to a stop after a deep backswing now
  strikes). `onTarget` is measured in travel (`rawForPower`), so the glow is ~±6 px everywhere and a 97% notch reaches
  into the detent.
- Landscape: the arc sits at 57% of the pad (0.7 × the pad height) and the readout left of it, so the target, the
  landing ring and the flag stay above the arc and off the readout. Portrait: the info card stops 8 px short of the
  tools column and a long lie chip wraps.

**main.js / game / caddie / bot:**
- Target notch (`playablePower`): safe = the predicted shot at the notch and at ±`SCATTER_P` (3%) lands out of water,
  OB, sand, scrub and fescue and rests out of them (aim point: and `SAFE_MARGIN` 3 m clear); otherwise the nearest
  safe power within ±0.16 (aim point, never past full) or ±0.06 (pin) in 2% steps, longer first on a tie. Red Mesa's
  8th: the 3-wood notch now rests 9 m from the scrub.
- `game.shotPreview(power)`: power to `PREVIEW_POWER_STEP` 0.02 and aim to `PREVIEW_AIM_STEP` 0.25°, up to 48 previews
  cached per spot, club and shot; `caddie.shotPreview` keeps one flat plane per terrain and height.
- Bot: from a deep bunker (rim ≥ 1 m above the ball) SW/LW normal and flop at 0.6/0.85/1.0 power over a fan of 0, ±25,
  ±50, ±90 and 180°; an approach whose intended ball hits a tree (or ends behind the ball) is not "corrected" toward the
  ricochet, and lines ±3° and ±6° either side of it are tried; `NOISE_SAMPLES` 8.
- Looks: pot floors and back slopes are clean sand (no edge or hollow darkening) and the revetted face is lit stacked
  turf (links `revet` [0.3, 0.34, 0.17], sod × 0.62–1.07); Red Mesa's buttes are taller, warmer and less hazed with a
  ragged caprock and flanks lit or shaded by the sun; Red Mesa's turf is a deeper olive green with a bluer green.
- Tests: build-time checks warm up and take the best of three; the e2e tap meter sends both taps with explicit event
  times 600 ms apart and waits up to 45 s for shots to resolve.

**Results** (final): `npm test` 306/306; ESLint clean; e2e 558/558 checks (portrait, landscape and foldable on
`index.html` and `dist/golf.html`, now with the Mixed Nine flow); soak 30/30 (a full autoplay round on each of the four
courses and a mixed round, on both builds: no errors, peak 13–16 draw calls at `quality=low`, bot −1 to +5); the repo
root's `npm test` 159/159.

**Known gaps:** near-field turf is still the 0.5 m bake (soft at 3× up close); the buttes are still silhouettes (no
geometry); the bot plays the flop only from deep bunkers.

### 8.8 Mixed rounds of 9 or 18 holes (as built)

The user asked for "random holes which mix up the different courses"; Mixed Nine (§8.7) now has an 18-hole size.
Ids: `'mixed'` stays Mixed Nine (its name, saves and best record are unchanged); `'mixed18'` is **Mixed Eighteen**.
The fixed courses stay at nine holes.

- `courses.js`: `MIXED18_ID = 'mixed18'`, `MIXED18_NAME = 'Mixed Eighteen'`, `MIXED18_TAGLINE`, `MIXED_SIZES = [9, 18]`,
  `isMixedId(id)`, `mixedId(n)` (18 → `'mixed18'`, else `'mixed'`), `mixedHoles(id)` (9 / 18 / 0); `isCourseId` and
  `courseName` know `'mixed18'`.
  - `drawMixedHoles(seed, n = 9)`: n = 9 is the old code path, so every existing seed draws the same nine (golden:
    seed 7 → `links8, water5, links2, desert7, pines4, water4, links0, desert4, pines2`).
  - n = 18 (own stream `mulberry32(seed ^ 0x6d1f3a5b ^ 0x1b873593)`): two nines, each with the Mixed Nine make-up
    (pars 2/5/2, two or three holes per course, one course giving three, never the same course as the other nine's
    third), the second drawn from the holes the first left. Each nine is ordered with a par 4 first (also from another
    course than the 9th), then the course with the most holes left that is not the last hole's, preferring a par that
    differs from a par-3/par-5 predecessor. Up to 32 attempts keep the draw with the fewest back-to-back par 3s/5s
    (stopping at none). Result: 18 distinct holes, par 72 (Out 36, In 36), 4 par 3s and 4 par 5s, 5/5/4/4 per course,
    par 4s on the 1st and 10th, never one course twice in a row (also 9 → 10). Checked over 2000 seeds in the tests
    (5000 when built: no failures, no par pairs, ~0.03 ms per draw).
  - `mixedCourse(seed, picks?, n?)`: n is explicit, else a valid saved draw's length (9 or 18), else 9; `id`, `name`,
    `tagline` follow the size. `mixedSummary(n = 9)`: par 36 · n / 9, `holes: n`.
- `scoring.totals(card)` adds `out` (holes 1–9) and `in` (10–18; `null` on a nine), each
  `{played, strokes, par, toPar, coursePar, putts}`. Everything else in it is unchanged.
- `game.js`: `restore` rebuilds a mixed course with `mixedCourse(seed, mix, mixedHoles(courseId))` (an old
  `'mixed'` save restores its nine) and throws on a `holeIndex` outside the course (main then clears the save).
  `courseFromParam(value, holes = null)`: `mixed` (or `mixed9`/`mixed18`) with holes 9/18 → that size; fixed courses
  ignore holes. `recordBest`: a mixed round's new best is a lower `toPar` (every draw differs), a fixed course's
  fewer strokes. `debugSkipTo(i, strokesFor?)` (tests) records each unplayed hole before i (`strokesFor(k, par)`,
  default par; two putts) and loads hole i. The game itself was already generic over the hole count (pins, wind,
  card, `nextHole`, `_toScorecard`: after the 9th of 18 the phase is `scorecard`, after the 18th `roundOver`).
- Best rounds (`golf.best.v1`): the stored `mixed` record is Mixed Nine's (the migration is that nothing moves);
  Mixed Eighteen starts empty under `mixed18`. Mixed records read "Best +3" on the card, the menu title line and the
  final card.
- `main.js`: `?course=mixed&holes=18`; `START_HOLE` is clamped to 0..17 and then to the course (`?hole=14` works on
  Mixed Eighteen, a fixed course stops at 9); `newRound`/`backdropHole` use `isMixedId`/`mixedHoles` (Restart keeps
  the 18 picks, Play again draws new ones); `showMenu` passes `mixedSummary(9)` and `mixedSummary(18)` with their
  bests; Resume reads "Mixed Eighteen · Hole 10"; `__golfDone` adds `holes`; `app.debug.state()` adds `holes`;
  `app.debug.skipTo(i, toPar = [])` → `game.debugSkipTo(i, (k, par) => par + (toPar[k] || 0))`, then saves.
- `ui.js` menu: both mixed entries share one wide card, now a `div.course-card.cc-mixed[data-course="mixed"]
  [role=radio][tabindex=0]` (it holds buttons), with `span.cc-holes[role=radiogroup]` → `button[data-mix="mixed"]`
  "9 holes" and `button[data-mix="mixed18"]` "18 holes" (white pill on the selected one, 34 px tall; under the text
  in portrait, on the right in landscape). A pill tap selects that size and emits `'course'` with its id; a card tap
  selects the size picked last; `_selectCourse` fills the card's name, tagline, par and best for the size;
  `ui.selectedCourse` is `'mixed'` or `'mixed18'`. There are still five `[data-course]` cards.
- `ui.showScorecard` keeps `{card, opts}` and renders through `_renderScorecard()`; columns are holes, totals over a
  range (`Out` 1–9, `In` 10–18, `Tot`) or a blank. Up to nine holes the DOM is exactly as before (checked against the
  previous build). Eighteen: `#scorecard[data-holes="18"]`; portrait and square `data-card-layout="split"`, two
  `tbody`s (`sc-front`: 1–9 | Out | blank, `sc-back`: 10–18 | In | Tot, 8 px apart, card side padding 12 px); landscape
  `"row"`, one row 1–9 | Out | 10–18 | In | Tot (card up to 780 px). `applyLayout` re-renders an open card when the
  layout changes. Course chips, Yds, Par, Score and Putts rows sum per range. At 393 × 852 the table is 335 px in a
  343 px box; at 852 × 393 746 px in 754 px (no scrolling).
- Tests (`tests/mixed18.test.js`): the draw constraints over 2000 seeds and the unchanged nine; course objects and
  helpers; an 18-hole flow (card 1–18, the 9th → scorecard, the 10th from its course, the 18th → roundOver); save and
  restore on hole 14 at address and mid-flight, plus an old Mixed Nine save; Out/In totals; best records and
  `?holes=`. e2e `mixed18Round` (after `mixedRound`; skipped on a build without the switch): the 18 pill, a new round
  (18 picks, par 72), `debug.skipTo(8, ...)`, a real touch putt on the 9th, the scorecard (Out/In/Tot, 18 chips,
  Out = holes 1–9, two blocks in portrait and one row in landscape, no overflow), rotation with the card open, Next
  hole → 10, reload → "Mixed Eighteen · Hole 10" → Resume with the same draw and card. The soak adds `mixed18`
  (`?course=mixed&holes=18`, 18 holes, 30 min timeout).

## 9. Golfer (as built)

The user request: "Change the game so you can actually see the golfer hit the shot and you can select what he
looks like." This stage builds the character: a realistic, smooth low-poly golfer (console-golf style, not a
cartoon) with a customisable look, a rigidly skinned mesh, a real golf swing driven by the game's swing input,
and a skinned render pass with a ground shadow. The game wiring (customiser screen, the TV camera behind the
golfer, calling `strike` from a swipe) is the next stage; `tests/visual/golfer-preview.html` shows the
character on a real tee. Physics is untouched: the animation is looks only.

Files: `src/golfer.js` (skeleton, look, proportions, clubs), `src/golfer-mesh.js` (mesh), `src/swing-anim.js`
(poses, IK, placement, animator), the golfer programs in `src/shaders.js` and the pass in `src/render.js`.
All three new modules are pure.

### 9.1 Frames, skeleton, proportions (`golfer.js`)

- **Golfer frame G**: +X forward (from the golfer toward the ball line), +Y toward the target (the golfer's left
  for a right-hander), +Z up, origin on the ground at the centre of the stance (between the ankles). For aim
  direction d a right-hander faces right(d) = d × ẑ and stands on the **left** of the ball looking down the line
  from behind. A left-hander is the mirror image: G → world is T(origin) · Rz(yaw) · diag(1, −1, 1) with yaw =
  aimYaw + π/2 (right-hander: aimYaw − π/2, no mirror). Bone names say L/R for the right-handed figure, so `L` is
  always the lead side (a left-hander's glove is on the right hand).
- **Bones** (`BONES`, `B`, `BONE_PARENT`, `BONE_COUNT` = 20): pelvis (root), spine, chest, neck, head, clavL,
  upperArmL, forearmL, handL, clavR, upperArmR, forearmR, handR, thighL, shinL, footL, thighR, shinR, footR, club
  (child of handL; the trail hand grips the club by IK). Rest pose = G standing upright, arms hanging, every rest
  rotation the identity; limb segments lie exactly along −Z (shoulder/elbow/wrist and hip/knee/ankle share x, y),
  so a bone's −Z is its segment and +X the way the joint below bends.
- **Proportions** `bodyDims(look)` → `{look, H, fem, build, headH, chinZ, hipZ, kneeZ, ankleZ, shZ, shoulderHalf,
  hipHalf, joints: Float64Array(20*3) rest joint positions, upperArm, forearm, thigh, shin, foot:{toe, heel,
  ball, width, sole}, hand, grip}`: hip joint 0.52 H, knee 0.283 H, ankle 0.042 H, shoulder joint 0.80 H, upper
  arm 0.186 H, forearm 0.146 H; the head grows more slowly than the body (0.232 m × (H/1.78)^0.45: 7.7 heads at
  1.78 m); shoulders 0.112 H half-width (female 0.101), hips 0.05 H (female 0.055); `build` scales shoulders,
  chest, waist, belly, hips, limbs and neck (slim 0.88–0.96, athletic +6–10% up top and slimmer waist, heavy
  waist × 1.24 and belly × 1.55).
- **Grip frames** (`dims.grip`): each hand's bone pose in club space `{rot (Float64Array 3×3), wrist, grip}`: the
  lead hand's back faces the target, the trail hand sits `gap` (8.8 cm for 1.8 m) lower with its palm toward the
  target. The hands are modelled gripping and follow the club, so they never leave the grip.

### 9.2 The look (`golfer.js`)

```js
LOOK = { body:'male'|'female', skin:0..7, height:155..200 (cm), build:'slim'|'regular'|'athletic'|'heavy',
         hair:'short'|'buzz'|'sidepart'|'curly'|'long'|'ponytail'|'bald', hairColor:'#rrggbb',
         facialHair:'none'|'stubble'|'moustache'|'beard', sunglasses:bool,
         headwear:'none'|'cap'|'visor'|'bucket'|'flatcap', hatColor,
         shirt:'polo'|'striped'|'vest', shirtColor, shirtColor2 (stripes / the polo under the vest),
         legwear:'trousers'|'shorts', legColor, shoeColor, gloveColor,
         swing:'classic'|'compact'|'bigfinish'|'smooth' }
```

- `DEFAULT_LOOK`, `OPTIONS` (lists, menu order; `height: [155, 200]`), `OPTION_NAMES` (display names),
  palettes `SKIN_TONES` (8 natural tones, fair to deep), `HAIR_COLORS` (10), `CLOTH_COLORS` (20), each
  `{id, name, hex}`; `hexToRgb(hex)`.
- `normalizeLook(any)` → a complete valid look from anything (saved data, partial looks, garbage): unknown enums →
  default, colours accept `#rrggbb` (lower-cased) or a palette id, skin accepts 0..7 or a tone id, height is
  rounded and clamped (missing: 180 male / 168 female), a female figure has no facial hair, unknown keys dropped.
  Idempotent. `lookKey(look)` is a stable cache key.
- `PRESETS` (8: Tour Pro, Lady Pro, Power Hitter, Classic Gent, Weekend Warrior, Rising Star, Links Veteran,
  Collegiate; 3 female, skin tones 0–7 represented), `presetById(id)`, `randomLook(rng)` (tasteful colour pairs).
- Swing style is part of the look: Classic; Compact (backswing about 3/4 of Classic, quicker tempo); Big finish
  (high hands, reverse-C finish); Smooth (slower tempo). Looks only.

**Clubs** `clubSpec(club | id | kind, heightM)` → `{id, kind, head:'driver'|'wood'|'hybrid'|'iron'|'wedge'|'putter',
len, lie, loft (rad), butt, hosel, toe, up, faceN, sweet, impact, dims}`. `CLUB_SPECS` has the standard lengths
(driver 45", 3W 43", 5W 42", 4H 40", 5i 38" … LW 35", putter 34") and lies (56° … 64°, putter 71°), fitted to the
golfer (length ± 4.2% per 10% of height from 1.78 m; lie ± 6° per m). **Club space** (the club bone): origin at the
lead hand's grip point on the shaft, −Z down the shaft, +X the square (unlofted) face normal, −Y toward the toe.
`impact` = sweet spot + lofted face normal × ball radius: where the **centre of a ball** struck on the sweet
spot sits. That point is "the club head" for placement and tests.

### 9.3 Mesh (`golfer-mesh.js`)

`buildGolferMesh(look, club = '7i')` → `{pos, nrm, col, bone, mat, idx, tris, verts, center, height, key, club,
bones, parts}`: Float32Array positions (bind space = G at rest), unit normals, sRGB vertex colours, a bone index
per vertex (Float32Array; rigid skinning), a material per vertex (0 cloth, 1 skin, 2 hair, 3 metal, 4 gloss,
5 rubber/leather, 6 eyes), Uint16Array indices (counter-clockwise outside), `center` = the pelvis rest point,
`parts` = triangles per part.

- Parts are parametric surfaces (`Geo`: grids with normals averaged over coincident vertices, tubes with
  superelliptic sections, sweeps along curves, ellipsoids, caps, slabs); limbs overlap at the joints (rounded caps,
  knee balls under trousers, clavicle shoulder pads) so rigid skinning shows no gaps.
- **Body**: torso lofted from measured cross-section tables (pelvis/belt, abdomen, chest with pecs or bust),
  trapezius on the clavicles, neck; arms with deltoids, biceps, elbow; legs with trouser looseness, knees, calves
  for shorts with socks; golf shoes with soles. **Head**: lofted from a profile table (forehead, brow ridge, nasion,
  cheekbones, lips, chin, jaw, cranium), eye sockets, a wedge nose, ears, eyes with iris, pupil and lids (a 1 cm
  opening), brows; female heads have a smaller brow, narrower jaw and fuller lips. **Hair** shells over the scalp
  thinning to a natural hairline (seven styles; long hair hangs to the shoulders, the ponytail has a band); hats
  clip the hair. **Facial hair**: stubble (vertex colour), moustache, a beard shell that keeps the lips clear.
  **Sunglasses**: two lenses and a bridge with temple arms. **Headwear**: cap (panels, button, curved bill),
  visor, bucket hat (stitched brim), flat cap (tweed). **Clothes**: polo with an open collar and placket; striped
  polo with crisp bands (duplicated rows at every stripe edge); sweater vest over the polo with a crisp V-neck
  (two columns land exactly on the V's edges); belt and buckle; trousers or shorts. **Hands**: a fist of fingers
  wrapped round the grip, the back of the hand, a thumb down the shaft and a wrist; the lead hand is gloved.
- **Clubs**: grip with a band and butt cap, steel or graphite shaft; driver/wood/hybrid superellipsoid heads with
  a flat lofted face and an alignment mark; iron and wedge blades lofted per club with a thicker sole, hosel and
  grooves; a heel-toe blade putter with a plumber's neck. Length per club as fitted.
- **Budget** (measured): presets 6.9–8.0 k triangles, the heaviest combination (long hair, bucket hat, striped
  polo, beard, shorts, sunglasses, heavy, 2 m, driver) 8.9 k; tests cap every option at 9 000.

### 9.4 Animation (`swing-anim.js`)

**Pose parameters** (`P`, `NP` = 28, Float64Array): hipTurn (+ = turned back), shiftY (toward the target / H),
shiftX, drop (knee flex / H), tilt (hip hinge), bank, chest (shoulder turn), flex, bend (+ = trail shoulder lower),
e/phi/k (the lead **wrist** as a direction in the chest frame — polar from the spine's down axis, azimuth toward
the lead side — at k × the arm's length from the lead shoulder), qx..qw (club orientation in G), heel/pivot
(trail foot), kneeIn, look (0 ball … 1 down the line), trail/lead elbow pole vectors, clav (lead shoulder
protraction), rock (putting). `evalPose(rig, prm)` → bone world rotations/positions in G (`rig.s.R`, `rig.s.X`):
FK down the spine (spine/chest share flex, bend and twist 40/60), clavicles, the lead wrist from (e, phi, k), the
club hanging from it through the lead grip frame, the trail hand on the club, two-bone IK for both arms (the trail
clavicle reaches up to 3% of H when short) and both legs (feet planted on the ground, the trail heel lifts and
pivots about the ball of the foot, the trail knee kicks in), the head looking at the ball (40% neck, ≤ 85° on the
chest) or down the line. The skin matrices are world × [R | X] × T(−rest joint).

**Placement** `placeGolfer({ball, aimYaw, terrain | ground, handed, look, club, shot})` → rig (`W` G→world
Float64Array(16), `origin`, `mirror`, `ballG`, `bx`/`by` ball in G, `st` stance, `feet`, `keys`, …). The ground is
`terrain.heightAt/normalAt`, else `ground(x, y)`, else flat under the ball. Stance by club (half-width 0.092–
0.136 H: driver widest, putter narrowest; flop +0.02, bump −0.03), ball position along the line (driver
+0.088 H, off the lead heel; woods +0.05; hybrid +0.03; 7-iron centre; wedges just back; putter forward), feet
flared (lead 24°, trail 8°) and tilted to the ground at each foot, a pelvis drop for a lower foot.

**Keys** (P1…P10). **P1 address** is solved: the club soled 0.6 cm behind the ball at its address lie (hands 4°
low: they rise into impact), shaft lean by club (irons 4° hands-ahead, driver −3°), the spine angle per club
(33° driver … 40° wedges, 44° putter) unless the arms would hang outside 6°–29° forward (driver 30°; then the hinge moves
toward the band), and the stance distance solved so the lead wrist is 0.965 of the arm's reach (putts 0.84, soft
elbows). **P7 impact** is solved: the club's impact point exactly on the ball, lie +3.5°, shaft lean (irons 9°,
wedges 11°, woods 4°, driver −1° up, putter 3°), hips open 39°, shoulders open 18°, trail shoulder low (more
side bend until the trail hand reaches), trail heel up, the hinge solved so the lead arm is straight. **P2**
(shaft parallel back), **P3** (lead arm parallel), **P4** top (shoulders 93°, hips 44°, club parallel on line),
**P4X** overswing, **P5** (lead arm parallel down, lag), **P6** (shaft parallel down), **P8** (shaft parallel
through), **P9** (trail arm parallel), **P10** finish (belt buckle to the target, trail heel up and pivoted,
hands above the lead shoulder, shaft across the back) are designed (body angles, a grip position for a 1.8 m
golfer scaled and pulled toward the solved grip, shaft and face directions, elbow poles) and converted to the
same parameters. Follow-through variants: `low` (punch, stinger, bump & run: held-off, abbreviated), `flop`
(open face, high), `draw` (face rolled), `cut` (face held), `bigfinish` (reverse C, high hands).

**Motion.** Backswing u: 0 address, 1 P2, 2 P3, 3 P4, 4 P4X (Catmull–Rom over the keys, quaternions aligned);
power → u: 0.25 → 1, 0.5 → 1.9, 0.75 → 2.5, 1 → 3, 1.1 → 3.42 (Compact × 0.85). Downswing from the reached top:
the arms and club follow the downswing keys (P4 → P5 → P6 → P7) on d^1.9, the chest on d^1.45, the hips lead on
1 − (1 − d)^1.5, blending out of the backswing over the first 28%; it ends exactly on P7. Follow-through over
P7 → P8 → P9 → P10 on 1 − (1 − x)^2.4, shortened for partial swings (1.2 + 1.9·min(1, p/0.8) of 3) and shots.
Bump & run keeps the wrists 70% "dead" (the club turns with the lead arm). Putting: the chest and the club rock
about the chest (axis ⟂ to the target line and the chest–ball line), 0.025 + 0.3·power rad back, a pendulum
cos-timed through the solved impact and 1.15 × through. Idle at address: breathing, a waggle and a look at the
target every 4–6.5 s (putts: looks only).

**Timing** `swingTiming(style, power, kind)` → `{down, follow, back}` s: downswing (transition + downswing to
impact) Classic 0.27, Compact 0.235, Big finish 0.26, Smooth 0.315 (× 0.92–1 with power); follow-through 0.95 /
0.8 / 1.05 / 1.15 (shorter for partial swings); automatic backswing 0.85 / 0.68 / 0.9 / 1.05; putts 0.34 down,
0.55 follow (Smooth × 1.1, Compact × 0.92).

```js
const anim = new SwingAnimator(look, {club, handed, shot, style, ball, aimYaw, terrain, ground});
anim.place({ball, aimYaw, terrain, ground, handed, look, club, shot})   // -> anim; re-fits (about 1 ms)
anim.setClub(club); anim.setShot(id); anim.setLook(look)                // re-place with the same ball
anim.setBackswing(power)          // live, 0..1.1; the club follows smoothly (rate 14/s); 0 returns to address
anim.strike({power = 1, kind, shot, style, onImpact}) -> seconds to impact
                                  // from a live backswing (>= 60% of the target length) the downswing starts
                                  // at once; otherwise an automatic backswing first (from a finish or a cancel
                                  // it restarts at address). onImpact fires exactly once, on the frame that
                                  // shows the exact impact pose
anim.cancel()                     // ease back to address over 0.45 s (no onImpact)
anim.reset()                      // snap to address
anim.update(dt) -> Float32Array   // skin matrices, BONE_COUNT column-major mat4 (world x inverse bind); the
                                  // same buffer every frame, no allocation
anim.showPose(name, power = 1)    // 'address'|'P2'|'half'|'top'|'P5'|'P6'|'impact'|'P8'|'P9'|'finish'
anim.state                        // 'address'|'backswing'|'auto'|'downswing'|'follow'|'finish'|'cancel'
anim.kind, anim.impactTime, anim.bones, anim.rig
anim.clubHeadWorld(out?) -> {x,y,z}   // the club's impact point in world (= the ball at impact)
anim.jointWorld(bone, out?), anim.restPointWorld(bone, [x,y,z], out?), anim.footPoints() -> [heelL, toeL, heelR, toeR]
anim.pose -> {root:[x,y,z], quats:Float64Array(BONE_COUNT*4) local rotations, world:G->world}
```

- **Allocation-free update**: everything lives in preallocated typed arrays; doubles are handed to helpers in
  typed arrays rather than as arguments (a double passed to a non-inlined function is boxed every frame), and
  `Math.hypot` (a boxed builtin call) is replaced by `Math.sqrt` of sums. Measured with V8's sampling heap
  profiler: < 1 byte per frame in `swing-anim.js` after warm-up (unoptimized code boxes floats, an engine detail).
- **Deviation**: "backswing club-head height increases monotonically with power" holds up to lead-arm parallel;
  past it the club head comes down to parallel at the top, as in a real swing. The hands rise monotonically and
  the club head's path grows monotonically (tests check all three).

### 9.5 Rendering (`shaders.js`, `render.js`)

`scene.golfer = {visible, mesh | {look, club}, bones: Float32Array (anim.update()), alpha = 1, fadeNear = true}`.
`mesh` is a `buildGolferMesh` result (GPU buffers rebuilt when the object changes); with `look` + `club` the
renderer builds and caches the mesh itself. `GOLFER_VS/FS`: rigid skinning with `uniform mat4 uBones[20]`
(80 vertex uniform vectors, within WebGL1's 128), camera-relative bone translations, lit by the theme sun with
wrap diffuse (soft on skin with a warm terminator), hemisphere ambient, per-material specular (metal reflects the
sky), a cool sky rim light and the scene's fog and tone map. `alpha` fades the figure by ordered dither (no
sorting), and so does a camera within ~1 m (`fadeNear: false` turns that off for close-ups). A left-hander's
mirrored bones flip the winding (front face CW for that draw). **Shadow**: the figure flattened along the sun onto
the ground plane under the feet is drawn white into a 256² mask (`GOLFER_MASK_VS/FS`, an offscreen texture over a
square of ground reaching away from the sun), then laid on the ground blurred (`GOLFER_GROUND_VS/FS`, 9 taps,
alpha 0.42 × sun height): a soft sun shadow that darkens once where parts overlap. Draw calls: golfer 1 + shadow
2. Drawn after the trees and objects (opaque) and first among the overlays (shadow). Context loss: programs,
buffers and the mask are rebuilt (checked on WebGL2 and WebGL1).

### 9.6 Preview and tests

`tests/visual/golfer-preview.html?look=<preset>&club=<id>&pose=<key>|t=<s>&cam=behind|face|side|close|profile|
hands|clubhead|clubface&turn=<deg>&dist=<m>&handed=L&shot=<id>&power=<p>&slope=x,y&gl1=1&anim=1` plus any look
field (`&skin=5&hair=curly...`): the golfer on Hollow Pines' first tee (`?course=`, `?hole=`); `t` runs a
scripted swing (address 0.4 s, backswing, strike, impact at about 1.7 s); `window.__golfer.set({...})` re-poses
without a reload. Reviewed with Playwright (iPhone 393×852 and 852×393 at 3×, SwiftShader) through the ten key
positions and frame-by-frame swings for driver, 7-iron, wedge and putter, down the line and face on, every preset,
a left-hander, bump & run, punch, flop, Compact and Big finish.

`tests/golfer.test.js` (15 tests): skeleton invariants; `normalizeLook` on garbage; presets; club specs; mesh
budgets, index ranges, bone ids, unit normals for every option; no NaN in any key pose; the club head within 2 cm
of the ball at the onImpact frame for every club × height (155/175/200) × hand × style × build (1 344 swings;
measured 0.0 cm); placement side (right-hander left of the ball, left-hander mirrored); feet within 5 cm of the
ground on flat and 10% slopes (up, down, side) at address, top and impact; terrain placement; backswing
monotonicity (above); onImpact exactly once at the returned time (live and automatic backswings, every style;
downswing 0.22–0.32 s); cancel and reset; rigid, mirrored skin matrices and unit local quaternions; no
allocation in `update` (sampling heap profiler).

**Known gaps**: the game does not show the golfer yet (customiser, camera and strike wiring are the next stage);
faces are deliberately simple (no texture maps); rigid skinning shows soft creases at the knees and wrists in
extreme poses; long hair does not collide with the shoulders; the club does not flex.
