/**
 * Drives the built game in Chromium and captures screenshots.
 * Used to verify the renderer actually produces pixels — the tests can prove the
 * physics, only a browser can prove the shaders.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.GAME_URL ?? 'http://localhost:4173/';
const OUT = process.env.OUT_DIR ?? 'shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({
  viewport: { width: 430, height: 900 },
  deviceScaleFactor: 2,
});

const problems = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-title.png` });

await page.click('[data-action="campaign"]');
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/02-worlds.png` });

await page.click('[data-action="world"][data-world="1"]');
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/03-levels.png` });

await page.click('[data-action="level"][data-index="1"]');
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/04-level-start.png` });

// Pour: press in the middle of the screen and hold.
const box = { x: 215, y: 620 };
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/05-pouring.png` });
// Drag up to open the pour, and hold long enough to actually fill the glass.
await page.mouse.move(box.x, box.y - 120, { steps: 8 });
await page.waitForTimeout(1600);
await page.screenshot({ path: `${OUT}/06-pouring-more.png` });
await page.waitForTimeout(Number(process.env.HOLD_MS ?? 2600));
await page.screenshot({ path: `${OUT}/07-nearly-full.png` });
await page.mouse.up();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/08-settled.png` });
await page.waitForTimeout(3200);
await page.screenshot({ path: `${OUT}/09-result.png` });

// Report what the canvas actually contains, so a blank render is caught.
const stats = await page.evaluate(() => {
  const canvas = document.getElementById('stage');
  const gl = canvas.getContext('webgl2');
  return {
    size: [canvas.width, canvas.height],
    renderer: gl ? gl.getParameter(gl.VERSION) : 'no webgl2',
    lost: gl ? gl.isContextLost() : true,
  };
});
console.log(JSON.stringify(stats));
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors');
await browser.close();
