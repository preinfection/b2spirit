# b2spirit

A cinematic, fully procedural 3D opening for a landing page: a B-2 Spirit
passes over a sea of clouds, leaves contrails hanging in the air, and hands off to the
`mutate.lol` wordmark before the layer lifts away to reveal the page.

**This runs locally only.** Nothing here deploys or publishes anything.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (bound to localhost only)
```

Production build, served locally:

```bash
npm run build
npm run preview    # http://localhost:4173
```

Useful URL parameters:

| Parameter | What it does |
| --- | --- |
| `?intro=force` | Plays the intro even if the OS asks for reduced motion (it is skipped otherwise). |
| `?capture&t=1.2` | Dev only. Renders one exact frame of the shot and freezes it (see Validation). |
| `?view=model` | Dev only. Orbit viewer for the procedural B-2 (`&az=0&el=40&dist=60`). |

## Sequence

| Time | What happens |
| --- | --- |
| 0.0 s | The first painted frame already shows the aircraft entering top-right, partly cropped. |
| 0.0–2.4 s | One continuous pass: through the centre (~45% of the width), banking and yawing into a climbing turn, out the lower-right. |
| 2.42 s | The wordmark rises gently out of a soft blur. |
| 3.95–4.95 s | The whole layer fades, scales up slightly and blurs away. The page is already underneath. |

The timings live in `src/intro/timeline.ts`. One clock drives both the WebGL shot and
the DOM overlay, so they cannot drift apart.

## How it works

```
src/
  main.ts                    entry (render-blocking), starts the intro
  intro/
    index.ts                 playIntro(): public API, fallbacks, cleanup
    Intro.ts                 orchestrator: renderer, sizing/DPI, frame loop, disposal
    timeline.ts              shot timing + CSS-equivalent easing
    overlay.ts               wordmark + final reveal (DOM), driven by the shot clock
    shot/flight.ts           deterministic flight model (heading, speed, climb, bank)
    shot/cameraRig.ts        aerial camera: framing per aspect, loose tracking, buffeting
    aircraft/planform.ts     B-2 planform + surface definition (pure math)
    aircraft/b2Geometry.ts   closed skin mesh from the surface functions
    aircraft/b2Textures.ts   procedural coating, panels, inlets, troughs, windscreen
    aircraft/B2.ts           mesh + physically based stealth-coating material
    environment/atmosphere.ts  shared sun/sky/haze values
    environment/CloudPass.ts raymarched volumetric cloud sea (reduced-res HDR pass)
    environment/noiseBake.ts GPU-baked tileable 2D/3D noise
    environment/envMap.ts    pre-filtered sky/cloud environment for reflections
    contrails/Contrails.ts   GPU particle contrails that live in the air mass
    render/Pipeline.ts       HDR target (MSAA) → bloom → ACES tone map, grade, grain
  debug/                     dev-only model viewer and frame capture (tree-shaken)
```

Key decisions:

- **No blank first frame.** The entry script is `blocking="render"` (added by a small Vite
  plugin), and `playIntro()` renders frame 0 synchronously while the module evaluates. The
  browser's first paint therefore already contains the aircraft. There is no loader and no
  fade-in. The inline CSS gives a matching fallback gradient, plus a failsafe that removes
  the layer if the script never runs.
- **Deterministic and frame-rate independent.** The flight is integrated once at startup.
  Contrail particles store where and when they were shed, and the shader computes their
  age, drift, spread and fade. Any time `t` can be rendered exactly, which the capture
  tooling relies on.
- **Physically coherent motion.** The camera platform flies slower than the bomber, so the
  bomber overtakes it. Heading always follows the velocity, and bank follows the turn rate
  (with a little lead). The shot plays as gentle slow motion, so the contrails can visibly
  hang in the air after the pass.
- **Framing survives any aspect ratio.** Horizontal coverage is kept constant, so the
  aircraft is ~45% of the width at the centre on 16:9, 21:9 and 4:3 alike. Tall viewports
  clamp the lens, scale the subject and pan the camera more to follow it.
- **GPU budget.** The clouds render at ~0.55× CSS resolution (capped at 0.8 MP) and are
  upsampled. The scene target is capped at ~4.2 MP, with DPR capped at 2. If early frames
  run slow, cloud resolution drops once. Once the aircraft is gone, it is no longer drawn
  or shadow-mapped.
- **Cleanup.** When the reveal finishes, every geometry, material, texture and render
  target is disposed, the WebGL context is released, and the layer is removed from the DOM.
  The page's `inert` and scroll lock are lifted.

## Validation tooling

These scripts use Playwright with Chromium's software GL, so they are slow but exact:

```bash
npm run dev    # in another terminal
node scripts/capture.mjs --size 1600x900 --sheet          # frames + metrics + contact sheet
node scripts/capture.mjs --size 2520x1080 --times 0,1.1   # any aspect / --dpr 2
node scripts/tune-flight.ts                               # screen path + span table, no rendering

npm run build && npm run preview   # in another terminal
node scripts/check-first-paint.mjs   # asserts first paint happens after frame 0 was rendered
node scripts/check-playback.mjs      # plays in real time, checks phases + cleanup
```

`capture.mjs` prints, for each frame, the aircraft's screen position, apparent wingspan as a
fraction of the viewport width, bank angle, and whether any part of it is on screen.

## Integrating into a real site

The landing page in `index.html` and `src/styles/site.css` is a stand-in. To use the intro on
the real page, keep the `#intro` markup and the inline critical styles in `index.html`, and
call `playIntro({ root, page })` from a render-blocking entry module. The page underneath
should read `--intro-content` (0 → 1) if its content should settle in during the reveal.
