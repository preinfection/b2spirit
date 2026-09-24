import { CanvasTexture, NoColorSpace, SRGBColorSpace, type Texture } from 'three';
import {
  EXHAUST_C,
  HALF_SPAN,
  NACELLE_HALF_WIDTH,
  NACELLE_S,
  SWEEP,
  TRAILING_EDGE,
  TROUGH_INNER,
  TROUGH_OUTER,
  inletLipC,
  trailingEdgeC,
} from './planform';
import { UV_CHORD, UV_SPAN } from './b2Geometry';

const W = 2048;
const H = 1024;

type Pt = readonly [number, number];
type Ctx = CanvasRenderingContext2D;

/** Planform (s, c) in metres → canvas pixels. Canvas row 0 is the nose (flipY texture). */
const px = (s: number, c: number): [number, number] => [((s + HALF_SPAN) / UV_SPAN) * W, (c / UV_CHORD) * H];
const PX_PER_M = W / UV_SPAN;

/** Deterministic PRNG so the aircraft looks identical on every load. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(): [HTMLCanvasElement, Ctx] {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: false })!;
  return [cv, ctx];
}

function poly(ctx: Ctx, pts: readonly Pt[], mirror = false) {
  ctx.beginPath();
  pts.forEach(([s, c], i) => {
    const [x, y] = px(mirror ? -s : s, c);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function line(ctx: Ctx, a: Pt, b: Pt, mirror = false) {
  const [x0, y0] = px(mirror ? -a[0] : a[0], a[1]);
  const [x1, y1] = px(mirror ? -b[0] : b[0], b[1]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

const both = (fn: (mirror: boolean) => void) => {
  fn(false);
  fn(true);
};

/** Grey level helper for the data canvases (0..1). */
const g = (v: number) => {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${n},${n},${n})`;
};

/* ------------------------------------------------------------------------ */
/* Shared feature geometry                                                   */
/* ------------------------------------------------------------------------ */

/** Control surfaces: parallelograms hinged parallel to each trailing-edge segment. */
function controlSurfaces(): Array<{ pts: Pt[]; kind: 'elevon' | 'rudder' | 'glas' }> {
  const te = TRAILING_EDGE;
  const out: Array<{ pts: Pt[]; kind: 'elevon' | 'rudder' | 'glas' }> = [];
  // Beaver tail / gust load alleviation surface: the centre point aft of the inner notches.
  const [sn, cn] = te[1];
  out.push({ kind: 'glas', pts: [[-sn * 0.62, cn + sn * 0.38 * SWEEP], [0, te[0][1]], [sn * 0.62, cn + sn * 0.38 * SWEEP], [0, cn + 0.2]] });
  // Split into individual surfaces along each segment.
  const splits: Array<[number, number, number, 'elevon' | 'rudder']> = [
    // segment index, number of surfaces, hinge depth (m), kind
    [1, 1, 1.5, 'elevon'],
    [2, 2, 1.7, 'elevon'],
    [3, 2, 1.75, 'elevon'],
    [4, 1, 1.35, 'rudder'],
  ];
  for (const [seg, count, depth, kind] of splits) {
    const [s0, c0] = te[seg];
    const [s1, c1] = te[seg + 1];
    for (let k = 0; k < count; k++) {
      const t0 = k / count + (k === 0 ? 0.06 : 0.01);
      const t1 = (k + 1) / count - (k === count - 1 ? 0.04 : 0.01);
      const a: Pt = [s0 + (s1 - s0) * t0, c0 + (c1 - c0) * t0];
      const b: Pt = [s0 + (s1 - s0) * t1, c0 + (c1 - c0) * t1];
      const d = depth * (kind === 'rudder' ? 1 : 1 - 0.25 * t0);
      out.push({ kind, pts: [a, b, [b[0], b[1] - d], [a[0], a[1] - d]] });
    }
  }
  return out;
}

/** The four-pane windscreen, drawn on the forward slope of the cockpit hump. */
const WINDSCREEN: Pt[][] = [
  [[-0.07, 2.75], [-1.12, 3.2], [-1.22, 4.3], [-0.07, 4.02]],
  [[-1.24, 3.3], [-1.78, 3.9], [-1.86, 4.95], [-1.34, 4.45]],
];

/** Inlet duct mouth: from the front face up over the jagged lip into the recessed scoop. */
function inletPolygon(): Pt[] {
  const pts: Pt[] = [];
  const n = 24;
  const at = (i: number) => NACELLE_S - NACELLE_HALF_WIDTH * 0.86 + (NACELLE_HALF_WIDTH * 1.72 * i) / n;
  for (let i = 0; i <= n; i++) pts.push([at(i), inletLipC(at(i)) - 0.52]);
  for (let i = n; i >= 0; i--) {
    const s = at(i);
    pts.push([s, inletLipC(s) + 0.55 - 0.25 * Math.abs((s - NACELLE_S) / NACELLE_HALF_WIDTH)]);
  }
  return pts;
}

/** Panel seams: straight lines aligned with the planform edges (as on the real skin). */
function panelSeams(): Array<[Pt, Pt]> {
  const seams: Array<[Pt, Pt]> = [];
  // Spar-aligned lines running parallel to the leading edge.
  for (const off of [1.0, 3.3, 5.6]) {
    const s0 = off === 1.0 ? 1.6 : 3.2;
    const s1 = HALF_SPAN - 1.5 - off * 0.6;
    seams.push([[s0, s0 * SWEEP + off], [s1, s1 * SWEEP + off]]);
  }
  // Chordwise seams across the outer wing.
  for (const s of [11.4, 16.2, 23.4]) {
    const c0 = s * SWEEP + 1.0;
    const c1 = Math.min(trailingEdgeC(s) - 1.9, c0 + 5.2);
    if (c1 > c0 + 0.5) seams.push([[s, c0], [s, c1]]);
  }
  // Centre-body and spine panels.
  seams.push([[0.9, 5.4], [0.9, 12.5]], [[1.85, 5.9], [2.2, 12]], [[0.45, 12.5], [1.85, 12.8]]);
  // Nacelle access panels with sawtooth forward and aft edges.
  const ns = NACELLE_S;
  const w = NACELLE_HALF_WIDTH * 0.72;
  seams.push(
    [[ns - w, 8.2], [ns, 8.2 - w * SWEEP * 0.6]],
    [[ns, 8.2 - w * SWEEP * 0.6], [ns + w, 8.2]],
    [[ns - w, 12.6], [ns, 12.6 - w * SWEEP * 0.6]],
    [[ns, 12.6 - w * SWEEP * 0.6], [ns + w, 12.6]],
    [[ns - w, 8.2], [ns - w, 12.6]],
    [[ns + w, 8.2], [ns + w, 12.6]],
  );
  return seams;
}

/* ------------------------------------------------------------------------ */
/* Albedo                                                                    */
/* ------------------------------------------------------------------------ */

function mottle(ctx: Ctx, seed: number, cells: number, alpha: number, spread: number) {
  const r = rng(seed);
  const cw = Math.max(4, Math.round(cells));
  const ch = Math.max(2, Math.round(cells / 2));
  const small = document.createElement('canvas');
  small.width = cw;
  small.height = ch;
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(cw, ch);
  for (let i = 0; i < cw * ch; i++) {
    const v = 128 + (r() - 0.5) * 2 * spread;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v + (r() - 0.5) * spread * 0.3;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'overlay';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, W, H);
  ctx.restore();
}

function buildAlbedo(): HTMLCanvasElement {
  const [cv, ctx] = canvas();
  const r = rng(7);

  // Base coating: dark neutral grey with a faint cool cast.
  ctx.fillStyle = '#3d4045';
  ctx.fillRect(0, 0, W, H);

  // Large, soft coating variation (re-sprayed patches, weathering).
  mottle(ctx, 11, 18, 0.22, 60);
  mottle(ctx, 12, 70, 0.14, 50);
  mottle(ctx, 13, 260, 0.08, 50);

  // Slightly different panel tones.
  const panelTone = (pts: Pt[], tone: string, a: number) => {
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = tone;
    both((m) => {
      poly(ctx, pts, m);
      ctx.fill();
    });
    ctx.restore();
  };
  // Leading-edge treatment band.
  const le: Pt[] = [[0.3, 0.2], [HALF_SPAN - 0.5, (HALF_SPAN - 0.5) * SWEEP], [HALF_SPAN - 0.9, (HALF_SPAN - 0.9) * SWEEP + 0.25], [0.3, 0.95]];
  panelTone(le, '#5c6168', 0.55);
  // Outer-wing panels.
  panelTone([[9, 9 * SWEEP + 1], [16.2, 16.2 * SWEEP + 1], [16.2, 16.2 * SWEEP + 3.3], [9, 9 * SWEEP + 3.3]], '#3f4348', 0.35);
  panelTone([[19.6, 19.6 * SWEEP + 1], [23.4, 23.4 * SWEEP + 1], [23.4, 23.4 * SWEEP + 3.3], [19.6, 19.6 * SWEEP + 3.3]], '#555a61', 0.3);
  panelTone([[11.4, 11.4 * SWEEP + 3.3], [16.2, 16.2 * SWEEP + 3.3], [16.2, 16.2 * SWEEP + 5.6], [11.4, 11.4 * SWEEP + 5.6]], '#52575d', 0.25);
  // Nacelle access panels.
  const ns = NACELLE_S;
  const w = NACELLE_HALF_WIDTH * 0.72;
  panelTone([[ns - w, 8.2], [ns, 8.2 - w * SWEEP * 0.6], [ns + w, 8.2], [ns + w, 12.6], [ns, 12.6 - w * SWEEP * 0.6], [ns - w, 12.6]], '#42464c', 0.4);

  // Control surfaces: marginally darker, with hinge gaps.
  for (const cs of controlSurfaces()) {
    const tone = cs.kind === 'glas' ? '#474b51' : cs.kind === 'rudder' ? '#43474d' : '#45494f';
    panelTone(cs.pts, tone, 0.6);
  }

  // Exhaust troughs: heat-resistant tiles, lighter and warmer, sooted near the nozzles.
  both((m) => {
    const sgn = m ? -1 : 1;
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      const s = TROUGH_INNER + 0.1 + (TROUGH_OUTER - TROUGH_INNER - 0.2) * t;
      const cte = trailingEdgeC(s);
      const [x0, y0] = px(sgn * s, EXHAUST_C + 0.25);
      const [, y1] = px(sgn * s, cte);
      const grad = ctx.createLinearGradient(x0, y0, x0, y1);
      const streak = 0.85 + 0.3 * r();
      grad.addColorStop(0, '#2b2a28');
      grad.addColorStop(0.12, `rgba(92,88,80,${0.95 * streak})`);
      grad.addColorStop(0.6, `rgba(118,113,103,${0.9 * streak})`);
      grad.addColorStop(1, `rgba(96,92,86,${0.85 * streak})`);
      ctx.fillStyle = grad;
      const wpx = ((TROUGH_OUTER - TROUGH_INNER) / 39) * PX_PER_M + 1.5;
      ctx.fillRect(x0 - wpx / 2, y0, wpx, y1 - y0);
    }
    // Soot streaks along the flow.
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = '#1e1d1b';
    for (let i = 0; i < 18; i++) {
      const s = TROUGH_INNER + 0.3 + r() * (TROUGH_OUTER - TROUGH_INNER - 0.6);
      ctx.lineWidth = 2 + r() * 6;
      line(ctx, [sgn * s, EXHAUST_C + 0.3], [sgn * (s + (r() - 0.5) * 0.3), EXHAUST_C + 1.5 + r() * 3]);
    }
    ctx.restore();
  });

  // Nozzle exits: dark slots at the aft end of each nacelle.
  both((m) => {
    poly(ctx, [[TROUGH_INNER + 0.2, EXHAUST_C - 0.15], [TROUGH_OUTER - 0.25, EXHAUST_C - 0.15], [TROUGH_OUTER - 0.25, EXHAUST_C + 0.3], [TROUGH_INNER + 0.2, EXHAUST_C + 0.3]], m);
    ctx.fillStyle = '#0d0e10';
    ctx.fill();
  });

  // Engine inlets: dark ducts below a jagged lip.
  both((m) => {
    const n = 24;
    poly(ctx, inletPolygon(), m);
    ctx.fillStyle = '#08090a';
    ctx.fill();
    // Lip edge catches light.
    ctx.strokeStyle = '#6a6f76';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const s = NACELLE_S - NACELLE_HALF_WIDTH * 0.86 + (NACELLE_HALF_WIDTH * 1.72 * i) / n;
      const [x, y] = px(m ? -s : s, inletLipC(s) + 0.02);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Auxiliary intake doors on the nacelle crown.
    ctx.fillStyle = '#1a1c1f';
    poly(ctx, [[NACELLE_S - 0.75, 9.6], [NACELLE_S - 0.2, 9.6 - 0.25], [NACELLE_S - 0.2, 10.5], [NACELLE_S - 0.75, 10.75]], m);
    ctx.fill();
    poly(ctx, [[NACELLE_S + 0.2, 9.35], [NACELLE_S + 0.75, 9.6], [NACELLE_S + 0.75, 10.75], [NACELLE_S + 0.2, 10.5]], m);
    ctx.fill();
  });

  // Windscreen.
  both((m) => {
    for (const pane of WINDSCREEN) {
      poly(ctx, pane, m);
      ctx.fillStyle = '#07090c';
      ctx.fill();
      ctx.strokeStyle = '#2e3136';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });

  // Air-refuelling receptacle behind the cockpit.
  poly(ctx, [[-0.45, 6.6], [0.45, 6.6], [0.45, 7.7], [-0.45, 7.7]]);
  ctx.fillStyle = '#5a5f66';
  ctx.fill();
  poly(ctx, [[-0.16, 6.8], [0.16, 6.8], [0.16, 7.45], [-0.16, 7.45]]);
  ctx.fillStyle = '#16181b';
  ctx.fill();

  // Panel seams: thin, slightly darker lines.
  ctx.save();
  ctx.strokeStyle = 'rgba(28,30,33,0.32)';
  ctx.lineWidth = 1.4;
  for (const [a, b] of panelSeams()) both((m) => line(ctx, a, b, m));
  // Hinge lines and gaps between control surfaces.
  ctx.strokeStyle = 'rgba(20,21,24,0.8)';
  ctx.lineWidth = 2.2;
  for (const cs of controlSurfaces()) {
    ctx.beginPath();
    cs.pts.forEach(([s, c], i) => {
      const [x, y] = px(s, c);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    if (cs.kind !== 'glas') {
      ctx.beginPath();
      cs.pts.forEach(([s, c], i) => {
        const [x, y] = px(-s, c);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();

  // Fine speckle so the coating never reads as a flat fill up close.
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 6;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/* ------------------------------------------------------------------------ */
/* Packed data map: R = bump height, G = roughness, B = metalness            */
/* ------------------------------------------------------------------------ */

function buildDataMap(): HTMLCanvasElement {
  const [bumpCv, bump] = canvas();
  const [roughCv, rough] = canvas();
  const [metalCv, metal] = canvas();
  const r = rng(21);

  bump.fillStyle = g(0.5);
  bump.fillRect(0, 0, W, H);
  rough.fillStyle = g(0.46);
  rough.fillRect(0, 0, W, H);
  mottle(rough, 31, 40, 0.6, 40);
  mottle(rough, 32, 160, 0.4, 30);
  metal.fillStyle = g(0.12);
  metal.fillRect(0, 0, W, H);
  mottle(metal, 33, 30, 0.5, 30);

  // Leading edge: smoother, slightly glossier.
  const le: Pt[] = [[0.3, 0.2], [HALF_SPAN - 0.5, (HALF_SPAN - 0.5) * SWEEP], [HALF_SPAN - 0.9, (HALF_SPAN - 0.9) * SWEEP + 0.25], [0.3, 0.95]];
  both((m) => {
    poly(rough, le, m);
    rough.fillStyle = g(0.4);
    rough.fill();
  });

  // Troughs: rough ceramic tiles, with a tile grid in the bump channel.
  both((m) => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 16; i++) {
      const s = TROUGH_INNER + ((TROUGH_OUTER - TROUGH_INNER) * i) / 16;
      pts.push([s, trailingEdgeC(s)]);
    }
    pts.push([TROUGH_OUTER, EXHAUST_C], [TROUGH_INNER, EXHAUST_C]);
    poly(rough, pts, m);
    rough.fillStyle = g(0.74);
    rough.fill();
    poly(metal, pts, m);
    metal.fillStyle = g(0.35);
    metal.fill();
    bump.save();
    poly(bump, pts, m);
    bump.clip();
    bump.strokeStyle = g(0.32);
    bump.lineWidth = 1.2;
    for (let c = EXHAUST_C; c < 21; c += 0.32) line(bump, [-HALF_SPAN, c], [HALF_SPAN, c]);
    for (let s = TROUGH_INNER; s < TROUGH_OUTER; s += 0.32) line(bump, [m ? -s : s, EXHAUST_C], [m ? -s : s, 21]);
    bump.restore();
  });

  // Inlets and nozzles: matte, non-metallic, recessed.
  both((m) => {
    const pts = inletPolygon();
    for (const [ctx, v] of [[rough, 0.85], [metal, 0.0], [bump, 0.25]] as const) {
      poly(ctx, pts, m);
      ctx.fillStyle = g(v);
      ctx.fill();
    }
  });

  // Windscreen: smooth glass, raised frames.
  both((m) => {
    for (const pane of WINDSCREEN) {
      poly(rough, pane, m);
      rough.fillStyle = g(0.05);
      rough.fill();
      poly(metal, pane, m);
      metal.fillStyle = g(0.0);
      metal.fill();
      poly(bump, pane, m);
      bump.fillStyle = g(0.46);
      bump.fill();
      bump.strokeStyle = g(0.72);
      bump.lineWidth = 3;
      bump.stroke();
    }
  });

  // Panel seams and control-surface gaps as grooves.
  bump.strokeStyle = g(0.38);
  bump.lineWidth = 1.5;
  for (const [a, b] of panelSeams()) both((m) => line(bump, a, b, m));
  bump.strokeStyle = g(0.08);
  bump.lineWidth = 2.6;
  for (const cs of controlSurfaces()) {
    for (const m of cs.kind === 'glas' ? [false] : [false, true]) {
      poly(bump, cs.pts, m);
      bump.stroke();
    }
  }
  // Tiny fastener rows along the spar seams (felt more than seen).
  bump.fillStyle = g(0.4);
  for (const [a, b] of panelSeams()) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / 0.18);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      for (const m of [false, true]) {
        const [x, y] = px((m ? -1 : 1) * (a[0] + (b[0] - a[0]) * t + 0.07), a[1] + (b[1] - a[1]) * t + 0.07);
        bump.fillRect(x, y, 1.4, 1.4);
      }
    }
  }

  // Pack channels.
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d')!;
  const bd = bump.getImageData(0, 0, W, H).data;
  const rd = rough.getImageData(0, 0, W, H).data;
  const md = metal.getImageData(0, 0, W, H).data;
  const img = octx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = bd[i];
    d[i + 1] = Math.min(255, rd[i] + (r() - 0.5) * 10);
    d[i + 2] = md[i];
    d[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  void bumpCv;
  void roughCv;
  void metalCv;
  return out;
}

export interface B2Textures {
  albedo: Texture;
  data: Texture;
}

export function buildB2Textures(maxAnisotropy: number): B2Textures {
  const albedo = new CanvasTexture(buildAlbedo());
  albedo.colorSpace = SRGBColorSpace;
  const data = new CanvasTexture(buildDataMap());
  data.colorSpace = NoColorSpace;
  for (const t of [albedo, data]) t.anisotropy = Math.min(8, maxAnisotropy);
  return { albedo, data };
}
