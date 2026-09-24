import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGL3DRenderTarget,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';

/** Tileable gradient and cellular noise, shared by both bakes. */
const NOISE_GLSL = /* glsl */ `
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  vec3 grad(vec3 cell, float period, float seed) {
    return normalize(hash33(mod(cell, period) + seed * 17.13) * 2.0 - 1.0);
  }
  float perlin(vec3 p, float period, float seed) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(grad(i + vec3(0,0,0), period, seed), f - vec3(0,0,0));
    float n100 = dot(grad(i + vec3(1,0,0), period, seed), f - vec3(1,0,0));
    float n010 = dot(grad(i + vec3(0,1,0), period, seed), f - vec3(0,1,0));
    float n110 = dot(grad(i + vec3(1,1,0), period, seed), f - vec3(1,1,0));
    float n001 = dot(grad(i + vec3(0,0,1), period, seed), f - vec3(0,0,1));
    float n101 = dot(grad(i + vec3(1,0,1), period, seed), f - vec3(1,0,1));
    float n011 = dot(grad(i + vec3(0,1,1), period, seed), f - vec3(0,1,1));
    float n111 = dot(grad(i + vec3(1,1,1), period, seed), f - vec3(1,1,1));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  }
  float perlinFbm(vec3 p, float period, int octaves, float seed) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int o = 0; o < 8; o++) {
      if (o >= octaves) break;
      sum += amp * perlin(p, period, seed + float(o));
      norm += amp;
      p *= 2.0; period *= 2.0; amp *= 0.5;
    }
    return sum / norm;
  }
  // Distance to the nearest feature point (cell units).
  float worley(vec3 p, float period, float seed) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    float d = 1e9;
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 o = vec3(float(x), float(y), float(z));
      vec3 r = o + hash33(mod(i + o, period) + seed * 31.7) - f;
      d = min(d, dot(r, r));
    }
    return sqrt(d);
  }
  // 2D variant (z fixed), cheaper for the heightfield bake.
  float worley2(vec2 p, float period, float seed) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d = 1e9;
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + hash33(vec3(mod(i + o, period), seed * 31.7)).xy - f;
      d = min(d, dot(r, r));
    }
    return sqrt(d);
  }
  // Rounded cumulus "dome": 1 at a cell centre, 0 at its rim.
  float dome(vec2 p, float period, float seed) {
    float d = worley2(p * period, period, seed);
    return sqrt(clamp(1.0 - d * d * 1.35, 0.0, 1.0));
  }
`;

const VERT = /* glsl */ `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function fullscreen(material: ShaderMaterial) {
  const scene = new Scene();
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1), mesh };
}

/**
 * 2D heightfield noise (tileable, mipmapped):
 *  R: broad perlin fbm (regional swell / coverage)
 *  G: multi-scale cumulus domes (cellular)
 *  B: second perlin fbm (variation)
 *  A: fine domes
 */
export function bakeNoise2D(renderer: WebGLRenderer, size = 512): WebGLRenderTarget {
  const target = new WebGLRenderTarget(size, size, {
    type: HalfFloatType,
    format: RGBAFormat,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
  });
  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vUv;
        float r = perlinFbm(vec3(p * 5.0, 0.5), 5.0, 6, 1.0) * 0.5 + 0.5;
        float g = dome(p, 6.0, 2.0) * 0.55 + dome(p + 0.37, 12.0, 3.0) * 0.3 + dome(p + 0.71, 24.0, 4.0) * 0.15;
        float b = perlinFbm(vec3(p * 4.0, 1.5), 4.0, 5, 7.0) * 0.5 + 0.5;
        float a = dome(p, 16.0, 5.0) * 0.6 + dome(p + 0.13, 32.0, 6.0) * 0.4;
        gl_FragColor = vec4(r, g, b, a);
      }
    `,
  });
  const fs = fullscreen(material);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(fs.scene, fs.camera);
  renderer.setRenderTarget(prev);
  fs.mesh.geometry.dispose();
  material.dispose();
  return target;
}

/**
 * 3D detail noise (tileable) for eroding cloud edges into billows and wisps:
 *  R: perlin-worley (billowy)
 *  G: worley fbm (fine cauliflower detail)
 */
export function bakeNoise3D(renderer: WebGLRenderer, size = 64): WebGL3DRenderTarget {
  const target = new WebGL3DRenderTarget(size, size, size, { depthBuffer: false });
  const tex = target.texture;
  tex.type = UnsignedByteType;
  tex.format = RGBAFormat;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;

  const material = new ShaderMaterial({
    uniforms: { uZ: { value: 0 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uZ;
      in vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        vec3 p = vec3(vUv, uZ);
        float pn = perlinFbm(p * 4.0, 4.0, 4, 11.0) * 0.5 + 0.5;
        float w1 = 1.0 - worley(p * 4.0, 4.0, 12.0);
        float w2 = 1.0 - worley(p * 8.0, 8.0, 13.0);
        float w3 = 1.0 - worley(p * 16.0, 16.0, 14.0);
        float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
        // Perlin-worley: perlin remapped by inverted worley fbm, giving rounded,
        // connected billows (as used for production cloud shapes).
        float pw = clamp((pn - (wf - 1.0)) / (2.0 - wf), 0.0, 1.0);
        pw = clamp((pw - 0.35) / 0.6, 0.0, 1.0);
        float w4 = 1.0 - worley(p * 12.0, 12.0, 15.0);
        float w5 = 1.0 - worley(p * 24.0, 24.0, 16.0);
        float fine = w2 * 0.5 + w4 * 0.3 + w5 * 0.2;
        gl_FragColor = vec4(pw, fine, pn, 1.0);
      }
    `,
  });
  const fs = fullscreen(material);
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < size; z++) {
    material.uniforms.uZ.value = (z + 0.5) / size;
    renderer.setRenderTarget(target, z);
    renderer.render(fs.scene, fs.camera);
  }
  renderer.setRenderTarget(prev);
  fs.mesh.geometry.dispose();
  material.dispose();
  return target;
}
