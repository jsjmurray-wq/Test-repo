# Hollow Pines Golf

A realistic 3D golf game for iPhone Safari (and any modern browser): nine hand-designed holes,
par 36, solo stroke play. Vanilla JavaScript ES modules and a custom WebGL renderer with no
dependencies and no external assets. Every sound is synthesised and every texture is baked at
load. It lives entirely in `golf/` and shares no code with the pool game in the repository root.

## Controls

| Action | How |
|---|---|
| Aim | Drag left or right on the upper part of the screen (faster drags turn further) |
| Swing | On the lower pad: drag **down** to take the club back (the arc shows power), then swipe **up** fast through your starting point |
| Shape the shot | A straight swipe flies straight; curving the swipe draws or fades the ball |
| Overswing | Pulling past the end of the arc (red zone) gives more power but doubles the dispersion |
| Putt | Drag down to set the pace (the readout shows the flat-roll distance), then release |
| Putt range | **−** / **+** next to the putter |
| Read the green | **Read**, then drag to look around (slope grid on the green) |
| Map | **Map**, then tap a point on the course to aim straight at it |
| Flyover | **Flyover** replays the hole preview |
| Change club | ◀ / ▶ on the club picker (the caddie picks one for every new lie) |
| Skip intro / flight | Tap anywhere |
| Pause | ❙❙ top right (Esc on a keyboard) |

## Rules

Simplified Rules of Golf: every swing counts (a cancelled swing does not). Out of bounds is stroke
and distance. From water you choose **Drop (+1)** near where the ball went in (red: within two club
lengths, no nearer the hole, on ground that holds the ball, or back on the line to level ground when
the bank is steep all round; yellow: back on the line from the hole) or **Replay (+1)** from the
previous spot. The dialog marks where the ball went in and both spots. You pick up at double par. The scorecard tracks fairways hit, greens in regulation
and putts; birdies or better are circled, bogeys or worse are boxed.

Settings (persisted on the device): units (yards or metres), wind (off, light, breezy),
difficulty (easy, normal, pro: how much the shape of your swipe affects the ball), left- or
right-handed, sound, and graphics quality.

## Running

```sh
cd golf
npm test          # unit tests (node --test): physics, course, swing, rules, input ...
npm run e2e       # Playwright end-to-end run in headless Chromium
npm run build     # dist/golf.html (single self-contained file) + dist/golf-artifact.html
npm run serve     # http-server on :8081 (or any static server)
npm run lint      # eslint src tests scripts
npm run calibrate # re-solve club ball speeds against target carries
npm run course    # per-hole report (length, par, hazards)
npm run icons     # regenerate icons/icon-180.png and icon-512.png (needs Playwright)
```

ES modules need HTTP, so open `http://localhost:8081/` rather than `index.html` from disk; the
single-file build in `dist/golf.html` works from anywhere. URL options: `?hole=N` (start a round
at hole N), `?autoplay=1` (the bot plays the round), `?fast=N` (playback speed), `?seed=N`,
`?quality=low`, `?debug=1` (fps overlay), `?nogl=1` (logic without WebGL), `?test=1` (e2e hooks).

`npm run e2e` drives the real UI with touch events on iPhone portrait/landscape and foldable
viewports, on both `index.html` and `dist/golf.html` (`--shots` saves screenshots to
`screenshots/`, `--soak` adds a full autoplay round).

## Hosting

Any static host works (GitHub Pages, Netlify, S3). Serve `golf/` as is, or just upload
`dist/golf.html`. On iPhone, Share → Add to Home Screen runs it full screen with the manifest and
icon; the game keeps the screen awake while you play and saves the round on every shot, so you can
resume after closing Safari.

## Code layout

| Path | Contents |
|---|---|
| `docs/architecture.md` | The binding contract: coordinate frame, module style, every public API |
| `src/constants.js`, `vec3.js`, `rng.js` | Shared constants, surfaces, unit helpers, vector maths, seeded RNG |
| `src/clubs.js`, `aero.js`, `physics.js` | Club table, drag/lift and wind profile, flight/bounce/roll/cup simulation |
| `src/noise.js`, `spline.js`, `terrain.js`, `course.js` | The nine holes as data and their procedural terrain |
| `src/lie.js`, `swing.js`, `caddie.js`, `rules.js`, `scoring.js`, `game.js`, `bot.js` | Gameplay: lies, swipe interpretation, club suggestions, rules, scorecard, state machine, autoplay bot |
| `src/mat4.js`, `gl.js`, `shaders.js`, `meshes.js`, `bake.js`, `render.js`, `camera.js` | WebGL renderer and camera rig |
| `src/input.js`, `ui.js`, `audio.js`, `main.js` | Pointer gestures, DOM HUD and menus, synthesised audio, boot and loop |
| `index.html`, `style.css` | Shell and broadcast-style HUD (portrait, landscape and square layouts) |
| `scripts/` | Single-file build, icon renderer, calibration and course report |
| `tests/` | `node --test` unit tests and the Playwright e2e spec |
