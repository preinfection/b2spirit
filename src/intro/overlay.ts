import { TIMELINE, clamp01, easeIn, easeInOut, easeOutQuint, easeOutSoft } from './timeline';

/**
 * Drives the DOM side of the intro from the shared clock: the wordmark
 * resolving out of blur, and the whole layer lifting away. Styles are only
 * written while something is actually changing.
 */
export class Overlay {
  private readonly wordmark: HTMLElement | null;
  private lastWordmark = -1;
  private lastReveal = -1;

  constructor(
    private readonly root: HTMLElement,
    private readonly page: HTMLElement | null,
  ) {
    this.wordmark = root.querySelector<HTMLElement>('.intro__wordmark');
  }

  update(t: number) {
    const wm = clamp01((t - TIMELINE.wordmarkStart) / TIMELINE.wordmarkDuration);
    if (this.wordmark && wm !== this.lastWordmark) {
      this.lastWordmark = wm;
      const rise = easeOutQuint(wm);
      const focus = easeOutSoft(clamp01(wm * 1.08));
      const opacity = easeInOut(clamp01(wm * 1.7));
      const s = this.wordmark.style;
      s.opacity = opacity.toFixed(4);
      s.transform = `translate3d(0, ${((1 - rise) * 0.2).toFixed(4)}em, 0) scale(${(1.015 - 0.015 * rise).toFixed(4)})`;
      s.filter = focus >= 0.999 ? 'none' : `blur(${((1 - focus) * 0.16).toFixed(4)}em)`;
    }

    const rv = clamp01((t - TIMELINE.revealStart) / TIMELINE.revealDuration);
    if (rv !== this.lastReveal) {
      this.lastReveal = rv;
      const s = this.root.style;
      if (rv <= 0) {
        s.opacity = '';
        s.transform = '';
        s.filter = '';
      } else {
        s.opacity = (1 - easeInOut(rv)).toFixed(4);
        s.transform = `scale(${(1 + 0.075 * easeOutSoft(rv)).toFixed(4)})`;
        s.filter = `blur(${(22 * easeIn(rv)).toFixed(3)}px)`;
      }
      if (this.page) {
        // The page underneath settles into place as the layer lifts; its content
        // arrives in the second half so it never cross-dissolves with the wordmark.
        const settle = easeOutSoft(rv);
        const content = easeOutSoft(clamp01((rv - 0.42) / 0.58));
        const ps = this.page.style;
        ps.transform = rv > 0 && rv < 1 ? `scale(${(0.985 + 0.015 * settle).toFixed(4)})` : '';
        if (rv >= 1) ps.removeProperty('--intro-content');
        else ps.setProperty('--intro-content', content.toFixed(4));
      }
    }
  }
}
