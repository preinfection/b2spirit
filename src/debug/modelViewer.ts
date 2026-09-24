import { ACESFilmicToneMapping, AmbientLight, Color, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { B2 } from '../intro/aircraft/B2';
import { ATMOSPHERE } from '../intro/environment/atmosphere';
import { createEnvironmentMap } from '../intro/environment/envMap';

/**
 * Dev-only turntable for inspecting the procedural B-2 (`/?view=model`).
 * Query params: `az`, `el` (degrees), `dist` (metres) set the camera.
 */
export function startModelViewer() {
  document.getElementById('intro')?.remove();
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '10' });
  document.body.appendChild(canvas);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;

  const env = createEnvironmentMap(renderer);
  const scene = new Scene();
  scene.background = new Color(0.55, 0.65, 0.78);
  const b2 = new B2(env.texture, renderer.capabilities.getMaxAnisotropy());
  scene.add(b2.object);

  const sun = new DirectionalLight(ATMOSPHERE.sunColor, ATMOSPHERE.sunIntensity);
  sun.position.copy(ATMOSPHERE.sunDir).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 140 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, new AmbientLight(0xffffff, 0.0));

  const q = new URLSearchParams(location.search);
  const az = (Number(q.get('az') ?? 0) * Math.PI) / 180;
  const el = (Number(q.get('el') ?? 40) * Math.PI) / 180;
  const dist = Number(q.get('dist') ?? 70);
  const camera = new PerspectiveCamera(Number(q.get('fov') ?? 48), innerWidth / innerHeight, 0.5, 2000);
  camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.update();

  const frame = () => {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
  (window as unknown as { __viewerReady: boolean }).__viewerReady = true;
}
