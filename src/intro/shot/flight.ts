/**
 * Deterministic flight model for the pass.
 *
 * Everything is a pure function of shot time `t` (seconds), so any frame can be
 * reproduced exactly (scrubbing, capture, resize) and the motion never depends
 * on frame rate.
 *
 * Frames:
 *  - "air frame": fixed to the air mass (clouds and contrails live here).
 *  - "ship frame": fixed to the camera platform, which flies along +Z through
 *    the air at SHIP_SPEED. A point fixed in the air drifts towards -Z in the
 *    ship frame (away from camera, i.e. up the screen).
 *
 * The aircraft is modelled kinematically: airspeed, heading and flight-path
 * angle are smooth functions of time and position is their integral. Bank is
 * derived from the turn rate (with a little lead, as a pilot rolls into a turn
 * before the heading swings), so the rotation always matches the path.
 *
 * This module is plain math (no three.js) so it can be tuned from Node.
 */

export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

export const FLIGHT = {
  /** Camera platform speed through the air (m/s, +Z). Slower than the bomber so it overtakes. */
  shipSpeed: 52,
  /** Base airspeed of the aircraft (m/s). The shot plays as gentle slow motion. */
  airspeed: 84,
  /** Heading before the turn (radians, 0 = +Z, positive = towards +X / screen-right). */
  headingStart: -27 * DEG,
  /** Total heading change through the turn towards the lower-right exit. */
  headingChange: 80 * DEG,
  turnStart: 1.04,
  turnEnd: 2.24,
  /** Where the aircraft is (ship frame) at the hero moment. */
  heroTime: 1.12,
  // 60 m from the camera, dead centre of frame for the -36° camera pitch.
  heroPosition: [0.0, -35.27, -48.54] as Vec3,
  /** Visual bank limit and how quickly bank saturates with turn rate. */
  maxBank: 44 * DEG,
  bankRateScale: 1.15,
  bankLead: 0.1,
  /** Nose-up attitude relative to the flight path (angle of attack). */
  alpha: 2.2 * DEG,
  /** Simulation span; before t=0 is pre-roll so contrails already exist at frame 0. */
  tMin: -3.0,
  tMax: 3.6,
} as const;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** C2-continuous ease (smootherstep) and its derivative. */
const smoother = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const smootherD = (x: number) => {
  if (x <= 0 || x >= 1) return 0;
  return 30 * x * x * (x - 1) * (x - 1);
};

/** Airspeed: eases off slightly approaching the hero moment, then powers out of the turn. */
export function airspeed(t: number): number {
  const ease = 1 - 0.08 * Math.exp(-((t - 0.95) ** 2) / (2 * 0.45 ** 2));
  const powerOut = 1 + 0.34 * smoothstep(1.2, 2.4, t);
  return FLIGHT.airspeed * ease * powerOut;
}

export function heading(t: number): number {
  const u = (t - FLIGHT.turnStart) / (FLIGHT.turnEnd - FLIGHT.turnStart);
  return FLIGHT.headingStart + FLIGHT.headingChange * smoother(u);
}

export function headingRate(t: number): number {
  const span = FLIGHT.turnEnd - FLIGHT.turnStart;
  return (FLIGHT.headingChange * smootherD((t - FLIGHT.turnStart) / span)) / span;
}

/** Flight-path angle: a shallow descent on entry, then a climbing turn under power. */
export function pathAngle(t: number): number {
  return -4.5 * DEG * (1 - smoothstep(0.2, 1.5, t)) + 4.0 * DEG * smoothstep(1.5, 2.4, t);
}

export function bankAngle(t: number): number {
  const r = headingRate(t + FLIGHT.bankLead);
  return FLIGHT.maxBank * Math.tanh(r / FLIGHT.bankRateScale);
}

/** Ship displacement through the air (air = ship + offset). */
export function airOffset(t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = 0;
  out[1] = 0;
  out[2] = FLIGHT.shipSpeed * t;
  return out;
}

/* ------------------------------------------------------------------------ */
/* Integrated trajectory (precomputed once, sampled with linear interpolation) */
/* ------------------------------------------------------------------------ */

const DT = 1 / 480;
const N = Math.ceil((FLIGHT.tMax - FLIGHT.tMin) / DT) + 1;
const airPos = new Float64Array(N * 3);

(function integrate() {
  // Integrate from the hero time in both directions so the hero position is exact.
  const heroIndex = Math.round((FLIGHT.heroTime - FLIGHT.tMin) / DT);
  const hero = FLIGHT.heroPosition;
  const off = airOffset(FLIGHT.heroTime);
  airPos[heroIndex * 3] = hero[0] + off[0];
  airPos[heroIndex * 3 + 1] = hero[1] + off[1];
  airPos[heroIndex * 3 + 2] = hero[2] + off[2];
  const vel = (t: number): Vec3 => {
    const v = airspeed(t);
    const psi = heading(t);
    const gam = pathAngle(t);
    return [v * Math.sin(psi) * Math.cos(gam), v * Math.sin(gam), v * Math.cos(psi) * Math.cos(gam)];
  };
  const step = (from: number, to: number) => {
    const t0 = FLIGHT.tMin + from * DT;
    const h = (to - from) * DT;
    // RK4 on a time-only velocity field.
    const k1 = vel(t0);
    const k2 = vel(t0 + h / 2);
    const k4 = vel(t0 + h);
    for (let a = 0; a < 3; a++) airPos[to * 3 + a] = airPos[from * 3 + a] + (h / 6) * (k1[a] + 4 * k2[a] + k4[a]);
  };
  for (let i = heroIndex; i < N - 1; i++) step(i, i + 1);
  for (let i = heroIndex; i > 0; i--) step(i, i - 1);
})();

export interface FlightSample {
  /** Aircraft position in the ship frame. */
  position: Vec3;
  /** Orthonormal attitude basis in the ship frame (model +X, +Y, +Z). */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  bank: number;
}

export function createSample(): FlightSample {
  return { position: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1], bank: 0 };
}

/** Position of the aircraft in the air frame. */
export function airPosition(t: number, out: Vec3): Vec3 {
  const x = Math.min(Math.max((t - FLIGHT.tMin) / DT, 0), N - 1.000001);
  const i = Math.floor(x);
  const f = x - i;
  for (let a = 0; a < 3; a++) out[a] = airPos[i * 3 + a] * (1 - f) + airPos[(i + 1) * 3 + a] * f;
  return out;
}

const tmp: Vec3 = [0, 0, 0];

/**
 * Samples the aircraft state at time t (ship frame).
 * `turbulence` adds tiny deterministic attitude/position perturbations.
 */
export function sampleFlight(t: number, out: FlightSample, turbulence = 1): FlightSample {
  airPosition(t, out.position);
  airOffset(t, tmp);
  out.position[0] -= tmp[0];
  out.position[1] -= tmp[1];
  out.position[2] -= tmp[2];

  const psi = heading(t) + turbulence * 0.25 * DEG * Math.sin(t * 3.1 + 0.4);
  const pitch = pathAngle(t) + FLIGHT.alpha + turbulence * 0.22 * DEG * Math.sin(t * 4.3 + 1.3) * Math.sin(t * 1.7);
  const bank = bankAngle(t) + turbulence * 0.5 * DEG * (Math.sin(t * 2.3 + 2.1) + 0.5 * Math.sin(t * 5.9));
  out.bank = bank;
  out.position[1] += turbulence * 0.12 * Math.sin(t * 2.7 + 0.8);

  // Heading/pitch define the forward axis; bank rolls the up axis around it.
  const cp = Math.cos(pitch);
  const f: Vec3 = [Math.sin(psi) * cp, Math.sin(pitch), Math.cos(psi) * cp];
  // Level "left" axis (model +X) and level up.
  let lx = Math.cos(psi);
  let lz = -Math.sin(psi);
  const ln = Math.hypot(lx, lz);
  lx /= ln;
  lz /= ln;
  // up0 = f × left (keeps the basis right-handed with left = up × forward).
  const u0: Vec3 = [f[1] * lz - f[2] * 0, f[2] * lx - f[0] * lz, f[0] * 0 - f[1] * lx];
  // Positive bank (turning towards +X, the left wing) tilts the lift vector towards +X.
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);
  const up: Vec3 = [u0[0] * cb + lx * sb, u0[1] * cb, u0[2] * cb + lz * sb];
  const left: Vec3 = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
  out.forward = f;
  out.up = up;
  out.right = left;
  return out;
}
