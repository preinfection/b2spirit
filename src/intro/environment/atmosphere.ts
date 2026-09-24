import { Color, Vector3 } from 'three';

/**
 * Single source of truth for the lighting of the shot. The cloud raymarcher,
 * the aircraft's PBR lighting, the environment map and the contrails all read
 * from here so they sit in the same light.
 *
 * Frame convention ("ship frame"): the camera platform sits near the origin
 * looking towards -Z and down; +X is screen-right, +Y is up.
 */
export const ATMOSPHERE = {
  /** Direction *towards* the sun: afternoon sun low on the right, slightly ahead of camera. */
  sunDir: new Vector3(0.83, 0.47, -0.3).normalize(),
  /** Linear-light sun colour; intensity is applied separately. */
  sunColor: new Color(1.0, 0.93, 0.83),
  /** Illuminance scale: a white Lambertian surface facing the sun reflects ~intensity/π. */
  sunIntensity: 3.4,
  skyZenith: new Color(0.16, 0.3, 0.62),
  skyHorizon: new Color(0.62, 0.74, 0.9),
  /** Ambient light scattered down onto cloud tops from the sky dome. */
  skyAmbient: new Color(0.14, 0.205, 0.34),
  /** Light bounced up from lower cloud onto undersides. */
  bounceAmbient: new Color(0.16, 0.18, 0.22),
  /** Aerial-perspective haze colour (before sun glow is added). */
  haze: new Color(0.52, 0.63, 0.8),
  /** Haze extinction per metre. */
  hazeDensity: 1 / 5200,
} as const;
