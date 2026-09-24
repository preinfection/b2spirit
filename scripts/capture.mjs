// Frame-accurate validation capture of the intro (dev server must be running).
//
//   node scripts/capture.mjs [--out .capture] [--size 1600x900] [--times 0,0.5,1] [--sheet]
//
// Renders each requested shot time via the dev-only `?capture` hook, saves a PNG
// per frame, prints aircraft metrics (screen position, apparent wingspan, bank,
// visibility) and optionally assembles a labelled contact sheet (needs Python + Pillow).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const out = args.out ?? '.capture';
const [width, height] = String(args.size ?? '1600x900').split('x').map(Number);
const times = String(args.times ?? '0,0.3,0.6,0.9,1.1,1.3,1.5,1.7,1.9,2.1,2.3,2.5,2.8,3.2,3.6,4.0,4.3,4.6,4.9').split(',').map(Number);
const url = args.url ?? 'http://localhost:5173/';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(args.dpr ?? 1) });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[browser]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${url}?capture&t=${times[0]}`);
await page.waitForFunction(() => !!window.__intro, null, { timeout: 180000 });

const results = [];
for (const t of times) {
  const started = Date.now();
  const m = await page.evaluate((tt) => window.__intro.seek(tt), t);
  const file = `${out}/t${t.toFixed(2).padStart(5, '0')}.png`;
  await page.screenshot({ path: file, timeout: 300000 });
  results.push({ t, file, ...m });
  const c = m.centre;
  console.log(
    `t=${t.toFixed(2)}  centre=(${c[0].toFixed(2)},${c[1].toFixed(2)})  span=${(m.spanFraction * 100).toFixed(1)}%  bank=${m.bankDeg.toFixed(1)}°  visible=${m.anyPartVisible}  (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}
writeFileSync(`${out}/metrics.json`, JSON.stringify(results, null, 2));
await browser.close();

if (args.sheet) {
  const py = `
import json, sys
from PIL import Image, ImageDraw
res = json.load(open(sys.argv[1] + '/metrics.json'))
cols = 4
tw = 480
ims = [Image.open(r['file']).convert('RGB') for r in res]
th = int(tw * ims[0].height / ims[0].width)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * (th + 22)), (20, 20, 24))
d = ImageDraw.Draw(sheet)
for i, (r, im) in enumerate(zip(res, ims)):
    x, y = (i % cols) * tw, (i // cols) * (th + 22)
    sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y + 22))
    d.text((x + 6, y + 5), f"t={r['t']:.2f}s  span={r['spanFraction']*100:.0f}%  bank={r['bankDeg']:.0f}  vis={r['anyPartVisible']}", fill=(230, 230, 230))
sheet.save(sys.argv[1] + '/sheet.jpg', quality=88)
print(sys.argv[1] + '/sheet.jpg')
`;
  console.log(execFileSync('python3', ['-c', py, out]).toString().trim());
}
