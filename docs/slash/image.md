# /image — Terminal Inline Image Preview & Metadata Inspection

Inspects a workspace-contained local PNG, JPEG, GIF, or WebP artifact and previews it inline inside capable terminals.

## Subcommands & Flags

| Usage | Effect |
|---|---|
| `/image` | Re-open the latest tool screenshot or generated image (`browser_screenshot`, `image_generate`, `present_artifact`) inside `<ImagePreviewModal>` |
| `/image <path>` | Open `<ImagePreviewModal>` inside the TUI using the terminal's negotiated graphics protocol, or print header metadata in headless/REPL surfaces |
| `/image <path> --info` | Print MIME type, pixel dimensions, and byte size without opening an interactive modal |

## Terminal graphics negotiation & containment

When `/image <path>` opens `<ImagePreviewModal>` in the TUI, `@wrongstack/tui` selects the richest protocol supported by the host terminal (overridable at boot via `WRONGSTACK_TUI_GRAPHICS=auto|kitty|iterm2|halfblock|off` or live without restart via `/settings graphics <auto|kitty|iterm2|halfblock|off>`):

1. **Kitty Graphics Protocol (`APC \x1b_G...`):** Chunked 4,096-byte base64 payloads transmitted with `q=2` (suppress terminal `OK`/`ENOENT` responses so stdin is never polluted). Closing the modal emits `a=d,d=i,i=<slotId>,q=2` to free terminal GPU memory.
2. **iTerm2 Inline Images (`OSC 1337`):** Base64 `File=inline=1;preserveAspectRatio=1` sequences (wrapped in DCS passthrough when running inside `tmux` with passthrough enabled).
3. **24-bit Truecolor Half-Block Fallback (`▀`):** Bilinear downsampling rendered with foreground/background RGB cells on terminals without native image protocols.

Security & containment guarantees:

- Paths are resolved via `fs.realpath` and verified to stay strictly within `projectRoot` (up to 20 MiB per file).
- Previewing an image via `/image` renders strictly on the local human surface (`ImagePreviewCache`) and never injects base64 payloads into the LLM prompt context unless the user explicitly attaches the file to a prompt.

## Code reference

- `packages/runtime/src/portable-commands/image.ts` — portable `/image` command and binary header inspector
- `packages/tui/src/graphics/image-codec.ts` — Kitty APC, iTerm2 `OSC 1337`, and 24-bit half-block encoders
- `packages/tui/src/graphics/image-preview-cache.ts` — bounded LRU preview cache and runtime `/settings graphics` override store
- `packages/tui/src/components/image-preview-modal.tsx` — TUI modal with protocol badge and Kitty slot cleanup
- [Session Management](session.md)
- [Session Tree, Live Plugins & Synchronized Graphics Plan](../plans/session-tree-live-plugins-tui-graphics-2026-11.md)
