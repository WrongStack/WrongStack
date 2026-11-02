---
name: media-production
description: "Video production with Remotion, FFmpeg, Motion Canvas, Manim or AI video: MP4/WebM renders, captions, narration mux, transcodes. Use when producing a product demo, explainer or social clip, burning or muxing subtitles, normalizing audio, or converting, trimming or compressing video; pick the engine from the content. Not for live web UI animation (use motion-design) or composing music and voice (use audio-studio)."
version: 1.3.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request renders or encodes video: Remotion compositions, ffmpeg commands, MP4/WebM delivery, captions or a narration timeline."
metadata:
  routing-group: media
---

# Media Production

## Selection card
- Task: Plan, render and deliver finished video: engine choice, shot list, encode, captions, audio mux.
- Start: Run `ffmpeg -version`, read the media project's lockfile and render scripts, and probe every source asset with ffprobe.
- Finish: the delivered file passes the stream and decode checks below, boundary frames were extracted and viewed, loudness was measured, and the render command reproduces it.

## Overview

A video is done when the delivered file plays on the target player with legible frames, synced audio at the right loudness and a command that reproduces it, not when the renderer exits 0.
Latest stable targets checked 2026-11-02: Remotion 4.0.540, Motion Canvas 3.17.2, Manim Community 0.22.1 and FFmpeg 9.0.2. Refresh these before a new setup.
Most delivery bugs are invisible in an editor preview: wrong pixel format, untagged color, variable frame rate, a moov atom at the end, audio drift.

## Rules

1. Probe before building and after rendering: container, codec, pixel format, fps, duration and audio layout are facts from `ffprobe -v error -show_streams -show_format`, never assumptions.
2. Compatibility delivery is H.264 in MP4 with `-pix_fmt yuv420p`, even dimensions, `-movflags +faststart` and AAC at 48 kHz. RGB/PNG sources otherwise encode as yuv444p, which QuickTime, Safari, phones and many uploaders refuse or show black.
3. Time comes from the frame index, never the wall clock: Remotion `useCurrentFrame()`, Motion Canvas generators, Manim `run_time`. No CSS transitions, timers, `Math.random()` or live network inside rendered frames.
4. Conform every shot before assembly: same resolution, SAR 1, constant frame rate, pixel format, 48 kHz sample rate and channel layout. The concat demuxer with `-c copy` only works when codec parameters match exactly.
5. Tag color. FFmpeg's default RGB-to-YUV conversion uses the BT.601 matrix while HD players assume BT.709, so untagged renders shift hue and contrast. Convert with `scale=out_color_matrix=bt709:out_range=tv` and tag `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`.
6. Measure loudness against the destination: about -14 LUFS integrated for streaming and social, -16 for podcasts and web narration, -23 for EBU R128 broadcast; true peak at or below -1 dBTP. Use two-pass `loudnorm`, not a single guessed gain.
7. Render a master once (ProRes 422 HQ or near-lossless H.264) and derive every delivery encode from it; never transcode one lossy delivery file into another.
8. Record rights: fonts, music, stock, AI-provider output terms and the Remotion company license. Never promise free commercial use without reading the license.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| Product/UI demo, data-driven variants | Remotion; read [Remotion workflow](references/remotion.md); render stills of first, densest and last frames before the full render |
| Diagram or code walkthrough | Motion Canvas (motion-canvas-video skill); confirm how the project triggers a render |
| Math or science explainer | Manim Community (manim-video skill) |
| Convert, trim, compress | Probe input; decide stream copy vs re-encode; read [delivery workflow](references/ffmpeg.md) |
| Captions or subtitles | Burned-in for muted autoplay social; soft `mov_text` in MP4 or WebVTT on the web; max 2 lines of about 42 characters |
| Plays in Chrome, black or broken in Safari/QuickTime | Check pix_fmt (yuv444p, 4:2:2, 10-bit), HEVC tag `hev1` vs `hvc1`, odd width or height |
| Audio drifts or ends early | Compare `r_frame_rate` with `avg_frame_rate` (VFR), mixed sample rates, `-shortest`, image-sequence `-framerate` placement |
| Vertical social cut | 1080x1920; keep text and faces out of the top ~15% and bottom ~20% where platform UI sits; check current platform specs |
| Transparent overlay | ProRes 4444 (`-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le`) or VP9 WebM with yuva420p; H.264 has no alpha |
| AI-generated shots | Shortest test shot first; record model id, prompt, seed, aspect, duration, request id; conform fps and size before editing |

## Patterns and pitfalls

- **Keyframe-snapped cuts** — with `-c copy` a cut starts at the previous keyframe, so clips begin early or freeze. `-ss` before `-i` is fast and frame-accurate only when re-encoding.
- **CRF is per codec** — x264 CRF 18 is near-transparent and 23 the default; x265 and AV1 scales differ, so do not copy numbers across codecs. `-tune animation` helps flat motion graphics.
- **GOP length** — for HLS/DASH set `-g` to 2x fps, `-keyint_min` equal and `-sc_threshold 0` so segments align; very long GOPs make scrubbing and seeking slow.
- **HEVC on Apple** — needs `-tag:v hvc1`; the default `hev1` tag will not play in QuickTime or Safari.
- **HDR sources** — phone and Mac screen recordings may be 10-bit HLG or PQ (`color_transfer` arib-std-b67 or smpte2084). Tone-map to SDR (zscale plus tonemap) or colors wash out.
- **Variable frame rate** — screen and phone recordings are often VFR; conform with `-vf fps=30` or `-fps_mode cfr` before editing or concat.
- **Image sequences** — `-framerate 60` must come before `-i frames/%05d.png`; after it, frames are read at 25 fps and then duplicated or dropped.
- **Burned subtitles** — the subtitles filter needs libass and installed fonts; on Windows escape the drive colon (`subtitles='C\:/work/subs.srt'`); style with `force_style='FontName=Inter,FontSize=22,Outline=2'`.
- **Audio format** — resample 44.1 kHz music to 48 kHz for video; mono narration goes to both channels (`-ac 2`), not hard-left; `aresample=async=1` repairs small drift.
- **Ducking** — `sidechaincompress` keyed by the voice (split it with `asplit`) sounds natural; a fixed `volume=0.2` either buries the music or the speech.
- **Text at delivery size** — at 1080p, body text below about 32 px and thin weights break down after compression; view one still at 100% and one downscaled to phone width.
- **Faststart** — without `+faststart` the moov atom sits at the end and web players download the whole file before starting.

## Workflow

1. Turn the brief into a shot list (purpose, duration, visuals, voice or captions, transitions, assets) and a delivery spec: container, codec, size, fps, pix_fmt, audio, loudness target, max file size, platform.
2. Inventory tools: `ffmpeg -version`, `ffmpeg -hide_banner -encoders` filtered for libx264, libx265, aac, prores and libsvtav1; engine versions from lockfiles; probe every asset.
3. Prototype the hardest shot at delivery resolution: densest text, one transition, one audio sync point. Fix fonts and asset loading before scaling up.
4. Build scenes and render masters per section; keep sources and accepted takes.
5. Assemble, conform and encode delivery files from masters; normalize audio with two-pass loudnorm.
6. Run the proof below, view the extracted frames, and listen to the start, every transition and the end.
7. Report the source entrypoint, exact render and encode commands, output path, ffprobe summary, loudness reading and anything not verified.

## Proof

- Streams: `ffprobe -v error -show_entries stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,color_space,sample_rate,channels:format=duration,size -of json out.mp4`
- Clean decode: `ffmpeg -v error -i out.mp4 -f null -` prints nothing for a healthy file.
- Frames: `ffmpeg -ss 00:00:03 -i out.mp4 -frames:v 1 -update 1 check-03s.png` for first, transition and last moments; contact sheet with `ffmpeg -i out.mp4 -vf "fps=1/2,scale=480:-2,tile=4x3" -frames:v 1 sheet.png`.
- Loudness: `ffmpeg -i out.mp4 -af ebur128=peak=true -f null -` and read Integrated and True peak from the summary.
- Stream durations match: `ffprobe -v error -show_entries stream=codec_type,duration -of csv=p=0 out.mp4`.
- Faststart: in `ffprobe -v trace out.mp4` output the moov atom appears before mdat.
- Remotion stills and renders: see the [Remotion workflow](references/remotion.md).

## Stop and ask

- Licensing is unclear for music, fonts, stock, AI output or a commercial Remotion user.
- Paid AI video or voice generation beyond one short test, or an unconfigured provider account.
- The command would overwrite or delete source footage, masters or an existing deliverable.
- Platform limits (size, duration, bitrate) conflict with the requested quality.
- Real people's likeness or voice is involved.

## Before returning

- [ ] Engine matches the content; engine and FFmpeg versions read from the environment
- [ ] Delivery spec written and the output ffprobe matches it: codec, yuv420p, even size, constant fps, 48 kHz audio, duration
- [ ] Color tagged bt709 (or deliberately otherwise) and a frame compared against the source render
- [ ] Decode pass clean; first, transition and last frames extracted and viewed at delivery resolution
- [ ] Integrated loudness and true peak measured against the stated target
- [ ] Captions timed, legible and inside safe areas; promised soft subtitle track present
- [ ] Masters and sources preserved; render commands and rights recorded in the report

## Sources

[FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [FFmpeg H.264 guide](https://trac.ffmpeg.org/wiki/Encode/H.264), [Remotion docs](https://www.remotion.dev/docs/), [EBU R128](https://tech.ebu.ch/publications/r128).

## Skills in scope

- audio-studio — music tracks, TTS narration and loudness-matched stems before the mux.
- motion-canvas-video — generator-driven 2D diagrams and code walkthrough scenes.
- manim-video — mathematical equations, geometric proofs and scientific visualizations.
- threejs-3d — WebGL/WebGPU scenes embedded in frame-accurate pipelines.
- micro-animation-gif — short silent loops for chat, PRs and release notes.
- office-documents — companion slide decks, scripts and PDF handouts.
