/**
 * B-2 Spirit planform and surface definition, in metres.
 *
 * Planform coordinates: `s` is the spanwise offset from the centreline (the
 * shape is symmetric, so functions take |s|), `c` is the chordwise distance aft
 * of the nose apex.
 *
 * Reference figures: 52.4 m span, ~21 m length, 33° leading-edge sweep. Every
 * edge of the real aircraft is aligned with one of the two leading edges
 * ("planform alignment"), so each trailing-edge segment below is swept at
 * exactly ±33°. That produces the four-notch "double-W" trailing edge:
 * wingtip → large outer tooth → deep outer notch → smaller inner tooth →
 * inner notch → centreline beaver tail.
 */

const DEG = Math.PI / 180;

export const SWEEP = Math.tan(33 * DEG);
export const HALF_SPAN = 26.2;
export const LENGTH = 21.0;

/** Spanwise positions of the trailing-edge vertices. */
const TE_S = [0, 5.2, 7.6, 14.0, 21.95, HALF_SPAN] as const;
/** Alternating direction of each trailing-edge segment (+1 = moves aft when going outboard). */
const TE_DIR = [-1, +1, -1, +1, -1] as const;

/** Trailing-edge vertices [s, c], derived so every segment is parallel to a leading edge. */
export const TRAILING_EDGE: ReadonlyArray<readonly [number, number]> = (() => {
  const pts: Array<[number, number]> = [[0, LENGTH]];
  for (let i = 1; i < TE_S.length; i++) {
    const [ps, pc] = pts[i - 1];
    pts.push([TE_S[i], pc + TE_DIR[i - 1] * (TE_S[i] - ps) * SWEEP]);
  }
  return pts;
})();

/** Spanwise stations the surface mesh must hit exactly so the sawtooth stays crisp. */
export const TE_KINKS: readonly number[] = TE_S;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Polynomial smooth-max: blends two surfaces with a fillet of radius ~k. */
function smax(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
  return mix(b, a, h) + k * h * (1 - h);
}

export function leadingEdgeC(s: number): number {
  return Math.abs(s) * SWEEP;
}

export function trailingEdgeC(s: number): number {
  const a = Math.min(Math.abs(s), HALF_SPAN);
  const te = TRAILING_EDGE;
  for (let i = 1; i < te.length; i++) {
    if (a <= te[i][0]) {
      const [s0, c0] = te[i - 1];
      const [s1, c1] = te[i];
      return mix(c0, c1, (a - s0) / (s1 - s0));
    }
  }
  return te[te.length - 1][1];
}

/** Smooth trailing-edge envelope used to shape the airfoil independently of the sawtooth. */
function envelopeC(a: number): number {
  const t = a / HALF_SPAN;
  return mix(LENGTH - 0.4, TRAILING_EDGE[TRAILING_EDGE.length - 1][1] + 0.1, Math.pow(t, 1.6));
}

/** Normalised NACA-style thickness distribution, peak (=1) near 30% chord. */
function foil(u: number): number {
  const x = clamp(u, 0, 1);
  const y = 0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x;
  return y / 0.15;
}

/* ------------------------------------------------------------------------ */
/* Centre body (cockpit hump and spine)                                      */
/* ------------------------------------------------------------------------ */

function bodyProfile(c: number): number {
  if (c <= 0) return 0;
  // Sharp "beak": steep convex rise to the windscreen, canopy crest ~6 m aft.
  const rise = 1 - Math.pow(1 - clamp(c / 6.4, 0, 1), 2.2);
  const fall = Math.pow(smoothstep(6.6, 22, c), 1.1);
  return 2.15 * rise - 1.55 * fall;
}

function bodyHalfWidth(c: number): number {
  if (c < 2.5) return mix(0.45, 2.0, smoothstep(0, 2.5, c) ** 0.8);
  if (c < 9) return mix(2.0, 3.1, smoothstep(2.5, 9, c));
  return mix(3.1, 1.9, smoothstep(9, 21, c));
}

function bodyHeight(s: number, c: number): number {
  const w = bodyHalfWidth(c);
  const x = Math.abs(s) / w;
  if (x >= 1) return -1;
  return bodyProfile(c) * Math.pow(1 - x * x, 1.05);
}

/* ------------------------------------------------------------------------ */
/* Engine nacelles (one hump per side, housing two engines)                  */
/* ------------------------------------------------------------------------ */

export const NACELLE_S = 4.25;
export const NACELLE_HALF_WIDTH = 2.15;
export const EXHAUST_C = 14.4;

/** Jagged inlet lip: the lip line zig-zags across the nacelle width. */
export function inletLipC(s: number): number {
  const x = clamp((Math.abs(s) - NACELLE_S) / NACELLE_HALF_WIDTH, -1, 1); // -1..1 across the nacelle
  const f = x + 0.5 - Math.floor(x + 0.5);
  const tri = Math.abs(2 * f - 1); // teeth at x = ±0.5
  return 6.1 + 0.5 * Math.abs(x) + 0.32 * tri;
}

function nacelleHeight(s: number, c: number): number {
  const x = (Math.abs(s) - NACELLE_S) / NACELLE_HALF_WIDTH;
  if (Math.abs(x) >= 1) return -1;
  const lip = inletLipC(s);
  const front = smoothstep(lip - 0.5, lip + 0.02, c);
  // Recessed duct mouth just behind the lip, visible from above as a dark scoop.
  const scoop = 0.32 * (1 - smoothstep(lip + 0.05, lip + 0.85, c)) * front;
  const crown = 1.34 - 0.36 * smoothstep(9.5, EXHAUST_C, c);
  const back = 1 - smoothstep(EXHAUST_C - 0.05, EXHAUST_C + 0.35, c);
  const cross = Math.pow(1 - x * x, 0.75);
  return (crown - scoop) * front * back * cross - (1 - front * back) * 0.4;
}

/* ------------------------------------------------------------------------ */
/* Exhaust troughs (recessed channels aft of the nozzles)                    */
/* ------------------------------------------------------------------------ */

export const TROUGH_INNER = 2.75;
export const TROUGH_OUTER = 6.35;

export function troughMask(s: number, c: number): number {
  const a = Math.abs(s);
  const across = smoothstep(TROUGH_INNER - 0.2, TROUGH_INNER + 0.15, a) * (1 - smoothstep(TROUGH_OUTER - 0.15, TROUGH_OUTER + 0.2, a));
  const along = smoothstep(EXHAUST_C, EXHAUST_C + 0.4, c);
  return across * along;
}

/* ------------------------------------------------------------------------ */
/* Surfaces                                                                  */
/* ------------------------------------------------------------------------ */

function wingThickness(a: number): number {
  const t = a / HALF_SPAN;
  return 0.05 + 1.05 * Math.pow(1 - t, 1.3);
}

/** Height of the upper skin above the chord plane at (s, c). */
export function upperHeight(s: number, c: number): number {
  const a = Math.abs(s);
  const cle = a * SWEEP;
  const cte = trailingEdgeC(a);
  const dLE = Math.max(c - cle, 0);
  const dTE = Math.max(cte - c, 0);
  const chord = Math.max(cte - cle, 1e-3);

  const cref = Math.max(envelopeC(a) - cle, 0.3);
  const u = Math.min(dLE / cref, 0.72);
  const teLen = clamp(chord * 0.3, 0.12, 2.4);
  const teFade = smoothstep(0, teLen, dTE);
  const tipFade = 1 - smoothstep(HALF_SPAN - 0.9, HALF_SPAN, a);

  let h = wingThickness(a) * foil(u) * (0.25 + 0.75 * teFade) * teFade ** 0.35 * tipFade;

  const body = bodyHeight(s, c);
  if (body > -1) h = smax(h, body * teFade ** 0.5, 0.75);

  const nac = nacelleHeight(s, c);
  if (nac > -1) h = smax(h, nac * teFade ** 0.5, 0.7);

  h -= 0.2 * troughMask(s, c) * smoothstep(0, 0.5, dTE);

  // Leading edge: sharp but slightly rounded "beak".
  h *= Math.pow(smoothstep(0, 0.9, dLE), 0.5);
  return Math.max(h, 0);
}

/** Depth of the lower skin below the chord plane (positive number). */
export function lowerDepth(s: number, c: number): number {
  const a = Math.abs(s);
  const cle = a * SWEEP;
  const cte = trailingEdgeC(a);
  const dLE = Math.max(c - cle, 0);
  const dTE = Math.max(cte - c, 0);
  const chord = Math.max(cte - cle, 1e-3);
  const cref = Math.max(envelopeC(a) - cle, 0.3);
  const u = Math.min(dLE / cref, 0.72);
  const teFade = smoothstep(0, clamp(chord * 0.3, 0.12, 2.4), dTE);
  const tipFade = 1 - smoothstep(HALF_SPAN - 0.9, HALF_SPAN, a);
  let d = 0.42 * wingThickness(a) * foil(u) * teFade * tipFade;
  const bw = 3.6;
  const x = a / bw;
  if (x < 1) d += 0.55 * Math.pow(1 - x * x, 1.5) * smoothstep(0.5, 6, c) * (1 - smoothstep(15, 20.5, c));
  return d * Math.pow(smoothstep(0, 0.6, dLE), 0.5);
}

/** Engine exhaust positions (planform coordinates) used as contrail sources. */
export const ENGINE_EXHAUSTS: ReadonlyArray<readonly [number, number]> = [
  [-5.3, EXHAUST_C],
  [-3.6, EXHAUST_C],
  [3.6, EXHAUST_C],
  [5.3, EXHAUST_C],
];
