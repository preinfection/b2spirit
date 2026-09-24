// Plays the intro in real time and checks the end state:
// phase marks fire in order, the layer is removed, the page is interactive,
// and no errors were logged. Uses a small viewport so software GL keeps up.
//   node scripts/check-playback.mjs [url] [WxH]
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:4173/';
const [w, h] = (process.argv[3] ?? '480x270').split('x').map(Number);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
// Sample the frame rate during playback.
await page.evaluate(() => {
  window.__frames = 0;
  const f = () => { window.__frames++; if (document.getElementById('intro')) requestAnimationFrame(f); };
  requestAnimationFrame(f);
});
await page.waitForFunction(() => !document.getElementById('intro'), null, { timeout: 240000 });
const r = await page.evaluate(() => {
  const m = (n) => performance.getEntriesByName(n)[0];
  const first = m('intro:first-frame');
  const rel = (n) => (m(n) ? +(m(n).startTime - first.startTime).toFixed(0) : null);
  const shot = (n) => (m(n) ? +m(n).detail.shotTime.toFixed(3) : null);
  const app = document.getElementById('app');
  return {
    wallClockMs: { wordmark: rel('intro:wordmark'), reveal: rel('intro:reveal'), complete: rel('intro:complete') },
    shotTime: { wordmark: shot('intro:wordmark'), reveal: shot('intro:reveal'), complete: shot('intro:complete') },
    frames: window.__frames,
    introRemoved: !document.getElementById('intro'),
    htmlClass: document.documentElement.className,
    pageInert: app.hasAttribute('inert'),
    pageTransform: app.style.transform,
    bodyOverflow: getComputedStyle(document.body).overflow,
    canvases: document.querySelectorAll('canvas').length,
  };
});
console.log(JSON.stringify(r, null, 2));
if (errors.length) console.log('errors:', errors);
await browser.close();
