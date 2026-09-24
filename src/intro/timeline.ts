/**
 * Shot timing (seconds). One clock drives the WebGL shot and the DOM overlay,
 * so the wordmark and reveal can never drift out of sync with the flight.
 */
export const TIMELINE = {
  /** The aircraft has fully cleared the frame by this time. */
  aircraftGone: 2.5,
  /** Grade eases the exposure down behind the centre as the jet leaves. */
  scrimIn: [2.05, 3.0],
  wordmarkStart: 2.42,
  wordmarkDuration: 1.35,
  /** ~1.5 s after the wordmark appears, the whole layer lifts away. */
  revealStart: 3.95,
  revealDuration: 1.0,
} as const;

export const INTRO_END = TIMELINE.revealStart + TIMELINE.revealDuration;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** CSS-equivalent cubic-bezier easing, solved with Newton iterations + bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-6) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** Long, soft deceleration: settles without any overshoot. */
export const easeOutQuint = cubicBezier(0.22, 1, 0.36, 1);
export const easeOutSoft = cubicBezier(0.25, 0.8, 0.3, 1);
export const easeInOut = cubicBezier(0.45, 0, 0.2, 1);
export const easeIn = cubicBezier(0.5, 0, 0.75, 0.3);
