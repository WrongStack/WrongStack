# TUI in browser-hosted terminals

> **Scope:** how `@wrongstack/tui` stays legible inside xterm.js-family emulators —
> VS Code's integrated terminal, code-server / openvscode-server, GitHub
> Codespaces, Gitpod, Theia, Jupyter, Cloud Shell, Replit, and self-hosted web
> terminals (ttyd, gotty, wetty).
> **Source of truth:** `@wrongstack/core` `utils/terminal-capability.ts`
> (`detectTerminalHost`, `TerminalCapability.terminalHost`) and
> `packages/tui/src/ui-glyphs.ts` (`resolveIconStyle`).

---

## 1. Why a separate host class

A browser terminal is not a slower native terminal; it differs in two ways that
break a full-screen Ink layout outright.

1. **The font belongs to the page, not the process.** xterm.js paints with a CSS
   font stack configured on the client. The TUI's Nerd Font profile relies on
   private-use-area (PUA) glyphs (`󰚩`, ``, ``, …) that only exist in a patched
   font usually installed by the operator. When the client is another machine —
   a Codespace, a Gitpod workspace, a Jupyter server — a font scan run here
   describes a machine the user is not looking at, and every PUA glyph becomes a
   tofu box whose width disagrees with the one the app measured.
2. **Image protocols do not exist there.** xterm.js implements neither the Kitty
   Graphics protocol (`APC G`) nor iTerm2 `OSC 1337` inline images. An escape
   sequence carrying a base64 payload is not silently swallowed — it paints as
   literal text across the screen.

## 2. Host detection

`detectTerminalHost(env)` classifies the painting surface and reports whether the
client is remote:

```ts
type TerminalHost = 'native' | 'browser';

interface TerminalHostInfo {
  host: TerminalHost;
  kind: string | null;       // 'codespaces' | 'gitpod' | 'vscode' | … | null
  remoteClient: boolean;     // true when the browser client is another machine
}
```

The result is computed once at launch and exposed as
`detectTerminal().terminalHost`, alongside the existing colour/mouse/title
capability snapshot.

Only markers the emulator or its hosting platform actually export are consulted —
never a guess based on `$TERM`, which browser emulators report as
`xterm-256color` exactly like a native one.

| Marker | `kind` | `remoteClient` |
|--------|--------|----------------|
| `CODESPACE_NAME`, `CODESPACES=true` | `codespaces` | yes |
| `GITPOD_WORKSPACE_ID`, `GITPOD_WORKSPACE_URL` | `gitpod` | yes |
| `OPENVSCODE_SERVER_ROOT` | `code-server` | yes |
| `THEIA_WORKSPACE_ROOT`, `TERM_PROGRAM=theia` | `theia` | yes |
| `CLOUD_SHELL=true` | `cloud-shell` | yes |
| `REPL_ID`, `REPL_OWNER`, `REPLIT_DEV_DOMAIN` | `replit` | yes |
| `JPY_PARENT_PID`, `JUPYTER_SERVER_ROOT` | `jupyter` | yes |
| `TERMINAL_EMULATOR=JetBrains-JediTerm` | `jetbrains` | yes |
| `CODER_WORKSPACE_ID`, `CODER_AGENT_URL` | `coder` | yes |
| `C9_USER`, `C9_PROJECT` | `cloud9` | yes |
| `BROWSER_TERMINAL=1` | `browser` | yes |
| `TERM_PROGRAM=vscode` (also `vscode-insiders`) | `vscode` | no — local webview client |
| `TERM_PROGRAM=hyper`, `TERM_PROGRAM=tabby` | `hyper` / `tabby` | no |
| an SSH session alongside any of the above | as above | yes |

Native terminals resolve to `{ host: 'native', kind: null, remoteClient: false }`,
so behaviour there is unchanged. `remoteClient` is diagnostic only: glyph
suppression keys off `host === 'browser'`, because a webview paints with the
page's font stack whether or not its client is remote.

### 2.1 Overrides

| Variable | Effect |
|----------|--------|
| `WRONGSTACK_TUI_TERMINAL=browser` (or `web`, `xterm`) | force the browser class — for ttyd/gotty/wetty, which export no marker |
| `WRONGSTACK_TUI_TERMINAL=native` | force the native class when a marker is wrong |
| `WRONGSTACK_TUI_ICON_STYLE=unicode\|nerd\|ascii\|browser` | wins over all host-based glyph decisions; `browser` forces the width-safe profile on any terminal |
| `WRONGSTACK_TUI_GRAPHICS=kitty\|iterm2\|halfblock\|off` | wins over the graphics clamp below |

## 3. Effects

### 3.1 Glyph profile

`resolveIconStyle()` returns the `browser` profile for **every** browser host —
local webview and remote client alike. The reason is structural, not geographic:
an xterm.js surface paints with a CSS font stack chosen by the page, so a font
scan of this machine cannot describe the glyphs the user will see. That is
equally true for a desktop VS Code terminal (usually Consolas/Menlo/Cascadia, not
the Nerd Font we found on disk) and for VS Code Remote-SSH / Remote-Containers,
where the shell is spawned on the server and `SSH_CONNECTION` is typically absent.

`remoteClient` remains on `TerminalHostInfo` as diagnostic metadata — it says
whether the user is looking at another machine — but glyph safety no longer
depends on it. A user who did configure a Nerd Font in their editor opts back in
with `WRONGSTACK_TUI_ICON_STYLE=nerd`.

### 3.1.1 The `browser` profile

`glyphSet('browser')` is the `unicode` profile with every width-unstable symbol
replaced by a single-cell glyph from a range common monospace fonts actually
cover. Two failure modes are removed, not one:

- **Missing glyphs.** Symbols most monospace fonts never ship — `⚿`/`⚷`
  (lock/unlock), `⎗`/`⎘` (pin/bookmark), `⛨` (shield), `⌕` (filter/search),
  `⎇` (git branch), `⌘`, `⌁`, `⧉`, `⊛`, `☷`, `❯`, `⟦`/`⟧`, `〰`, `✦`/`✸`/`✷`,
  `⚑` — fall back to an arbitrary font whose cell width the layout did not budget.
- **Emoji presentation.** `🎨`, `⚡`, `⚙`, `✉` are drawn from an emoji font in many
  browsers, so a glyph measured as one cell occupies two (or vice versa).

The substitutes are deliberately plain (`>`, `L`, `@`, `◑`, `╋`, `▥`, `*`, `!`)
and carry meaning through colour and placement. Everything already safe — box
drawing, block elements, geometric shapes, arrows, `✓`, `×` — is inherited from
`unicode` untouched.

Allowed code points are pinned in `BROWSER_SAFE_CODE_POINTS`: ASCII, Latin-1,
`– — ‖ • …`, arrows, `√`, box drawing (U+2500–257F), block elements
(U+2580–259F), geometric shapes (U+25A0–25FF), `✓` and `✗`. The structural
prefixes (`indent`, `treeLast`, `treeBranch`, `treeThrough`) stay two cells wide
and are built only from those ranges.

### 3.2 Graphics protocol

`detectTerminal().graphicsProtocol` degrades to `halfblock` (truecolor `▀` cell
mosaic) for a browser host — or `none` without truecolor — instead of
`kitty`/`iterm2`. Because the value flows through
`resolveEffectiveGraphicsProtocol()`, the image preview modal, the tool-card
preview, and the Kitty stdin/teardown filters all adapt without further checks.

A detected browser host is also treated as truecolor-capable: `detectTerminal()`
promotes its `colorDepth` to 3 regardless of `COLORTERM`, because xterm.js paints
24-bit colour whether or not the shell was told so. That matters for self-hosted
web terminals — ttyd, gotty and wetty commonly launch a shell with only
`TERM=xterm-256color`, which previously yielded `colorDepth: 2` and demoted every
image preview to a text card. Explicit opt-outs still win: `NO_COLOR`,
`FORCE_COLOR=0`, `TERM=dumb` and non-TTY output keep depth 0 and therefore
`graphicsProtocol: 'none'`.

### 3.3 What intentionally does not change

Alternate-screen entry, synchronized output (`DECSET 2026`, ignored harmlessly by
emulators that lack it), bracketed paste, SGR mouse tracking, and OSC title
updates all work in browser emulators and are left alone. Colour depth is the one
otherwise-similar capability that *is* adjusted — see §3.2.

## 4. Verification

- `packages/core/tests/utils/terminal-capability-graphics.test.ts` — host
  classification per marker, SSH promotion, both override directions, the
  kitty-to-halfblock clamp, and explicit-override precedence.
- `packages/tui/tests/ui-glyphs.test.ts` — glyph suppression for local and remote
  browser hosts, native-terminal font detection, and override precedence.

Both suites assert the decision layer; they do not paint into a real browser
terminal. A visual check in xterm.js remains a manual step.
