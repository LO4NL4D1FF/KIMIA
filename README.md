# Pour It

A physics-based liquid-pouring precision game. You tilt a jug to fill a glass —
but the glass fights you: it leans, it turns, it has things in the way, and
sometimes there are two of them.

Built mobile-first as a web game (TypeScript + WebGL2), packaged for Android
with Capacitor.

```bash
npm install
npm run dev       # play it at the printed URL
npm test          # 104 tests
npm run build     # production build into dist/
```

## Controls

| | Touch | Keyboard |
|---|---|---|
| Aim | Your finger's position across the screen | `←` `→` |
| Pour | Touch and hold; drag up to pour harder | `Space`, with `↑` `↓` to meter |
| Stop | Let go | Release `Space` |
| End the attempt | **Done** | **Done** |

Aim is the spout, not the jug body, so metering the flow never drags your aim
sideways. Letting go and waiting settles the liquid and scores the attempt; a
pause mid-pour does not end it, so you can move between two glasses.

## How it works

```
src/
  core/        pure simulation — no DOM, no WebGL, fully tested
    fluid.ts       position-based fluid solver
    body.ts        kinematic capsule colliders
    shapes.ts      glasses, jugs, obstacles
    jug.ts         the pour model
    fill.ts        what is in the glass, what is on the floor
    scoring.ts     precision, cleanliness, stars
    simulation.ts  fixed-step loop tying it together
  levels/      campaign and endless level generation
  render/      WebGL2 renderer, shaders, procedural backgrounds
  game/        shell, input, audio, haptics, save
```

`core/` and `levels/` have no browser dependencies, which is why the entire
mechanic can be regression-tested headlessly — including whether a level can be
won at all.

### The fluid

Position Based Fluids (Macklin & Müller 2013): predict, then solve a density
constraint over neighbours found with a spatial hash, then derive velocity from
the corrected positions. Chosen over a spring-mass blob or a fill meter because
it stays stable at large timesteps, is incompressible enough to look like water,
and is cheap enough for a phone. Incompressibility is what gives the pour weight:
liquid piles up, glugs through a narrow neck and sloshes when the glass moves,
none of it scripted.

Three things were needed to make it behave:

- **Swept boundary collision.** A falling stream covers more ground in one step
  than a glass wall is thick, so testing only the end position let liquid pour
  straight through the side of the glass — fills capped at 36% before this.
- **Clamped position corrections.** The artificial-pressure term grows like
  `1/r`, so two particles forced into the same spot in a wall corner could fling
  one out of the world.
- **A cohesion kernel that vanishes at `r = 0`.** The obvious form diverges, and
  overlapping particles detonate.

### The pour

The jug's contents are a scalar rather than simulated particles, which keeps the
whole particle budget on the part the player is judging and makes the tilt→flow
curve directly tunable and testable. The curve models the real thing: nothing
comes out until the lip drops below the liquid line, a full jug tips over its lip
much sooner than an empty one, and flow follows Torricelli's `sqrt(head)` so it
eases in rather than switching on, and tapers as the jug drains. Pour too gently
and a draining jug stops giving — you have to tip further as it empties.

### Fill and scoring

Fill detection is geometric: a particle counts because it *is* inside the glass
right now, not because it crossed a trigger. Overflow, slosh-out and a glass
tipping its contents back out all fall out of that for free.

Capacity is *measured* on a grid rather than derived from the glass's dimensions,
so targets stay honest for tapered shapes and for obstacles that displace liquid.
(Settled liquid packs about 1.02–1.14× the grid figure, so a full glass holds
marginally more than the nominal capacity — measured, not assumed.)

Score is 75% precision, 25% how much you kept in. Three stars needs both. In
multi-glass levels stars are gated on the *worst* glass, so you cannot win by
over-serving one and ignoring the other.

### Levels

Five worlds of 25 levels, each introducing exactly one new variable — still,
tilted, turning, obstacles, multiple glasses — with each world's 25th level
combining everything introduced so far. Levels are generated deterministically
from their id, so a level always builds identically without shipping 125 files.
Endless mode draws from the same mechanic pool, unlocking and then stacking them
on a saturating escalation curve that never quite reaches 1.

Two mechanics needed reinterpreting to be playable at all:

- **"Spinning glass" is a turntable.** A 2D glass tumbled past roughly 50° cannot
  hold liquid, so a literal spin is not a game. It reads instead as a glass on a
  carousel: rocking about its base while travelling along an arc, so you lead a
  moving target and time the pour against the rock.
- **Obstacles always leave a threadable gap.** Baffles are sized and shifted to
  one wall so a clear channel always remains; funnel gaps have a floor. Hard,
  never impossible.

### The look

Photoreal liquid in front of hand-crafted worlds, as the concept asks.

The liquid is splatted into a density field, thresholded for a surface, and that
field's gradient used as a normal to refract the painted background, with
Beer-Lambert absorption through the depth plus specular, Fresnel and foam.
Working from a field rather than drawing discs is what makes it read as one body
of liquid. Splats stretch along their velocity — without that, a stream renders
as a string of beads instead of a rope.

The glass is drawn as a volume, not an outline. The light path through a
cylindrical shell,

```
path(x) = 2 * ( sqrt(R² - x²) - sqrt(r² - x²) )
```

is short through the middle and long at the edges, which produces the
bright-centre, dark-green-rimmed look that reads instantly as glass. Elliptical
rim and base supply the third dimension (the rim's far arc is dimmer, being seen
through the glass), and a contact shadow with a caustic seats it on the table.
It renders in two passes — far wall, then liquid, then near wall — so the liquid
is *inside* the glass rather than painted over it.

Backgrounds are painted procedurally with Canvas2D (washes, brush marks,
hand-wobbled lines), one identity per world, and uploaded as a texture.

Splat positions are jittered: a regular lattice puts a periodic ripple into the
density field, and since the surface normal is that field's gradient, the ripple
appears as a dot grid across every liquid surface.

### Feel

Audio is synthesised, so every cue can be driven continuously by the simulation
rather than triggered as a clip. The pour is band-passed noise whose brightness
and level follow the flow. A soft tone rises in pitch as the glass approaches its
target and keeps climbing if you overfill — in a precision game you need to feel
the target coming without staring at a number. Spills get a dull thump, a screen
shake and a haptic tick; landing it gets an arpeggio that climbs with your stars.

## Testing

```bash
npm test
```

Tests cover the kernels and solver stability, boundary integrity (including a
tunnelling regression), the pour curve, fill and scoring, level structure, save
data and the camera. The important one is a **reference autoplayer** that aims,
meters and stops exactly as a player would. Every sampled level, and every
sampled endless stage, must be winnable by it — an unwinnable level fails the
build.

Determinism is tested directly: the same inputs produce identical results, and
60Hz and 144Hz reach the same outcome, which a precision game judged to a few
percent needs.

```bash
npm run shots     # drives the built game in Chromium and captures screenshots
```

## Android

The web build is the app; Capacitor wraps it.

```bash
npm run android:add     # once, creates android/
npm run android:apk     # debug APK -> android/app/build/outputs/apk/debug/
npm run android:release # release build (needs signing config)
```

Requires the Android SDK and JDK 17; `npm run android:open` opens the project in
Android Studio. `capacitor.config.json` holds the app id and theme colours.

## Decisions worth knowing

- **Fixed timestep (1/120s) with an accumulator.** Gameplay is frame-rate
  independent — mandatory when a fill target is judged to a few percent.
- **Aim is the spout position.** Tilting to meter the flow must not move where
  the liquid lands.
- **The jug holds more than you need, but not much more.** You cannot win by
  emptying it; you have to stop.
- **Stars never gate progress.** Clearing a level opens the next one; stars are
  there for people who want to go back.
- **UI is DOM, not drawn in GL.** Crisp text, trivially responsive, and none of
  it competes with the canvas for frame time.

## Still open

- Illustrated background style is procedural placeholder art with the right
  structure — cozy/whimsical vs. abstract/painterly is still an open call from
  the concept, and `src/render/backgrounds.ts` is where it gets made.
- Monetisation for endless mode is not implemented.
- Obstacle types beyond baffles and funnels (moving hazards, colour-mixing
  liquids) are not implemented.
