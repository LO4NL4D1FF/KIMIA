# Pour It — design notes

Where the concept document met the physics, and what had to change.

## Mechanics that needed reinterpreting

### "Spinning glass"

A glass rotated past roughly 50° in 2D empties itself. A literally spinning glass
therefore cannot be filled at all — it is not a hard level, it is not a level.

The mechanic ships as a **turntable**: the glass rocks about its base while
travelling along an arc, which is what a glass on a carousel actually does. The
skill is leading a moving target and timing the pour against the rock, which is
the skill the concept was reaching for. World 3 is themed "Carousel Cafe" to
make the reading obvious rather than arbitrary.

`MAX_ROCK` and `MAX_TRAVEL` in `src/levels/campaign.ts` are correctness limits,
not taste: past them, levels become unwinnable or walk off screen.

### Obstacles

An obstacle that fully covers the mouth of the glass makes a level impossible,
and difficulty generation will produce that by accident. Baffles are therefore
sized to at most `width - MIN_STREAM_GAP` and shifted against one wall, so a
clear channel always remains on the other side. Funnel gaps have a floor.

The aim helper finds that channel, which is also what the game needs to show a
player where the shot is.

## Numbers that were measured, not chosen

- **Packing efficiency 1.02–1.14.** Settled liquid holds slightly more nominal
  volume than the geometric capacity of the cavity, because it settles into a
  denser packing than the square lattice the rest density is calibrated on. A
  full glass therefore legitimately exceeds its "capacity" by a little.
- **Splash retention.** With a thin fluid, roughly 40% of a pour sprayed back out
  of the glass. Viscosity is the dominant control: 0.08 → 0.15 took retention
  from ~0.57 to ~0.99. Wall friction and pour height matter far less.
- **Pour height 0.2 m.** A one-metre drop turns the stream into a jet that
  shatters on impact. Nobody pours from a metre up.
- **Flow rate.** Tuned so a glass takes a few seconds of full flow: long enough
  to correct mid-pour, short enough that a level lands inside the 15–30s window
  the concept specifies.

## The difficulty curve, as measured

Sampling every third level with the reference autoplayer (best of two pour rates):

| World | Mechanic | Result |
|---|---|---|
| 1 | still | 3 stars throughout — teaching |
| 2 | tilt | 3 stars throughout |
| 3 | turntable | 3 stars throughout |
| 4 | obstacles | mostly 3, one 2 |
| 5 | multiple glasses | 1–3, and the slowest to finish |

The bot has perfect information about volumes, which a human reading a gauge does
not, so real difficulty sits above this. Worlds 1–3 being comfortable for it is
the intent: they teach.

## Things deliberately not built

- **Simulating the jug's contents as particles.** It would double the particle
  count to make the half of the liquid the player is not judging more accurate,
  and it would make the tilt→flow curve emergent and therefore untunable. The
  jug's liquid is rendered into the same density field, so it still looks right.
- **Stars gating progress.** The concept is explicit that completionists get a
  reason to replay without anyone being walled out.
- **A tutorial.** Each world's first level carries one line of text that fades on
  the first touch, and the mechanic is introduced alone for four levels.
