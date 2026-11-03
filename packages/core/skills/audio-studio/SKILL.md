---
name: audio-studio
description: "Music, voiceover and sound: Suno song prompts, lyrics, ElevenLabs TTS narration, LUFS loudness mastering and Web Audio UI sounds. Use when writing a song or soundtrack prompt, generating narration, mixing voice over music, fixing clipping or loudness, or adding browser sound effects. Not for assembling the final video timeline or mux (use media-production)."
version: 1.3.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request asks for a song, soundtrack, voiceover, TTS, sound effects or loudness fixes, or touches AudioContext code."
metadata:
  routing-group: media
---

# Audio Studio

## Selection card
- Task: Produce music, narration and sound assets, or implement browser audio, to a measured delivery spec.
- Start: Read the brief for duration, use and destination; list the available provider and model, existing audio code (AudioContext, Howler, audio elements) and any storyboard timestamps.
- Finish: every delivered file was listened to end to end, ffprobe and loudness readings match the spec, and model, voice and license facts are recorded.

## Overview

Audio is judged by ear and by meter: a prompt is not a deliverable, and a file is not done until someone has listened to all of it and measured its loudness, true peak, sample rate and length.
Suno v6 is the current flagship model (v6-mini is the accessible fast variant), verified against its official model guide on 2026-10-23. ElevenLabs offers Eleven v3 alongside models optimized for latency. Choose the latest available model appropriate to the task; record its exact id, access tier and output limits. Do not describe an SDK version as a model version.

## Rules

1. Fix the spec before generating: duration, vocal or instrumental, language, tempo feel, instrumentation, mood described in words (not "in the style of" a living artist), destination and loudness target.
2. Keep style descriptors out of the lyric field. Section tags guide structure; they do not guarantee BPM, timestamps or duration, so edit to length afterwards.
3. Generate a short sample first when voice, pronunciation or cost is uncertain; bound retries and keep a take log (model id, voice id, settings, date) for the accepted take.
4. Master to the destination, measured: about -14 LUFS integrated for streaming, -16 for podcasts and web narration, -23 for EBU R128 broadcast; true peak at or below -1 dBTP. Two-pass loudnorm, not a guessed gain.
5. Keep a WAV master at the project rate (48 kHz for video, 44.1 kHz for music distribution, 24-bit); dither only when reducing to 16-bit; derive AAC, MP3 or Opus copies from the master.
6. Use only authorized voices: no cloning or imitation of a real person without documented consent. Check the account tier's commercial terms for music and voice output; keep API keys out of code and logs.
7. Browser audio: create or resume the AudioContext inside a user gesture, keep one context per app, ramp every gain change, ship mute and volume controls (UI sounds default to quiet or off), and disconnect nodes on teardown.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| Song, jingle, soundtrack | Style prompt (genre, era, instrumentation, tempo feel, vocal type) plus tagged lyrics; generate two candidates; trim and fade to length |
| Narration or TTS | Script with pronunciations; numbers and acronyms written as spoken; sample one paragraph per voice; check pace (about 140-160 words per minute for explainers) |
| Voice over music | Normalize the voice first; duck music 10-15 dB under speech with a sidechain; check intelligibility on laptop speakers |
| Clipping or distortion | Measure true peak; check inter-sample peaks after the lossy encode; limit before encoding, never after |
| Episode louder or quieter than the others | Measure integrated LUFS of both; two-pass loudnorm both to one target |
| UI sound effects | Clips under ~200 ms decoded once into AudioBuffers; a new BufferSource per hit; global mute respected |
| Silent on iOS or Safari | Context created outside a gesture, the hardware silent switch, autoplay policy; log `audioCtx.state` |
| Voice cleanup | High-pass around 80 Hz, `afftdn` denoise, gentle compression, then loudness; listen for artifacts |
| Seamless loop | Cut on zero crossings or crossfade; loop three times to hear the seam; avoid MP3 for loops |

## Patterns and pitfalls

- **Directions sung aloud** — anything in the lyric field may be sung. Bracket section tags only; style, mood and instrumentation belong in the style field.
- **Scansion** — matching syllable counts per section give steadier melodies; overlong lines get rushed or dropped.
- **Pronunciation** — write numbers as words ("twenty twenty-six"), spell acronyms as intended, and use the provider's pronunciation dictionary or phoneme markup only where its docs list support; Eleven v3 audio tags are not SSML.
- **Long TTS drift** — one huge request drifts in pace and tone; generate per paragraph with fixed voice settings and stitch with consistent pauses (300-600 ms) and room tone.
- **Single-pass loudnorm** — dynamic mode can pump. Run the measuring pass, then feed `measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh` and `offset` into the second pass with `linear=true`.
- **Inter-sample peaks** — a file peaking at -0.1 dBFS can clip after AAC or MP3 decoding; true-peak limit to -1 dBTP (lower for very loud masters).
- **MP3 gaps** — encoder delay and padding break seamless loops; use WAV, Ogg Opus, or Web Audio `loopStart`/`loopEnd` on a decoded buffer.
- **Web Audio clicks** — before a ramp, call `cancelScheduledValues(now)` and `setValueAtTime(gain.value, now)`, then ramp; `exponentialRampToValueAtTime` cannot reach 0, so ramp to 0.0001 or switch to `setTargetAtTime(0, now, 0.02)`.
- **Node lifetime** — AudioBufferSourceNode plays once; create one per play. Oscillators and media-element sources must be stopped and disconnected; each extra AudioContext costs a hardware stream and browsers cap them.
- **Mono fold-down** — wide stereo can cancel on phone speakers; render a mono check (`-ac 1`) and listen for missing parts.
- **Resampling** — 44.1 kHz assets in a 48 kHz timeline get resampled implicitly; resample once, deliberately, with `aresample=48000`.

## Workflow

1. Inspect existing audio code, assets and provider access; read current model docs before any paid generation or SDK upgrade.
2. Write the spec and the script or lyrics; align to storyboard timestamps when the audio serves a video.
3. Generate samples, choose, then generate full takes; log every accepted take.
4. Edit: trims with 10-50 ms fades, crossfades, room tone between lines, voice-over-music ducking.
5. Master: two-pass loudness to the target, true peak at or below -1 dBTP; export the WAV master and delivery copies.
6. Run the proof, then listen end to end on headphones and on laptop speakers.
7. Report files, model and voice ids, settings, measurements and anything not listened to.

## Proof

- Format: `ffprobe -v error -show_entries stream=codec_name,sample_rate,channels:format=duration -of json voice.wav`
- Measure pass: `ffmpeg -i mix.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -`
- Final reading: `ffmpeg -i mix.wav -af ebur128=peak=true -f null -` and record Integrated, LRA and True peak.
- Dropouts and truncation: `ffmpeg -i take.wav -af silencedetect=noise=-50dB:d=0.5 -f null -`
- Visual check: `ffmpeg -i mix.wav -filter_complex "showwavespic=s=1600x300" -frames:v 1 wave.png` exposes flat-topped clipping and missing sections.
- Browser audio: in a real browser, first gesture starts sound, mute survives reload, no console errors, and nodes stop after unmount.

## Stop and ask

- Cloning or imitating a real person's voice, or lyrics that reuse copyrighted text.
- Paid generation beyond the sample, or unknown commercial terms for the account tier.
- Replacing an established audio library, provider or asset pipeline.
- Broadcast or ad delivery without a written loudness spec.

## Before returning

- [ ] Model id, voice id, settings, account tier and license scope recorded
- [ ] Every delivered file heard end to end: no sung directions, truncation or mispronounced terms
- [ ] ffprobe sample rate, channels and duration match the spec
- [ ] Integrated loudness and true peak measured and inside the target
- [ ] Speech intelligible over music; fades and ducking click-free
- [ ] Lossless master kept; delivery copies derived from it
- [ ] Browser audio: gesture unlock, mute and volume persistence, and teardown checked in a real browser

## Sources

[Suno models](https://help.suno.com/en/articles/13924737),
[ElevenLabs models](https://elevenlabs.io/docs/overview/models),
[FFmpeg loudnorm](https://ffmpeg.org/ffmpeg-filters.html#loudnorm),
[Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API).
SDK snapshot: ElevenLabs client 1.33.0 and fal client 1.10.1, checked 2026-11-02; refresh npm before installation.

## Skills in scope

- media-production — muxing audio stems, captions and the final video timeline.
- motion-canvas-video — binding 2D animation cues and transitions to narration timestamps.
- manim-video — synchronizing proof steps and waits with spoken voiceover segments.
- accessibility — captions, transcripts and user control over autoplaying sound.
