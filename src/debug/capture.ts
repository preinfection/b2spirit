import { Intro } from '../intro/Intro';
import '../intro/intro.css';

/**
 * Dev-only: renders the intro at arbitrary times for frame-accurate review.
 * `/?capture&t=1.2` shows t = 1.2 s; `window.__intro.seek(t)` renders another.
 */
export function startCapture(root: HTMLElement, page: HTMLElement | null) {
  root.classList.add('is-live');
  page?.setAttribute('inert', '');
  const intro = new Intro({ root, page, manual: true });
  const t0 = Number(new URLSearchParams(location.search).get('t') ?? 0);
  intro.renderFrame(t0);
  const api = {
    seek(t: number) {
      intro.renderFrame(t);
      return new Promise<ReturnType<Intro['metrics']>>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(intro.metrics()))));
    },
    metrics: () => intro.metrics(),
    instance: intro,
  };
  (window as unknown as { __intro: typeof api }).__intro = api;
}
