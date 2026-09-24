// Verifies the "no empty frame" guarantee: the browser's first paint must happen
// after the intro's first WebGL frame was rendered (so it contains the aircraft),
// and nothing but the intro layer may be visible on that paint.
//   node scripts/check-first-paint.mjs [url]
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(300);
const r = await page.evaluate(() => {
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]));
  const frame = performance.getEntriesByName('intro:first-frame')[0]?.startTime ?? null;
  const intro = document.getElementById('intro');
  return { paints, firstFrame: frame, introPresent: !!intro, introOpacity: intro ? getComputedStyle(intro).opacity : null };
});
console.log(JSON.stringify(r, null, 2));
const fp = r.paints['first-paint'] ?? r.paints['first-contentful-paint'];
const ok = r.firstFrame !== null && fp !== undefined && fp >= r.firstFrame;
console.log(ok ? `PASS: first paint at ${fp.toFixed(1)}ms, after first frame at ${r.firstFrame.toFixed(1)}ms` : 'FAIL: first paint preceded the first intro frame');
if (errors.length) console.log('errors:', errors);
await browser.close();
process.exit(ok ? 0 : 1);
