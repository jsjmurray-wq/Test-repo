# Hollow Pines Golf

A realistic 3D golf game for iPhone Safari (and any modern browser): four hand-designed nine-hole
courses (par 36 each), solo stroke play, special shots and a forgiving swipe swing. Vanilla
JavaScript ES modules and a custom WebGL renderer with no dependencies and no external assets.
Every sound is synthesised and every texture is baked at load. It lives entirely in `golf/` and
shares no code with the pool game in the repository root.

## Courses

Pick a course on the main menu before starting a new round. Each course keeps its own best round,
and the saved round remembers its course.

| Course | Style | Conditions | Holes |
|---|---|---|---|
| **Hollow Pines** | Tree-lined parkland in rolling hills: ponds, a creek, elevated greens | Standard turf, 10.5 ft greens | First Light, Mirror Pond, Serpent, The Climb, Lakeside, Eyrie, Long Drop, Temptation, Homeward |
| **Red Mesa** | Target golf through the high desert: forced carries over washes and arroyos, waste areas, saguaros, red buttes on the horizon | Firm (more bounce and roll), quick 11 ft greens. Desert scrub is a tough lie with erratic bounces | Trailhead, Canyon, Long Arroyo, Sidewinder, Coyote (drivable), Sundial, Red Rock, Sidewash, Oasis |
| **Coral Cay** | Lagoons and the ocean: an island green, a split fairway, a peninsula green and a spit out into the surf; palms and white beaches | Soft and lush, 10.5 ft greens. Beaches play as waste sand (no penalty) | Palm Walk, The Fork, The Island, Mangroves, Peninsula, Shell Beach, Breakers, Reef Run, Sunset |
| **Kittiwake Links** | Seaside links: dunes, deep revetted pot bunkers, a burn, gorse, a blind drive and a Valley of Sin | Very firm and fast-running, slower 9.5 ft greens, 3 m/s windier than the wind setting (unless wind is off). Fescue beyond the rough stops the ball dead and is hard to escape | Kittiwake, Sandhills, Postage, Hell, Burnside, Whins, Haar, Strand, Home |
| **Mixed Nine** | Nine random holes drawn from all four courses: two or three from each, par 36, a new draw every round (Restart replays the same nine) | Each hole plays with its own course's look, turf, greens and wind; the intro and the scorecard name the course each hole comes from | Random |
| **Mixed Eighteen** | Tap **18 holes** on the Mixed card: eighteen different random holes, four or five from each course, par 72 (two par-36 nines, par 4s on the 1st and 10th, never two holes of one course in a row) | As Mixed Nine; the scorecard has Out, In and Total (two nine-hole blocks in portrait, one row in landscape). Mixed Nine and Mixed Eighteen keep separate best rounds, by score to par | Random |

## Controls

| Action | How |
|---|---|
| Choose a course | Tap a course card on the main menu, then **New round** (on the Mixed card, pick **9 holes** or **18 holes**) |
| Aim | Drag left or right on the upper part of the screen (faster drags turn further) |
| Swing (swipe, the default) | On the lower pad: drag **down** to take the club back, then flick **up**. A short, quick flick is enough: you do not need to get back to where you started, and a slow but clear upswing still hits (a little shorter, *Decel*) |
| Power | 25/50/75% of the travel is 25/50/75% power (ticks on the arc). Full power clicks into place: the 100% tick lights up green over a generous stretch of travel |
| Target notch | The gold notch on the arc is the power that reaches the pin (when the pin is out of reach, the hole's target where it bends, never short of a forced carry); it glows when you are on it. On Easy, a power within 5% of it snaps onto it |
| Overswing | Pulling well past full (the red zone) gives up to 10% more power but doubles the dispersion |
| Shape the shot | A straight swipe flies straight; curving the swipe draws or fades the ball. Only a frantic snap counts as *Rushed* |
| Cancel a swing | Hold still at the bottom and lift your finger (in landscape, dragging well off the side of the pad also cancels). A cancelled swing is not a stroke |
| Tap meter (optional) | Settings → **Swing control: Tap meter**. Tap the pad to start the power bar, tap again to hit (it fills, hangs briefly at full, then falls back). The shot flies straight; contact scatter still applies |
| Special shot | Tap **Shot** beside the club picker and pick one (see below). It lasts one stroke |
| Putt | Drag down to set the pace (the readout shows the flat-roll distance; the notch is the pace that finishes just past the cup), then release. Slide back up to the start, or off to the side, to cancel |
| Putt range | **−** / **+** next to the putter |
| Read the green | On the green the **caddie's read** sits under the info card: how much the putt breaks and which way ("Breaks ~1 ft R→L": how far outside the hole to start it, the same distance as the aim), uphill or downhill and how long it plays ("plays 21 ft"), and where to aim ("Aim 2 cups right"). **Aim at read** lines you up on it (and picks a putt range that fits); the gold notch is then the caddie's pace. A dotted **preview line** shows where the putt at your aim and pace rolls, bending with the break; it turns gold when it would drop (all of it on Easy, the start on Normal, none on Pro; Settings → Putt preview). **Read** shows the slope: streaks flowing downhill (green under 1%, yellow to 2.5%, orange to 4%, red steeper), arrows, height contours and the slope % at the ball and the hole; drag to look around, or **Behind ball**, **Behind hole** or **Overhead** |
| Chip preview | Within 40 m of the green (not on Pro) a chip or pitch shows where it rolls after landing |
| Map | **Map**, then tap a point on the course to aim straight at it |
| Flyover | **Flyover** replays the hole preview |
| Change club | ◀ / ▶ on the club picker (the caddie picks one for every new lie) |
| Skip intro / flight | Tap anywhere |
| Pause | ❙❙ top right (Esc on a keyboard); Restart round or Quit to menu from there |

## Special shots

| Shot | Clubs | What it does |
|---|---|---|
| Draw | Any full-swing club | Starts on the line and bends left (right for a left-hander), runs out a few yards more. The aim preview shows the curved flight and where it lands |
| Cut | Any full-swing club | Starts on the line and slides right (left for a left-hander), lands a little softer and shorter |
| Stinger | Driver, woods, 4 hybrid, 5–6 iron (not from sand or fescue) | Low bullet: a driver stays under 15 m high, carries about a fifth less and runs three to four times as far. Great into the wind on firm ground |
| Punch | 4 hybrid, irons, PW, GW | Low knock-down under branches or the wind: carries 80–90% and the wind costs far less |
| Flop | GW, SW, LW (not from hardpan or beach sand) | Sky-high, lands at 55° or steeper and stops within a few yards on the green |
| Bump & run | 7 iron to SW | Lands short and rolls: carry is a third to under half of the total |

The club readout, power arc, target notch and toast all follow the selected shot
("7i Stinger · 140/178 yd · Straight").

## Your golfer

You see your golfer hit every shot: a realistic golfer (smooth low-poly, console-golf proportions)
steps up to the ball at every address, on the tee, the fairway, in the rough, in a bunker and on the
green, holding the club you picked and facing your aim (he turns with it), and waggles and glances
at the target while you line up. The camera is the TV shot from behind him down the target line
(on the left of the screen for a right-hander, the right for a left-hander), with the ball in the
swing arc and the target, landing area and flag in view.

- **Your swipe is his swing.** As you drag down he takes the club back as far as the power gauge
  says (a half swipe is a half swing; the tap meter drives him the same way); let go to cancel and
  he eases back to address. Flick up and he swings down: the ball leaves the club at impact, about
  a quarter of a second later, with the swish of the club and the strike. Putts are a putting
  stroke, and the special shots look the part (held-off stinger and punch, open-faced flop, a short
  bump & run).
- **TV coverage.** After the strike the camera holds on his follow-through as the ball leaves, then
  follows it; he holds his finish until the camera has gone. Read, Map and the flyover leave him
  out of the picture.
- Your look, height and swing style are saved on the device (`golf.golfer.v1`). `?autoplay` and the
  bot swing through him too.

The character can also be viewed on its own in `tests/visual/golfer-preview.html`, on the first tee
of Hollow Pines.

| Choice | Options |
|---|---|
| Body | Male or female figure, 8 natural skin tones, height 155–200 cm, build slim / regular / athletic / heavy |
| Hair and face | Short, buzz cut, side part, curly, long, ponytail or bald, 10 hair colours; no facial hair, stubble, moustache or beard; sunglasses |
| Clothes | Cap, visor, bucket hat, flat cap or none (any colour); polo, striped polo or sweater vest over a polo (two colours); trousers or shorts; shoe and glove colours |
| Swing style | **Classic**; **Compact** (about a three-quarter backswing, quicker); **Big finish** (high hands, reverse C); **Smooth** (slower tempo). Looks only: the ball flies exactly the same |
| Presets | Tour Pro, Lady Pro, Power Hitter, Classic Gent, Weekend Warrior, Rising Star, Links Veteran, Collegiate |

The swing is a real golf swing: a one-piece takeaway, a full shoulder turn (about 90°, hips 45°)
with the club parallel at the top, the hips leading the downswing, the club lagging, hands ahead and
the club head exactly on the ball at impact, extension and a balanced finish facing the target with
the trail heel up. The backswing follows your swipe (a half swipe is a half swing), the setup changes
with the club (wider stance and the ball off the lead heel with the driver, more bend with the
wedges, eyes over the ball with the putter: a shoulder-rocking putting stroke), and the special
shots look the part (a short, hands-ahead bump & run, a held-off punch, an open-faced high flop). A
left-hander is the mirror image. The golfer casts a soft shadow on the ground.

Preview URL options: `?look=tour` (a preset id) or any look field (`&body=female&skin=5&hair=curly`),
`&club=D` (any club id), `&pose=address|top|impact|finish` or `&t=1.7` (seconds into a scripted swing),
`&cam=behind|face|side|close`, `&turn=45` (turntable), `&handed=L`, `&shot=flop`, `&anim=1` (swing on a
loop).

### The Golfer screen

Tap **Your golfer** on the main menu (the badge with his picture: top right in portrait, above New
round in landscape) or **Golfer** on the pause sheet to choose what he looks like,
like a console game's character creator: he stands on a tee of the course you picked, in 3D, and every
change shows on him at once.

- **Turn and zoom:** drag him round (flick to spin), pinch or double-tap to go from the full body to
  his face and back, or use the turn and zoom buttons. Each tab moves the camera for you: **Hair &
  Face** goes in close, and he looks up at you.
- **Tabs:** **Body** (figure, skin tone, a height slider in cm and feet, a build slider), **Hair &
  Face** (hairstyle, hair colour, facial hair, sunglasses), **Clothes** (headwear and its colour,
  shirt style and colours, trousers or shorts, shoes, glove) and **Swing** (the four swing styles,
  each with a picture of its arc; the club he swings in the preview).
- **Presets and Random:** the row above the tabs starts you from one of the eight golfers, or a random
  one.
- **Try swing** plays a full swing in the chosen style (with the swish and the strike); picking a swing
  style plays it straight away.
- **Done** saves your golfer and he walks out with you at once (in a round in progress too); **Cancel**
  (or Escape) leaves him as he was. If the browser cannot store it (private mode), he is kept until the
  page is closed.

The screen fits portrait (preview on top, controls below) and landscape (preview on the left).

## Rules

Simplified Rules of Golf: every swing counts (a cancelled swing does not). Out of bounds is stroke
and distance. From water you choose **Drop (+1)** near where the ball went in (red: within two club
lengths, no nearer the hole, on ground that holds the ball, or back on the line to level ground when
the bank is steep all round; yellow: back on the line from the hole) or **Replay (+1)** from the
previous spot. The dialog marks where the ball went in and both spots. Waste areas, beaches, desert
scrub and fescue are not penalty areas: play the ball as it lies. You pick up at double par. The
scorecard tracks fairways hit, greens in regulation and putts; birdies or better are circled, bogeys
or worse are boxed.

Settings (persisted on the device): units (yards or metres), wind (off, light, breezy; the links
adds more), swing control (swipe or tap meter), difficulty (easy, normal, pro: how much the shape of
your swipe affects the ball; Easy also snaps power onto the target notch), putt preview (auto, full,
part, off: auto is full on Easy, part on Normal, off on Pro), left- or right-handed, sound, and
graphics quality.

## Running

```sh
cd golf
npm test          # unit tests (node --test): physics, courses, swing, shots, rules, input ...
npm run e2e       # Playwright end-to-end run in headless Chromium
npm run build     # dist/golf.html (single self-contained file) + dist/golf-artifact.html
npm run serve     # http-server on :8081 (or any static server)
npm run lint      # eslint src tests scripts
npm run calibrate # re-solve club ball speeds against target carries
npm run course    # per-hole report for every course (length, par, surfaces, objects); add a course id for one
npm run icons     # regenerate icons/icon-180.png and icon-512.png (needs Playwright)
```

ES modules need HTTP, so open `http://localhost:8081/` rather than `index.html` from disk; the
single-file build in `dist/golf.html` works from anywhere. URL options: `?course=ID` (`pines`,
`desert`, `water`, `links` or `mixed`: the course for new rounds; `?course=mixed&holes=18` for Mixed
Eighteen), `?hole=N` (start a round at hole N),
`?autoplay=1` (the bot plays the round), `?fast=N` (playback speed), `?seed=N`, `?quality=low`,
`?debug=1` (fps and draw-call overlay), `?nogl=1` (logic without WebGL), `?test=1` (e2e hooks).

`npm run e2e` drives the real UI with touch events on iPhone portrait/landscape and foldable
viewports, on both `index.html` and `dist/golf.html`: a Hollow Pines hole with a short-flick swing,
a cancelled swing, a tap-meter shot, pause and resume, then the course picker and a round on each
new course with a special shot from the shot sheet, reload and resume, a Mixed Nine round, and a Mixed
Eighteen round taken to the 10th (the Out/In scorecard, rotation, reload and resume), then green
reading on three of its greens (the read card, the preview line, Read with each camera inside the
draw-call budget, Aim at read and a touch putt on the notch that drops or finishes within 0.5 m, and
the Putt preview setting). `--shots` saves
screenshots to `screenshots/`; `--soak` adds a full autoplay round on every course and both mixed sizes
(`--courses=desert,mixed18` for some; `--soak-only` skips the UI flow) and checks the renderer stays
within its draw-call budget.

## Hosting

Any static host works (GitHub Pages, Netlify, S3). Serve `golf/` as is, or just upload
`dist/golf.html`. On iPhone, Share → Add to Home Screen runs it full screen with the manifest and
icon; the game keeps the screen awake while you play and saves the round on every shot, so you can
resume after closing Safari.

## Code layout

| Path | Contents |
|---|---|
| `docs/architecture.md` | The binding contract: coordinate frame, module style, every public API (section 8: version 2; section 9: the golfer) |
| `src/constants.js`, `vec3.js`, `rng.js` | Shared constants, surfaces and course conditions, unit helpers, vector maths, seeded RNG |
| `src/clubs.js`, `aero.js`, `physics.js` | Club table, drag/lift and wind profile, flight/bounce/roll/cup simulation (firmness and green speed per course) |
| `src/noise.js`, `spline.js`, `terrain.js` | Procedural terrain from the hole data: corridors, desert/fescue/waste, pot bunkers, island and sea water, themed objects |
| `src/course.js`, `course-desert.js`, `course-water.js`, `course-links.js`, `courses.js` | The four courses as data (Hollow Pines, Red Mesa, Coral Cay, Kittiwake Links) and the course registry |
| `src/lie.js`, `swing.js`, `shots.js`, `caddie.js`, `rules.js`, `scoring.js`, `game.js`, `bot.js` | Gameplay: lies, swipe interpretation, special shots, club suggestions, rules, scorecard, state machine, autoplay bot |
| `src/putting-aid.js`, `green-flow.js` | Green reading: the putt and chip previews, the caddie's read and its words, slope bands, the preview throttle; the flowing slope streaks |
| `src/mat4.js`, `gl.js`, `shaders.js`, `meshes.js`, `bake.js`, `render.js`, `camera.js`, `themes.js` | WebGL renderer, per-course looks (parkland, desert, tropical, links) and camera rig |
| `src/golfer.js`, `golfer-mesh.js`, `swing-anim.js` | The golfer: skeleton, customisable look and presets, the skinned mesh, swing poses, IK and the animator |
| `src/input.js`, `ui.js`, `audio.js`, `main.js` | Pointer gestures and tap meter, DOM HUD and menus, synthesised audio, boot and loop |
| `index.html`, `style.css` | Shell and broadcast-style HUD (portrait, landscape and square layouts) |
| `scripts/` | Single-file build, icon renderer, calibration and course report |
| `tests/` | `node --test` unit tests, the Playwright e2e spec and visual previews (`tests/visual/`: renderer, golfer) |
