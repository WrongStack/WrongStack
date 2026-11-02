---
name: threejs-3d
description: "Three.js and React Three Fiber 3D: WebGPURenderer, TSL shaders, glTF/KTX2/Draco/Meshopt assets, cameras, disposal, draw calls. Use when building or debugging a 3D scene, porting GLSL ShaderMaterial to TSL, loading or compressing models, fixing GPU memory leaks or low frame rates, or upgrading three across releases. Not for 2D canvas art (use algorithmic-art) or DOM UI animation (use motion-design)."
version: 1.3.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request touches three, @react-three/fiber, drei, .glb or .gltf assets, WGSL or GLSL shaders, or WebGPU rendering in the browser."
metadata:
  routing-group: media
paths: ["*.{glsl,wgsl,vert,frag}"]
---

# Three.js and Browser 3D

## Selection card
- Task: Build, port and optimize interactive Three.js / R3F scenes, shaders and 3D assets.
- Start: Read package.json for three, @types/three, @react-three/fiber and drei; grep for `three/webgpu` vs `three` imports, ShaderMaterial and EffectComposer usage; list the target browsers and devices.
- Finish: the scene renders on the target backend and its fallback, renderer.info numbers are recorded before and after the change, mount/unmount cycles return memory to baseline, and checks below pass.

## Overview

Browser 3D is a GPU budget problem with a resource-ownership problem attached: count draw calls, texture memory and shader compiles, and dispose exactly what you created.
Latest stable targets checked 2026-11-02: Three.js 0.187.0 (r187), @types/three 0.187.0, React Three Fiber 9.8.2 and Drei 10.7.9 with React 19.3.1. Refresh these together before installation and check peer ranges.
three ships breaking changes between r-numbers; read the migration guide entry for every release you cross.

## Rules

1. Choose the renderer deliberately. WebGPURenderer (`three/webgpu`) falls back to WebGL2, but it does not run GLSL `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile` or classic `EffectComposer` passes; port them to TSL node materials and the node `RenderPipeline` (named `PostProcessing` before r183). Never mix the two stacks.
2. Initialize before the first frame: `await renderer.init()`, or drive rendering with `renderer.setAnimationLoop`. Test the fallback path with `forceWebGL: true` on targets without WebGPU.
3. Budget by measurement: `renderer.info.render.calls` and `.triangles` per frame plus `renderer.info.memory`. Every mesh-material pair costs a draw call, and every shadow-casting light re-renders its casters (a point light six times).
4. Dispose what you own. Removing an object from the scene frees nothing on the GPU: call `dispose()` on geometries, materials, textures and render targets, and `close()` on ImageBitmaps. R3F disposes JSX-created objects on unmount, but not `<primitive object>` or cached `useGLTF` scenes, which may be shared.
5. Ship GPU-ready assets: KTX2/Basis textures stay compressed in VRAM while PNG and JPEG expand to full RGBA; Meshopt or Draco for geometry. Configure KTX2Loader with a transcoder path and `detectSupport(renderer)`, plus the Draco or Meshopt decoder.
6. Manage color: color textures get `colorSpace = SRGBColorSpace`, data maps (normal, roughness, metalness, AO) keep `NoColorSpace`. GLTFLoader sets these; hand-loaded textures need them explicitly. Pick tone mapping (ACES, AgX, Neutral) and exposure once, deliberately.
7. Keep the frame loop allocation-free and out of React state: mutate refs, reuse scratch vectors, scale motion by delta; use `frameloop="demand"` with `invalidate()` for scenes that are mostly still.
8. Precompile before reveal (`renderer.compileAsync(scene, camera)`) to avoid first-interaction shader stalls; ship a loading state and a non-3D fallback.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| New scene | Decide WebGPU vs WebGL from browser targets and needed features; lit test scene, controls, stats overlay; baseline numbers on the weakest device |
| Port GLSL to WebGPU | Rewrite as a TSL `Fn` on a node material (`colorNode`, `positionNode`); parameters as `uniform()` nodes updated through `.value` |
| Low frame rate | Read `renderer.info`; check shadows, DPR, transparent overdraw, post-processing passes; decide CPU-bound vs GPU-bound in a performance trace |
| Memory grows across navigations | Compare `renderer.info.memory` before and after mount cycles; look for render targets, loader textures, listeners and observers left behind |
| Model slow or huge | `npx @gltf-transform/cli inspect model.glb`; resize textures, KTX2 compress, Meshopt geometry, prune unused nodes |
| Black screen on WebGPU | Missing `init()`, a GLSL material on the node renderer, TSL errors in the console; retry with `forceWebGL` |
| Too dark or washed out after upgrade | Texture color spaces, output color space, tone mapping; light units changed in r155 (legacy lights removed), so old intensities need rescaling |
| R3F with WebGPU | Pass an async `gl` factory that constructs and initializes WebGPURenderer, after checking the R3F v9 docs for the supported pattern |
| Upgrade across releases | Walk the migration guide per r-number (for example Clock deprecated in favor of Timer in r183); align @types/three |
| Slow picking | three-mesh-bvh accelerated raycast, layers, simplified collider meshes |

## Patterns and pitfalls

- **Transparency sorting** — sorted per object, not per triangle, so overlapping transparent meshes flicker; prefer cutouts (`alphaTest: 0.5` or `alphaHash: true`), `depthWrite: false`, or explicit `renderOrder`.
- **Depth precision** — z-fighting comes from a tiny `near`; keep near as large as the scene allows before reaching for logarithmic depth.
- **Pixel ratio** — fragment cost scales with pixels; cap DPR at 2 (`dpr={[1, 2]}` in R3F) and lower it adaptively under load.
- **Shadows** — each light's map is a full scene render; tighten the shadow camera frustum, keep map sizes modest, and set `shadowMap.autoUpdate = false` with `needsUpdate` for static scenes.
- **Texture memory math** — 4096x4096 RGBA is about 64 MB, about 85 MB with mipmaps; ten of those exhaust a mobile GPU.
- **Instancing** — set `instanceMatrix.needsUpdate = true` after edits and call `computeBoundingSphere()` after moving instances, or culling hides them; BatchedMesh merges different geometries sharing a material.
- **Resize** — update `camera.aspect`, call `updateProjectionMatrix()` and `renderer.setSize(w, h, false)` from a ResizeObserver on the container (R3F does this for you).
- **Context and device loss** — handle `webglcontextlost` (prevent default to allow restore) and WebGPU `device.lost`; mobile Safari drops contexts under memory pressure.
- **Draco vs Meshopt** — Draco yields the smallest geometry but decodes slower in WASM; Meshopt decodes fast, compresses further with gzip or brotli and handles animation data.
- **Shared glTF caches** — `useGLTF` returns cached objects; `scene.clone()` shares geometry and materials, and skinned meshes need `SkeletonUtils.clone`. Never dispose shared resources from one consumer.
- **TSL node churn** — building new nodes every frame triggers recompiles; build the graph once and update uniforms.
- **Canvas accessibility** — the canvas is invisible to assistive tech; mirror essential information and controls in the DOM and stop auto-rotation and camera drift under reduced motion.

## Workflow

1. Inspect versions, renderer imports, target browsers and the asset pipeline.
2. Build a minimal scene and record baseline draw calls, triangles, memory and frame time on the weakest target.
3. Inspect and optimize assets; wire KTX2, Draco or Meshopt loaders with local decoder paths.
4. Implement with clear ownership: whoever creates a GPU resource disposes it; the frame loop stays allocation-free.
5. Exercise resize, DPR change, background tab, ten mount/unmount cycles, load failure, context loss and the WebGL fallback.
6. Report before and after numbers, the backend tested, and what was not tested on real hardware.

## Proof

- Project checks: the repo's typecheck and test scripts (for example `npx tsc --noEmit`), with @types/three matching three.
- Assets: `npx @gltf-transform/cli inspect model.glb`, then `npx @gltf-transform/cli optimize in.glb out.glb --texture-compress ktx2 --compress meshopt` (confirm flags with `--help` for the installed version).
- Runtime numbers: log `renderer.info.render.calls`, `renderer.info.render.triangles`, `renderer.info.memory.geometries` and `renderer.info.memory.textures` before and after ten mount cycles; they must return to baseline.
- Frame time: Chrome Performance panel with GPU track, or stats-gl / r3f-perf overlays on the target device.
- Visual: `npx playwright screenshot --wait-for-timeout 3000 http://localhost:5173 scene.png`; headless CI often lacks WebGPU and needs software GL flags, so test the WebGL fallback there and WebGPU on real hardware.

## Stop and ask

- Switching between WebGL and WebGPU renderers, or between vanilla three and R3F.
- An upgrade that crosses many r-releases or changes peer React versions.
- Model, texture or HDRI licensing is unclear.
- No target device or frame budget is defined for a performance claim.

## Before returning

- [ ] three, @types/three, @react-three/fiber and drei versions aligned with their peer ranges
- [ ] Renderer stack consistent: no GLSL materials or EffectComposer on WebGPURenderer
- [ ] Draw calls, triangles and memory recorded before and after the change
- [ ] Ten mount/unmount cycles return renderer.info.memory to baseline; shared caches untouched
- [ ] Texture color spaces and tone mapping set deliberately
- [ ] Frame loop free of allocations and React state updates
- [ ] DPR capped; loading, error and non-3D fallbacks present; reduced motion respected

## Sources

[WebGPURenderer](https://threejs.org/docs/pages/WebGPURenderer.html),
[R3F performance pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls),
[three.js migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide),
[glTF Transform](https://gltf-transform.dev/).

## Skills in scope

- react-modern — React 19 Suspense boundaries, ref lifecycle cleanup and state outside the canvas.
- motion-design — DOM overlay transitions and scroll progress coordinated with camera states.
- web-performance — glTF/KTX2 payload sizing, shader compile stalls and frame pacing.
- accessibility — reduced-motion camera behavior and DOM equivalents for 3D interactions.
- algorithmic-art — seeded 2D generative pieces that do not need a 3D scene graph.
