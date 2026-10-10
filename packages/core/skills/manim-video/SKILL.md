---
name: manim-video
version: 1.0.1
description: "Create mathematical, geometric and scientific videos with Manim Community in Python. Use when animating equations, graphs, transformations or educational explanations; distinguish Manim Community from ManimGL and deliver a rendered, inspected video."
trigger: "animating equations, graphs, transformations or educational explanations; distinguish Manim Community from ManimGL and deliver a rendered, inspected video."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: media
---

# Manim Video

## Selection card
- Task: Render mathematical animation with Manim Community.
- Start: Identify the existing engine, scene, timeline and delivery format.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Target Manim Community 0.22.0, checked against PyPI and stable documentation on
2026-10-09. Confirm Python/system requirements from package metadata and the
installation guide. ManimGL is a different project with different APIs.

## Rules

1. Inspect the project's environment and imports. Use its virtual environment
   and dependency manager; avoid global installation or copying ManimGL examples
   into Manim Community.
2. Derive the explanation before the animation: quantities, units, assumptions,
   equation steps, axes and what each transformation means.
3. Use Scene or a supported specialized scene, explicit run_time and deliberate
   waits. Updaters must have bounded ownership and be removed when no longer needed.
4. Validate mathematical correctness independently from a successful render.
   Avoid transforms that visually imply an invalid equivalence.
5. Distinguish Text from Tex/MathTex. LaTeX requires external tooling; prototype
   one formula and required font before building a long sequence.
6. Select the renderer for needed capabilities. Do not assume Cairo and OpenGL
   have identical output or plugin support.

## Workflow

1. Plan the narration and visual proof with representative formulas.
2. Create reusable labels, axes, colors and transformations with a stable visual
   identity. Keep critical content inside the output frame.
3. Render a low-quality preview and inspect layout, glyphs, direction of motion
   and timing. Re-render boundary frames after corrections.
4. Render the final scene at the agreed dimensions/fps. Add narration or subtitles
   through the installed integration or final media assembly.
5. Probe and play the final artifact; inspect numerical labels and every equation.
   Provide the scene class, environment/lockfile and exact render command.

## Minimal scene

~~~python
from manim import Circle, Create, Scene, Transform, Square

class ShapeTransition(Scene):
    def construct(self):
        shape = Circle()
        self.play(Create(shape), run_time=1)
        self.play(Transform(shape, Square()), run_time=1)
        self.wait(0.5)
~~~

From the selected environment: python -m manim -ql scene.py ShapeTransition.
Use python -m manim --help for current quality, renderer and output flags.
This example avoids LaTeX; mathematical scenes should verify its availability.

## Sources

[Installation](https://docs.manim.community/en/stable/installation.html),
[quickstart](https://docs.manim.community/en/stable/tutorials/quickstart.html),
[PyPI](https://pypi.org/pypi/manim/json).

## Acceptance checks

- Render and play the final file; verify mathematical meaning, layout and duration.

## Skills in scope

- media-production — narration, subtitles and final encoding.
- audio-studio — spoken explanation.
- tech-stack — Python and system dependency compatibility.
