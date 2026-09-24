import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three';

const FS_VERT = /* glsl */ `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Dual-filter downsample; the first pass also applies a soft bloom threshold. */
const DOWN_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  in vec2 vUv;
  vec3 prefilter(vec3 c) {
    if (uThreshold <= 0.0) return c;
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = rq * rq / (4.0 * uKnee + 1e-4);
    return c * max(rq, br - uThreshold) / max(br, 1e-4);
  }
  void main() {
    vec2 o = uTexel;
    vec3 c = texture(uSrc, vUv).rgb * 4.0;
    c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
    c += texture(uSrc, vUv + vec2( o.x, -o.y)).rgb;
    c += texture(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
    c += texture(uSrc, vUv + vec2( o.x,  o.y)).rgb;
    gl_FragColor = vec4(prefilter(c / 8.0), 1.0);
  }
`;

const UP_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uSrc;
  uniform sampler2D uBase;
  uniform vec2 uTexel;
  in vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 c = texture(uSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
    c += texture(uSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
    c += texture(uSrc, vUv + vec2(0.0, o.y * 2.0)).rgb;
    c += texture(uSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
    c += texture(uSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb;
    c += texture(uSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
    c += texture(uSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb;
    c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
    gl_FragColor = vec4(c / 12.0 + texture(uBase, vUv).rgb, 1.0);
  }
`;

const FINAL_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uExposure;
  uniform float uBloomStrength;
  uniform float uScrim;
  uniform float uTime;
  uniform vec2 uResolution;
  in vec2 vUv;

  vec3 rrtOdt(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 acesFilmic(vec3 c) {
    const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    return clamp(outM * rrtOdt(inM * (c / 0.6)), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec3 hdr = texture(uScene, vUv).rgb;
    hdr += texture(uBloom, vUv).rgb * uBloomStrength;

    vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
    vec2 cp = (vUv - 0.5) * aspect;
    float r = length(cp);

    // Grade: a touch of exposure pull behind the wordmark, weighted to the centre.
    float scrim = uScrim * (0.1 + 0.38 * (1.0 - smoothstep(0.0, 0.8, length(cp * vec2(0.75, 1.5)))));
    hdr *= uExposure * (1.0 - scrim);

    vec3 col = acesFilmic(hdr);
    // Gentle filmic contrast around mid-grey, a touch of richness, cool shadows.
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = clamp(mix(vec3(l), col, 1.07), 0.0, 1.0);
    col = clamp((col - 0.18) * 1.06 + 0.18, 0.0, 1.0);
    col = mix(col, col * vec3(0.95, 0.99, 1.06), (1.0 - l) * 0.4);
    // Optical vignette.
    col *= mix(1.0, 0.74, smoothstep(0.42, 1.25, r));

    col = toSRGB(col);
    // Fine animated grain in display space, strongest in the mid-tones.
    float g = hash(vUv * uResolution + fract(uTime * 7.31) * 113.0) - 0.5;
    col += g * 0.018 * (1.0 - abs(l - 0.5) * 1.4);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface GradeParams {
  exposure: number;
  bloomStrength: number;
  scrim: number;
  time: number;
}

/**
 * HDR render chain: scene → (MSAA HDR target) → bloom mips → tone-mapped,
 * graded output on the canvas.
 */
export class Pipeline {
  readonly sceneTarget: WebGLRenderTarget;
  private readonly bloomDown: WebGLRenderTarget[] = [];
  private readonly bloomUp: WebGLRenderTarget[] = [];
  private readonly fsScene = new Scene();
  private readonly fsCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fsMesh: Mesh;
  private readonly down: ShaderMaterial;
  private readonly up: ShaderMaterial;
  private readonly final: ShaderMaterial;
  private width = 1;
  private height = 1;

  constructor(samples: number) {
    const hdr = { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false } as const;
    this.sceneTarget = new WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: true, samples });
    for (let i = 0; i < 5; i++) {
      this.bloomDown.push(new WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: false }));
      this.bloomUp.push(new WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: false }));
    }
    const common = { vertexShader: FS_VERT, depthTest: false, depthWrite: false } as const;
    this.down = new ShaderMaterial({
      ...common,
      fragmentShader: DOWN_FRAG,
      uniforms: { uSrc: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: 0 }, uKnee: { value: 0.5 } },
    });
    this.up = new ShaderMaterial({
      ...common,
      fragmentShader: UP_FRAG,
      uniforms: { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new Vector2() } },
    });
    this.final = new ShaderMaterial({
      ...common,
      fragmentShader: FINAL_FRAG,
      uniforms: {
        uScene: { value: this.sceneTarget.texture },
        uBloom: { value: null },
        uExposure: { value: 1 },
        uBloomStrength: { value: 0.12 },
        uScrim: { value: 0 },
        uTime: { value: 0 },
        uResolution: { value: new Vector2(1, 1) },
      },
    });
    this.fsMesh = new Mesh(new PlaneGeometry(2, 2), this.final);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.sceneTarget.setSize(width, height);
    let w = width;
    let h = height;
    for (let i = 0; i < this.bloomDown.length; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.bloomDown[i].setSize(w, h);
      this.bloomUp[i].setSize(w, h);
    }
    this.final.uniforms.uResolution.value.set(width, height);
  }

  private pass(renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget | null) {
    this.fsMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.fsScene, this.fsCamera);
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, grade: GradeParams) {
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // Bloom: threshold + downsample chain, then tent upsample back up.
    let src: Texture = this.sceneTarget.texture;
    let sw = this.width;
    let sh = this.height;
    for (let i = 0; i < this.bloomDown.length; i++) {
      this.down.uniforms.uSrc.value = src;
      this.down.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      this.down.uniforms.uThreshold.value = i === 0 ? 1.1 : 0;
      this.pass(renderer, this.down, this.bloomDown[i]);
      src = this.bloomDown[i].texture;
      sw = this.bloomDown[i].width;
      sh = this.bloomDown[i].height;
    }
    const last = this.bloomDown.length - 1;
    src = this.bloomDown[last].texture;
    for (let i = last - 1; i >= 0; i--) {
      this.up.uniforms.uSrc.value = src;
      this.up.uniforms.uBase.value = this.bloomDown[i].texture;
      this.up.uniforms.uTexel.value.set(1 / this.bloomDown[i + 1].width, 1 / this.bloomDown[i + 1].height);
      this.pass(renderer, this.up, this.bloomUp[i]);
      src = this.bloomUp[i].texture;
    }

    const u = this.final.uniforms;
    u.uBloom.value = src;
    u.uExposure.value = grade.exposure;
    u.uBloomStrength.value = grade.bloomStrength;
    u.uScrim.value = grade.scrim;
    u.uTime.value = grade.time;
    this.pass(renderer, this.final, null);
  }

  dispose() {
    this.sceneTarget.dispose();
    for (const t of [...this.bloomDown, ...this.bloomUp]) t.dispose();
    this.down.dispose();
    this.up.dispose();
    this.final.dispose();
    this.fsMesh.geometry.dispose();
  }
}
