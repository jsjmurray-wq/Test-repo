# American 8-Ball

A realistic American 8-ball pool game for the iPhone (and any modern browser). It runs in Safari
with nothing to install and can be added to the Home Screen so it opens full-screen like an app.
It works in portrait, in landscape and on large, near-square screens such as an unfolded foldable
phone or an iPad.

- **Play the computer** at four levels (Easy, Medium, Hard, Pro), or **pass and play** with a friend
  on one phone.
- **Real 7-ft bar table:** WPA-sized pockets with jaws that rattle, diamond sights, cloth and wood.
- **Ball physics:** sliding versus rolling friction, follow, draw and stun, side spin (english) with
  squirt, cushion rebounds that respond to english, and collision-induced throw. Balls roll with
  their numbers and stripes turning.
- **Rules:** WPA 8-ball, adapted for casual play:
  - Open table after the break.
  - Groups go to whoever pockets the first ball after the break.
  - Call the pocket for the 8-ball only.
  - Ball in hand after a foul, and behind the head string after a scratch on the break.
  - An illegal break gives the opponent a choice.
  - All the ways to lose on the 8 apply.
- **Matches:** race to 1, 3 or 5 racks with alternating breaks and a rematch option.
- **Other:** synthesised sound effects, and autosave so you can resume a match later.

## Playing on an iPhone

Open the game link in Safari. To install it, tap **Share → Add to Home Screen**; it then launches
full-screen from its own icon.

| Action | How |
|---|---|
| Aim | Drag anywhere on the table to swing the cue around the cue ball, or tap a spot to aim straight at it |
| Fine aim | Drag the ribbed wheel for tiny adjustments |
| Shoot | Pull the cue down on the power bar and let go. Slide back to the top to cancel |
| Spin | Tap the cue-ball button and drag the red dot: top for follow, bottom for draw, sides for english |
| Ball in hand | Drag the cue ball to where you want it. A green ring means the spot is legal |
| Call the 8 | Tap the pocket you're calling. The pocket the guide points at is pre-selected |

## Running locally

```bash
npm run serve        # http://localhost:8080 (needs http-server; or any static file server)
npm test             # unit tests: physics, rules, game flow, AI (node --test)
npm run e2e          # Playwright smoke tests in iPhone-sized viewports
npm run build        # single self-contained file -> dist/pool8.html
```

Opening a page with `?debug=1` shows frame timing. `?autoplay=hard` makes the computer play itself.

## Hosting with GitHub Pages (permanent link, Home-Screen installable)

1. On GitHub, go to **Settings → Pages**.
2. Choose **Deploy from a branch**, then pick this branch and the `/ (root)` folder.
3. Open `https://<user>.github.io/<repo>/` on the iPhone and add it to the Home Screen.

`dist/pool8.html` is the same game in a single file. You can host it anywhere, or AirDrop it to the
phone and open it.

## Code layout

| Path | Purpose |
|---|---|
| `src/constants.js`, `src/table.js` | Table geometry (7-ft bar table, WPA pockets) and physics constants |
| `src/physics.js` | Deterministic fixed-step ball physics with time-of-impact collisions |
| `src/rules.js`, `src/game.js` | Pure 8-ball rules engine and the match state machine |
| `src/ai.js` | Computer player that simulates candidate shots with the real physics |
| `src/render.js` | Canvas renderer: table, rolling 3D balls, cue, aim guide |
| `src/input.js`, `src/ui.js`, `index.html`, `style.css` | Touch controls, HUD, menus |
| `src/audio.js` | Web Audio synthesised sound effects |
| `src/main.js` | Game loop and wiring |
| `docs/` | Architecture, module contracts and the rules specification |

Everything is vanilla JavaScript (ES modules and Canvas 2D), with no dependencies and no external
assets.
