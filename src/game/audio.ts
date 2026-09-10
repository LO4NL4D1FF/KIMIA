import { clamp, clamp01, lerp } from '../core/geometry';

/**
 * All sound is synthesised — no assets to load, and every cue can be driven
 * continuously by the simulation instead of triggered as a clip.
 *
 * The important one is `fillTone`: a soft pitch that rises with how full the
 * glass is. In a precision game the player needs to feel the target approaching
 * without staring at a number, and pitch is the most legible channel for it.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Continuous pour stream. */
  private pourGain: GainNode | null = null;
  private pourFilter: BiquadFilterNode | null = null;
  /** Continuous fill-progress tone. */
  private toneGain: GainNode | null = null;
  private toneOsc: OscillatorNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  private started = false;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(enabled ? 0.9 : 0, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Must be called from a user gesture: browsers will not start audio otherwise.
   */
  start(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.started = true;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(ctx.destination);

    // Two seconds of noise, looped, is the bed for the stream and the splashes.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;

    // The pour: band-passed noise whose brightness and level follow the flow.
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
    this.pourFilter = filter;
    this.pourGain = gain;

    // The fill tone: a soft sine, pitch tracking the fill.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 320;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0;
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = 2200;
    osc.connect(toneGain).connect(toneFilter).connect(this.master);
    osc.start();
    this.toneOsc = osc;
    this.toneGain = toneGain;
  }

  /**
   * Continuous state, called every frame.
   * `flow` is 0..1 of peak pour rate; `fill` is volume/target.
   */
  update(flow: number, fill: number, pouring: boolean): void {
    if (!this.ctx || !this.pourGain || !this.pourFilter || !this.toneGain || !this.toneOsc) return;
    const now = this.ctx.currentTime;
    const f = clamp01(flow);

    this.pourGain.gain.setTargetAtTime(f * 0.16, now, 0.04);
    // A fuller stream is a lower, throatier sound; a dribble is thin and high.
    this.pourFilter.frequency.setTargetAtTime(lerp(1500, 620, f), now, 0.06);
    this.pourFilter.Q.setTargetAtTime(lerp(0.7, 1.6, f), now, 0.08);

    // Pitch rises towards the target and keeps climbing if you overfill, so the
    // moment to stop is audible.
    const ratio = clamp(fill, 0, 1.6);
    const semitones = ratio * 16;
    this.toneOsc.frequency.setTargetAtTime(300 * Math.pow(2, semitones / 12), now, 0.05);
    this.toneGain.gain.setTargetAtTime(pouring ? 0.055 : 0, now, 0.12);
  }

  /** A splash where the stream lands. */
  splash(strength: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const s = clamp01(strength);
    if (s < 0.06) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = lerp(0.8, 1.5, s);
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = lerp(600, 1800, s);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.05 * s, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.1 + s * 0.09);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(now, Math.random() * 1.5);
    source.stop(now + 0.25);
  }

  /** Liquid hitting the table: duller, heavier, and it should feel like a loss. */
  spill(volume: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const strength = clamp01(volume * 90);
    if (strength < 0.05) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.07 * strength, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.22);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now, Math.random());
    source.stop(now + 0.3);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, now);
    thump.frequency.exponentialRampToValueAtTime(58, now + 0.16);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.09 * strength, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thump.connect(thumpGain).connect(this.master);
    thump.start(now);
    thump.stop(now + 0.2);
  }

  /** The reward. Number of stars picks how far up the arpeggio it goes. */
  chime(stars: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // A major triad plus the octave: unambiguous "you did it".
    const partials = [[880, 0], [1108.7, 0.07], [1318.5, 0.14], [1760, 0.21]];
    const notes = partials.slice(0, Math.max(1, Math.min(4, stars + 1)));

    for (const [freq, delay] of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const at = now + delay;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.13, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0008, at + 0.9);
      osc.connect(gain).connect(this.master);
      osc.start(at);
      osc.stop(at + 1);
    }
  }

  /** The failure. A soft descending pair — disappointing, never harsh. */
  fail(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (const [freq, delay] of [[392, 0], [294, 0.1]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const at = now + delay;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.1, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0008, at + 0.5);
      osc.connect(gain).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.6);
    }
  }

  /** UI tick. */
  click(pitch = 1): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 660 * pitch;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.06);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  /** Silence the continuous voices, e.g. when leaving a level. */
  quiet(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.pourGain?.gain.setTargetAtTime(0, now, 0.05);
    this.toneGain?.gain.setTargetAtTime(0, now, 0.05);
  }
}
