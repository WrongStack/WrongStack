---
name: threejs-3d
description: "Build and optimize browser 3D scenes with Three.js, React Three Fiber, WebGPU or WebGL, TSL and glTF assets. Use when implementing cameras, materials, 3D interaction, model loading or renderer performance; preserve renderer compatibility and resource ownership."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "implementing cameras, materials, 3D interaction, model loading or renderer performance; preserve renderer compatibility and resource ownership."
metadata:
  routing-group: media
---

# Three.js and Browser 3D

## Selection card
- Task: Build interactive Three.js 3D rendering and shaders.
- Start: Identify the existing engine, scene, timeline and delivery format.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Latest stable targets checked 2026-10-09: Three.js 0.186.1 (r186),
@types/three 0.186.0, React Three Fiber 9.8.1 and Drei 10.7.9 with React 19.3.0.
Refresh these together before installation and check peer ranges.

## Rules

1. Choose the renderer from deployment requirements, materials and postprocessing.
   WebGPURenderer is a modern option with WebGL2 fallback; backend fallback does
   not guarantee every shader, compute feature or plugin behaves identically.
2. For WebGPU use the matching three/webgpu and three/tsl APIs. Initialize the
   renderer before rendering; keep supported WebGL paths when integration needs them.
3. Bound pixel ratio, shadow cost, render targets, texture sizes and geometry.
   Use frame/draw-call measurements, not a universal mesh-count threshold.
4. Keep allocations and React setState out of per-frame hot loops. Mutate owned
   scene refs for frame updates and use delta for frame-rate independent movement.
5. Dispose only resources the component owns. Cached glTF textures/materials may
   be shared across mounts; blindly disposing them breaks the remaining users.
6. Provide loading/error states and a useful non-canvas fallback. Preserve keyboard
   and pointer alternatives where the scene implements a user task.

## Workflow

1. Inspect browser targets, renderer and asset pipeline. Start with a simple lit
   scene and camera controls; validate the actual target browser before complex shaders.
2. Load assets with bounded error handling. In R3F, use Suspense around loading
   boundaries and inspect cache/disposal ownership.
3. Profile instancing, merging, compressed textures and geometry codecs against
   visual quality and download/decoder cost. Compress only where it helps.
4. Test resize, DPR changes, background tabs, repeated mounts, loading failure and
   context/device loss where supported.
5. Record cold-load size/time, frame performance and resource counts after repeated
   mount/unmount. Distinguish source correctness from rendered verification.

## Sources

[WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html),
[R3F performance pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls).

## Acceptance checks

- View the actual scene, test fallbacks and measure rendering/resources on the target device.

## Skills in scope

- react-modern — lifecycle and Suspense boundaries.
- motion-design — DOM transitions around the canvas.
- web-performance — download and frame profiling.
- accessibility — equivalent interaction outside the scene.
