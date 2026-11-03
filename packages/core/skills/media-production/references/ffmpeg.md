# FFmpeg Encoding, Assembly & Delivery Reference

Current stable release checked 2026-11-02: FFmpeg 9.0.2.
Read [download/release information](https://ffmpeg.org/download.html) and the
[filter documentation](https://ffmpeg.org/ffmpeg-filters.html).
Check installed build, encoders and filters before generating commands.

## 1. Probe Input Streams First

Always inspect every source video, audio stem, and image sequence with `ffprobe` before constructing a filtergraph:

~~~powershell
ffmpeg -version
ffprobe -v error -show_entries format=duration,bit_rate:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels,color_space,color_transfer -of json input.mp4
~~~

- Distinguish stream copy (`-c copy`, fast and lossless but cuts only on keyframes and forbids filters) from re-encoding (required whenever scaling, cropping, padding, burning subtitles, or normalizing audio).
- Ensure output dimensions are divisible by 2 (`scale=-2:1080`) for `yuv420p` H.264/HEVC encoders.

## 2. Common Production Recipes

### Universal Web / Social MP4 (H.264 + AAC + Faststart)
~~~powershell
ffmpeg -n -i input.mov -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -c:a aac -b:a 192k -ar 48000 -movflags +faststart output.mp4
~~~

### Aspect-Ratio Fit Without Cropping (e.g., 16:9 → 9:16 Vertical `1080x1920`)
~~~powershell
ffmpeg -n -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -movflags +faststart output-vertical.mp4
~~~

### Image Sequence + Voiceover Mux (Frame-Accurate)
Place `-framerate` **before** `-i` so the image demuxer reads frames at the intended timeline rate:
~~~powershell
ffmpeg -n -framerate 60 -i frames/frame_%05d.png -i narration.wav -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart final.mp4
~~~

### Voiceover + Background Music Ducking (`sidechaincompress` or Volume Mix)
Normalize voiceover (`loudnorm=I=-16:TP=-1.5:LRA=11`) and attenuate background music so speech remains intelligible:
~~~powershell
ffmpeg -n -i video.mp4 -i voice.wav -i music.mp3 -filter_complex "[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo];[2:a]volume=0.18,afade=t=out:st=28:d=2[bg];[vo][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k output-mixed.mp4
~~~

## 3. Quality & Verification Checklist

- **Browser/QuickTime Compatibility**: Always specify `-pix_fmt yuv420p` and `-movflags +faststart` for H.264 MP4 deliverables; omitting `yuv420p` when encoding from PNG/RGB inputs defaults to `yuv444p`, which renders as a black screen in Safari/QuickTime and many mobile players.
- **Concatenation**: When joining multiple clips via the `concat` demuxer or filter, normalize resolution, SAR (`setsar=1`), framerate (`fps=30`), pixel format, and audio sample rate (`48000` Hz stereo) across all inputs first to prevent A/V drift or decoder glitches.
- **Post-Encode Verification**: Run `ffprobe` on the output file, extract representative thumbnails (`ffmpeg -ss 00:00:05 -i output.mp4 -frames:v 1 check.png`), and verify that audio duration matches video duration without end-frame truncation.
