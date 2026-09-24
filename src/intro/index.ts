import { Intro } from './Intro';
import './intro.css';

export interface PlayIntroOptions {
  /** The opening layer (contains the canvas and the wordmark). */
  root: HTMLElement;
  /** The page underneath, revealed at the end. */
  page?: HTMLElement | null;
  /** Play even when the user prefers reduced motion. */
  force?: boolean;
}

/**
 * Plays the cinematic opening over the page.
 *
 * Must be called synchronously while the (render-blocking) entry module
 * evaluates: the first frame is rendered before this returns, so the first
 * paint already shows the aircraft mid-shot.
 *
 * Resolves once the layer has lifted away and every GPU resource is released.
 */
export function playIntro({ root, page = null, force = false }: PlayIntroOptions): Promise<void> {
  const html = document.documentElement;
  const cleanup = () => {
    root.remove();
    html.classList.remove('intro-running');
    if (page) {
      page.removeAttribute('inert');
      page.style.transform = '';
      page.style.removeProperty('--intro-content');
    }
  };

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion && !force) {
    cleanup();
    return Promise.resolve();
  }

  page?.setAttribute('inert', '');
  root.classList.add('is-live');

  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  try {
    const intro = new Intro({
      root,
      page,
      onComplete: () => {
        cleanup();
        finished();
      },
    });
    intro.renderFrame(0);
    // Lets tooling verify that the first paint happened after this frame existed.
    performance.mark('intro:first-frame');
    intro.play();
  } catch (err) {
    // No WebGL2 / HDR targets: skip straight to the page rather than show a broken shot.
    console.warn('[intro] skipped:', err);
    cleanup();
    return Promise.resolve();
  }
  return done;
}

export { Intro };
