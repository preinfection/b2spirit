import { BackSide, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, type WebGLRenderTarget, type WebGLRenderer } from 'three';
import { ATMOSPHERE } from './atmosphere';

/**
 * Pre-filtered HDR environment for the aircraft's reflections: sky dome above,
 * a bright sunlit cloud deck below, both fading into horizon haze. Generated
 * once on the GPU (a few milliseconds), never per frame.
 */
export function createEnvironmentMap(renderer: WebGLRenderer): WebGLRenderTarget {
  const a = ATMOSPHERE;
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: a.sunDir },
      uSun: { value: a.sunColor.clone().multiplyScalar(a.sunIntensity) },
      uZenith: { value: a.skyZenith },
      uHorizon: { value: a.skyHorizon },
      uHaze: { value: a.haze },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uSun, uZenith, uHorizon, uHaze;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float mu = dot(d, uSunDir);
        vec3 col;
        if (d.y >= 0.0) {
          col = mix(uHorizon, uZenith, pow(d.y, 0.45));
          col += uSun * (0.05 * pow(max(mu, 0.0), 8.0) + 0.02 * pow(max(mu, 0.0), 2.0));
        } else {
          // Sunlit cloud deck below: bright, slightly brighter towards the sun.
          vec3 deck = vec3(0.86, 0.88, 0.92) * (0.8 + 0.35 * max(mu, 0.0));
          col = mix(deck, uHaze * 1.1, exp(-(-d.y) * 7.0));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const scene = new Scene();
  const sphere = new Mesh(new SphereGeometry(10, 48, 24), material);
  scene.add(sphere);

  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  sphere.geometry.dispose();
  material.dispose();
  return target;
}
