import { Euler, MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { createSample, sampleFlight, type FlightSample } from './flight';

const DEG = Math.PI / 180;

/** Reference framing, authored for 16:9. */
export const FRAMING = {
  /** Camera platform looks back and down at the approaching aircraft. */
  pitch: -36 * DEG,
  /** A barely-there Dutch angle keeps the frame from feeling like a UI. */
  roll: -1.6 * DEG,
  /** Vertical FOV at 16:9. Horizontal coverage is preserved on other aspects. */
  refVFov: 48 * DEG,
  refAspect: 16 / 9,
  minVFov: 30 * DEG,
  maxVFov: 64 * DEG,
  /** Wingspan-to-width target at the hero moment for landscape; portrait allows larger. */
  spanFractionLandscape: 0.46,
  spanFractionPortrait: 0.7,
} as const;

export interface Framing {
  vFov: number;
  /** Uniform scale applied to the aircraft (and contrails) so its apparent size suits the aspect. */
  subjectScale: number;
}

/**
 * Keeps horizontal coverage constant across aspect ratios so the aircraft never
 * shrinks on wide monitors; tall/narrow viewports clamp the vertical FOV and
 * scale the subject instead of distorting the lens.
 */
export function computeFraming(aspect: number): Framing {
  const refTanH = Math.tan(FRAMING.refVFov / 2) * FRAMING.refAspect;
  let vFov = 2 * Math.atan(refTanH / aspect);
  vFov = MathUtils.clamp(vFov, FRAMING.minVFov, FRAMING.maxVFov);
  const tanH = Math.tan(vFov / 2) * aspect;
  // Apparent span fraction scales with 1/tanH; aim for the target for this aspect.
  const target = MathUtils.lerp(FRAMING.spanFractionPortrait, FRAMING.spanFractionLandscape, MathUtils.smoothstep(aspect, 0.6, 1.3));
  const natural = FRAMING.spanFractionLandscape * (refTanH / tanH);
  const subjectScale = Math.min(1, target / natural);
  return { vFov, subjectScale };
}

/** Sum of incommensurate sines: smooth, deterministic, no visible period. */
function wobble(t: number, seed: number, comps: ReadonlyArray<readonly [number, number]>): number {
  let v = 0;
  for (let i = 0; i < comps.length; i++) {
    const [freq, amp] = comps[i];
    v += amp * Math.sin(t * freq * Math.PI * 2 + seed * (i + 1) * 1.7);
  }
  return v;
}

/**
 * Aerial camera platform. The operator follows the aircraft loosely (a fraction
 * of its angular offset, with lag) and the platform carries restrained
 * low-frequency buffeting, plus a short bump as the bomber's wake passes.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  private readonly lagged: FlightSample = createSample();
  private readonly refInverse = new Matrix4();
  private readonly refQuat = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  /** How strongly the operator follows the aircraft; narrow frames need more panning. */
  private trackGain = 0.15;

  constructor(aspect: number) {
    const f = computeFraming(aspect);
    this.camera = new PerspectiveCamera(f.vFov / DEG, aspect, 0.5, 30000);
    this.euler.set(FRAMING.pitch, 0, FRAMING.roll);
    this.refQuat.setFromEuler(this.euler);
    this.refInverse.makeRotationFromQuaternion(this.refQuat).invert();
  }

  setAspect(aspect: number): Framing {
    const f = computeFraming(aspect);
    this.trackGain = MathUtils.lerp(0.15, 0.66, (1 - MathUtils.smoothstep(aspect, 0.5, 1.25)) ** 0.8);
    this.camera.fov = f.vFov / DEG;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    return f;
  }

  update(t: number) {
    // Loose tracking of where the aircraft was a moment ago.
    sampleFlight(t - 0.28, this.lagged, 0);
    const p = this.lagged.position;
    this.v.set(p[0], p[1], p[2]).applyMatrix4(this.refInverse);
    const depth = Math.max(-this.v.z, 1);
    const follow = 1 - MathUtils.smoothstep(t, 1.75, 3.0);
    const yaw = MathUtils.clamp(Math.atan2(this.v.x, depth), -0.7, 0.7) * this.trackGain * follow;
    const pitch = MathUtils.clamp(Math.atan2(this.v.y, depth), -0.6, 0.6) * 0.13 * follow;

    // Airborne platform: slow drift plus fine buffet; a brief wake bump at ~2.3s.
    const wake = Math.exp(-(((t - 2.32) / 0.28) ** 2));
    const fine = 1 + 1.8 * wake;
    const bPitch = wobble(t, 1, [[0.37, 0.1], [0.83, 0.05]]) + fine * wobble(t, 2, [[2.3, 0.022], [5.9, 0.01]]);
    const bYaw = wobble(t, 3, [[0.29, 0.09], [0.71, 0.045]]) + fine * wobble(t, 4, [[2.9, 0.02], [6.7, 0.009]]);
    const bRoll = wobble(t, 5, [[0.23, 0.18], [0.61, 0.06]]) + fine * wobble(t, 6, [[3.3, 0.03]]);

    this.euler.set(pitch + bPitch * DEG, -yaw + bYaw * DEG, bRoll * DEG + 0.4 * DEG * Math.sin(t * 0.5), 'YXZ');
    this.q.setFromEuler(this.euler);
    // Offsets are applied in the reference camera's local frame.
    this.camera.quaternion.copy(this.refQuat).multiply(this.q);

    this.camera.position.set(
      wobble(t, 7, [[0.21, 0.35], [0.9, 0.08]]),
      wobble(t, 8, [[0.17, 0.3], [0.77, 0.07]]) + 0.2 * wake * Math.sin(t * 19),
      wobble(t, 9, [[0.13, 0.25]]),
    );
    this.camera.updateMatrixWorld(true);
  }
}
