---
name: algorithmic-art
description: "Generative art in p5.js, Canvas2D, SVG or shaders: seeded noise flow fields, particles, circle packing, plotter SVG, PNG exports. Use when making code-driven artwork, a reproducible series from seeds, a high-resolution print or pen-plotter export, or an animated generative loop. Not for 3D scenes (use threejs-3d) or static editorial posters (use canvas-design)."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request asks for generative, procedural or algorithmic art, a p5.js sketch, flow fields, noise or seeded variations."
metadata:
  routing-group: media
---

# Algorithmic Art

## Selection card
- Task: Build seeded, resolution-independent generative artwork and export it for screen, print or plotter.
- Start: Fix the output (screen PNG, print size and DPI, plotter SVG, or loop video), the canvas aspect and the runtime (p5.js, plain Canvas2D, SVG or a shader); read any existing sketch and its seed handling.
- Finish: the same seed renders an identical image twice, a seed grid shows the parameter space holds up, and the export matches the target size; checks below pass.

## Overview

Generative art is a system plus a seed: a piece is finished when one seed reproduces the same image at any output size and most seeds in the parameter space are worth keeping, not when one render looks lucky.
Target standalone HTML with p5.js or plain Canvas2D (checked 2026-11-02: p5 2.3.4 stable on npm/CDN; verify 2.x async setup/preload changes when upgrading from 1.11.x).
Composition decisions (margins, density variation, a focal area, negative space, value structure) matter more than how many algorithms are stacked.

## Rules

1. One seed drives everything. `randomSeed` and `noiseSeed` cover only p5's `random()` and `noise()`; any `Math.random()`, `Date` or unseeded library call breaks reproducibility. In plain JS, hash the seed string into a small PRNG (sfc32 or mulberry32). Put the seed in the URL and the export filename.
2. Work in canvas units, not pixels: `const u = width / 1000` for positions, step sizes, stroke weights and noise scales, so a 4x export is the same composition with finer detail.
3. Set `pixelDensity(1)` (or an explicit value) before exporting. p5 defaults to the display density, so `saveCanvas` writes a 2x file on a Retina screen and 1x elsewhere.
4. Fix iteration counts and time steps: simulations run N steps with a fixed dt; animation frame N is a pure function of N. Never stop on a timer or depend on the frame rate.
5. Explore the space before polishing: render a grid of 16-36 seeds, tighten parameter ranges until most outputs work, and keep a curated seed list.
6. Choose palettes in a perceptual space (OKLCH or OKLab): 3-5 hues, deliberate lightness steps, checked in grayscale for value structure.
7. Batch drawing: one path per streamline (`beginShape` to `endShape`) rather than one `line()` per step with style changes; `loadPixels`/`updatePixels` once per frame; past roughly 100k moving particles move to WebGL or a shader.

## First moves by situation

| Request | First moves |
|---|---|
| Flow field | Angle `noise(x * s, y * s) * TAU * k`, where s sets feature size; fixed step length; a spatial grid with a separation distance gives non-overlapping streamlines |
| Packing or even spacing | Poisson-disk sampling (Bridson) or a spatial hash for neighbour checks instead of all-pairs loops |
| Pen plotter | SVG paths only, no fills; size in millimetres; stroke width equals pen width; `vpype read in.svg linemerge linesort write out.svg` to cut pen-up travel |
| Print | Pixels = inches x DPI (A3 at 300 DPI is about 3508x4961); browsers cap canvas dimensions, so tile larger renders; ask about CMYK and bleed |
| Seamless animated loop | Drive everything by t in [0, 1); loop noise by sampling a circle in noise space (`noise(ox + r * cos(TAU * t), oy + r * sin(TAU * t))`); export frames, encode with FFmpeg |
| Port from p5 1.x | Replace `preload` with an async `setup` and `await loadImage(...)`; read the 2.x compatibility notes for shape and typography changes |
| Slow sketch | `noLoop()` for static pieces; cache static layers in `createGraphics`; profile before optimizing |
| Shader art | Seed through a uniform; hash-based noise; expect precision differences on mobile (mediump) and across GPUs |

## Patterns and pitfalls

- **Noise distribution** — `noise()` clusters around 0.5 and rarely reaches 0 or 1; remap from the observed range rather than assuming 0..1, and remember `noiseDetail` shifts it.
- **Lattice artifacts** — sampling noise at integer coordinates repeats the lattice value; scale inputs by a non-integer factor.
- **Edge bias** — particles leave the canvas and density collapses at borders; respawn uniformly or clip to a margin deliberately.
- **8-bit accumulation** — thousands of low-alpha strokes band and stall at a floor color in an 8-bit canvas; add grain at the end or accumulate in float buffers (WebGL).
- **Hairline seams** — adjacent filled shapes show anti-aliasing gaps; overlap them slightly or stroke with the fill color.
- **Biased shuffles** — `sort(() => random() - 0.5)` is not uniform; use Fisher-Yates with the seeded generator (p5 `shuffle()` already uses `random()`).
- **GPU determinism** — the same shader can differ across GPUs and drivers; archive the canonical render when exact reproduction matters.
- **Async assets in p5 2.x** — fonts and images load with `await` in `setup`; drawing before they resolve silently uses fallbacks.
- **Hue sweeps** — default HSB rainbows and uniform random sprinkles read as clichés; vary density and scale with intent.

## Template (p5.js)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Flow field</title>
  <script src="https://cdn.jsdelivr.net/npm/p5@2.3.4/lib/p5.min.js"></script>
  <style>html,body{margin:0;background:#111;display:grid;place-items:center;min-height:100vh}</style>
</head>
<body>
<script>
const q = new URLSearchParams(location.search);
let seed = Number(q.get('seed') ?? 42);
const SIZE = Number(q.get('size') ?? 1080);        // export: ?size=4320
function setup() { createCanvas(SIZE, SIZE); pixelDensity(1); noLoop(); }
function draw() {
  randomSeed(seed); noiseSeed(seed);
  const u = width / 1000;                            // geometry in canvas units
  background('#f2efe8'); noFill();
  stroke(20, 30, 40, 40); strokeWeight(0.8 * u);
  for (let i = 0; i < 4000; i++) {
    let x = random(width), y = random(height);
    beginShape();
    for (let s = 0; s < 80; s++) {
      vertex(x, y);
      const a = noise((x / u) * 0.0015, (y / u) * 0.0015) * TAU * 2;
      x += cos(a) * 2 * u; y += sin(a) * 2 * u;
    }
    endShape();
  }
}
function keyPressed() {
  if (key === ' ') { seed = Math.floor(Math.random() * 1e6); redraw(); }  // new seed, then deterministic
  if (key === 's') saveCanvas(`flow-${seed}-${width}`, 'png');
}
</script>
</body>
</html>
```

## Workflow

1. Write the brief: output medium and size, aspect, mood, palette constraints, runtime.
2. Build the system with all randomness behind the seed and all geometry in canvas units.
3. Render a seed grid; tune parameter ranges and composition; curate seeds.
4. Add controls (reseed, save, pause) and the URL parameters for seed and size.
5. Export at the target size; for plotters optimize the SVG; for loops render frames and encode.
6. Run the proof and report seeds, parameters, sizes and file paths.

## Proof

- Serve locally (`python -m http.server 8080`), then `npx playwright screenshot --wait-for-timeout 1500 "http://localhost:8080/?seed=42" a.png` twice and compare with `magick compare -metric AE a.png b.png null:` (0 differing pixels) or matching `sha256sum` output.
- Seed grid: render seeds 1-16 to thumbnails and tile them with `magick montage seed-*.png -tile 4x -geometry 400x400+4+4 grid.png`; view it.
- Resolution independence: render seed 42 at 1080 and 4320, downscale the large one with `magick big.png -resize 1080x1080 big-small.png`, and compare by eye or RMSE.
- Plotter SVG: `vpype read out.svg linemerge linesort write out-opt.svg` succeeds and the file contains only stroked paths.
- Loops: frames encode with `ffmpeg -framerate 60 -i frame-%05d.png -pix_fmt yuv420p loop.mp4`, and the last frame flows into the first.

## Stop and ask

- The brief asks to reproduce a specific living artist's signature style or a copyrighted piece.
- Print production needs CMYK, bleed or paper specs that are not given.
- The target requires platform-specific constraints (on-chain minting, hash-derived seeds) not described.

## Before returning

- [ ] Same seed renders identical output twice (pixel compare or hash)
- [ ] Every random and noise call flows from the seed; seed appears in URL and filenames
- [ ] Geometry, strokes and noise scale expressed in canvas units; pixel density explicit
- [ ] Seed grid reviewed; curated seeds and parameter ranges reported
- [ ] Export matches the target size, DPI or plotter format
- [ ] Palette checked for value contrast in grayscale; no default rainbow sweeps

## Skills in scope

- threejs-3d — 3D WebGL/WebGPU scenes, custom materials and spatial work.
- canvas-design — static posters and print-ready editorial compositions.
- motion-design — choreographed UI and SVG animation in live web apps.
- media-production — encoding rendered frame sequences into delivery video.
