# Remotion Production Workflow

Checked 2026-11-02: Remotion and @remotion/renderer 4.0.540.
Keep all @remotion/* packages on the exact matching version (no caret `^` skew across `@remotion/cli`, `@remotion/renderer`, `@remotion/transitions`, `@remotion/google-fonts`, and `remotion`). Verify the current
[setup](https://www.remotion.dev/docs/),
[renderer API](https://www.remotion.dev/docs/renderer/render-media) and
[license](https://www.remotion.dev/docs/license) before adding or upgrading.

## 1. Frame-Deterministic Composition Contract

- Register every `<Composition>` in `src/Root.tsx` with explicit `id`, `component`, `width`, `height`, `fps`, `durationInFrames`, `defaultProps`, and optional `schema` (Zod) + `calculateMetadata` when duration or dimensions depend on async input data.
- Drive **all** motion from `useCurrentFrame()` and `useVideoConfig()` (`fps`, `width`, `height`, `durationInFrames`) using `interpolate()` or `spring()`:
  - Always pass `{ extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }` to `interpolate()` unless unbounded extrapolation is intentional.
  - Remember that `<Sequence from={start} durationInFrames={len}>` shifts `useCurrentFrame()` to `0` at `start` for its children; use `<Series>` or `@remotion/transitions` (`<TransitionSeries>`) for sequential shots.
- **Forbidden inside Remotion components**: CSS `transition` / `@keyframes`, `requestAnimationFrame`, `setTimeout` / `setInterval`, `Math.random()` (use `random('seed-string')` from `remotion`), and unawaited network fetches inside render frames. Headless Chromium renders frames out of order and in parallel; non-frame-driven state causes flickering and torn frames.

## 2. Asset, Font & Audio Readiness

- Reference local assets via `staticFile('path-in-public.png')` and render media with Remotion's `<Img>` and its video/audio tags so the renderer waits for frame decoding before capturing screenshots. Newer docs recommend `<Video>`/`<Audio>` from `@remotion/media` (WebCodecs-based, needs CORS for remote files) and rename the old `remotion` tags to `<Html5Video>`/`<Html5Audio>`; `<OffthreadVideo>` remains the broad-codec option. Check the [video tags comparison](https://www.remotion.dev/docs/video-tags) for the installed version before choosing.
- When loading custom fonts or async data inside a component, gate rendering with `delayRender('reason')` and call `continueRender(handle)` (or `cancelRender(err)` on failure) inside a `useEffect` cleanup-safe block so Chromium never captures fallback system fonts.

## 3. Staged Preview & Final Render Pipeline

1. **Still & Boundary Frame Inspection**: Render key frames (first frame, transition midpoints, dense text frames, final frame) before encoding a full timeline:
   ~~~powershell
   bunx remotion still src/index.ts ProductDemo out/check-frame.png --frame=45
   ~~~
2. **Short Segment Test**: Render a 2–3 second frame range (`--frames=0-90`) to verify motion smoothness, audio sync, and encoding flags.
3. **Full Production Render**:
   ~~~powershell
   bunx remotion render src/index.ts ProductDemo out/product-demo.mp4 --codec=h264 --pixel-format=yuv420p --crf=18
   ~~~
   Bound `--concurrency` when rendering WebGL/Three.js (`@remotion/three` with `--gl=angle`) or high-resolution 4K compositions so headless browser workers do not exhaust RAM or GPU contexts.
4. **Delivery Verification**: Probe the output file with `ffprobe` (confirm `width`, `height`, `r_frame_rate`, `duration`, `pix_fmt=yuv420p`, and audio stream presence) and inspect playback. Do not claim free commercial use without checking the applicable Remotion company license terms.
