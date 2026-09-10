import type { Simulation } from '../core/simulation';
import { PLAYFIELD, TABLE_Y } from '../core/simulation';
import { pointInPolygon, polygonArea, type Vec2 } from '../core/geometry';
import { Camera } from './camera';
import { paintBackground, paletteFor, type Palette } from './backgrounds';
import { GLASS_FRAG, GLASS_VERT } from './glass';
import {
  BACKGROUND_FRAG,
  DENSITY_FRAG,
  DENSITY_VERT,
  FULLSCREEN_VERT,
  LIQUID_FRAG,
  SOLID_FRAG,
  SOLID_VERT,
} from './shaders';
import {
  Uniforms,
  createProgram,
  createQuad,
  createRenderTarget,
  createTextureFromCanvas,
  resizeRenderTarget,
  type RenderTarget,
} from './gl';

/** Density field runs at half resolution: it is smooth, so nobody can tell. */
const DENSITY_SCALE = 0.5;

const EMPTY_POINTS = new Float32Array(0);

/** Sutherland-Hodgman clip of a polygon against the half-plane y <= limit. */
function clipBelow(corners: ReadonlyArray<readonly [number, number]>, limit: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % corners.length];
    const aIn = ay <= limit;
    const bIn = by <= limit;
    if (aIn) out.push({ x: ax, y: ay });
    if (aIn !== bIn) {
      const t = (limit - ay) / (by - ay || 1e-9);
      out.push({ x: ax + (bx - ax) * t, y: limit });
    }
  }
  return out;
}

export interface RenderOptions {
  theme: string;
  seed: number;
}

/**
 * Draws one frame: illustrated background, then the liquid as a refractive body,
 * then the glass and props over it.
 */
export class Renderer {
  readonly camera = new Camera();
  private readonly gl: WebGL2RenderingContext;
  private readonly quad: WebGLBuffer;

  private readonly densityProgram: WebGLProgram;
  private readonly densityUniforms: Uniforms;
  private readonly liquidProgram: WebGLProgram;
  private readonly liquidUniforms: Uniforms;
  private readonly solidProgram: WebGLProgram;
  private readonly solidUniforms: Uniforms;
  private readonly backgroundProgram: WebGLProgram;
  private readonly backgroundUniforms: Uniforms;
  private readonly glassProgram: WebGLProgram;
  private readonly glassUniforms: Uniforms;

  private densityTarget: RenderTarget;
  private backgroundTexture: WebGLTexture | null = null;
  private backgroundCanvas: HTMLCanvasElement | null = null;

  private readonly particleVao: WebGLVertexArrayObject;
  private readonly particleBuffer: WebGLBuffer;
  private particleData = new Float32Array(0);

  private readonly solidVao: WebGLVertexArrayObject;
  private readonly solidBuffer: WebGLBuffer;
  private solidData = new Float32Array(0);

  private readonly fullscreenVao: WebGLVertexArrayObject;
  private readonly glassVao: WebGLVertexArrayObject;
  private readonly glassBuffer: WebGLBuffer;
  private glassData = new Float32Array(0);
  private glassCount = 0;

  private palette: Palette = paletteFor('kitchen');
  private theme = 'kitchen';
  private seed = 0;
  private time = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    // Needed to render the density field into a float target.
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_float_blend');

    this.quad = createQuad(gl);
    this.densityProgram = createProgram(gl, DENSITY_VERT, DENSITY_FRAG);
    this.densityUniforms = new Uniforms(gl, this.densityProgram);
    this.liquidProgram = createProgram(gl, FULLSCREEN_VERT, LIQUID_FRAG);
    this.liquidUniforms = new Uniforms(gl, this.liquidProgram);
    this.solidProgram = createProgram(gl, SOLID_VERT, SOLID_FRAG);
    this.solidUniforms = new Uniforms(gl, this.solidProgram);
    this.backgroundProgram = createProgram(gl, FULLSCREEN_VERT, BACKGROUND_FRAG);
    this.backgroundUniforms = new Uniforms(gl, this.backgroundProgram);
    this.glassProgram = createProgram(gl, GLASS_VERT, GLASS_FRAG);
    this.glassUniforms = new Uniforms(gl, this.glassProgram);

    this.densityTarget = createRenderTarget(gl, 2, 2);

    // Fullscreen quad VAO.
    this.fullscreenVao = this.makeVao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    });

    // Instanced particles: quad corners + per-instance centre and velocity.
    this.particleBuffer = gl.createBuffer()!;
    this.particleVao = this.makeVao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 16, 8);
      gl.vertexAttribDivisor(2, 1);
    });

    // Instanced vessels: quad corners + transform, shape and extras.
    this.glassBuffer = gl.createBuffer()!;
    this.glassVao = this.makeVao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glassBuffer);
      for (let slot = 1; slot <= 3; slot++) {
        gl.enableVertexAttribArray(slot);
        gl.vertexAttribPointer(slot, 4, gl.FLOAT, false, 48, (slot - 1) * 16);
        gl.vertexAttribDivisor(slot, 1);
      }
    });

    // Instanced capsules: quad corners + per-instance segment and style.
    this.solidBuffer = gl.createBuffer()!;
    this.solidVao = this.makeVao(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
      gl.vertexAttribDivisor(2, 1);
    });
  }

  private makeVao(setup: () => void): WebGLVertexArrayObject {
    const vao = this.gl.createVertexArray();
    if (!vao) throw new Error('could not create VAO');
    this.gl.bindVertexArray(vao);
    setup();
    this.gl.bindVertexArray(null);
    return vao;
  }

  /** Load (or repaint) the background for a level. */
  setScene(options: RenderOptions): void {
    const changed = options.theme !== this.theme || options.seed !== this.seed;
    this.theme = options.theme;
    this.seed = options.seed;
    this.palette = paletteFor(options.theme);
    if (changed || !this.backgroundTexture) this.repaintBackground();
  }

  private repaintBackground(): void {
    const gl = this.gl;
    // Paint at a fixed generous size: it is a soft painting, so it scales well
    // and does not need repainting on every resize.
    const width = 1024;
    const visibleWorldHeight = this.camera.height / Math.max(this.camera.scale, 1e-6);
    const worldWidth = PLAYFIELD.maxX - PLAYFIELD.minX;
    const aspect = visibleWorldHeight > 0 ? visibleWorldHeight / worldWidth : 1.7;
    const height = Math.round(width * Math.min(Math.max(aspect, 1.0), 2.4));

    // Where the table sits, as a fraction down the painted canvas.
    const topWorldY = this.camera.originY + visibleWorldHeight;
    const horizon = Math.min(
      0.97,
      Math.max(0.5, (topWorldY - TABLE_Y) / Math.max(visibleWorldHeight, 1e-6)),
    );

    this.backgroundCanvas = paintBackground({
      width,
      height,
      theme: this.theme,
      horizon,
      seed: this.seed,
    });
    if (this.backgroundTexture) gl.deleteTexture(this.backgroundTexture);
    this.backgroundTexture = createTextureFromCanvas(gl, this.backgroundCanvas);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const before = this.camera.height;
    this.camera.resize(cssWidth, cssHeight, dpr);
    this.canvas.width = this.camera.width;
    this.canvas.height = this.camera.height;
    resizeRenderTarget(
      this.gl,
      this.densityTarget,
      Math.max(2, Math.round(this.camera.width * DENSITY_SCALE)),
      Math.max(2, Math.round(this.camera.height * DENSITY_SCALE)),
    );
    // The painting's horizon depends on how much world is visible.
    if (Math.abs(before - this.camera.height) > 1 || !this.backgroundTexture) {
      this.repaintBackground();
    }
  }

  /** World-space rectangle currently on screen. */
  private viewport(): { originX: number; originY: number; width: number; height: number } {
    const width = this.camera.width / this.camera.scale;
    const height = this.camera.height / this.camera.scale;
    return {
      originX: this.camera.originX - this.camera.shakeX / this.camera.scale,
      originY: this.camera.originY + this.camera.shakeY / this.camera.scale,
      width,
      height,
    };
  }

  render(sim: Simulation, dt: number): void {
    this.time += dt;
    const gl = this.gl;
    const view = this.viewport();

    this.drawDensity(sim, view);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.camera.width, this.camera.height);
    gl.disable(gl.BLEND);
    this.drawBackground();

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Order matters: the far wall of the glass, then the liquid, then the near
    // wall over it. Drawn any other way the liquid sits on top of the whole
    // glass and the illusion collapses.
    this.buildVessels(sim);
    this.drawVessels(view, 0);
    this.drawLiquid();
    this.drawVessels(view, 1);
    this.drawSolids(sim, view);
  }

  /** Pack the glasses (and the jug) as vessel instances. */
  private buildVessels(sim: Simulation): void {
    const vessels: Array<{
      x: number;
      y: number;
      angle: number;
      halfBase: number;
      halfTop: number;
      height: number;
      wall: number;
      surfaceY: number;
      kind: number;
      waist: number;
    }> = [];

    for (let g = 0; g < sim.glasses.length; g++) {
      const body = sim.glasses[g];
      const spec = sim.spec.glasses[g];
      const fill = sim.fill.glasses[g];
      // The liquid surface in glass-local terms, for the meniscus ellipse.
      const surfaceLocal = fill && fill.volume > 0 ? body.toLocal({ x: body.position.x, y: fill.surfaceY }).y : 0;
      vessels.push({
        x: body.position.x,
        y: body.position.y,
        angle: body.angle,
        halfBase: (spec.width * (spec.taper ?? 1)) / 2,
        halfTop: spec.width / 2,
        height: spec.height,
        wall: spec.thickness ?? 0.022,
        surfaceY: Math.max(0, Math.min(spec.height, surfaceLocal)),
        kind: 0,
        waist: spec.waist ?? 0,
      });
    }

    const jug = sim.jug;
    // A vessel's local origin is the centre of its base, but the jug rotates
    // about its middle — so place that origin where the base actually ends up.
    const jugAngle = jug.bodyAngle;
    const baseOffset = jug.config.height * 0.5;
    vessels.push({
      x: jug.position.x + baseOffset * Math.sin(jugAngle),
      y: jug.position.y - baseOffset * Math.cos(jugAngle),
      angle: jugAngle,
      halfBase: jug.config.width * 0.42,
      halfTop: jug.config.width * 0.5,
      height: jug.config.height,
      wall: Math.min(jug.config.width, jug.config.height) * 0.075,
      // The jug's own contents are drawn into the density field, so no ring.
      surfaceY: 0,
      kind: 1,
      waist: 0,
    });

    this.glassCount = vessels.length;
    if (this.glassData.length < vessels.length * 12) {
      this.glassData = new Float32Array(Math.max(8, vessels.length * 2) * 12);
    }
    for (let i = 0; i < vessels.length; i++) {
      const v = vessels[i];
      const o = i * 12;
      this.glassData[o] = v.x;
      this.glassData[o + 1] = v.y;
      this.glassData[o + 2] = Math.cos(v.angle);
      this.glassData[o + 3] = Math.sin(v.angle);
      this.glassData[o + 4] = v.halfBase;
      this.glassData[o + 5] = v.halfTop;
      this.glassData[o + 6] = v.height;
      this.glassData[o + 7] = v.wall;
      this.glassData[o + 8] = v.surfaceY;
      this.glassData[o + 9] = v.kind;
      // How squashed the rim ellipse is: the apparent viewing angle.
      this.glassData[o + 10] = 0.19;
      this.glassData[o + 11] = v.waist;
    }
  }

  /**
   * Draw the vessels. `pass` 0 is everything behind the liquid (far wall, base,
   * contact shadow), pass 1 everything in front (near wall, rim, highlights).
   *
   * Each instance is drawn on its own because the shader needs that vessel's
   * transform as a uniform to map local space back to screen space for its
   * refraction lookup.
   */
  private drawVessels(view: ReturnType<Renderer['viewport']>, pass: number): void {
    if (this.glassCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.glassProgram);
    gl.bindVertexArray(this.glassVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glassBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.glassData, gl.DYNAMIC_DRAW);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture!);
    gl.uniform1i(this.glassUniforms.at('uBackground'), 0);
    gl.uniform2f(this.glassUniforms.at('uViewOrigin'), view.originX, view.originY);
    gl.uniform2f(this.glassUniforms.at('uViewSize'), view.width, view.height);
    gl.uniform2f(this.glassUniforms.at('uLightDir'), -0.42, 0.66);
    gl.uniform3f(
      this.glassUniforms.at('uLightColour'),
      this.palette.light[0],
      this.palette.light[1],
      this.palette.light[2],
    );
    gl.uniform1f(this.glassUniforms.at('uPixelWorld'), 1 / this.camera.scale);
    gl.uniform1f(this.glassUniforms.at('uPass'), pass);
    // Faintly green, like real soda-lime glass seen edge-on.
    gl.uniform3f(this.glassUniforms.at('uGlassTint'), 0.86, 0.95, 0.9);

    for (let i = 0; i < this.glassCount; i++) {
      const o = i * 12;
      gl.uniform4f(
        this.glassUniforms.at('uTransform'),
        this.glassData[o],
        this.glassData[o + 1],
        this.glassData[o + 2],
        this.glassData[o + 3],
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
      // Advance the instance pointer to the next vessel.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glassBuffer);
      for (let slot = 1; slot <= 3; slot++) {
        gl.vertexAttribPointer(slot, 4, gl.FLOAT, false, 48, (i + 1) * 48 + (slot - 1) * 16);
      }
    }
    // Restore the pointers for the next frame.
    for (let slot = 1; slot <= 3; slot++) {
      gl.vertexAttribPointer(slot, 4, gl.FLOAT, false, 48, (slot - 1) * 16);
    }
    gl.bindVertexArray(null);
  }

  /** Pass 1: splat every particle into the density field. */
  private drawDensity(sim: Simulation, view: ReturnType<Renderer['viewport']>): void {
    const gl = this.gl;
    const fluid = sim.fluid;
    const jugPoints = this.jugLiquidPoints(sim);
    const count = fluid.count + jugPoints.length / 2;

    if (this.particleData.length < count * 4) {
      this.particleData = new Float32Array(Math.max(64, count * 2) * 4);
    }
    for (let i = 0; i < fluid.count; i++) {
      const o = i * 4;
      this.particleData[o] = fluid.px[i];
      this.particleData[o + 1] = fluid.py[i];
      this.particleData[o + 2] = fluid.vx[i];
      this.particleData[o + 3] = fluid.vy[i];
    }
    for (let k = 0; k < jugPoints.length / 2; k++) {
      const o = (fluid.count + k) * 4;
      this.particleData[o] = jugPoints[k * 2];
      this.particleData[o + 1] = jugPoints[k * 2 + 1];
      // Zero velocity: the jug's contents are still, so they splat round.
      this.particleData[o + 2] = 0;
      this.particleData[o + 3] = 0;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.densityTarget.framebuffer);
    gl.viewport(0, 0, this.densityTarget.width, this.densityTarget.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count === 0) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.densityProgram);
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.particleData, gl.DYNAMIC_DRAW);

    gl.uniform2f(this.densityUniforms.at('uViewOrigin'), view.originX, view.originY);
    gl.uniform2f(this.densityUniforms.at('uViewSize'), view.width, view.height);
    // Splat wider than the particle itself so neighbours merge into one body.
    gl.uniform1f(this.densityUniforms.at('uRadius'), sim.fluid.params.spacing * 2.35);
    gl.uniform1f(this.densityUniforms.at('uStretch'), 0.85);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  private drawBackground(): void {
    if (!this.backgroundTexture) return;
    const gl = this.gl;
    gl.useProgram(this.backgroundProgram);
    gl.bindVertexArray(this.fullscreenVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    gl.uniform1i(this.backgroundUniforms.at('uBackground'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /** Pass 2: shade the density field as a refractive body of liquid. */
  private drawLiquid(): void {
    const gl = this.gl;
    gl.useProgram(this.liquidProgram);
    gl.bindVertexArray(this.fullscreenVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.densityTarget.texture);
    gl.uniform1i(this.liquidUniforms.at('uDensity'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture!);
    gl.uniform1i(this.liquidUniforms.at('uBackground'), 1);

    gl.uniform2f(
      this.liquidUniforms.at('uTexel'),
      1 / this.densityTarget.width,
      1 / this.densityTarget.height,
    );
    // Raised with the splat radius: a wider splat sums to more density, and the
    // surface has to stay on the liquid's actual boundary.
    gl.uniform1f(this.liquidUniforms.at('uThreshold'), 0.72);
    // Water, not ink: absorb only a little, and mostly in the red.
    gl.uniform3f(this.liquidUniforms.at('uLiquidColour'), 0.78, 0.92, 0.97);
    gl.uniform3f(
      this.liquidUniforms.at('uLightColour'),
      this.palette.light[0],
      this.palette.light[1],
      this.palette.light[2],
    );
    gl.uniform2f(this.liquidUniforms.at('uLightDir'), -0.42, 0.66);
    gl.uniform1f(this.liquidUniforms.at('uRefraction'), 0.05);
    gl.uniform1f(this.liquidUniforms.at('uTime'), this.time);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /** Pass 3: glass, props and the jug, over the liquid. */
  private drawSolids(sim: Simulation, view: ReturnType<Renderer['viewport']>): void {
    const gl = this.gl;
    const walls: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; radius: number; kind: number }> = [];

    // Glasses and the jug body are drawn by the vessel shader; this pass is for
    // props and for the jug's spout and handle.
    for (const obstacle of sim.obstacles) {
      for (const wall of obstacle.worldWalls()) walls.push({ ...wall, kind: 1 });
    }
    this.collectJug(sim, walls);

    if (walls.length === 0) return;
    if (this.solidData.length < walls.length * 8) {
      this.solidData = new Float32Array(Math.max(32, walls.length * 2) * 8);
    }
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      const o = i * 8;
      this.solidData[o] = w.a.x;
      this.solidData[o + 1] = w.a.y;
      this.solidData[o + 2] = w.b.x;
      this.solidData[o + 3] = w.b.y;
      this.solidData[o + 4] = w.radius;
      this.solidData[o + 5] = w.kind;
      this.solidData[o + 6] = w.kind > 0.5 ? 1 : 0.34; // opacity of the material
      this.solidData[o + 7] = w.kind > 0.5 ? 18 : 64; // specular tightness
    }

    gl.useProgram(this.solidProgram);
    gl.bindVertexArray(this.solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.solidData, gl.DYNAMIC_DRAW);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture!);
    gl.uniform1i(this.solidUniforms.at('uBackground'), 0);
    gl.uniform2f(this.solidUniforms.at('uViewOrigin'), view.originX, view.originY);
    gl.uniform2f(this.solidUniforms.at('uViewSize'), view.width, view.height);
    gl.uniform2f(this.solidUniforms.at('uLightDir'), -0.42, 0.66);
    gl.uniform3f(
      this.solidUniforms.at('uLightColour'),
      this.palette.light[0],
      this.palette.light[1],
      this.palette.light[2],
    );
    gl.uniform1f(this.solidUniforms.at('uPixelWorld'), 1 / this.camera.scale);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, walls.length);
    gl.bindVertexArray(null);
  }

  /**
   * Points filling the liquid still in the jug.
   *
   * The jug's contents are a scalar in the simulation, but the player needs to
   * see the jug empty out — so they are reconstructed here as splats for the
   * density field. They then pick up exactly the same refraction and surface
   * shading as the poured liquid, and the surface stays level as the jug tips,
   * because the fill height is solved in world space.
   */
  private jugLiquidPoints(sim: Simulation): Float32Array {
    const jug = sim.jug;
    const fraction = jug.fillFraction;
    if (fraction <= 0.001) return EMPTY_POINTS;

    const { width, height } = jug.config;
    const angle = jug.bodyAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfW = width * 0.46;
    const halfH = height * 0.46;
    const corners: Array<[number, number]> = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, halfH],
      [-halfW, halfH],
    ].map(([x, y]) => [
      jug.position.x + x * cos - y * sin,
      jug.position.y + x * sin + y * cos,
    ]) as Array<[number, number]>;

    const ys = corners.map((c) => c[1]);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const full = polygonArea(corners.map(([x, y]) => ({ x, y })));
    const wanted = full * fraction;

    // Bisect for the world-space surface height that encloses the right area.
    let low = minY;
    let high = maxY;
    for (let iter = 0; iter < 14; iter++) {
      const mid = (low + high) * 0.5;
      const area = polygonArea(clipBelow(corners, mid));
      if (area < wanted) low = mid;
      else high = mid;
    }
    const surface = (low + high) * 0.5;
    const region = clipBelow(corners, surface);
    if (region.length < 3) return EMPTY_POINTS;

    // Grid-fill the region. Spacing matches the fluid so the splats merge into
    // one body rather than reading as dots.
    // Tighter than the fluid's own spacing, and jittered. A regular grid of
    // splats produces a periodic ripple in the density field, and since the
    // surface normal is that field's gradient, the ripple shows up as a visible
    // dot pattern. Breaking the lattice removes it.
    const spacing = sim.fluid.params.spacing * 0.7;
    const xs = region.map((p) => p.x);
    const rminX = Math.min(...xs);
    const rmaxX = Math.max(...xs);
    const rminY = Math.min(...region.map((p) => p.y));
    const points: number[] = [];
    let n = 0;
    for (let y = rminY + spacing * 0.5; y < surface; y += spacing) {
      for (let x = rminX + spacing * 0.5; x < rmaxX; x += spacing) {
        // Deterministic hash jitter: stable frame to frame, so the liquid does
        // not shimmer, but not periodic either.
        const h = Math.sin(n * 12.9898) * 43758.5453;
        const g = Math.sin(n * 78.233) * 12345.6789;
        n++;
        const jx = x + (h - Math.floor(h) - 0.5) * spacing * 0.85;
        const jy = y + (g - Math.floor(g) - 0.5) * spacing * 0.85;
        if (pointInPolygon({ x: jx, y: jy }, region)) points.push(jx, jy);
      }
    }
    return new Float32Array(points);
  }

  /** The jug is a body too, but it is posed from the Jug model each frame. */
  private collectJug(
    sim: Simulation,
    out: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; radius: number; kind: number }>,
  ): void {
    const jug = sim.jug;
    const { width, height } = jug.config;
    const angle = jug.bodyAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const place = (x: number, y: number) => ({
      x: jug.position.x + x * cos - y * sin,
      y: jug.position.y + x * sin + y * cos,
    });

    const halfW = width * 0.5;
    const halfH = height * 0.5;
    const thickness = Math.min(width, height) * 0.1;
    const side = jug.tilt >= 0 ? 1 : -1;
    const outline: Array<[[number, number], [number, number]]> = [
      // The pouring lip, flared out on whichever side the jug is tipped.
      [[halfW * side * 0.92, halfH * 0.9], [halfW * side * 1.1, halfH * 1.04]],
      // The handle, on the side away from the spout.
      [[-side * (halfW + thickness * 1.7), halfH * 0.34], [-side * (halfW + thickness * 1.7), -halfH * 0.36]],
      [[-side * halfW, halfH * 0.34], [-side * (halfW + thickness * 1.7), halfH * 0.34]],
      [[-side * halfW, -halfH * 0.36], [-side * (halfW + thickness * 1.7), -halfH * 0.36]],
    ];
    for (const [from, to] of outline) {
      out.push({
        a: place(from[0], from[1]),
        b: place(to[0], to[1]),
        radius: thickness * 0.42,
        kind: 0,
      });
    }
  }
}
