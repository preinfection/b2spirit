import { BufferAttribute, BufferGeometry } from 'three';
import { HALF_SPAN, TE_KINKS, leadingEdgeC, lowerDepth, trailingEdgeC, upperHeight } from './planform';

/**
 * Model space: +Z is forward (nose), +Y is up, +X is the aircraft's left wing.
 * Planform chord position c maps to z = Z_REF - c, so the origin sits roughly
 * at the centre of lift and the aircraft rotates about a believable point.
 */
export const Z_REF = 11.5;

/** Texture-space extents shared with the procedural textures. */
export const UV_SPAN = HALF_SPAN * 2;
export const UV_CHORD = 21.3;

function spanStations(): number[] {
  const half: number[] = [];
  let s = 0;
  while (s < HALF_SPAN - 1e-6) {
    half.push(s);
    s += s < 7.4 ? 0.075 : s < 15 ? 0.16 : 0.2;
  }
  // Snap the nearest station onto each trailing-edge kink so every sawtooth
  // vertex lands exactly on a mesh column.
  for (const k of TE_KINKS) {
    let best = 0;
    for (let i = 1; i < half.length; i++) if (Math.abs(half[i] - k) < Math.abs(half[best] - k)) best = i;
    if (Math.abs(half[best] - k) < 0.05) half[best] = k;
    else half.push(k);
  }
  half.sort((a, b) => a - b);
  const full: number[] = [];
  for (let i = half.length - 1; i > 0; i--) full.push(-half[i]);
  return full.concat(half);
}

function chordStations(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    // Mildly denser towards the leading edge, where curvature is highest.
    out.push(0.6 * x + 0.4 * x * x);
  }
  return out;
}

/**
 * Builds the B-2 skin as two structured grids (upper and lower surface) that
 * share their leading and trailing edges, giving a closed, crease-free shell.
 */
export function buildB2Geometry(chordSamples = 190): BufferGeometry {
  const span = spanStations();
  const chord = chordStations(chordSamples);
  const ns = span.length;
  const nc = chord.length;
  const vertsPerSurface = ns * nc;

  const position = new Float32Array(vertsPerSurface * 2 * 3);
  const uv = new Float32Array(vertsPerSurface * 2 * 2);

  for (let surface = 0; surface < 2; surface++) {
    for (let i = 0; i < ns; i++) {
      const s = span[i];
      const cle = leadingEdgeC(s);
      const cte = trailingEdgeC(s);
      for (let j = 0; j < nc; j++) {
        const c = cle + (cte - cle) * chord[j];
        const y = surface === 0 ? upperHeight(s, c) : -lowerDepth(s, c);
        const v = surface * vertsPerSurface + i * nc + j;
        position[v * 3] = s;
        position[v * 3 + 1] = y;
        position[v * 3 + 2] = Z_REF - c;
        uv[v * 2] = (s + HALF_SPAN) / UV_SPAN;
        uv[v * 2 + 1] = 1 - c / UV_CHORD;
      }
    }
  }

  const quads = (ns - 1) * (nc - 1);
  const index = new Uint32Array(quads * 6 * 2);
  let k = 0;
  for (let surface = 0; surface < 2; surface++) {
    const base = surface * vertsPerSurface;
    for (let i = 0; i < ns - 1; i++) {
      for (let j = 0; j < nc - 1; j++) {
        const a = base + i * nc + j;
        const b = base + (i + 1) * nc + j;
        const c = a + 1;
        const d = b + 1;
        // Upper skin faces +Y, lower skin faces -Y.
        if (surface === 0) {
          index[k++] = a; index[k++] = b; index[k++] = c;
          index[k++] = b; index[k++] = d; index[k++] = c;
        } else {
          index[k++] = a; index[k++] = c; index[k++] = b;
          index[k++] = b; index[k++] = c; index[k++] = d;
        }
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
