# cs_grid

A browser multiplayer FPS in TypeScript. The authoritative game server is a
**Cloudflare Durable Object**; the client is **Three.js** with client-side
prediction, entity interpolation and lag compensation. Rooms fill themselves
with **bots** that navigate, take cover and fight.

No art assets — every texture, weapon model and sound is generated at runtime,
so the whole client is one ~150 KB gzipped bundle.

```
npm install
npm run build:client     # the worker serves this via its ASSETS binding
npm run dev              # vite on :5173 + wrangler dev on :8787
```

Open <http://localhost:5173>, pick a callsign, hit **Deploy**.
For a production-shaped run, `npm start` builds the client and serves
everything from `wrangler dev` on <http://localhost:8787>.

---

## Why Durable Objects

An FPS match is the textbook case for a Durable Object: it is a single, small,
strongly-consistent piece of mutable state that every participant must agree on,
and it needs a loop.

| Requirement | How a DO satisfies it |
| --- | --- |
| One authoritative world per match | `idFromName(room)` routes every player in a room to the same object |
| No locking around shared state | A DO is single-threaded; the world lives in plain memory |
| A fixed-rate simulation | `setInterval` runs while any player is connected |
| Fan-out to all players | Every WebSocket for the match terminates on that object |
| Sit close to the players | The object migrates to the region that is actually using it |

```
             ┌──────────────────────────────────────┐
  browser ───┤ Worker (stateless)                   │
  browser ───┤  /ws        -> GameRoom DO           │
  browser ───┤  /api/status-> GameRoom DO           │
             │  /*         -> ASSETS (built client) │
             └───────────────┬──────────────────────┘
                             │
                 ┌───────────▼────────────┐
                 │ GameRoom (Durable Obj) │
                 │  64 Hz world.step()    │
                 │  bots think()          │
                 │  32 Hz snapshots  ─────┼──> every connected socket
                 └────────────────────────┘
```

Two deliberate choices are worth calling out:

- **No WebSocket hibernation.** Hibernation lets a DO be evicted between
  messages, which would throw away the in-memory world. A match needs a
  continuously running tick, so the object stays resident while anyone is
  connected. When the last player leaves the match **freezes** rather than
  playing on to an empty room, and is discarded 15 s later. Reconnect inside
  that window and you resume the exact scoreline you left.
- **Tick-derived time, not wall-clock.** `world.timeMs` is `tick * TICK_MS`.
  Workers pin `Date.now()` between I/O events, so wall-clock is only used to
  decide *how many* ticks to run, never as the simulation clock.

## Layout

```
src/shared/    engine shared by both sides — must stay byte-identical
  config.ts      every tuning constant
  math.ts        Vec3, angles, seeded PRNG
  binary.ts      BinaryWriter / BinaryReader
  protocol.ts    wire format
  map.ts         the map, authored as boxes
  collision.ts   AABB raycasts, hull sweeps, moveAndSlide
  movement.ts    the movement step (server authority AND client prediction)
  weapons.ts     weapon table
  nav.ts         waypoint graph + A*

src/game/      the authoritative simulation — no runtime-specific APIs
  world.ts       tick loop, hitscan, damage, scoring, match flow
  combatant.ts   a player or bot, plus its lag-compensation history
  bot.ts         bot brains

src/worker/    Cloudflare glue
  index.ts       routing: /ws, /api/status, static assets
  game-room.ts   the Durable Object

src/client/    browser
  main.ts        fixed-step loop wiring everything together
  net.ts         transport + server clock estimation
  input.ts       pointer lock, keyboard, mouse
  prediction.ts  local prediction and reconciliation
  hud.ts         DOM HUD
  audio.ts       synthesized SFX
  render/        Three.js scene, world, avatars, viewmodel, effects
```

`src/game/` deliberately imports nothing from `workers-types`, which is what
lets the whole match run inside `node --test`.

## Netcode

**64 Hz simulation, 32 Hz snapshots, 64 Hz input.**

*Prediction.* The client samples input on a fixed 64 Hz step, runs
`stepMovement` locally, and keeps the command in an unacked queue. When a
snapshot arrives it snaps to the authoritative state and replays every command
the server has not yet acknowledged. Residual error under 1.5 m is not snapped
but bled off visually over a few frames.

Because prediction and authority are literally the same function, the two agree
closely — `scripts/smoke.ts` measures the live reconciliation error and asserts
it stays at quantization noise (**~1.5 cm mean** in practice).

*Interpolation.* Other players are rendered `INTERP_DELAY_MS` (100 ms) in the
past, interpolated between the two bracketing snapshots. Yaw is unwrapped as it
is buffered so a player crossing ±π does not spin the long way round.

*Lag compensation.* Every combatant records its hull each tick. When a player
fires, the server rewinds all other players by `ping/2 + interpolation delay`
(clamped to `MAX_REWIND_MS`) and traces against those historical hulls — so
what you saw is what you hit. Bots have zero latency and are never rewound.
`tests/world.test.ts` pins this down: the same shot connects with a 200 ms ping
and misses without rewind.

*Cheat resistance.* The server owns position, health, ammo and fire rate.
Clients send intent, never state. Queued commands are capped per tick, `dt` is
clamped, sequence numbers are monotonic, and the rewind window is bounded no
matter what RTT a client claims.

*Wire format.* Binary, hand-rolled. Positions are `int32` at 1/1024 m, angles
16-bit, velocities 16-bit at 1/64 m/s. A snapshot carrying 15 other players
plus local state is under 400 bytes.

## Bots

A bot is not a special entity. It produces the same `InputCommand` stream a
browser sends and is simulated by the identical code path — so bots cannot
outrun the movement rules, and anything that fixes players fixes bots.

Each bot runs a small state machine (patrol → engage → hunt) over:

- **Perception** every 90 ms — range, a real field of view (so they *can* be
  flanked), and a line-of-sight raycast.
- **Navigation** — A* over a waypoint graph generated from the map at start-up
  by dropping a 2 m grid onto the floor, keeping the spots where a player hull
  fits, and linking neighbours whose traverse is walkable or jumpable.
- **Aim** — bounded turn rate, a faster snap for the initial acquisition,
  persistent gaussian jitter, a reaction delay, and target leading.
- **Combat** — burst discipline, weapon-appropriate engagement ranges,
  strafing, crouching, cover use, and reloading when disengaged.

### Tuning them

Difficulty is changeable **in game** — press `O`, or release the mouse with
`Esc`, and pick a tier. The change applies to the whole room immediately (every
bot brain is rebuilt on its original seed) and is announced to everyone.
`BOT_SKILL` in `wrangler.jsonc` only sets what a fresh room starts on, and
`TARGET_PLAYERS` controls how full a room is kept. The tiers measure
out roughly like this over a 10-bot deathmatch:

| tier | kills/min | headshot % of kills |
| --- | --- | --- |
| easy | 14 | 14% |
| normal | 37 | 29% |
| hard | 43 | 45% |
| elite | 57 | 68% |

If a tier is not to taste, the numbers live in `PROFILES` in `src/game/bot.ts`.
In rough order of how much they matter:

| parameter | effect |
| --- | --- |
| `aimJitter` | angular aim error in radians — the biggest single lever. 0.05 is about a metre off at 20 m |
| `aimHeight` | where on the body they aim, as a fraction of hull height. Low values keep a wide error cone off the head |
| `headshotBias` | how often they deliberately go for the head. A headshot is 4x, so this dominates time-to-kill |
| `reactionMinMs` / `reactionMaxMs` | delay between acquiring you and being allowed to fire |
| `visionRange`, `fovCos` | how far and how wide they notice you at all — the lever on how *often* you get fought |
| `burstMin` / `burstMax`, `burstPause*` | how long they hold the trigger, and how long they leave you alone afterwards |
| `turnSpeed` / `snapSpeed` | how fast they can swing onto you |

`tests/bot-difficulty.test.ts` runs a headless match per tier and asserts the
ladder stays monotonic, so a tuning change that accidentally makes `easy`
deadlier than `elite` fails the suite. That is not hypothetical — it is exactly
what happened when `aimJitter` was applied as a per-tick random walk that the
tracking term cancelled on the same tick.

## Gameplay

Team deathmatch, Raiders vs Sentinels, first to `SCORE_LIMIT` kills or the round
clock. Five weapons — rifle, SMG, bolt-action, DBS shotgun, and a pistol in the
sidearm slot — with per-weapon spread, recoil, falloff and movement penalties.

The **DBS** is modelled on PUBG's double-barrel bullpup: nine pellets a shell,
fourteen shells, and an action that racks after every *second* shell, so it
fires a fast pair and then stalls for ~0.7 s. Its falloff curve is fitted to the
source data (26 damage per pellet at the muzzle, 18.1 at 10 m) and it is spent
past 25 m. Weapons can declare a `burstSize`/`burstCycleMs`, applied identically
by the server and by client prediction so the stall lands on the same frame in
both. Armor absorbs 45% of
non-leg damage. Headshots, assists, killfeed, damage direction indicators, fall
damage, spawn protection. A compact kill/death roster for every player sits on
the left at all times; `Tab` swaps it for the full scoreboard with assists,
score and ping.

| | |
| --- | --- |
| `WASD` | move |
| `Space` / `Ctrl` or `C` / `Shift` | jump / crouch / walk |
| `Q` / `E` | lean left / right |
| `LMB` / `RMB` / `R` | fire / aim / reload |
| `1` `2` | primary / sidearm |
| `Tab` / `Y` | scoreboard / chat |
| `O` / `Esc` | options / release mouse |

The crosshair gap is the actual spread cone projected onto the screen, so it
shows exactly where bullets can land.

**Leaning** is authoritative, not a camera trick. Holding `Q`/`E` slides the
viewpoint up to 42 cm sideways past your hull, and the server applies the same
offset when it traces your shots — so you really can clear a corner without
stepping into it. Two things keep it honest: a probe stops the head leaning
into geometry (the closer the wall, the less lean you get), and your torso
visibly leans on everyone else's screen, so the sliver of body you bought
yourself is a sliver they can shoot. Leaning also costs ~28% of your movement
speed and is disabled in mid-air.

**Scoped optics.** The LR-50's magnified sight swaps the viewmodel out for a
scope overlay once you aim, rather than holding the weapon in front of the
camera — otherwise the scope body would sit in the middle of the screen.

## Tooling

[oxlint](https://oxc.rs) and [oxfmt](https://oxc.rs) — the Rust-based linter and
formatter — plus TypeScript in strict mode across three separate projects, since
the worker (`@cloudflare/workers-types`) and the client (`DOM`) have
incompatible globals.

```
npm run check        # fmt:check + lint + typecheck + test   <- do this before pushing
npm run fmt          # rewrite formatting
npm run lint:fix     # apply lint autofixes
npm run typecheck    # all three tsconfig projects
npm test             # 71 unit tests
```

### Git hooks (husky)

| Hook | Runs |
| --- | --- |
| `pre-commit` | `lint-staged`: oxfmt + `oxlint --fix --max-warnings=0` on staged files |
| `commit-msg` | conventional-commit shape (`feat(server): …`) |
| `pre-push` | full typecheck + test suite |

Installed automatically by `npm install` via the `prepare` script.

### Tests

`npm test` covers the binary codec and quantization bounds, the full protocol
round trip, raycasts and hull collision (including tunnel resistance), movement
determinism and replay-invariance, the nav graph, and a headless minute-long bot
match asserting score bookkeeping and that nobody leaves the map. There is also
a markup-contract test that fails if the HUD looks up an element `index.html`
does not have.

`scripts/smoke.ts` is the end-to-end check: it drives a headless client through
the real protocol *and the real prediction code* against a running server.

```
npm run dev:worker &
npx tsx scripts/smoke.ts ws://127.0.0.1:8787/ws?room=smoke 8
```

## Deploying

```
npx wrangler login
npm run deploy
```

`GET /api/status?room=x` returns a live JSON scoreboard for a room without
joining it.

**On cost.** The class is declared as `new_sqlite_classes`, the SQLite-backed
storage flavour, which is what makes Durable Objects usable outside the paid
plan. Be aware that this design is unlike a normal request-driven DO: the tick
loop keeps the object resident for the whole match, so it bills Durable Object
**duration** continuously while anyone is connected, not just per request. The
simulation stops the moment the last player disconnects and the world is
dropped 15 s later (`IDLE_SHUTDOWN_MS`), so an abandoned room stops costing CPU
immediately rather than letting the bots fight on unobserved. An empty room
costs nothing at all, because the object is never created until someone opens a
socket.

## Known limitations

- The renderer has not been exercised in a real browser in this environment —
  the client is verified by type checking, a production build, the markup
  contract test, and by running its prediction module live against the server.
  The Three.js scene graph itself is unverified.
- Match state is in memory. If a Durable Object is evicted or redeployed
  mid-match, the room restarts.
- One map.
