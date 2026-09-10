import { Simulation, type SimEvent } from '../core/simulation';
import { Renderer } from '../render/renderer';
import { PourController } from './input';
import { GameAudio } from './audio';
import { Haptics } from './haptics';
import {
  LEVELS_PER_WORLD,
  TOTAL_LEVELS,
  WORLDS,
  WORLD_COUNT,
  buildLevel,
  levelFromOrdinal,
  levelOrdinal,
} from '../levels/campaign';
import {
  ENDLESS_LIVES,
  advanceEndlessRun,
  buildEndlessStage,
  isRunOver,
  startEndlessRun,
  type EndlessRun,
} from '../levels/endless';
import { endlessStageScore } from '../core/scoring';
import type { LevelSpec } from '../levels/types';
import {
  loadSave,
  markHintSeen,
  persist,
  recordEndless,
  recordLevel,
  starsInWorld,
  totalStars,
  type SaveData,
} from './save';
import { clamp01 } from '../core/geometry';

type Screen = 'title' | 'worlds' | 'levels' | 'play' | 'result';
type Mode = 'campaign' | 'endless';

const STAR = '★';
const EMPTY_STAR = '☆';

/**
 * Wires the simulation, renderer, input and feedback together, and owns the
 * screens. UI is DOM rather than drawn in GL: text stays crisp, layout is
 * trivially responsive, and none of it competes with the canvas for frame time.
 */
export class Game {
  private readonly renderer: Renderer;
  private readonly input: PourController;
  private readonly audio = new GameAudio();
  private readonly haptics = new Haptics();
  private save: SaveData;

  private sim: Simulation | null = null;
  private spec: LevelSpec | null = null;
  private mode: Mode = 'campaign';
  private screen: Screen = 'title';
  private endless: EndlessRun | null = null;
  private viewedWorld = 1;

  private lastFrame = 0;
  private shake = 0;
  private running = false;
  private resultShownAt = 0;

  constructor(
    private readonly root: HTMLElement,
    canvas: HTMLCanvasElement,
  ) {
    this.renderer = new Renderer(canvas);
    this.input = new PourController(canvas, this.renderer.camera);
    this.save = loadSave();
    this.audio.setEnabled(this.save.soundOn);
    this.haptics.setEnabled(this.save.hapticsOn);

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.showTitle();
    this.running = true;
    requestAnimationFrame((t) => this.frame(t));
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(width, height, dpr);
  }

  // ---------------------------------------------------------------- screens

  private showTitle(): void {
    this.screen = 'title';
    this.teardownPlay();
    const stars = totalStars(this.save);
    this.root.innerHTML = `
      <section class="screen title">
        <div class="brand">
          <h1>Pour It</h1>
          <p class="tagline">Fill the glass. The glass disagrees.</p>
        </div>
        <div class="menu">
          <button class="primary" data-action="campaign">Campaign</button>
          <button data-action="endless">Endless</button>
        </div>
        <footer class="title-footer">
          <span>${stars} / ${TOTAL_LEVELS * 3} ${STAR}</span>
          ${this.save.endlessBest > 0 ? `<span>Best endless ${this.save.endlessBest.toLocaleString()}</span>` : ''}
          <span class="toggles">
            <button class="chip ${this.save.soundOn ? 'on' : ''}" data-action="sound">Sound ${this.save.soundOn ? 'on' : 'off'}</button>
            ${this.haptics.supported ? `<button class="chip ${this.save.hapticsOn ? 'on' : ''}" data-action="haptics">Haptics ${this.save.hapticsOn ? 'on' : 'off'}</button>` : ''}
          </span>
        </footer>
      </section>`;
    this.bind();
  }

  private showWorlds(): void {
    this.screen = 'worlds';
    this.teardownPlay();
    const furthest = levelFromOrdinal(this.save.unlocked);
    const cards = WORLDS.map((world) => {
      const unlocked = world.number <= furthest.world;
      const earned = starsInWorld(this.save, world.number, LEVELS_PER_WORLD);
      return `
        <button class="world-card ${unlocked ? '' : 'locked'}" data-action="world" data-world="${world.number}" ${unlocked ? '' : 'disabled'}>
          <span class="world-index">World ${world.number}</span>
          <span class="world-name">${world.name}</span>
          <span class="world-teaches">${unlocked ? world.hint : 'Finish the world before to open this'}</span>
          <span class="world-stars">${earned} / ${LEVELS_PER_WORLD * 3} ${STAR}</span>
        </button>`;
    }).join('');
    this.root.innerHTML = `
      <section class="screen list">
        <header class="bar">
          <button class="ghost" data-action="title">Back</button>
          <h2>Campaign</h2>
          <span class="count">${totalStars(this.save)} ${STAR}</span>
        </header>
        <div class="worlds">${cards}</div>
      </section>`;
    this.bind();
  }

  private showLevels(world: number): void {
    this.screen = 'levels';
    this.viewedWorld = world;
    this.teardownPlay();
    const definition = WORLDS[world - 1];
    const tiles = Array.from({ length: LEVELS_PER_WORLD }, (_, k) => {
      const index = k + 1;
      const ordinal = levelOrdinal(world, index);
      const stars = this.save.stars[ordinal] ?? 0;
      const unlocked = ordinal <= this.save.unlocked;
      const isBoss = index === LEVELS_PER_WORLD;
      return `
        <button class="tile ${unlocked ? '' : 'locked'} ${isBoss ? 'boss' : ''}" data-action="level"
                data-world="${world}" data-index="${index}" ${unlocked ? '' : 'disabled'}>
          <span class="tile-index">${isBoss ? 'Last Call' : index}</span>
          <span class="tile-stars">${STAR.repeat(stars)}${EMPTY_STAR.repeat(3 - stars)}</span>
        </button>`;
    }).join('');
    this.root.innerHTML = `
      <section class="screen list">
        <header class="bar">
          <button class="ghost" data-action="worlds">Back</button>
          <h2>${definition.name}</h2>
          <span class="count">${starsInWorld(this.save, world, LEVELS_PER_WORLD)} ${STAR}</span>
        </header>
        <div class="tiles">${tiles}</div>
      </section>`;
    this.bind();
  }

  // ------------------------------------------------------------------- play

  private startLevel(world: number, index: number): void {
    this.mode = 'campaign';
    this.endless = null;
    this.launch(buildLevel(world, index));
  }

  private startEndless(): void {
    this.mode = 'endless';
    this.endless = startEndlessRun(Math.floor(Math.random() * 0x7fffffff), this.save.endlessBest);
    this.launch(buildEndlessStage(this.endless.stage, this.endless.seed));
  }

  private launch(spec: LevelSpec): void {
    this.screen = 'play';
    this.spec = spec;
    this.sim = new Simulation(spec);
    this.shake = 0;

    const theme = this.mode === 'endless' ? 'endless' : WORLDS[spec.world - 1]?.theme ?? 'kitchen';
    this.renderer.setScene({ theme, seed: spec.world * 100 + spec.index });

    this.audio.start();
    this.input.setAim(spec.jug.x);
    this.input.attach();

    const hintId = `${spec.id}-hint`;
    const showHint = spec.hint && !this.save.hintsSeen.includes(hintId);
    if (showHint) markHintSeen(this.save, hintId);

    this.root.innerHTML = `
      <section class="screen hud">
        <header class="hud-top">
          <button class="ghost small" data-action="quit">Quit</button>
          <div class="hud-title">${this.mode === 'endless' ? `Stage ${spec.index}` : spec.name}</div>
          <div class="hud-clock" data-clock>--</div>
        </header>
        ${this.mode === 'endless' ? this.endlessBanner() : ''}
        <div class="gauges" data-gauges></div>
        ${showHint ? `<div class="hint" data-hint><p>${spec.hint}</p></div>` : ''}
        <footer class="hud-bottom">
          <div class="jug-gauge"><span data-jug-fill></span></div>
          <button class="ghost small" data-action="commit">Done</button>
        </footer>
      </section>`;
    this.bind();
    if (showHint) {
      // The hint fades on the first touch — never a dialog to dismiss.
      const hide = () => this.root.querySelector('[data-hint]')?.classList.add('gone');
      this.root.querySelector('[data-hint]')?.addEventListener('animationend', hide);
      window.addEventListener('pointerdown', hide, { once: true });
    }
  }

  private endlessBanner(): string {
    const run = this.endless;
    if (!run) return '';
    return `
      <div class="endless-bar">
        <span>Score ${run.score.toLocaleString()}</span>
        <span>${'♥'.repeat(run.lives)}${'·'.repeat(Math.max(0, ENDLESS_LIVES - run.lives))}</span>
        <span>${run.combo > 0 ? `Combo x${run.combo}` : `Best ${run.best.toLocaleString()}`}</span>
      </div>`;
  }

  private teardownPlay(): void {
    this.input.detach();
    this.audio.quiet();
    this.sim = null;
    this.spec = null;
  }

  private retry(): void {
    if (!this.spec) return;
    // Instant: rebuild the same level and go. No confirmation, no transition.
    this.launch(this.spec);
  }

  private advance(): void {
    if (this.mode === 'endless') {
      const run = this.endless;
      if (!run) return this.showTitle();
      if (isRunOver(run)) {
        recordEndless(this.save, run.score, run.stage);
        return this.showTitle();
      }
      return this.launch(buildEndlessStage(run.stage, run.seed));
    }

    const spec = this.spec;
    if (!spec) return this.showTitle();
    const next = spec.index + 1;
    if (next > LEVELS_PER_WORLD) {
      if (spec.world >= WORLD_COUNT) return this.showWorlds();
      return this.showLevels(spec.world + 1);
    }
    this.startLevel(spec.world, next);
  }

  // ------------------------------------------------------------------ frame

  private frame(now: number): void {
    if (!this.running) return;
    const dt = this.lastFrame === 0 ? 1 / 60 : Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.sim && this.screen === 'play') this.step(dt);
    else if (this.sim && this.screen === 'result') this.renderer.render(this.sim, dt);

    requestAnimationFrame((t) => this.frame(t));
  }

  private step(dt: number): void {
    const sim = this.sim!;
    const request = this.input.sample(dt);
    sim.setTilt(request.tilt);
    sim.setJugX(request.aim);

    const events = sim.update(dt);
    this.handleEvents(events);

    // Screen shake decays exponentially; it is only ever a nudge.
    this.shake = Math.max(0, this.shake - dt * 3.2);
    const amplitude = this.shake * this.shake * 9 * this.renderer.camera.dpr;
    this.renderer.camera.shakeX = (Math.random() * 2 - 1) * amplitude;
    this.renderer.camera.shakeY = (Math.random() * 2 - 1) * amplitude;

    const target = sim.totalTarget;
    const filled = sim.fill.glasses.reduce((sum, g) => sum + g.volume, 0);
    this.audio.update(
      sim.jug.smoothedFlowRate / Math.max(sim.jug.config.spoutArea * sim.jug.config.exitSpeed, 1e-6),
      target > 0 ? filled / target : 0,
      sim.isFlowing,
    );

    this.updateHud(sim);
    this.renderer.render(sim, dt);
  }

  private handleEvents(events: SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'impact':
          this.audio.splash(event.strength);
          if (event.strength > 0.45) this.haptics.tick();
          break;
        case 'spill':
          this.audio.spill(event.volume);
          this.shake = Math.min(1, this.shake + 0.35);
          this.haptics.spill();
          break;
        case 'glass-full':
          this.audio.click(1.5);
          break;
        case 'complete':
          this.finish();
          break;
        default:
          break;
      }
    }
  }

  private updateHud(sim: Simulation): void {
    const clock = this.root.querySelector('[data-clock]');
    if (clock) {
      const remaining = sim.timeRemaining;
      clock.textContent = sim.phase === 'ready' ? 'Ready' : `${remaining.toFixed(1)}s`;
      clock.classList.toggle('urgent', remaining < 5 && sim.phase !== 'ready');
    }

    const gauges = this.root.querySelector('[data-gauges]');
    if (gauges) {
      // One bar per glass: filled portion, plus a marker at the target.
      const html = sim.fill.glasses
        .map((glass) => {
          const ratio = glass.capacity > 0 ? clamp01(glass.volume / glass.capacity) : 0;
          const mark = glass.capacity > 0 ? clamp01(glass.target / glass.capacity) : 0;
          const error = glass.target > 0 ? (glass.volume - glass.target) / glass.target : 0;
          const state = Math.abs(error) < 0.06 ? 'good' : error > 0 ? 'over' : '';
          return `
            <div class="gauge ${state}">
              <div class="gauge-fill" style="height:${(ratio * 100).toFixed(1)}%"></div>
              <div class="gauge-mark" style="bottom:${(mark * 100).toFixed(1)}%"></div>
            </div>`;
        })
        .join('');
      if (gauges.innerHTML !== html) gauges.innerHTML = html;
    }

    const jugFill = this.root.querySelector('[data-jug-fill]') as HTMLElement | null;
    if (jugFill) jugFill.style.width = `${(sim.jug.fillFraction * 100).toFixed(1)}%`;
  }

  private finish(): void {
    const sim = this.sim;
    const spec = this.spec;
    if (!sim?.result || !spec) return;
    const result = sim.result;

    this.input.detach();
    this.audio.quiet();
    if (result.passed) {
      this.audio.chime(result.stars);
      this.haptics.success(result.stars);
    } else {
      this.audio.fail();
      this.haptics.fail();
    }

    let banner = '';
    if (this.mode === 'campaign') {
      const { improved } = recordLevel(this.save, spec.world, spec.index, result.stars);
      if (improved && result.stars > 0) banner = 'New best';
    } else if (this.endless) {
      const gained = endlessStageScore(result, this.endless.stage, this.endless.combo);
      this.endless = advanceEndlessRun(
        this.endless,
        gained,
        result.passed,
        result.stars === 3,
      );
      if (result.passed) banner = `+${gained.toLocaleString()}`;
      if (isRunOver(this.endless)) {
        const best = recordEndless(this.save, this.endless.score, this.endless.stage);
        banner = best ? 'New personal best' : 'Run over';
      }
    }

    this.showResult(banner);
  }

  private showResult(banner: string): void {
    const sim = this.sim;
    const result = sim?.result;
    if (!sim || !result) return;
    this.screen = 'result';
    this.resultShownAt = performance.now();

    const verdictCopy: Record<string, string> = {
      perfect: 'Dead on.',
      short: 'Short. More next time.',
      overfilled: 'Over the line.',
      messy: 'Accurate, but everywhere.',
      failed: result.timedOut ? 'Out of time.' : 'Not close enough.',
    };

    const endlessOver = this.mode === 'endless' && this.endless && isRunOver(this.endless);
    const stars = `${STAR.repeat(result.stars)}${EMPTY_STAR.repeat(3 - result.stars)}`;

    this.root.innerHTML = `
      <section class="screen result">
        <div class="result-card">
          <div class="result-stars ${result.stars === 3 ? 'gold' : ''}">${stars}</div>
          <h2>${verdictCopy[result.verdict] ?? ''}</h2>
          ${banner ? `<p class="banner">${banner}</p>` : ''}
          <dl class="stats">
            <div><dt>Precision</dt><dd>${Math.round(result.accuracy * 100)}%</dd></div>
            <div><dt>Kept in</dt><dd>${Math.round(result.cleanliness * 100)}%</dd></div>
            <div><dt>Points</dt><dd>${result.points}</dd></div>
          </dl>
          ${
            this.mode === 'endless' && this.endless
              ? `<p class="endless-total">Score ${this.endless.score.toLocaleString()} · ${'♥'.repeat(Math.max(0, this.endless.lives))}</p>`
              : ''
          }
          <div class="result-actions">
            <button class="primary" data-action="retry">Again</button>
            ${
              endlessOver
                ? `<button data-action="title">Finish</button>`
                : result.passed
                  ? `<button data-action="next">Next</button>`
                  : `<button data-action="quit">Quit</button>`
            }
          </div>
        </div>
      </section>`;
    this.bind();
  }

  // ------------------------------------------------------------------ input

  private bind(): void {
    for (const element of Array.from(this.root.querySelectorAll('[data-action]'))) {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        const action = (element as HTMLElement).dataset.action!;
        // Guard against a stray tap carrying through into the result screen.
        if (this.screen === 'result' && performance.now() - this.resultShownAt < 150) return;
        this.audio.start();
        this.audio.click();
        this.act(action, element as HTMLElement);
      });
    }
  }

  private act(action: string, element: HTMLElement): void {
    switch (action) {
      case 'campaign':
        this.showWorlds();
        break;
      case 'endless':
        this.startEndless();
        break;
      case 'title':
        this.showTitle();
        break;
      case 'worlds':
        this.showWorlds();
        break;
      case 'world':
        this.showLevels(Number(element.dataset.world));
        break;
      case 'level':
        this.startLevel(Number(element.dataset.world), Number(element.dataset.index));
        break;
      case 'commit':
        this.sim?.commit();
        break;
      case 'retry':
        this.retry();
        break;
      case 'next':
        this.advance();
        break;
      case 'quit':
        if (this.mode === 'endless') this.showTitle();
        else this.showLevels(this.spec?.world ?? this.viewedWorld);
        break;
      case 'sound':
        this.save.soundOn = !this.save.soundOn;
        this.audio.setEnabled(this.save.soundOn);
        persist(this.save);
        this.showTitle();
        break;
      case 'haptics':
        this.save.hapticsOn = !this.save.hapticsOn;
        this.haptics.setEnabled(this.save.hapticsOn);
        persist(this.save);
        this.showTitle();
        break;
      default:
        break;
    }
  }
}
