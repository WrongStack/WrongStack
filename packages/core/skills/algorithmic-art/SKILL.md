---
name: algorithmic-art
description: "Create generative, mathematical, and algorithmic art using p5.js, Canvas2D, or WebGPU shaders with seeded randomness and parameter controls. Use when authoring code-driven visual art, flow fields, particle simulations, or geometric patterns without AI aesthetic clichés."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "authoring code-driven visual art, flow fields, particle simulations, or geometric patterns without AI aesthetic clichés."
metadata:
  routing-group: media
---

# Algorithmic Art — WrongStack

## Selection card
- Task: Generate code-driven algorithmic and mathematical artwork.
- Start: Define visual movement, coordinate space, noise functions, and random seed.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Algorithmic art expresses computational aesthetic movements through code rather than static pixels.
Produce deterministic, seedable, high-craft generative pieces in standalone HTML/JS or p5.js
using mathematical rigor, vector fields, cellular automata, or parametric curves.
Avoid generic AI visual clichés (e.g. flat purple/cyan neon blobs, uncalibrated concentric circles).

## Core Principles

1. **Deterministic Reproducibility**:
   - Always expose a controllable `seed` (PRNG: Mulberry32 or splitmix32) so compositions can be perfectly re-rendered.
   - Keep canvas dimensions explicitly bounded (e.g. 1920x1080 or responsive square 1080x1080).
2. **Computational Depth**:
   - Favor multi-octave Simplex/Perlin noise, curl noise, attractor systems (Strange, Lorenz, Clifford),
     reaction-diffusion, or Voronoi tessellations over basic trigonometric sine waves.
   - Employ particle density fields, differential line growth, or harmonic wave interference.
3. **Palette & Material Craft**:
   - Formulate restrained, deliberate color schemes (3 to 5 colors maximum) with deliberate value contrast.
   - Add subtle grain, optical texture, or stroke-weight modulation to prevent sterile digital flatness.
4. **Interactive Controls**:
   - Expose essential parameter tweaking via keyboard triggers (e.g., Space to reseed, 'S' to save PNG, 'P' to pause animation).

## Recommended Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Generative Artwork</title>
  <script src="https://cdn.jsdelivr.net/npm/p5@1.11.0/lib/p5.min.js"></script>
  <style>
    body { margin: 0; background: #0f1115; display: flex; justify-content: center; align-items: center; min-height: 100vh; overflow: hidden; }
    canvas { box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
  </style>
</head>
<body>
  <script>
    let seed = 42;
    function setup() {
      createCanvas(1080, 1080);
      randomSeed(seed);
      noiseSeed(seed);
      noLoop();
      drawArtwork();
    }
    function drawArtwork() {
      // High-craft particle or vector field drawing implementation
    }
    function keyPressed() {
      if (key === ' ') { seed = floor(random(100000)); setup(); }
      if (key === 's' || key === 'S') saveCanvas('artwork-' + seed, 'png');
    }
  </script>
</body>
</html>
```

## Acceptance checks

- Randomness is seed-driven; refreshing with the same seed reproduces the identical frame.
- Algorithmic depth is verified through complex mathematical or emergent behavior.
- High-resolution export mechanism (PNG/SVG/WebM) is functional and verified.
- Visual output avoids default AI slop and respects intentional palette boundaries.
