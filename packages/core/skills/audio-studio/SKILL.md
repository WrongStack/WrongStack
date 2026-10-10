---
name: audio-studio
description: "Compose music, lyrics, soundscapes and voiceovers, or implement browser audio feedback. Use when creating Suno or other music prompts, TTS narration, a soundtrack or interactive sound; use media-production for the final video timeline and mux."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "creating Suno or other music prompts, TTS narration, a soundtrack or interactive sound; use media-production for the final video timeline and mux."
metadata:
  routing-group: media
---

# Audio Studio

## Selection card
- Task: Prepare music, narration and audio delivery.
- Start: Identify the existing engine, scene, timeline and delivery format.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Suno v6 is the current flagship model (v6-mini is the accessible fast variant),
verified against its official model guide on 2026-10-09. ElevenLabs offers Eleven
v3 alongside models optimized for latency. Choose the latest available model
appropriate to the task; record its exact id, access tier and output limits.
Do not describe an SDK version as a model version.

## Rules

1. Define duration, language, instrumental/vocal intent, pacing, instrumentation,
   reference mood and delivery format before generation. Use reasonable defaults
   when the brief is sufficient.
2. Separate style directions from sung/spoken text. Section tags may guide a music
   model; they do not guarantee BPM, exact timestamps or duration.
3. For narration, mark pronunciation, pauses and emotional changes only in syntax
   the chosen provider supports. Do not force a gender, accent or imitation.
4. Use authorized voices, lyrics and licensed assets. Check commercial-use terms
   for the user's access tier. Keep API keys outside source and output logs.
5. Distinguish a prompt from a generated audio file. Deliver the actual file only
   after listening to it and validating its duration, clipping and channels.
6. For browser audio, create/resume AudioContext after a user gesture, provide mute
   and volume control, and release oscillators and audio nodes when finished.

## Workflow

1. Inspect existing audio code and provider/tool availability. Verify current
   model documentation before a paid generation or SDK upgrade.
2. Draft the musical structure or narration; synchronize it to the storyboard
   when the task includes video.
3. Generate a short sample first when voice, pronunciation or cost is uncertain.
   Bound retries and preserve accepted takes.
4. Listen for missing words, unintended sung directions, harsh cuts and
   distortion. Measure loudness/true peak against the destination specification,
   rather than applying a universal loudness number.
5. Retain a lossless master when available; export a playback-compatible preview.
   Record voice/model, sample rate, channels, duration and edits.

## Sources

[Suno models](https://help.suno.com/en/articles/13924737),
[ElevenLabs models](https://elevenlabs.io/docs/overview/models).
SDK snapshot: ElevenLabs client 1.27.0 and fal client 1.10.1, checked
2026-10-09; refresh npm before installation.

## Acceptance checks

- Listen to the delivered audio; verify duration, clipping, channels and the intended voice/music balance.

## Skills in scope

- media-production — audio placement, subtitles and delivery.
- motion-canvas-video — synchronize scene cues to narration.
- manim-video — narration pacing for explanations.
