import { Rng, hashSeed } from '../core/rng';

/**
 * Illustrated backgrounds.
 *
 * The design calls for a deliberate contrast: photoreal liquid in front of a
 * hand-crafted world. These are painted procedurally with Canvas2D — soft washes,
 * visible brush strokes, hand-wobbled lines — then handed to the GL renderer as
 * a texture. Painting rather than shading keeps them warm and stylised, and it
 * means each world reads as a place without competing with the liquid for
 * realism.
 */

export interface Palette {
  sky: [string, string];
  far: string;
  mid: string;
  near: string;
  accent: string;
  table: string;
  tableEdge: string;
  /** Tint the liquid picks up from the environment. */
  light: [number, number, number];
  ink: string;
}

export const PALETTES: Record<string, Palette> = {
  kitchen: {
    sky: ['#f6e7cf', '#efd3ae'],
    far: '#d9b48b',
    mid: '#c08f66',
    near: '#8d5f43',
    accent: '#e2705a',
    table: '#a9714a',
    tableEdge: '#6f452c',
    light: [1.0, 0.95, 0.86],
    ink: '#4a2f21',
  },
  shelf: {
    sky: ['#e7eef0', '#cbd9de'],
    far: '#a8bcc4',
    mid: '#7f97a3',
    near: '#4f6472',
    accent: '#e0a45c',
    table: '#8a8f7d',
    tableEdge: '#4d5346',
    light: [0.93, 0.97, 1.0],
    ink: '#2c3843',
  },
  carousel: {
    sky: ['#fbe3e6', '#f3c3cf'],
    far: '#e39bb0',
    mid: '#c1738f',
    near: '#8a4a68',
    accent: '#ffd166',
    table: '#b8657f',
    tableEdge: '#6d3149',
    light: [1.0, 0.92, 0.95],
    ink: '#4a2038',
  },
  workshop: {
    sky: ['#e8e2d6', '#cfc5b2'],
    far: '#b0a48c',
    mid: '#867a63',
    near: '#544c3d',
    accent: '#d98c3f',
    table: '#7d6a4f',
    tableEdge: '#463a29',
    light: [0.98, 0.95, 0.85],
    ink: '#332c1f',
  },
  rooftop: {
    sky: ['#2b3f63', '#5b4a7a'],
    far: '#3d4f74',
    mid: '#2a3555',
    near: '#1a2138',
    accent: '#ffc46b',
    table: '#2f3a52',
    tableEdge: '#141a2a',
    light: [0.82, 0.86, 1.0],
    ink: '#e6e9f5',
  },
  endless: {
    sky: ['#0f2027', '#203a43'],
    far: '#2c5364',
    mid: '#1c3b46',
    near: '#132530',
    accent: '#4fd1c5',
    table: '#1b333d',
    tableEdge: '#0b1a20',
    light: [0.8, 0.95, 1.0],
    ink: '#d7f2f0',
  },
};

export function paletteFor(theme: string): Palette {
  return PALETTES[theme] ?? PALETTES.kitchen;
}

/** A wobbled line, so nothing in the background looks machine-drawn. */
function handLine(
  ctx: CanvasRenderingContext2D,
  from: [number, number],
  to: [number, number],
  rng: Rng,
  wobble: number,
): void {
  const steps = 12;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ctx.lineTo(
      from[0] + (to[0] - from[0]) * t + rng.jitter(wobble),
      from[1] + (to[1] - from[1]) * t + rng.jitter(wobble),
    );
  }
  ctx.stroke();
}

/** Loose brush marks, to break up flat fills the way real paint does. */
function brushWash(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  colour: string,
  count: number,
  bounds: [number, number, number, number],
  size: number,
  alpha: number,
): void {
  const [x0, y0, x1, y1] = bounds;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  for (let i = 0; i < count; i++) {
    const x = rng.range(x0, x1);
    const y = rng.range(y0, y1);
    const w = size * rng.range(0.6, 1.8);
    const h = size * rng.range(0.2, 0.6);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng.jitter(0.5));
    ctx.beginPath();
    ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Per-theme set dressing, drawn behind the action. */
const SCENES: Record<string, (c: CanvasRenderingContext2D, p: Palette, rng: Rng, w: number, h: number, horizon: number) => void> = {
  kitchen(ctx, palette, rng, w, h, horizon) {
    // A window with morning light, a shelf, a couple of jars.
    const winW = w * 0.52;
    const winH = h * 0.34;
    const winX = w * 0.24;
    const winY = horizon - winH - h * 0.12;
    ctx.fillStyle = palette.far;
    roundedRect(ctx, winX, winY, winW, winH, w * 0.02);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,247,224,0.85)';
    roundedRect(ctx, winX + w * 0.02, winY + w * 0.02, winW - w * 0.04, winH - w * 0.04, w * 0.012);
    ctx.fill();
    ctx.strokeStyle = palette.near;
    ctx.lineWidth = w * 0.008;
    handLine(ctx, [winX + winW / 2, winY], [winX + winW / 2, winY + winH], rng, w * 0.003);
    handLine(ctx, [winX, winY + winH / 2], [winX + winW, winY + winH / 2], rng, w * 0.003);

    // Light spilling onto the wall.
    const beam = ctx.createLinearGradient(winX, winY, winX + winW * 0.6, horizon);
    beam.addColorStop(0, 'rgba(255,240,205,0.5)');
    beam.addColorStop(1, 'rgba(255,240,205,0)');
    ctx.fillStyle = beam;
    ctx.fillRect(0, winY, w, horizon - winY);

    // Shelf with jars.
    const shelfY = horizon - h * 0.075;
    ctx.fillStyle = palette.mid;
    ctx.fillRect(w * 0.06, shelfY, w * 0.3, h * 0.012);
    for (let i = 0; i < 3; i++) {
      const jw = w * 0.05 + rng.jitter(w * 0.008);
      const jh = h * 0.045 + rng.jitter(h * 0.01);
      const jx = w * 0.08 + i * w * 0.09;
      ctx.fillStyle = i === 1 ? palette.accent : palette.near;
      ctx.globalAlpha = 0.85;
      roundedRect(ctx, jx, shelfY - jh, jw, jh, jw * 0.25);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  },

  shelf(ctx, palette, rng, w, h, horizon) {
    // Stacked crooked shelves receding into a cool, misty room.
    for (let i = 0; i < 4; i++) {
      const y = horizon - h * (0.1 + i * 0.09);
      const inset = w * (0.05 + i * 0.04);
      ctx.strokeStyle = i % 2 === 0 ? palette.mid : palette.far;
      ctx.lineWidth = w * (0.014 - i * 0.002);
      handLine(ctx, [inset, y], [w - inset, y - h * 0.012], rng, w * 0.004);
      for (let k = 0; k < 3 - (i % 2); k++) {
        const bw = w * rng.range(0.05, 0.1);
        const bh = h * rng.range(0.03, 0.06);
        const bx = inset + w * 0.05 + k * w * 0.12 + rng.jitter(w * 0.02);
        ctx.fillStyle = rng.next() < 0.25 ? palette.accent : palette.near;
        ctx.globalAlpha = 0.7 - i * 0.1;
        roundedRect(ctx, bx, y - bh, bw, bh, w * 0.006);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  },

  carousel(ctx, palette, rng, w, h, horizon) {
    // Striped canopy and turned poles: a fairground tea room.
    const canopyY = h * 0.1;
    const canopyH = h * 0.16;
    const stripes = 11;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? palette.accent : palette.mid;
      ctx.beginPath();
      ctx.moveTo(w / 2, canopyY);
      ctx.lineTo((w / stripes) * i, canopyY + canopyH);
      ctx.lineTo((w / stripes) * (i + 1), canopyY + canopyH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = palette.near;
    ctx.beginPath();
    ctx.arc(w / 2, canopyY, w * 0.03, 0, Math.PI * 2);
    ctx.fill();

    for (const px of [w * 0.12, w * 0.88]) {
      ctx.strokeStyle = palette.near;
      ctx.lineWidth = w * 0.022;
      handLine(ctx, [px, canopyY + canopyH], [px, horizon], rng, w * 0.003);
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = w * 0.008;
      for (let y = canopyY + canopyH; y < horizon; y += h * 0.045) {
        ctx.beginPath();
        ctx.arc(px, y, w * 0.014, 0, Math.PI);
        ctx.stroke();
      }
    }
  },

  workshop(ctx, palette, rng, w, h, horizon) {
    // Pegboard, hanging tools, sawdust light.
    ctx.fillStyle = palette.far;
    ctx.fillRect(w * 0.1, horizon - h * 0.34, w * 0.8, h * 0.3);
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    for (let y = horizon - h * 0.32; y < horizon - h * 0.06; y += h * 0.022) {
      for (let x = w * 0.13; x < w * 0.87; x += w * 0.03) {
        ctx.beginPath();
        ctx.arc(x, y, w * 0.004, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = 0; i < 5; i++) {
      const x = w * (0.18 + i * 0.16) + rng.jitter(w * 0.01);
      const top = horizon - h * 0.3;
      const len = h * rng.range(0.06, 0.13);
      ctx.strokeStyle = palette.near;
      ctx.lineWidth = w * 0.012;
      handLine(ctx, [x, top], [x + rng.jitter(w * 0.01), top + len], rng, w * 0.002);
      ctx.fillStyle = i % 2 === 0 ? palette.accent : palette.mid;
      roundedRect(ctx, x - w * 0.018, top + len, w * 0.036, h * 0.028, w * 0.008);
      ctx.fill();
    }
  },

  rooftop(ctx, palette, rng, w, h, horizon) {
    // City at dusk: silhouettes, warm windows, a string of bulbs.
    for (let layer = 0; layer < 2; layer++) {
      ctx.fillStyle = layer === 0 ? palette.far : palette.mid;
      let x = -w * 0.05;
      while (x < w * 1.05) {
        const bw = w * rng.range(0.07, 0.16);
        const bh = h * rng.range(0.08, 0.26) * (layer === 0 ? 0.8 : 1);
        ctx.fillRect(x, horizon - h * 0.04 - bh, bw, bh);
        if (layer === 1) {
          ctx.fillStyle = palette.accent;
          for (let wy = horizon - h * 0.04 - bh + h * 0.02; wy < horizon - h * 0.06; wy += h * 0.028) {
            for (let wx = x + w * 0.015; wx < x + bw - w * 0.02; wx += w * 0.028) {
              if (rng.next() < 0.45) {
                ctx.globalAlpha = rng.range(0.35, 0.9);
                ctx.fillRect(wx, wy, w * 0.012, h * 0.012);
              }
            }
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = palette.mid;
        }
        x += bw + w * 0.012;
      }
    }
    // Bulb string, sagging.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = w * 0.004;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.1);
    ctx.quadraticCurveTo(w * 0.5, h * 0.19, w, h * 0.08);
    ctx.stroke();
    for (let i = 1; i < 9; i++) {
      const t = i / 9;
      const bx = w * t;
      const by = h * (0.1 + 0.09 * Math.sin(Math.PI * t)) + h * 0.012;
      const glow = ctx.createRadialGradient(bx, by, 0, bx, by, w * 0.05);
      glow.addColorStop(0, 'rgba(255,204,120,0.75)');
      glow.addColorStop(1, 'rgba(255,204,120,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(bx - w * 0.05, by - w * 0.05, w * 0.1, w * 0.1);
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(bx, by, w * 0.008, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  endless(ctx, palette, rng, w, h, horizon) {
    // Abstract depths: nothing to place you, everything to keep going.
    for (let i = 0; i < 5; i++) {
      const y = horizon - h * (0.05 + i * 0.12);
      ctx.strokeStyle = i % 2 === 0 ? palette.far : palette.mid;
      ctx.lineWidth = w * 0.01;
      ctx.globalAlpha = 0.6 - i * 0.09;
      ctx.beginPath();
      ctx.moveTo(-w * 0.1, y);
      ctx.quadraticCurveTo(w * 0.5, y - h * rng.range(0.02, 0.09), w * 1.1, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < 26; i++) {
      const x = rng.range(0, w);
      const y = rng.range(h * 0.05, horizon - h * 0.1);
      ctx.fillStyle = palette.accent;
      ctx.globalAlpha = rng.range(0.1, 0.45);
      ctx.beginPath();
      ctx.arc(x, y, w * rng.range(0.003, 0.012), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
};

export interface BackgroundOptions {
  width: number;
  height: number;
  theme: string;
  /** World Y of the table surface, as a fraction of the canvas height from the top. */
  horizon: number;
  seed?: number;
}

/**
 * Paint one level's background. Deterministic for a given theme and seed, so a
 * level always looks like itself.
 */
export function paintBackground(options: BackgroundOptions): HTMLCanvasElement {
  const { width, height, theme } = options;
  const palette = paletteFor(theme);
  const rng = new Rng(hashSeed(`${theme}-${options.seed ?? 0}`));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(width));
  canvas.height = Math.max(2, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const w = canvas.width;
  const h = canvas.height;
  const horizon = h * options.horizon;

  // Wash of sky/wall behind everything.
  const wash = ctx.createLinearGradient(0, 0, w * 0.2, h);
  wash.addColorStop(0, palette.sky[0]);
  wash.addColorStop(1, palette.sky[1]);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);
  brushWash(ctx, rng, palette.far, 60, [0, 0, w, horizon], w * 0.09, 0.07);

  SCENES[theme]?.(ctx, palette, rng, w, h, horizon);

  // Table: the surface the glass stands on, painted last so it sits in front.
  const tableGradient = ctx.createLinearGradient(0, horizon, 0, h);
  tableGradient.addColorStop(0, palette.table);
  tableGradient.addColorStop(1, palette.tableEdge);
  ctx.fillStyle = tableGradient;
  ctx.fillRect(0, horizon, w, h - horizon);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = Math.max(1, h * 0.003);
  handLine(ctx, [0, horizon], [w, horizon], rng, h * 0.002);
  brushWash(ctx, rng, palette.tableEdge, 40, [0, horizon, w, h], w * 0.07, 0.12);

  // Vignette, to sit the composition down and keep the eye on the glass.
  const vignette = ctx.createRadialGradient(w * 0.5, horizon * 0.92, w * 0.15, w * 0.5, horizon, w * 0.95);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  return canvas;
}
