---
name: manim-video
version: 1.1.1
description: "Manim Community Python videos: MathTex equations, Axes plots, geometry, transforms, ValueTracker updaters, rendered MP4 scenes. Use when animating an equation derivation, function plot, proof or physics/CS explainer in Python, or fixing a failing manim render or LaTeX error; ManimGL (3b1b) code is a different API. Not for UI demos or code walkthroughs (use media-production or motion-canvas-video)."
trigger: "Use when a request mentions manim, a Scene class with construct(), MathTex or Tex, or an animated math or science explanation."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: media
---

# Manim Video

## Selection card
- Task: Plan, render and inspect mathematical or scientific animation with Manim Community.
- Start: In the project environment run `python -m manim --version`, check whether code imports `manim` or `manimlib`, and run `latex --version` and `dvisvgm --version` if formulas are needed.
- Finish: the scene renders at the agreed quality, the final MP4 was probed and its densest frames viewed, and every formula and label was checked for mathematical correctness.

## Overview

A Manim video is a visual proof: the math must be right independently of the render, every transform must imply a true equivalence, and every frame must stay readable at delivery resolution.
Target Manim Community 0.22.1, checked against PyPI and stable documentation on 2026-10-23. Confirm Python/system requirements from package metadata and the installation guide. ManimGL is a different project with different APIs.
A successful render proves only that Python ran; it says nothing about correct math, overlapping labels or pacing.

## Rules

1. Confirm the flavor first: `from manim import *` is Manim Community; `from manimlib import *`, `ShowCreation`, `self.embed()` and `CONFIG` dicts are ManimGL. Translate examples, never paste across.
2. Derive the explanation before animating: quantities, units, assumptions and each equation step; the animation order follows the logical dependency order.
3. A morph asserts equality: apply `TransformMatchingTex` or `ReplacementTransform` only between expressions that are actually equal, or show the operation that changes them.
4. `Text` and `MarkupText` use Pango and installed fonts; `MathTex` and `Tex` need a LaTeX distribution plus dvisvgm. Prototype one formula with every required package before building the sequence.
5. Updaters are owned: anything added with `add_updater`, `always_redraw` or a `ValueTracker` dependency is removed (`clear_updaters`) when its role ends. Updaters run during every `wait()` and slow every frame.
6. Time explicitly: `run_time` per animation, deliberate `rate_func`, waits derived from the narration, and `self.next_section()` to split long videos.
7. Keep content in frame: the default frame is 8 units high and about 14.2 wide. Place with `to_edge(buff=...)` and `scale_to_fit_width(config.frame_width - 1)`; check the densest frame at final quality.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| Equation derivation | Split terms with `{{ }}` or `substrings_to_isolate`; `TransformMatchingTex` between steps; one color per variable via `set_color_by_tex` |
| Function plot | `Axes(x_range=[a, b, step], y_range=..., x_length=..., y_length=...)`; `axes.plot(f, x_range=..., discontinuities=[...])`; place points with `axes.c2p` |
| Parameter sweep | `ValueTracker` plus `always_redraw`; animate with `tracker.animate.set_value(v)` |
| Zoom or pan | `MovingCameraScene` and `self.camera.frame.animate.scale(0.5).move_to(target)` |
| 3D surface | `ThreeDScene`, `set_camera_orientation(phi=..., theta=...)`, `Surface`; preview at low quality because Cairo 3D is slow |
| LaTeX compile error | Render a single `MathTex` alone; read the `.log` under `media/Tex`; check raw strings and missing packages in a custom `TexTemplate` |
| Slow render | Look for heavy `always_redraw` bodies, updaters left running, high `-q` during iteration; keep caching on |
| Narration sync | Sections per narration beat; waits from measured voice durations, or the manim-voiceover plugin after checking its support for 0.22 |
| ManimGL example given | Map APIs to Community equivalents (ShowCreation to Create, `CONFIG` to `__init__` arguments) and re-test |

## Patterns and pitfalls

- **Raw strings** — write `MathTex(r"\frac{a}{b}")`; in a plain string `\f` is a form feed and `\b` a backspace.
- **Isolation boundaries** — an isolated substring that cuts through a LaTeX group (inside `\frac{...}`) fails to compile; isolate whole groups.
- **Transform semantics** — `Transform(a, b)` reshapes `a` and leaves `b` off the scene, so later animations on `b` show nothing; `ReplacementTransform(a, b)` is right when code continues with the target.
- **`.animate` interpolates end states** — `mob.animate.rotate(PI)` morphs straight to the end pose (it can shrink through the center); use `Rotate(mob, angle=PI)` for a true rotation.
- **Shared mobjects** — one mobject can only be in one place; `.copy()` it for a second appearance, and remove helper mobjects created inside updaters.
- **Layering** — later-added mobjects draw on top; `set_z_index` keeps labels above graphs and backgrounds below.
- **Quality presets** — `-ql` 480p15, `-qm` 720p30, `-qh` 1080p60, `-qp` 1440p60, `-qk` 2160p60. Previews at 15 fps look choppy, not slower. Custom output: `--resolution 1920,1080 --fps 30`.
- **Caching** — partial movies are cached by content hash under `media/videos/<module>/<quality>/partial_movie_files`; `--flush_cache` when a stale segment appears. Seed `random`/`numpy` yourself for reproducible layouts.
- **Fonts** — `Text(..., font="Inter")` falls back silently if the font is missing; list available fonts with `manimpango.list_fonts()`.
- **Renderer** — Cairo is the default and reference; `--renderer=opengl` previews faster but plugin and feature coverage differ, so verify the final render on the renderer you deliver from.
- **Backgrounds** — the default is black; for light themes set `config.background_color` and switch text, axes and stroke colors together.
- **Outputs** — `-s` saves the last frame as PNG, `--format gif` writes a GIF, `-t` renders with transparency; check `python -m manim render --help` for the container each flag produces.

## Workflow

1. Script narration beats against visual beats and equations; check each algebraic step (sympy `simplify(lhs - rhs) == 0` where applicable).
2. Verify the environment with `python -m manim checkhealth`; pin manim in the project's lockfile.
3. Create a style module: colors per variable, fonts, sizes, axes config, reusable helpers.
4. Build section by section; iterate with `-ql` and `-s` stills for layout.
5. Review the densest frames at `-qh`; fix overlaps and off-frame content.
6. Render the final quality; add narration through sections or media assembly; probe and play.
7. Report scene classes, exact command, environment and output paths.

## Proof

- Environment: `python -m manim checkhealth`
- Layout still: `python -m manim -ql -s scene.py Derivation`
- Final render: `python -m manim -qh scene.py Derivation`
- Streams: `ffprobe -v error -show_entries stream=width,height,r_frame_rate,pix_fmt:format=duration -of json media/videos/scene/1080p60/Derivation.mp4`
- Frames: `ffmpeg -ss 5 -i media/videos/scene/1080p60/Derivation.mp4 -frames:v 1 -update 1 f05.png` at each equation step; view them for overlaps and clipping.
- Math: a sympy check per transformed step, recorded in the report.

## Stop and ask

- The project uses ManimGL and the request would move it to Community (or the reverse).
- A LaTeX distribution or system packages (Cairo, Pango, FFmpeg) must be installed machine-wide.
- A mathematical or scientific claim cannot be verified from a derivation or a cited source.
- Narration requires paid voice generation.

## Before returning

- [ ] Manim Community APIs only; no manimlib imports or ManimGL idioms
- [ ] Every equation step and transform checked as mathematically valid
- [ ] LaTeX and fonts compile and render as intended; raw strings used
- [ ] Updaters removed when finished; no stray mobjects left on screen
- [ ] Densest frames viewed at final quality: no overlaps, nothing outside the frame
- [ ] Final MP4 probed for resolution, fps, duration and pixel format, and played back
- [ ] Scene class, render command and environment reported

## Sources

[Installation](https://docs.manim.community/en/stable/installation.html),
[quickstart](https://docs.manim.community/en/stable/tutorials/quickstart.html),
[reference manual](https://docs.manim.community/en/stable/reference.html),
[PyPI](https://pypi.org/pypi/manim/json).

## Skills in scope

- media-production — combining rendered scenes with audio stems, captions and final FFmpeg delivery.
- audio-studio — spoken narration timed to proof steps and waits.
- tech-stack — Python environments, Cairo/Pango/FFmpeg/LaTeX system dependencies and pins.
- motion-canvas-video — code walkthroughs and diagrams that are not mathematical scenes.
