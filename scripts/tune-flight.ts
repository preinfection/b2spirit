// Dev helper: prints the aircraft's screen position (NDC) and apparent wingspan
// for the reference 16:9 camera, so the pass can be tuned without rendering.
import { FLIGHT, createSample, sampleFlight, bankAngle, heading, airspeed } from '../src/intro/shot/flight.ts';

const DEG = Math.PI / 180;
const pitch = Number(process.env.PITCH ?? -36) * DEG;
const vFov = Number(process.env.VFOV ?? 48) * DEG;
const aspect = 16 / 9;
const tanV = Math.tan(vFov / 2);
const tanH = tanV * aspect;

function toNdc(p: number[]) {
  const c = Math.cos(-pitch), s = Math.sin(-pitch);
  const x = p[0];
  const y = p[1] * c - p[2] * s;
  const z = p[1] * s + p[2] * c;
  return [x / (-z * tanH), y / (-z * tanV), -z];
}
const sample = createSample();
const tip = (side: number) => {
  const lx = side * 26.2, lz = 11.5 - 26.2 * Math.tan(33 * DEG);
  return [0, 1, 2].map((a) => sample.position[a] + sample.right[a] * lx + sample.forward[a] * lz);
};
const nose = () => [0, 1, 2].map((a) => sample.position[a] + sample.forward[a] * 11.5);
const tail = () => [0, 1, 2].map((a) => sample.position[a] - sample.forward[a] * 9.5);
console.log(' t     ndcX   ndcY   dist  spanFrac  heading  bank  speed  |  L-tip          R-tip          nose           tail');
for (let t = -0.4; t <= 2.81; t += 0.2) {
  sampleFlight(t, sample, 0);
  const c = toNdc(sample.position);
  const a = toNdc(tip(1)), b = toNdc(tip(-1)), n = toNdc(nose()), tl = toNdc(tail());
  const f = (v: number[]) => `(${v[0].toFixed(2)},${v[1].toFixed(2)})`.padEnd(15);
  console.log(`${t.toFixed(1).padStart(4)}  ${c[0].toFixed(2).padStart(5)}  ${c[1].toFixed(2).padStart(5)}  ${c[2].toFixed(1).padStart(5)}  ${(Math.abs(a[0] - b[0]) / 2).toFixed(2).padStart(6)}  ${(heading(t) / DEG).toFixed(1).padStart(6)}  ${(bankAngle(t) / DEG).toFixed(1).padStart(5)}  ${airspeed(t).toFixed(0).padStart(4)}  |  ${f(a)}${f(b)}${f(n)}${f(tl)}  y=${sample.position[1].toFixed(1)}`);
}
void FLIGHT;
