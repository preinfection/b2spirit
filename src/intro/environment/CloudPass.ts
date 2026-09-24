import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { ATMOSPHERE } from './atmosphere';

/**
 * Volumetric cloud sea, raymarched at reduced resolution into an HDR target.
 *
 * The layer is a heightfield-driven density (cheap empty-space skipping above
 * the tops) whose upper shell is eroded by 3D noise into billows. Lighting uses
 * a short march towards the sun for self-shadowing, a multiple-scattering
 * approximation, a dual-lobe phase function, sky/bounce ambient that darkens
 * with depth, and aerial perspective towards the distance.
 */

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler2D uNoise2D;
uniform sampler3D uNoise3D;
uniform mat4 uCamWorld;
uniform mat4 uProjInv;
uniform vec3 uCamPos;
uniform vec3 uAir;
uniform float uTime;
uniform float uPixelAngle;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uSkyAmb;
uniform vec3 uBounce;
uniform vec3 uHaze;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uHazeDensity;

in vec2 vUv;

const float TOP_MAX = -330.0;
const float DECK = -720.0;
const float BASE = -1550.0;
const float SIGMA = 0.055;
const float SIGMA_LIGHT = 0.075;
const float PI = 3.14159265;

float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

float lodFor(float dist, float scale) {
  // Texture footprint vs. pixel footprint: keeps distant cloud detail alias-free.
  float texel = scale / 512.0;
  return max(0.0, log2(max(dist * uPixelAngle, 1e-3) / texel));
}

// Height of the cloud tops (metres, ship-frame y) at an air-frame position.
float cloudTop(vec2 p, float dist, out float cluster) {
  vec4 a = textureLod(uNoise2D, p / 7000.0, lodFor(dist, 7000.0));
  vec4 b = textureLod(uNoise2D, p / 2600.0 + vec2(0.37, 0.11), lodFor(dist, 2600.0));
  vec4 c = textureLod(uNoise2D, p / 900.0 + vec2(0.71, 0.53), lodFor(dist, 900.0));
  // Where cumulus clusters build up (vs. flatter, lower deck in between).
  cluster = smoothstep(0.36, 0.72, b.b * 0.7 + a.b * 0.5 - 0.1);
  float h = DECK;
  h += (a.r - 0.5) * 900.0;                           // regional swell and deep troughs
  h += (b.g - 0.35) * mix(70.0, 360.0, cluster);      // big cumulus heads, mostly in clusters
  h += (c.a - 0.45) * mix(30.0, 95.0, cluster);       // turrets on the heads
  h += (c.r - 0.5) * 40.0;
  return h;
}

float densityAt(vec3 p, float h, float cluster, float detail) {
  float depth = h - p.y;
  float d = smoothstep(-4.0, 34.0, depth);
  d *= smoothstep(BASE, BASE + 450.0, p.y);
  if (detail > 0.0 && depth < 150.0) {
    vec3 q = p / 460.0 + vec3(uTime * 0.0025, uTime * 0.004, 0.0);
    vec4 n = texture(uNoise3D, q);
    vec4 m = texture(uNoise3D, p / 140.0 + vec3(0.0, uTime * 0.01, 0.0));
    float shell = 1.0 - smoothstep(0.0, 150.0, depth);
    float erosion = (n.r * 0.7 + m.g * 0.45) * shell * detail * mix(0.55, 1.0, cluster);
    d = clamp((d - erosion * 0.8) / max(1.0 - erosion * 0.8, 0.05), 0.0, 1.0);
  }
  return d;
}

float coarseDensity(vec3 p, float dist) {
  float cl;
  float h = cloudTop(p.xz, dist, cl);
  float depth = h - p.y;
  return smoothstep(-6.0, 40.0, depth) * smoothstep(BASE, BASE + 450.0, p.y);
}

vec3 hazeColor(vec3 rd) {
  float mu = dot(rd, uSunDir);
  return uHaze + uSun * (0.06 * hg(mu, 0.75) + 0.02);
}

vec3 skyColor(vec3 rd) {
  float mu = dot(rd, uSunDir);
  vec3 c = mix(uHorizon, uZenith, pow(clamp(rd.y, 0.0, 1.0), 0.45));
  return c + uSun * (0.05 * pow(max(mu, 0.0), 8.0) + 0.012);
}

// Interleaved gradient noise: stable per-pixel jitter to hide step banding.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 view = uProjInv * ndc;
  vec3 rd = normalize((uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz);
  vec3 ro = uCamPos;

  if (rd.y > -0.004) {
    gl_FragColor = vec4(mix(hazeColor(rd), skyColor(rd), smoothstep(0.0, 0.08, rd.y)), 1.0);
    return;
  }

  float tEnter = max((TOP_MAX - ro.y) / rd.y, 0.0);
  float tExit = (BASE - ro.y) / rd.y;
  float tMax = min(tExit, 26000.0);
  float horizontal = length(rd.xz);
  float mu = dot(rd, uSunDir);

  float T = 1.0;
  vec3 L = vec3(0.0);
  float depthSum = 0.0;
  float weightSum = 0.0;
  float t = tEnter + ign(gl_FragCoord.xy) * 6.0;

  for (int i = 0; i < 110; i++) {
    if (t > tMax || T < 0.02) break;
    vec3 p = ro + rd * t;
    vec3 pa = p + uAir;
    float cluster;
    float h = cloudTop(pa.xz, t, cluster);
    float above = p.y - h;
    if (above > 22.0) {
      // Empty-space skip, bounded by the heightfield's steepest slope.
      t += max(above / (-rd.y + 1.7 * horizontal) * 0.85, 6.0);
      continue;
    }
    float detail = 1.0 - smoothstep(3500.0, 9000.0, t);
    float dens = densityAt(pa, h, cluster, detail);
    float dt = mix(7.0, 55.0, smoothstep(600.0, 9000.0, t));
    if (dens > 0.002) {
      // Light march towards the sun for self-shadowing by neighbouring heads.
      float tau = 0.0;
      float prev = 0.0;
      for (int j = 0; j < 5; j++) {
        float lt = 10.0 * pow(2.2, float(j));
        vec3 q = pa + uSunDir * lt;
        tau += coarseDensity(q, t + lt) * (lt - prev);
        prev = lt;
      }
      tau *= SIGMA_LIGHT;
      // Multiple-scattering approximation (decreasing extinction per octave).
      float sunT = 0.0;
      float a = 1.0, b = 1.0, c = 1.0;
      for (int o = 0; o < 3; o++) {
        sunT += a * exp(-b * tau) * mix(hg(mu, 0.62 * c), hg(mu, -0.18 * c), 0.35) * 4.0 * PI;
        a *= 0.45; b *= 0.4; c *= 0.6;
      }
      float depthBelowTop = max(h - p.y, 0.0);
      vec3 amb = uSkyAmb * mix(0.12, 1.0, exp(-depthBelowTop / 70.0)) + uBounce * 0.3 * (1.0 - exp(-depthBelowTop / 300.0));
      // Powder term: sunlit edges read brighter than their dense interiors.
      float powder = 1.0 - 0.3 * exp(-dens * 3.0);
      vec3 S = uSun * sunT * 0.36 * powder + amb;
      float sigma = dens * SIGMA;
      float Tstep = exp(-sigma * dt);
      L += T * S * (1.0 - Tstep);
      float w = T * (1.0 - Tstep);
      depthSum += w * t;
      weightSum += w;
      T *= Tstep;
    }
    t += dt;
  }

  vec3 haze = hazeColor(rd);
  vec3 col = vec3(0.0);
  if (weightSum > 1e-4) {
    float dC = depthSum / weightSum;
    float fogC = exp(-dC * uHazeDensity);
    col = L * fogC + haze * (1.0 - fogC) * (1.0 - T);
  }
  if (t >= tExit) {
    // The ray slipped through a gap: shadowed haze over the distant surface below.
    float dB = tExit + 5000.0;
    float fogB = exp(-dB * uHazeDensity * 0.8);
    col += T * mix(vec3(0.05, 0.08, 0.12), haze * 0.45, 1.0 - fogB);
  } else {
    // Step budget or range exhausted near the horizon: distant cloud dissolves into haze.
    col += T * haze;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export class CloudPass {
  readonly target: WebGLRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: Mesh;

  constructor(noise2D: Texture, noise3D: Texture) {
    this.target = new WebGLRenderTarget(4, 4, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const a = ATMOSPHERE;
    this.material = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uNoise2D: { value: noise2D },
        uNoise3D: { value: noise3D },
        uCamWorld: { value: new Matrix4() },
        uProjInv: { value: new Matrix4() },
        uCamPos: { value: new Vector3() },
        uAir: { value: new Vector3() },
        uTime: { value: 0 },
        uPixelAngle: { value: 0.001 },
        uSunDir: { value: a.sunDir },
        uSun: { value: a.sunColor.clone().multiplyScalar(a.sunIntensity) },
        uSkyAmb: { value: a.skyAmbient },
        uBounce: { value: a.bounceAmbient },
        uHaze: { value: a.haze },
        uZenith: { value: a.skyZenith },
        uHorizon: { value: a.skyHorizon },
        uHazeDensity: { value: a.hazeDensity },
      },
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: FRAG,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  setSize(width: number, height: number) {
    this.target.setSize(width, height);
  }

  render(renderer: WebGLRenderer, camera: PerspectiveCamera, air: Vector3, time: number) {
    const u = this.material.uniforms;
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uAir.value.copy(air);
    u.uTime.value = time;
    u.uPixelAngle.value = (2 * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / this.target.height;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
