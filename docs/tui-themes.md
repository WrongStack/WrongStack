# TUI Theme Presets

WrongStack'in TUI'si **35 tema preset'i** ile gelir. Aktif preset `config.themePreset` alanında saklanır ve `/theme` ile değiştirilir.

> Bu dosya `packages/tui/src/theme.ts` içindeki canlı paletten üretilmiştir. Elle düzenlemeyin — palet değişirse yeniden üretin.

## Kullanım

```
/theme                  Etkileşimli seçici (↑/↓ gez, Enter uygula, Esc iptal)
/theme <preset>         Doğrudan geçiş, örn. /theme gruvbox-material
```

Seçim aktif profilin config dosyasına yazılır, yani sonraki açılışta da geçerlidir.

## Preset listesi

`Taban` = pencere arka planı, `Vurgu` = birincil aksan (istem, araç adı), `+ / − wash` = diff satır arka planları.

| # | Preset id | İsim | Aile | Taban | Vurgu | + wash | − wash |
|---:|---|---|---|---|---|---|---|
| 1 | `catppuccin` | Catppuccin Mocha | Catppuccin | `#181825` | `#94e2d5` | `#1e3b2a` | `#3b1f26` |
| 2 | `tokyo-night` | Tokyo Night | Tokyo Night | `#16161e` | `#7dcfff` | `#1c3326` | `#37202b` |
| 3 | `nord` | Nord | — | `#2e3440` | `#88c0d0` | `#2f4034` | `#442f35` |
| 4 | `cyberpunk` | Cyberpunk | — | `#0d0d1a` | `#00f0ff` | `#0d2e1f` | `#2e0d1c` |
| 5 | `dracula` | Dracula | — | `#282a36` | `#8be9fd` | `#26402e` | `#43262e` |
| 6 | `gruvbox-dark` | Gruvbox Dark | Gruvbox | `#282828` | `#83a598` | `#1f3a1f` | `#3a1f1f` |
| 7 | `solarized-dark` | Solarized Dark | — | `#002b36` | `#268bd2` | `#0e3a30` | `#3a1a1a` |
| 8 | `one-dark` | One Dark | — | `#21252b` | `#61afef` | `#1f3a26` | `#3a2226` |
| 9 | `monokai` | Monokai | Monokai | `#1e1f1c` | `#66d9ef` | `#1f3318` | `#3a1f25` |
| 10 | `rose-pine` | Rosé Pine | Rosé Pine | `#191724` | `#9ccfd8` | `#1f3538` | `#3a2530` |
| 11 | `kanagawa` | Kanagawa | — | `#16161d` | `#7fb4ca` | `#1f2d1f` | `#321e22` |
| 12 | `ayu-dark` | Ayu Dark | — | `#0f1419` | `#59c2ff` | `#1c2a1f` | `#2e1c20` |
| 13 | `everforest` | Everforest | — | `#2d353b` | `#7fbbb3` | `#1f3326` | `#331f25` |
| 14 | `night-owl` | Night Owl | — | `#011627` | `#82aaff` | `#0e2e26` | `#2e1722` |
| 15 | `synthwave` | Synthwave '84 | — | `#1a103a` | `#36f9f6` | `#1f3530` | `#3a1f30` |
| 16 | `github-dark` | GitHub Dark | — | `#0d1117` | `#58a6ff` | `#0d2f18` | `#3d1418` |
| 17 | `material-ocean` | Material Ocean | Material | `#0f111a` | `#89ddff` | `#17301f` | `#331b21` |
| 18 | `nightfox` | Nightfox | — | `#192330` | `#719cd6` | `#1d3025` | `#33202a` |
| 19 | `oxocarbon` | Oxocarbon | — | `#161616` | `#78a9ff` | `#17301f` | `#33182a` |
| 20 | `catppuccin-macchiato` | Catppuccin Macchiato | Catppuccin | `#1e2030` | `#8bd5ca` | `#26402f` | `#3f242c` |
| 21 | `catppuccin-frappe` | Catppuccin Frappé | Catppuccin | `#292c3c` | `#81c8be` | `#2c4034` | `#422a32` |
| 22 | `gruvbox-material` | Gruvbox Material | Gruvbox | `#282828` | `#7daea3` | `#26332a` | `#3a2426` |
| 23 | `tokyo-night-storm` | Tokyo Night Storm | Tokyo Night | `#1f2335` | `#7aa2f7` | `#20372c` | `#3b2331` |
| 24 | `rose-pine-moon` | Rosé Pine Moon | Rosé Pine | `#232136` | `#9ccfd8` | `#22403e` | `#3a2836` |
| 25 | `zenburn` | Zenburn | — | `#3f3f3f` | `#8cd0d3` | `#2b3a2a` | `#42292a` |
| 26 | `palenight` | Palenight | Material | `#292d3e` | `#82aaff` | `#2b4033` | `#43293a` |
| 27 | `horizon` | Horizon | — | `#1c1e26` | `#26bbd9` | `#16362e` | `#3a1f2a` |
| 28 | `sonokai` | Sonokai | Monokai | `#2d2a2e` | `#7accd7` | `#2c3a2b` | `#43262f` |
| 29 | `edge-dark` | Edge Dark | — | `#2b2d3a` | `#6cb6eb` | `#29392c` | `#3d2830` |
| 30 | `moonfly` | Moonfly | — | `#080808` | `#80a0ff` | `#10301d` | `#331414` |
| 31 | `melange` | Melange | — | `#292522` | `#a3a9ce` | `#2f3a30` | `#3f2b28` |
| 32 | `poimandres` | Poimandres | — | `#1b1e28` | `#5de4c7` | `#14352f` | `#35202c` |
| 33 | `vitesse-dark` | Vitesse Dark | — | `#121212` | `#6394bf` | `#16301f` | `#331d1d` |
| 34 | `aura` | Aura Dark | — | `#15141b` | `#82e2ff` | `#14382c` | `#351d23` |
| 35 | `dark-plus` | VS Code Dark+ | — | `#1e1e1e` | `#569cd6` | `#16351f` | `#3a1d20` |

### Açıklamalar

- **Catppuccin Mocha** (`catppuccin`) — Warm pastel — the original WrongStack default
- **Tokyo Night** (`tokyo-night`) — Cool blue-purple, calm low-contrast coding palette
- **Nord** (`nord`) — Arctic, muted blues and greens — easy on the eyes
- **Cyberpunk** (`cyberpunk`) — Hot pink + neon cyan, high-contrast night mode
- **Dracula** (`dracula`) — Classic purple-on-black, vivid accents
- **Gruvbox Dark** (`gruvbox-dark`) — Warm earthy retro palette — orange, olive and muted aqua
- **Solarized Dark** (`solarized-dark`) — Precision contrast, base16 classic with teal undertones
- **One Dark** (`one-dark`) — Atom's iconic dark palette — blue-led with warm accents
- **Monokai** (`monokai`) — Sublime Text classic — vivid magenta, cyan and lime
- **Rosé Pine** (`rose-pine`) — Aesthetic pine & foam — soft pastel evening tones
- **Kanagawa** (`kanagawa`) — Hokusai-inspired waves — sumi ink on washi
- **Ayu Dark** (`ayu-dark`) — Simple, pleasant dark — warm orange + cool blue mix
- **Everforest** (`everforest`) — Green-based comfort palette — forest greens and warm tans
- **Night Owl** (`night-owl`) — Sarah Drasner's night theme — deep navy with bold accents
- **Synthwave '84** (`synthwave`) — Hot pink + neon cyan on deep purple — 80s retro glow
- **GitHub Dark** (`github-dark`) — GitHub's default dark — crisp blue on near-black
- **Material Ocean** (`material-ocean`) — Deepest Material variant — ink blue with pastel accents
- **Nightfox** (`nightfox`) — Balanced slate blue with muted sage and rose
- **Oxocarbon** (`oxocarbon`) — IBM Carbon-derived — neutral greys, electric blue & pink
- **Catppuccin Macchiato** (`catppuccin-macchiato`) — Warmer, one shade lighter than Mocha
- **Catppuccin Frappé** (`catppuccin-frappe`) — The lightest Catppuccin dark — gentle midday contrast
- **Gruvbox Material** (`gruvbox-material`) — Softened Gruvbox — same warmth, lower eye strain
- **Tokyo Night Storm** (`tokyo-night-storm`) — Tokyo Night on a lifted blue-grey base
- **Rosé Pine Moon** (`rose-pine-moon`) — Rosé Pine at dusk — deeper base, same soft accents
- **Zenburn** (`zenburn`) — The classic low-contrast grey — desaturated and calm
- **Palenight** (`palenight`) — Material Palenight — indigo base, candy accents
- **Horizon** (`horizon`) — Warm coral and mint on charcoal — sunset gradient
- **Sonokai** (`sonokai`) — Monokai Pro descendant — punchy on warm graphite
- **Edge Dark** (`edge-dark`) — Clean, evenly-weighted palette on desaturated navy
- **Moonfly** (`moonfly`) — Near-black base with high-chroma accents — maximum contrast
- **Melange** (`melange`) — Warm sepia and clay — the least blue dark theme here
- **Poimandres** (`poimandres`) — Teal-forward, low-saturation — mint on deep indigo
- **Vitesse Dark** (`vitesse-dark`) — Anthony Fu's minimal palette — muted, print-like
- **Aura Dark** (`aura`) — Vivid purple and spring green on near-black violet
- **VS Code Dark+** (`dark-plus`) — Visual Studio Code's default — familiar blue/orange/teal

## Bir preset neyi tanımlar

Her preset `Theme` arayüzünün tamamını doldurur (`packages/tui/src/theme.ts`). Anlamlı gruplar:

| Token | Nerede görünür |
|---|---|
| `surface`, `surfaceRaised` | Panel zeminleri (yalnız terminal truecolor arka plan destekliyorsa) |
| `textPrimary`, `textSecondary`, `textMuted` | Gövde metni, yardımcı etiketler, sessiz meta |
| `accent` | İstem, bağlantı, araç adı, asistan etiketi |
| `user`, `assistant`, `tool` | Transkript rol etiketleri |
| `success`, `warn`, `error` | ✓/✗ işaretleri, uyarılar **ve diff `+` / `−` işaretçileri** |
| `brand`, `brandPrimary`, `brandAccent` | Açılış logosu ve marka aksanları |
| `borderDefault`, `borderSubtle`, `borderActive` | Panel çerçeveleri, araç sonucu rayları, odaklı çerçeve |
| `diffAddBg`, `diffDelBg` | Diff satır arka plan yıkamaları |
| `monitor.{fleet,agents,worktree,phase}` | Her overlay'in kendi kimlik rengi |

## Yeni preset eklemek

İki dosya, ikisi de derleme zamanında zorunlu tutulur:

1. `packages/core/src/types/config/ui.ts` → `THEME_PRESET_IDS` dizisine id ekleyin. **Bu kanonik listedir.**
2. `packages/tui/src/theme.ts` → `themePresets` içine palet, `THEME_OPTIONS` içine picker satırı ekleyin.

Başka hiçbir yere dokunmayın. CLI `/theme` komutu ve boot adapter geçerli id kümesini `THEME_PRESET_IDS`'ten **türetir**, kendi kopyalarını tutmaz.

Unutursanız `tsc` durdurur:

- `themePresets` tipi `Record<ThemePresetId, Theme>`'dir ve **cast edilmez** — eksik preset de, arayüzde olmayan fazla anahtar da hatadır.
- CLI'ın `THEME_META`'sı total bir `Record<ThemePresetId, …>`'dir — etiketi unutulan id hatadır.

> ⚠️ `packages/core`'u build etmeden `tsc` çalıştırırsanız TUI stale `dist`'ten okur ve yeni id'yi tanımaz. Önce `pnpm --filter @wrongstack/core build`.

## Kalite kuralları

`packages/tui/tests/theme-presets.test.ts` her preset'i şunlara karşı doğrular:

| Kural | Eşik |
|---|---|
| Tüm renk token'ları 6 haneli küçük harf hex | — |
| `monitor` tam olarak 4 anahtar içerir (`fleet`, `agents`, `worktree`, `phase`) | fazla anahtar yasak |
| Diff wash'ları yeterince koyu (üstündeki kod okunabilsin) | luminance < 0.25 |
| `+` işaretçisi kendi wash'ında okunur | kontrast > 3:1 |
| `−` işaretçisi kendi wash'ında okunur | kontrast > 3:1 |
| Wash üstüne terfi ettirilen yorum token'ı okunur | kontrast ≥ 4.5:1 (WCAG AA) |

**Tek belgelenmiş istisna:** `rose-pine`. Paletinde hiç yeşil yoktur — `success` pine (`#31748f`) rengidir ve "eklendi" görünümünü koruyan hiçbir wash 3:1'e ulaşamaz. Test için ayrı bir eşik (2.4) tanımlanmıştır; diğer 34 preset 3:1'de tutulur.

## Sözdizimi renkleri

Diff gövdesindeki kodun renkleri de temaya bağlıdır.

`packages/tui/src/highlight.ts` **saf bir tokenizer**'dır: `theme`'i import etmez ve hiçbir hex'e karar vermez. Bunun yerine **semantik rol adları** üretir — `syntax.keyword`, `syntax.string`, `syntax.comment` … Bu adlar render anında `softColor()` tarafından **aktif** palete çözülür; zaten her bileşenin renk prop'u Ink shim'i üzerinden oradan geçiyor.

Eskiden tokenizer çıplak ANSI adları (`'magenta'`, `'green'`) üretiyordu. Bunlar **donmuş** `pastel` haritasına çözülüyordu, o yüzden Gruvbox'ta bir diff Catppuccin moru anahtar kelimeler render ediyordu.

### Roller ve varsayılan kaynakları

Hiçbir preset bu 14 rengi elle yazmaz — hepsi preset'in zaten tanımladığı token'lardan türetilir (`SYNTAX_TOKEN`, `theme.ts`):

| Rol | Varsayılan kaynak | Nerede |
|---|---|---|
| `keyword`, `decorator` | `brand` | `const`, `function`, `@dec` |
| `string` | `success` | tırnak içi, template |
| `comment` | `textMuted` | `//`, `#`, `/* */` |
| `commentOnWash` | `textSecondary` | diff wash üstündeki yorum |
| `number`, `literal`, `flag` | `warn` | sayılar, `true`/`null`, `--flag` |
| `property`, `variable`, `command` | `accent` | JSON anahtarı, `$VAR`, ilk sözcük |
| `diffAdd` / `diffDel` / `diffMeta` | `success` / `error` / `accent` | `diff` dilinde satır sınıfı |

Yani yeni bir preset **sıfır ek renk** ister — 14 rol mevcut token'larından tutarlı biçimde doğar.

### Preset başına override

Bir şema varsayılanla gerçekten anlaşmazsa `Theme.syntax` alanıyla rol pinlenebilir (opsiyonel, `Partial`). Bugün tek örnek `dark-plus`: VS Code string'leri turuncu, yorumları yeşildir — alışılmış yeşil-string / gri-yorum konvansiyonunun tersi.

```ts
syntax: {
  string: '#ce9178',
  comment: '#6a9955',
  commentOnWash: '#9fc98b',
},
```

`commentOnWash` de pinlenir, yoksa yorum dosya ortasında yeşilden griye atlardı.

> **Uyarı:** `softColor` çözemediği bir adı olduğu gibi geçirir ve Ink/chalk onu **sessizce düşürür** — token hiç renksiz render edilir. `highlight.ts`'in ürettiği her ad `SYNTAX_TOKEN`'da bulunmalıdır. `highlight.test.ts` bunu her dil için doğrular.

### Hâlâ temaya bağlı olmayan

~177 çıplak ANSI `color="…"` çağrı noktası (`color="red"`, `borderColor="magenta"`) hâlâ donmuş `pastel` haritasına çözülüyor ve tema değişiminden bağımsız. Bunlar ayrı bir geçiş.

## Terminal arka plan desteği

`theme.supportsBackground` açılışta `TERM` / `COLORTERM` / `NO_COLOR` ve `stdout.isTTY`'den belirlenir. `false` olduğunda diff blokları wash'ları tamamen atlar ve yalnızca kalın renkli `+`/`−` işaretçileriyle render eder — böylece `NO_COLOR=1`, `TERM=xterm` veya boruya yönlendirilmiş çıktı okunabilir kalır.

