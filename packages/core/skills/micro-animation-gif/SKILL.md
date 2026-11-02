---
name: micro-animation-gif
description: "Animated GIFs for Slack/Discord emoji, GitHub PRs and release notes via Pillow, FFmpeg palettegen and gifsicle, under byte budgets. Use when making an animated emoji, loading spinner, badge loop or short screen-recording GIF, or shrinking a GIF that is too large, flickers or has fringed transparency. Not for full videos with audio (use media-production) or live web UI animation (use motion-design)."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request asks for a GIF, animated emoji, looping sticker, or a smaller version of an animated image."
metadata:
  routing-group: media
---

# Micro-Animation GIF

## Selection card
- Task: Produce small, seamless animated GIFs for chat, PRs and release notes within a byte budget.
- Start: Write the budget (destination, dimensions, byte ceiling, fps, loop length, background theme) and check which of Pillow, `ffmpeg -version` and `gifsicle --version` are available.
- Finish: the GIF meets the byte budget by measured size, its delays and frame count are confirmed by gifsicle or ffprobe, and the coalesced first and last frames were viewed for the loop seam and edge fringes.

## Overview

A GIF is a 256-color, 1-bit-alpha format timed in hundredths of a second: small, smooth and clean results come from designing for those limits (few colors, one shared palette, small changing regions, delays of 20 ms or more), not from compression after the fact.
Tooling (checked 2026-11-02: Pillow 13.0.0 on PyPI, FFmpeg 9.0.2 stable, sharp 0.35.5 on npm).
File size scales with the pixels that change per frame times the frame count; colors are the second lever.

## Rules

1. Set the budget before drawing: dimensions, byte ceiling, frames, fps and loop length. Platform limits change; confirm them (Slack emoji is commonly cited at 128 KB and 128x128) before promising a fit.
2. Delays are stored in 10 ms units, and browsers treat delays of 10 ms or less as about 100 ms, so a "100 fps" GIF plays at 10 fps. Use multiples of 10 ms from 20 ms upward (50 ms = 20 fps); Pillow rounds 33 ms to 30 ms and the loop drifts.
3. Use one shared palette for flat graphics; per-frame palettes make colors flicker. With FFmpeg, generate the palette (palettegen) and apply it (paletteuse) in two passes; dithering off for flat art, ordered (bayer) for gradients because it compresses better than error diffusion.
4. Transparency is on or off per pixel. Anti-aliased edges against transparency leave halos on the other theme; matte to the known background, keep edges pixel-crisp, or ship light and dark variants.
5. Loop seamlessly: drive the animation by t = i / N over one full period so frame N would equal frame 0; never duplicate the first frame at the end.
6. Optimize last with `gifsicle -O3` (frame-difference cropping), then `--colors` and `--lossy` only as far as the eye allows; verify the byte count of the real file.
7. Respect motion sensitivity: no more than three flashes per second, short loops, and a static alternative where the platform allows (a `<picture>` source with `prefers-reduced-motion` on web pages).
8. Prefer a better format where accepted: GitHub PRs take MP4 uploads, web pages can use animated WebP/AVIF or a muted looping video. GIF is for places that accept nothing else.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| Emoji or spinner | Draw at 4x in RGB on the matte color, downsample with LANCZOS for anti-aliasing, 12-24 frames, shared 32-64 color palette |
| Screen recording to GIF | Trim to the 3-6 s that matter, crop to the changing region, scale to 480-800 px wide, 10-15 fps, two-pass palette, `gifsicle -O3` |
| GIF too large | Measure frames, dimensions and changing area; cut fps, crop, shorten, reduce colors, then `--lossy` |
| Colors flicker or band | Replace per-frame palettes with one shared palette; `stats_mode=diff` for recordings with a static background |
| White or dark halo | Matte to the destination background or threshold alpha; make light and dark variants for themed chat |
| Plays slower than designed | Check delays with `gifsicle --info`; anything at or below 10 ms is clamped |
| Needs real alpha and smooth edges | APNG or animated WebP where the destination supports them |
| Email release notes | Some Outlook desktop versions show only the first frame; make frame 0 carry the message |

## Generation pattern (Pillow, opaque with shared palette)

```python
from PIL import Image, ImageDraw
import math

S, N, SS, BG = 128, 24, 4, (255, 255, 255)   # size, frames, supersample, matte
frames = []
for i in range(N):
    t = i / N                                    # frame N would equal frame 0
    im = Image.new("RGB", (S * SS, S * SS), BG)
    r, c = (24 + 8 * math.sin(2 * math.pi * t)) * SS, S * SS / 2
    ImageDraw.Draw(im).ellipse([c - r, c - r, c + r, c + r], fill=(16, 185, 129))
    frames.append(im.resize((S, S), Image.Resampling.LANCZOS))

sheet = Image.new("RGB", (S, S * N))
for k, f in enumerate(frames):
    sheet.paste(f, (0, S * k))
pal = sheet.quantize(colors=32, method=Image.Quantize.MEDIANCUT)
out = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
out[0].save("pulse.gif", save_all=True, append_images=out[1:], duration=50, loop=0, disposal=1)
```

Then optimize: `gifsicle -O3 pulse.gif -o pulse.min.gif`.

## Patterns and pitfalls

- **ImageDraw has no anti-aliasing** — draw at 3-4x and downsample, or edges stair-step at 128 px.
- **RGBA quantization** — Pillow quantizes RGBA only with FASTOCTREE or LIBIMAGEQUANT; for transparent GIFs threshold alpha to 0 or 255 first and keep the transparent index consistent across frames.
- **Disposal** — moving shapes over transparency need `disposal=2` (restore to background) or they leave trails; opaque full frames with `disposal=1` let gifsicle store only changed rectangles.
- **Palette from one frame** — colors that appear only later get mapped wrongly; build the palette from all frames (a sprite sheet, or `stats_mode=full`).
- **Text in GIFs** — small text dithers into noise; keep it large, flat and on a solid fill, or move it to the surrounding message.
- **Recording noise** — cursor jitter, clocks and notification badges change pixels every frame and destroy compression; hide them before recording.
- **Viewer differences** — some viewers ignore loop counts or render the first frame only; check in the actual destination.
- **Coalescing** — optimized GIFs store partial frames; extract with coalescing or the frames look broken.

## Workflow

1. Write the budget and confirm destination limits.
2. Choose the source: procedural drawing (Pillow), a rendered animation, or a trimmed screen recording.
3. Produce frames at 3-4x for drawn art; keep timing on a 10 ms grid and the loop periodic.
4. Encode with a shared palette (Pillow quantize or FFmpeg two-pass).
5. Optimize with gifsicle; iterate on fps, crop, colors and lossy against the budget.
6. Run the proof; view in the destination (light and dark themes for chat).

## Proof

- Two-pass encode: `ffmpeg -i clip.mp4 -vf "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 out.gif`
- Optimize: `gifsicle -O3 --colors 64 --lossy=40 out.gif -o out.min.gif`
- Structure: `gifsicle --info out.min.gif` shows frame count, per-frame delays, disposal and loop count.
- Streams and size: `ffprobe -v error -count_frames -show_entries stream=width,height,nb_read_frames:format=duration,size -of json out.min.gif`
- Frames: `magick out.min.gif -coalesce frame-%02d.png`; view the first and last frames on light and dark backgrounds.
- Seam: `magick compare -metric RMSE frame-23.png frame-00.png null:` should be similar to the difference between neighbouring frames.

## Stop and ask

- The budget cannot be met without cutting content the request requires.
- The destination accepts video or WebP and GIF quality is suffering for no reason.
- The animation would flash more than three times per second or show sensitive screen content.

## Before returning

- [ ] Measured byte size is under the stated budget for the destination
- [ ] Dimensions, frame count and delays confirmed; delays on the 10 ms grid and at least 20 ms
- [ ] One shared palette; no color flicker between frames
- [ ] Loop seam viewed on coalesced first and last frames
- [ ] Edges checked on the destination's light and dark backgrounds
- [ ] No more than three flashes per second; sensitive screen content removed

## Skills in scope

- media-production — FFmpeg filtergraphs, Remotion and full video pipelines.
- motion-design — web UI micro-interactions, springs and CSS or Motion transitions.
- design-assets — optimizing raster, vector and animated assets for web delivery.
