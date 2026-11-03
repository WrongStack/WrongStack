---
name: motion-canvas-video
version: 1.1.1
description: "Motion Canvas TypeScript videos: makeScene2D, yield* generators, signals, Txt/Code/Line nodes, waitUntil narration cues, rendering. Use when building an animated diagram, code walkthrough or explainer timeline in Motion Canvas, syncing it to voiceover, or exporting frames or MP4. Not for interactive web UI motion (use motion-design) or equation-heavy math (use manim-video)."
trigger: "Use when a request mentions Motion Canvas, @motion-canvas packages, makeScene2D, yield* animations or a scripted 2D video timeline."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: media
---

# Motion Canvas Video

## Selection card
- Task: Animate and export a scripted 2D scene with Motion Canvas.
- Start: Read package.json, the lockfile, vite.config and src/project.ts; list the scenes, their .meta files and the configured exporter.
- Finish: the scene seeks and replays deterministically in the editor, the exported frames or MP4 were probed and viewed, and narration cues land on their beats.

## Overview

Motion Canvas is a deterministic, generator-driven timeline that renders through its browser editor: every frame must be reproducible from the scene code, its .meta files and the project settings.
Target Motion Canvas 3.17.2, verified 2026-11-02 for core, 2d, vite-plugin and ffmpeg packages. Motion Canvas is a video scene/timeline system; its JSX is not React and its generators are not browser animation hooks.
Scenes re-run from the start on every seek, so anything not derived from the generator and signals shows up as flicker or scrub-history-dependent frames.

## Rules

1. Verify all Motion Canvas package versions together and inspect the Vite plugin's peer range. Version 3.17.2 declares Vite 4.x or 5.x; latest Vite is 8.3.5. Do not force this unsupported combination or silently claim all packages are current and compatible. Report the blocker; isolate a compatible video workspace only when that tradeoff is authorized, or choose another renderer.
2. `yield*` waits for an animation to finish; compose with `all`, `sequence`, `chain`, `delay` and `waitFor`. Background loops must be started the way the Flow docs describe and must end with the scene.
3. Signals are the state. Pass functions as props (`text={() => String(count())}`) to stay reactive; reading `count()` once at construction freezes the value.
4. Sync narration with time events (`yield* waitUntil('intro-done')`). Their positions live in the scene's `.meta` file: commit .meta files, or the sync is lost.
5. Specify resolution, fps, background and exporter in the project settings before building. The default exporter writes an image sequence without audio; an MP4 needs the FFmpeg exporter or a separate mux.
6. Keep frames deterministic: no `Date.now()`, no `Math.random()` (use `useRandom()`), no module-level mutable state, no network data fetched during playback.
7. Load fonts and images before the first rendered frame and check frame 0: a late font swap makes the first frames use the fallback face.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| New video project | Check the scaffolder's current command in the quickstart; record installed Vite and plugin versions before writing scenes |
| Code walkthrough | `Code` node with the project's highlighter; animate with `code().selection(lines(...), 0.6)` and `code().code.replace(...)`, checking the Code docs for the installed version |
| Diagram with arrows | `Rect`, `Circle`, `Line` with `points` and `endArrow`; draw strokes progressively with `line().end(1, 0.8)` |
| Layout-heavy slide | `Layout` or `Rect` with the `layout` prop (flexbox); children's x/y are ignored inside a layout |
| Voiceover sync | Audio in `makeProject({ scenes, audio })`; `waitUntil` per beat; drag events in the editor timeline; commit .meta |
| Equation-heavy content | `Latex` node for display formulas; multi-step derivations go to manim-video |
| Talk or slide deck | `beginSlide('name')` and presenter mode |
| Flicker when scrubbing | Find module-level state, refs not re-created per run, randomness without `useRandom()` |
| Vite peer conflict | Report the declared peer range; propose an isolated workspace only with approval |

## Patterns and pitfalls

- **Not React** — nodes are created once; there are no hooks or re-renders. Change appearance through signals and tweens.
- **Refs** — `const box = createRef<Rect>()` with `ref={box}`, then `box()` returns the node; `makeRef(array, i)` for lists.
- **Tween syntax** — `yield* box().position.x(300, 0.8, easeInOutCubic)`; chain with `.to(0, 0.5)`; `sequence(0.1, ...)` staggers and `all(...)` runs in parallel.
- **Coordinates** — the origin is the scene center and y grows downward; positions are in pixels of the project resolution.
- **Resolution scale** — design at 1920x1080 and raise the render resolution scale for 4K; hard-coded sizes in another unit break layouts.
- **Time events vs waitFor** — `waitFor(2.3)` hard-codes timing that breaks when the voiceover is re-recorded; named events can be re-dragged without code edits.
- **Text** — the node is `Txt`; long text needs explicit `width` and `textWrap`; check line breaks at the final resolution.
- **Image-sequence export** — frames carry no audio and the filename pattern depends on settings; mux with FFmpeg at the same fps and check frame count equals fps times duration.
- **Editor-driven rendering** — rendering is started from the editor's video settings; there is no documented headless render command. If automation is required, report it rather than inventing a CLI.
- **Transparency** — PNG frames keep alpha only when the background is unset; H.264 MP4 drops alpha (use ProRes 4444 or WebM for overlays).

## Workflow

1. Inspect package.json, the lockfile, vite.config and src/project.ts; read the current quickstart before scaffolding; keep the package manager.
2. Storyboard scenes with labels and narration markers; decide resolution, fps and background.
3. Prototype one scene: refs, signals, one sequential and one parallel transition. Seek, scrub backwards and replay repeatedly before building more.
4. Add narration audio and time events; tune events against the waveform in the editor.
5. Inspect boundary frames; export a short range; check fonts, alpha, timing and audio.
6. Export the final frames or MP4; mux audio when exporting an image sequence; probe and play.

## Proof

- Types: `npx tsc --noEmit` (or the project's typecheck script).
- Editor: start the project's dev script, seek to the middle of each scene and back to 0, replay; frames must be identical.
- Frame count: number of files in the output folder equals fps times scene duration.
- Mux when needed: `ffmpeg -framerate 30 -i output/project/%06d.png -i voice.wav -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart out.mp4` (match the actual filename pattern and fps).
- Streams: `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt:format=duration -of json out.mp4`
- Frames: extract first, cue-boundary and last frames with `ffmpeg -ss 4 -i out.mp4 -frames:v 1 -update 1 cue.png` and view them.

## Stop and ask

- The Vite peer conflict needs a separate workspace, a downgrade or a different renderer.
- Rendering must run headless in CI and no supported path exists.
- Narration audio is missing or must be generated with a paid provider.
- The request would move an existing Remotion or Manim pipeline to Motion Canvas.

## Before returning

- [ ] `@motion-canvas/*` versions aligned and the Vite peer range checked; any blocker reported
- [ ] Animations built from `yield*`, `all`, `sequence`, `chain` and signals; no wall-clock or unseeded randomness
- [ ] Seeking and replay produce identical frames; .meta files with time events committed
- [ ] Fonts and assets resolved before frame 0
- [ ] Exported artifact probed for resolution, fps, duration and audio; frames viewed at cue boundaries
- [ ] Render settings, export method and mux command reported

## Sources

[Quickstart](https://motioncanvas.io/docs/quickstart/),
[animation flow](https://motioncanvas.io/docs/flow/),
[npm plugin metadata](https://registry.npmjs.org/@motion-canvas/vite-plugin/latest).

## Skills in scope

- media-production — multi-shot assembly, FFmpeg H.264/ProRes encoding and subtitle burn-in.
- audio-studio — voiceover and music matched to scene cues.
- tech-stack — isolated workspace dependencies when `@motion-canvas/vite-plugin` peer ranges lag the app's Vite.
- manim-video — equation derivations and scientific scenes in Python.
