import { Game } from './game/shell';
import './styles.css';

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
const ui = document.getElementById('ui');

function fail(message: string): void {
  if (!ui) return;
  ui.innerHTML = `
    <section class="screen title">
      <div class="brand"><h1>Pour It</h1><p class="tagline">${message}</p></div>
    </section>`;
}

if (!canvas || !ui) {
  fail('Something is missing from the page.');
} else {
  try {
    new Game(ui, canvas);
  } catch (error) {
    // The liquid needs WebGL2. Say so plainly rather than showing a blank screen.
    const detail = error instanceof Error ? error.message : String(error);
    fail(`This device cannot run the liquid renderer.<br><small>${detail}</small>`);
  }
}
