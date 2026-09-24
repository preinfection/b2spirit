// Dev helper: screenshots of the procedural B-2 from several angles.
// Usage: node scripts/shot-model.mjs <outDir> "az,el,dist[,fov]" ...
import { chromium } from 'playwright';
const [outDir, ...views] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const v of views) {
  const [az, el, dist, fov = 48] = v.split(',');
  await page.goto(`http://localhost:5173/?view=model&az=${az}&el=${el}&dist=${dist}&fov=${fov}`);
  await page.waitForFunction(() => window.__viewerReady === true, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  const file = `${outDir}/model_${az}_${el}_${dist}.png`;
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
