import {
  CustomBlending,
  DataTexture,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  AddEquation,
  BufferAttribute,
  ShaderMaterial,
  Vector3,
  type Camera,
} from 'three';
import { ATMOSPHERE } from '../environment/atmosphere';
import { FLIGHT, airOffset, createSample, sampleFlight, type Vec3 } from '../shot/flight';

/**
 * Contrails as soft, lit particles that live in the air mass.
 *
 * Each particle stores where (air frame) and when it was shed from an engine.
 * The vertex shader derives everything else from the particle's age: it
 * condenses a short distance behind the aircraft, drifts with the wake (pairs
 * of plumes merge, the trail sinks slightly), spreads, and slowly thins out.
 * Nothing is simulated on the CPU per frame, and any time can be rendered
 * exactly.
 */

export interface ContrailOptions {
  /** Engine exhaust positions in the aircraft's local frame. */
  exhausts: Vector3[];
  /** Subject scale (see computeFraming): contrail geometry scales with the aircraft. */
  scale: number;
  /** Emission window in shot time. */
  from?: number;
  to?: number;
  /** Seconds between particles per engine. */
  spacing?: number;
}

const VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uAir;
  uniform float uScale;
  attribute vec4 aEmit;    // xyz: air-frame position, w: emission time
  attribute vec4 aSeed;    // random 0..1
  attribute vec3 aMerge;   // offset towards the plume pair centre (air frame)
  varying vec2 vUv;
  varying float vAlpha;
  varying float vRot;
  varying float vAge;
  varying vec3 vViewPos;

  void main() {
    float age = uTime - aEmit.w;
    vUv = position.xy * 0.5 + 0.5;
    if (age <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      return;
    }
    // Wake dynamics: plumes are drawn into the wingtip-vortex pair and sink.
    float merge = 1.0 - exp(-age / 1.1);
    float te = aEmit.w;
    // Slow meander of the ageing trail (vortex-pair instability), shared by neighbours.
    vec3 meander = vec3(sin(te * 4.1 + 1.3), 0.6 * sin(te * 3.3 + 0.2), cos(te * 3.7)) * 0.9 * age;
    vec3 turb = (aSeed.xyz - 0.5) * vec3(1.0, 0.8, 1.0) * (0.3 + 2.6 * sqrt(age));
    vec3 air = aEmit.xyz + (aMerge * merge + (turb + meander + vec3(0.0, -1.1 * age, 0.0)) * uScale);
    vec3 ship = air - uAir;

    // Radius grows quickly as the plume mixes, then diffuses slowly.
    float radius = uScale * mix(0.7, 1.45, aSeed.w) * (0.5 + 1.8 * sqrt(age) + 0.7 * age);

    // Condensation happens a little behind the engines, then the trail thins.
    float condense = smoothstep(0.05, 0.2, age);
    float fade = exp(-age / 3.0);
    // Keep the column mass roughly constant as it spreads.
    float thin = 1.2 / (1.2 + radius / uScale);
    // Lumpy condensation along the trail: puffs every ~15-25 m.
    float lump = 0.5 + 0.5 * sin(te * 31.0 + aSeed.y * 1.5) * sin(te * 19.0 + 2.0) + 0.25 * sin(te * 57.0);
    lump = clamp(0.45 + 0.65 * lump, 0.2, 1.2);
    vAlpha = condense * fade * thin * lump * mix(0.5, 1.0, aSeed.y);
    vRot = aSeed.x * 6.2831 + age * (aSeed.z - 0.5) * 0.8;
    vAge = age;

    vec4 mv = modelViewMatrix * vec4(ship, 1.0);
    float c = cos(vRot), s = sin(vRot);
    vec2 corner = mat2(c, s, -s, c) * position.xy;
    mv.xy += corner * radius;
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uPuff;
  uniform vec3 uSunView;
  uniform vec3 uSun;
  uniform vec3 uAmb;
  uniform vec3 uHaze;
  uniform float uHazeDensity;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vRot;
  varying float vAge;
  varying vec3 vViewPos;

  void main() {
    if (vAlpha <= 0.001) discard;
    vec4 puff = texture2D(uPuff, vUv);
    float d = puff.r * vAlpha * uOpacity;
    if (d < 0.002) discard;
    // Treat each puff as a small sphere for a soft sun-facing gradient.
    vec2 q = vUv * 2.0 - 1.0;
    vec3 n = normalize(vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))) + 0.35));
    float lambert = clamp(dot(n, uSunView) * 0.5 + 0.5, 0.0, 1.0);
    float forward = pow(max(dot(normalize(-vViewPos), -uSunView), 0.0), 6.0);
    vec3 col = uSun * (0.24 + 0.3 * lambert + 0.3 * forward) + uAmb * (0.55 + 0.35 * puff.g);
    float fog = 1.0 - exp(-length(vViewPos) * uHazeDensity);
    col = mix(col, uHaze, fog);
    gl_FragColor = vec4(col * d, d);
  }
`;

/** Soft, irregular puff sprite (R: density, G: internal variation). */
function createPuffTexture(): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  // Small value-noise fbm, deterministic.
  const grid = 16;
  const rnd = new Float32Array((grid + 1) * (grid + 1) * 2);
  let seed = 1337;
  for (let i = 0; i < rnd.length; i++) {
    seed = (seed * 16807) % 2147483647;
    rnd[i] = seed / 2147483647;
  }
  const vnoise = (x: number, y: number, layer: number) => {
    const xi = Math.floor(x) % grid;
    const yi = Math.floor(y) % grid;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const at = (i: number, j: number) => rnd[(((j % grid) * (grid + 1) + (i % grid)) * 2 + layer) % rnd.length];
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const r = Math.hypot(nx - 0.5, ny - 0.5) * 2;
      let n = 0;
      let amp = 0.5;
      let f = 3;
      for (let o = 0; o < 4; o++) {
        n += amp * vnoise(nx * f, ny * f, 0);
        amp *= 0.5;
        f *= 2;
      }
      const falloff = Math.max(0, 1 - r * r);
      const dens = Math.max(0, falloff * falloff * (0.35 + 0.9 * n) - 0.08);
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, dens * 255);
      data[i + 1] = Math.min(255, vnoise(nx * 6, ny * 6, 1) * 255);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class Contrails {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly puff: DataTexture;
  private readonly viewMatrix3 = new Matrix4();
  private readonly sunView = new Vector3();

  constructor() {
    const geometry = new InstancedBufferGeometry();
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    geometry.setAttribute('position', new BufferAttribute(quad, 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.puff = createPuffTexture();
    const a = ATMOSPHERE;
    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      uniforms: {
        uTime: { value: 0 },
        uAir: { value: new Vector3() },
        uScale: { value: 1 },
        uPuff: { value: this.puff },
        uSunView: { value: new Vector3() },
        uSun: { value: a.sunColor.clone().multiplyScalar(a.sunIntensity) },
        uAmb: { value: a.skyAmbient.clone().multiplyScalar(1.1) },
        uHaze: { value: a.haze },
        uHazeDensity: { value: a.hazeDensity },
        uOpacity: { value: 0.85 },
      },
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  /** (Re)builds the particle set for the flight path at the given subject scale. */
  build({ exhausts, scale, from = FLIGHT.tMin + 0.4, to = 3.3, spacing = 1 / 190 }: ContrailOptions) {
    const count = Math.floor((to - from) / spacing) * exhausts.length;
    const emit = new Float32Array(count * 4);
    const seed = new Float32Array(count * 4);
    const merge = new Float32Array(count * 3);
    const sample = createSample();
    const off: Vec3 = [0, 0, 0];
    // Plume pair centres (engines on the same side merge together).
    const pairCentre = (e: Vector3) => {
      let sx = 0;
      let n = 0;
      for (const o of exhausts) if (Math.sign(o.x) === Math.sign(e.x)) (sx += o.x), n++;
      return sx / n;
    };
    let rs = 99991;
    const rnd = () => {
      rs = (rs * 48271) % 2147483647;
      return rs / 2147483647;
    };
    let k = 0;
    for (let t = from; k < count; t += spacing) {
      sampleFlight(t, sample, 0);
      airOffset(t, off);
      const [px, py, pz] = sample.position;
      const [lx, ly, lz] = sample.right;
      const [ux, uy, uz] = sample.up;
      const [fx, fy, fz] = sample.forward;
      for (const e of exhausts) {
        if (k >= count) break;
        const ex = e.x * scale;
        const ey = e.y * scale;
        const ez = e.z * scale;
        emit[k * 4] = px + lx * ex + ux * ey + fx * ez + off[0];
        emit[k * 4 + 1] = py + ly * ex + uy * ey + fy * ez + off[1];
        emit[k * 4 + 2] = pz + lz * ex + uz * ey + fz * ez + off[2];
        emit[k * 4 + 3] = t;
        const dx = (pairCentre(e) - e.x) * scale * 0.85;
        merge[k * 3] = lx * dx;
        merge[k * 3 + 1] = ly * dx;
        merge[k * 3 + 2] = lz * dx;
        seed[k * 4] = rnd();
        seed[k * 4 + 1] = rnd();
        seed[k * 4 + 2] = rnd();
        seed[k * 4 + 3] = rnd();
        k++;
      }
    }
    const g = this.mesh.geometry;
    g.setAttribute('aEmit', new InstancedBufferAttribute(emit, 4));
    g.setAttribute('aSeed', new InstancedBufferAttribute(seed, 4));
    g.setAttribute('aMerge', new InstancedBufferAttribute(merge, 3));
    g.instanceCount = count;
    this.mesh.material.uniforms.uScale.value = scale;
  }

  update(time: number, air: Vector3, camera: Camera) {
    const u = this.mesh.material.uniforms;
    u.uTime.value = time;
    u.uAir.value.copy(air);
    this.viewMatrix3.copy(camera.matrixWorldInverse);
    this.sunView.copy(ATMOSPHERE.sunDir).transformDirection(this.viewMatrix3);
    u.uSunView.value.copy(this.sunView);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.puff.dispose();
  }
}
