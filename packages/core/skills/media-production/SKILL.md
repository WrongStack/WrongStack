---
name: media-production
description: "Create and process finished videos with Remotion, Motion Canvas, Manim, FFmpeg or an available AI video provider. Use when producing a video, UI demo, explainer, subtitles, narration timeline or format conversion; select the renderer from the content rather than defaulting every video to one engine."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "producing a video, UI demo, explainer, subtitles, narration timeline or format conversion; select the renderer from the content rather than defaulting every video to one engine."
metadata:
  routing-group: media
---

# Media Production

## Selection card
- Task: Produce Remotion videos or assemble and encode media.
- Start: Identify the existing engine, scene, timeline and delivery format.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Deliver a playable video with reproducible source and observed output checks.
Latest stable targets checked 2026-10-09: Remotion 4.0.534, Motion Canvas 3.17.2,
Manim Community 0.22.0 and FFmpeg 9.0.2. Refresh these before a new setup.

## Rules

1. Inspect the existing media project, renderer, lockfiles and installed codecs.
   Preserve an established pipeline unless a change is requested or necessary.
2. Choose the engine by the intended content. Multiple engines can contribute
   shots, but normalize their framerate, dimensions and audio before assembly.
3. Make time deterministic. Render from frames or a controlled timeline, never
   wall-clock timers, unseeded randomness or live network state.
4. Specify dimensions, duration, fps, safe areas, delivery codec/container,
   caption treatment and audio requirements. Label demo data and generated media.
5. Inspect rights and renderer/provider licensing. Local rendering consumes
   compute and may carry license obligations; never promise universal zero cost.
6. Render into a task-owned output directory. Preserve accepted masters and
   source assets. Clean only disposable intermediates you own after validation.

## Choose and load

| Content | Preferred path | Read when selected |
|---|---|---|
| React UI, product demo, data-driven variations | Remotion | [Remotion workflow](references/remotion.md) |
| Diagram, vector scene, timed code animation | Motion Canvas | motion-canvas-video skill |
| Equations, geometry, scientific explanation | Manim Community | manim-video skill |
| Trim, transcode, crop/pad, subtitles, audio mux | FFmpeg | [delivery workflow](references/ffmpeg.md) |
| Cinematic or photographic generated shots | Available AI video provider | Live provider model/API documentation |

## Workflow

1. Turn the brief into a shot list: purpose, duration, visuals, voice/captions,
   transitions and assets. A small clip needs a short list, not a production bible.
2. Prototype one representative shot, including text at delivery resolution.
   Resolve font/loading/export dependencies before building the full timeline.
3. Implement reusable scenes. For AI shots, record the exact supported model,
   aspect ratio, duration, settings, request id and chosen take.
4. Render low-cost previews of first/last frames and transition boundaries.
   Inspect legibility, clipping, safe areas and continuity; listen to the audio.
5. Render the final file. Probe dimensions, fps, streams and duration, then play
   it. A successful process or nonzero file size alone is not delivery proof.
6. Report source entrypoint, render command, final artifact, output properties,
   checks and any missing audio/visual verification.

## Acceptance checks

- Render, probe and play the final video; verify dimensions, timing, streams, captions and audio.

## Skills in scope

- audio-studio — music and narration.
- motion-canvas-video — generator-based animated scenes.
- manim-video — mathematical and scientific scenes.
- threejs-3d — real-time 3D assets and scene integration.
- office-documents — related slide or document deliverables.
