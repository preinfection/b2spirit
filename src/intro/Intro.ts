import {
  DirectionalLight,
  Matrix4,
  Mesh,
  PCFSoftShadowMap,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  type WebGL3DRenderTarget,
  type WebGLRenderTarget,
} from 'three';
import { B2, B2_WINGSPAN } from './aircraft/B2';
import { Contrails } from './contrails/Contrails';
import { ATMOSPHERE } from './environment/atmosphere';
import { CloudPass } from './environment/CloudPass';
import { createEnvironmentMap } from './environment/envMap';
import { bakeNoise2D, bakeNoise3D } from './environment/noiseBake';
import { Overlay } from './overlay';
import { Pipeline } from './render/Pipeline';
import { CameraRig } from './shot/cameraRig';
import { FLIGHT, airOffset, createSample, sampleFlight, type Vec3 } from './shot/flight';
import { INTRO_END, TIMELINE, smoothstep } from './timeline';

/** Where in the (endless) cloud field the shot takes place; picked for composition. */
const CLOUD_ORIGIN = new Vector3(2600, 0, -1400);

/** Pixel budgets keep fill-rate sane on 4K / high-DPI displays. */
const MAX_SCENE_PIXELS = 4.2e6;
const MAX_CLOUD_PIXELS = 0.8e6;

export interface IntroOptions {
  root: HTMLElement;
  /** The landing page underneath (made inert while covered, gently settles on reveal). */
  page?: HTMLElement | null;
  /** Dev capture mode: no clock, frames are rendered on demand via seek(). */
  manual?: boolean;
  onComplete?: () => void;
}

export class Intro {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly rig: CameraRig;
  private readonly b2: B2;
  private readonly sun: DirectionalLight;
  private readonly contrails = new Contrails();
  private readonly clouds: CloudPass;
  private readonly pipeline: Pipeline;
  private readonly overlay: Overlay;
  private readonly background: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly noise2D: WebGLRenderTarget;
  private readonly noise3D: WebGL3DRenderTarget;
  private readonly env: WebGLRenderTarget;
  private readonly flight = createSample();
  private readonly air = new Vector3();
  private readonly cloudAir = new Vector3();
  private readonly airTmp: Vec3 = [0, 0, 0];
  private readonly basis = new Matrix4();
  private readonly resizeObserver: ResizeObserver;

  private subjectScale = 1;
  private cloudScale = 0.55;
  private raf = 0;
  private lastNow = -1;
  private time = 0;
  private slowFrames = 0;
  private frameCount = 0;
  private disposed = false;
  private readonly marked = new Set<string>();

  constructor(private readonly options: IntroOptions) {
    const canvas = options.root.querySelector('canvas');
    if (!canvas) throw new Error('Intro: missing canvas');

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // MSAA happens in the HDR scene target
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    const gl = this.renderer.getContext();
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      this.renderer.dispose();
      throw new Error('Intro: HDR render targets unsupported');
    }
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    const { width, height } = this.viewportSize();
    this.rig = new CameraRig(width / height);

    this.noise2D = bakeNoise2D(this.renderer);
    this.noise3D = bakeNoise3D(this.renderer);
    this.env = createEnvironmentMap(this.renderer);

    this.b2 = new B2(this.env.texture, this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.b2.object);

    this.sun = new DirectionalLight(ATMOSPHERE.sunColor, ATMOSPHERE.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.sun, this.sun.target);

    this.clouds = new CloudPass(this.noise2D.texture, this.noise3D.texture);
    this.background = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
          depthTest: false,
        depthWrite: false,
        uniforms: { uClouds: { value: this.clouds.target.texture } },
        vertexShader: /* glsl */ `
          out vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D uClouds;
          in vec2 vUv;
          void main() { gl_FragColor = vec4(texture(uClouds, vUv).rgb, 1.0); }
        `,
      }),
    );
    this.background.frustumCulled = false;
    this.background.renderOrder = -1000;
    this.scene.add(this.background);
    this.scene.add(this.contrails.mesh);

    this.pipeline = new Pipeline(width * height * this.pixelRatio(width, height) ** 2 <= 2.6e6 ? 4 : 2);
    this.overlay = new Overlay(options.root, options.page ?? null);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.root);
  }

  private viewportSize() {
    const r = this.options.root;
    return { width: Math.max(1, r.clientWidth || innerWidth), height: Math.max(1, r.clientHeight || innerHeight) };
  }

  private pixelRatio(width: number, height: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.min(dpr, Math.sqrt(MAX_SCENE_PIXELS / (width * height)));
  }

  private resize() {
    if (this.disposed) return;
    const { width, height } = this.viewportSize();
    const pr = this.pixelRatio(width, height);
    const w = Math.round(width * pr);
    const h = Math.round(height * pr);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.pipeline.setSize(w, h);

    const cloudW = width * this.cloudScale;
    const cloudH = height * this.cloudScale;
    const k = Math.min(1, Math.sqrt(MAX_CLOUD_PIXELS / (cloudW * cloudH)));
    this.clouds.setSize(Math.max(2, Math.round(cloudW * k)), Math.max(2, Math.round(cloudH * k)));

    const framing = this.rig.setAspect(width / height);
    if (framing.subjectScale !== this.subjectScale || this.frameCount === 0) {
      this.subjectScale = framing.subjectScale;
      this.b2.object.scale.setScalar(this.subjectScale);
      this.contrails.build({ exhausts: this.b2.exhausts, scale: this.subjectScale });
    }
    // Keep the current frame on screen while the window is being resized.
    if (this.frameCount > 0) this.renderFrame(this.time);
  }

  /** Renders the shot at time t (seconds). */
  renderFrame(t: number) {
    this.time = t;
    const s = this.subjectScale;

    sampleFlight(t, this.flight, 1);
    const [px, py, pz] = this.flight.position;
    const visible = t < TIMELINE.aircraftGone + 0.4;
    this.b2.object.visible = visible;
    this.b2.object.position.set(px, py, pz);
    const [lx, ly, lz] = this.flight.right;
    const [ux, uy, uz] = this.flight.up;
    const [fx, fy, fz] = this.flight.forward;
    this.basis.set(lx, ux, fx, 0, ly, uy, fy, 0, lz, uz, fz, 0, 0, 0, 0, 1);
    this.b2.object.quaternion.setFromRotationMatrix(this.basis);

    // Stop refreshing the shadow map once the aircraft is gone (toggling castShadow
    // instead would change shader programs and risk a recompile mid-shot).
    this.renderer.shadowMap.autoUpdate = visible;
    this.sun.target.position.set(px, py, pz);
    this.sun.position.copy(ATMOSPHERE.sunDir).multiplyScalar(120 * s).add(this.sun.target.position);
    const sc = this.sun.shadow.camera;
    const half = (B2_WINGSPAN / 2 + 2) * s;
    if (sc.right !== half) {
      Object.assign(sc, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 260 * s });
      sc.updateProjectionMatrix();
    }

    this.rig.update(t);
    airOffset(t, this.airTmp);
    this.air.set(this.airTmp[0], this.airTmp[1], this.airTmp[2]);
    this.cloudAir.copy(this.air).add(CLOUD_ORIGIN);

    this.contrails.update(t, this.air, this.rig.camera);
    this.clouds.render(this.renderer, this.rig.camera, this.cloudAir, t);
    this.pipeline.render(this.renderer, this.scene, this.rig.camera, {
      exposure: 0.7,
      bloomStrength: 0.1,
      scrim: smoothstep(TIMELINE.scrimIn[0], TIMELINE.scrimIn[1], t),
      time: t,
    });
    this.overlay.update(t);
    this.frameCount++;
    if (!this.options.manual) {
      if (t >= TIMELINE.wordmarkStart) this.mark('intro:wordmark');
      if (t >= TIMELINE.revealStart) this.mark('intro:reveal');
    }
  }

  /** Performance marks at phase boundaries (visible in DevTools, used by tooling). */
  private mark(name: string) {
    if (this.marked.has(name)) return;
    this.marked.add(name);
    performance.mark(name, { detail: { shotTime: this.time } });
  }

  /** Starts the real-time clock. Frame 0 has already been drawn synchronously by the caller. */
  play() {
    const tick = (now: number) => {
      if (this.disposed) return;
      if (this.lastNow < 0) {
        // First animation frame: the clock starts here, at t = 0.
        this.lastNow = now;
      } else {
        const dt = (now - this.lastNow) / 1000;
        this.lastNow = now;
        // Absorb long stalls (tab switches, hitches) instead of skipping the shot.
        this.time += Math.min(dt, 1 / 15);
        this.adaptQuality(dt);
      }
      if (this.time >= INTRO_END) {
        this.overlay.update(INTRO_END);
        this.finish();
        return;
      }
      this.renderFrame(this.time);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** If the GPU can't hold frame rate, trade cloud resolution for smoothness (once). */
  private adaptQuality(dt: number) {
    if (this.frameCount < 6 || this.cloudScale < 0.5) return;
    this.slowFrames = dt > 0.024 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 8) {
      this.cloudScale = 0.4;
      this.resize();
    }
  }

  private finish() {
    this.mark('intro:complete');
    this.dispose();
    this.options.onComplete?.();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.b2.dispose();
    this.contrails.dispose();
    this.clouds.dispose();
    this.pipeline.dispose();
    this.background.geometry.dispose();
    this.background.material.dispose();
    this.noise2D.dispose();
    this.noise3D.dispose();
    this.env.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ---------------------------------------------------------------------- */
  /* Dev instrumentation                                                     */
  /* ---------------------------------------------------------------------- */

  /** Screen-space facts about the aircraft at the current frame (for validation). */
  metrics() {
    const cam = this.rig.camera;
    const pts = [...this.b2.wingtips, new Vector3(0, 2, 11.5), new Vector3(0, 0, -9.5), new Vector3(21.95, 0, -8.69), new Vector3(-21.95, 0, -8.69)];
    const ndc = pts.map((p) => p.clone().applyMatrix4(this.b2.object.matrixWorld).project(cam));
    const [a, b] = ndc;
    const inside = ndc.some((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1);
    return {
      time: this.time,
      spanFraction: Math.abs(a.x - b.x) / 2,
      centre: this.b2.object.position.clone().project(cam).toArray(),
      bankDeg: (this.flight.bank * 180) / Math.PI,
      anyPartVisible: this.b2.object.visible && inside,
      points: ndc.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]),
      shipSpeed: FLIGHT.shipSpeed,
    };
  }
}
