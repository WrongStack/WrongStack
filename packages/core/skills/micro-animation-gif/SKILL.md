---
name: micro-animation-gif
description: "Generate compact, optimized animated GIFs for team chat (Slack/Discord), GitHub PRs, release notes, and UI micro-interactions using Pillow or FFmpeg. Use when creating animated emojis, loading spinners, badge animations, or lightweight UI demo loops under tight file-size constraints."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "creating animated emojis, loading spinners, badge animations, or lightweight UI demo loops under tight file-size constraints."
metadata:
  routing-group: media
---

# Micro-Animation GIF — WrongStack

## Selection card
- Task: Generate optimized, lightweight animated GIFs for chat and web.
- Start: Define target dimension (128x128 emoji or 480x480 demo), frame budget, and loop constraints.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

High-quality micro-animations convey user interface interactions, brand flair, and status updates
without the bandwidth bloat of raw video files. This skill builds optimized looping GIFs
using Python Pillow or FFmpeg with strict color quantization and byte-budget discipline.

## Dimension & File Budget Constraints

- **Chat Emojis (Slack / Discord)**:
  - Dimensions: 128x128 px.
  - File Budget: < 128 KB (strict upload ceiling).
  - Framerate: 10–15 FPS; duration: 1.0–2.5 seconds loop.
  - Palette: Quantized to 32–64 colors with transparency masking.
- **PR Demo & Release Clips**:
  - Dimensions: 480x480 px or 640x360 px (16:9).
  - File Budget: < 2.0 MB.
  - Framerate: 20–24 FPS; duration: 3.0–5.0 seconds seamless loop.
  - Palette: Quantized to 128 colors.

## Generation Pattern (Python Pillow)

```python
from PIL import Image, ImageDraw
import math

width, height = 128, 128
num_frames = 24
frames = []

for i in range(num_frames):
    angle = (2 * math.pi * i) / num_frames
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Center pulse circle
    cx, cy = width // 2, height // 2
    radius = 24 + int(8 * math.sin(angle))
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                 fill=(16, 185, 129, 255), outline=(255, 255, 255, 255), width=2)

    # Orbiting indicator
    ox = cx + int(40 * math.cos(angle))
    oy = cy + int(40 * math.sin(angle))
    draw.ellipse([ox - 6, oy - 6, ox + 6, oy + 6], fill=(245, 158, 11, 255))

    frames.append(img)

# Save with global palette quantization and infinite loop
frames[0].save(
    "pulse_indicator.gif",
    save_all=True,
    append_images=frames[1:],
    duration=50,  # 50ms = 20 fps
    loop=0,
    optimize=True,
    disposal=2
)
```

## Optimization Rules

1. **Loop Seam Matching**: Ensure frame `N-1` transitions smoothly into frame `0` without visual jerk.
2. **Quantization & Dithering**: Apply Floyd-Steinberg dithering only for gradients; disable dithering on solid flat shapes to dramatically shrink file size.
3. **Disposal Mode**: Set `disposal=2` (restore to background) when animating transparent backgrounds to eliminate ghost trail artifacts.

## Acceptance checks

- Animated GIF loops seamlessly without jarring jump-cuts.
- File size is strictly within target limits (< 128 KB for emoji, < 2 MB for demo clip).
- Palette quantization is verified; transparent areas render without fringing or ghosting.
- Playback framerate and timing are verified across standard image viewers.
