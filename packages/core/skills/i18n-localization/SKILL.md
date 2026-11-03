---
name: i18n-localization
description: "i18n and l10n: ICU plural and select messages, Intl dates, numbers and currency, time zones, RTL with logical CSS, locale routing. Use when adding languages or locales, extracting hard-coded strings, fixing plural, date, time-zone, currency, sorting or hydration bugs, or supporting Arabic or Hebrew RTL layouts; preserve message ids and the project's i18n library (i18next, FormatJS, next-intl, Lingui, vue-i18n). Not for single-language copy editing or visual redesign (use design-craft)."
trigger: "Use when text, numbers, dates or layout must work in more than one language, locale, time zone or writing direction."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "product"
---

# I18N Localization

## Selection card
- Task: Make UI text, formatting and layout correct across languages, locales, time zones and writing directions.
- Start: Find the i18n library and catalogs (`locales/*.json`, `messages/*.json`, `.po`), how the locale is resolved (URL prefix, cookie, `Accept-Language`) and where dates and numbers are formatted.
- Finish: changed screens render in the source locale, a plural-rich locale, an RTL locale and a pseudo-locale with no concatenation, clipping or hydration mismatch, and the catalog completeness check passes.

## Overview

Localization bugs are grammar and data-model bugs: a message is a whole sentence with its plural logic inside, a date is an instant plus a time zone, money is minor units plus a currency. Direction is a layout property, not a string.
Use current platform Intl and the project installed localization framework. Verify framework-specific server/client locale loading before changing packages.

## Rules

1. Keep language, formatting locale, time zone and currency as separate settings, each with an explicit fallback chain (`pt-BR` → `pt` → default).
2. One message per full sentence with ICU `plural`/`select` inside; never concatenate translated fragments or assemble word order in code.
3. Format at render time with `Intl` and the active locale; store instants as UTC ISO-8601, future wall-clock events as local time plus an IANA zone, money as integer minor units plus an ISO 4217 code.
4. Plural branches follow each target language's CLDR categories, not English one/other; English "no items" text needs an exact `=0` branch because English never selects `zero`.
5. Use logical CSS properties and `dir` on `<html>`; isolate user-generated or mixed-direction text with `dir="auto"` or `<bdi>`; mirror only directional icons.
6. Set `lang` on `<html>` and on any foreign-language span: it drives screen-reader voice, hyphenation, quotation marks and CJK glyph choice for shared Han characters.
7. Resolve the locale per request, include it in cache keys and `Vary`, and never keep it in a module-level server singleton.
8. Message ids are contracts with translators: a changed meaning gets a new id; an id is never reused for different text.

## First moves by situation

| Situation | First moves |
|---|---|
| Hard-coded strings | Run the library's extractor; switch to a pseudo-locale to expose what is still literal |
| Wrong plural in Polish, Russian or Arabic | `new Intl.PluralRules('pl').resolvedOptions().pluralCategories` lists the branches each message needs; add them |
| Date shows the previous day | `new Date('2026-03-01')` parses date-only text as UTC midnight; in a negative-offset zone it formats as Feb 28. Keep date-only values as strings or format with `timeZone: 'UTC'` |
| Hydration mismatch on dates or numbers | Server and browser resolved different locales or zones; pass both explicitly from the server, or render relative times only on the client |
| Arabic or Hebrew layout | `dir="rtl"`; replace `ml-*`, `left:`, `text-align: left` with `ms-*`, `inset-inline-start`, `text-align: start`; check icons, carousels, sliders and progress bars |
| Sorting or search feels wrong | `new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })`; Turkish casing needs `toLocaleUpperCase('tr')` (i → İ) |
| Currency wrong after a language switch | Currency comes from the data, the locale only formats it; JPY has 0 decimals, KWD 3 — let `Intl.NumberFormat` decide |
| Clipped German or Finnish labels | Pseudo-locale with ~40% expansion (short strings grow far more); remove fixed widths, allow wrapping |
| Localized SEO | Locale-prefixed URLs, `hreflang` alternates including `x-default`, localized `<title>` and description |

## Patterns and pitfalls

- **Plural categories** — French `one` covers 0 and 1 ("0 fichier"); Arabic uses zero, one, two, few, many, other; Polish and Russian one, few, many, other; Japanese and Chinese only other.
- **Number inside plural** — `#` prints the locale-formatted count; pass the raw number to the selector, never a pre-formatted string such as "1,5".
- **ICU apostrophes** — an apostrophe before `{`, `}` or `#` starts quoted literal text and `''` prints one apostrophe; a stray quote in French or Italian copy can swallow a placeholder. Typographic ’ avoids it.
- **Ordinals and gender** — `selectordinal` (or `Intl.PluralRules` with `type: 'ordinal'`) for 1st/2nd/3rd; `select` needs an `other` branch.
- **Ready-made formatters** — `Intl.RelativeTimeFormat` with `numeric: 'auto'` ("yesterday"), `Intl.ListFormat` ("A, B and C" per locale), `Intl.DisplayNames` for language, region and currency names instead of hard-coded lists.
- **Grapheme-safe truncation** — cut with `Intl.Segmenter` at `grapheme` granularity so emoji and combining marks survive; `word` granularity finds boundaries in Thai and Japanese, which have no spaces.
- **Script-hostile styling** — `letter-spacing` breaks Arabic joining; `text-transform: uppercase` is only right with the correct `lang` (Turkish i → İ) and many scripts have no case; never bake case into translations.
- **Bidi reordering** — names, numbers and URLs inside RTL sentences jump around; wrap them in `<bdi>` or Unicode isolates (U+2068 … U+2069).
- **What does not mirror** — flex, grid and logical properties follow `dir`; `translateX`, absolute `left`, SVG arrows, canvas drawing and scroll offsets do not.
- **Locale-aware numeric input** — `<input type="number">` handles comma decimals inconsistently; use `inputmode="decimal"` with locale-aware parsing.
- **MessageFormat 2** — a separate Unicode syntax; native `Intl.MessageFormat` is still a TC39 proposal, so do not migrate catalogs for it without a library decision.

## Workflow

1. Inventory the library, catalogs, locale resolution and formatting call sites (`rg -n "toLocale|new Intl|formatMessage" src`).
2. Extract strings into full-sentence messages with translator descriptions and placeholders named by meaning.
3. Route every date, number, currency, list and relative time through `Intl` with explicit locale and time zone.
4. Fix layout: logical properties, `dir`, `lang`, expansion room, mirrored directional icons only.
5. Exercise the source locale, a plural-rich locale (`pl` or `ar`), an RTL locale and the pseudo-locale; include DST transitions, year boundaries and 0- or 3-decimal currencies.
6. Verify missing-key fallback, server/client locale agreement and per-locale caching.

## Proof

- Catalog tooling, whichever the project uses: `npx lingui extract` then `npx lingui compile`; `npx formatjs extract "src/**/*.tsx" --out-file lang/en.json`; the configured i18next extractor; a CI completeness check.
- Plural categories: `node -e "console.log(new Intl.PluralRules('ar').resolvedOptions().pluralCategories)"`.
- Time-zone edges: run the suite under `TZ=America/Los_Angeles` and `TZ=Pacific/Kiritimati` (UTC+14) to expose date-only and offset bugs.
- Browser locale: Playwright `test.use({ locale: 'ar-EG', timezoneId: 'Asia/Tokyo' })`, then assert text, `dir` and a screenshot of the RTL layout.
- Missing keys: configure the library's missing-key handler to throw in tests.

## Stop and ask

- Switching the i18n library or message syntax, or re-keying catalogs that translators or a TMS already hold.
- Changing locale URL structure (redirects, SEO, existing links).
- The request needs currency conversion rather than formatting — that needs a rates source and business rules.
- Legal, medical or regulated text must be translated or approved.

## Before returning

- [ ] Language, locale, timezone, and currency kept distinct with explicit fallback behavior
- [ ] Messages use complete parameterized/pluralized templates with no string concatenation
- [ ] Layouts use logical CSS properties, set `<html lang dir>`, and survive 35%+ text expansion and RTL
- [ ] Accessible labels (`aria-label`, `alt`), validation messages, and page metadata localized
- [ ] Server rendering and caching isolated per locale with zero hydration mismatches
- [ ] Plural branches match each target locale's CLDR categories, checked with `Intl.PluralRules`
- [ ] Date and time output verified in at least two time zones, including a DST boundary

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Intl](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl), [W3C internationalization](https://www.w3.org/International/), [CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html), [ICU messages](https://unicode-org.github.io/icu/userguide/format_parse/messages/).

## Skills in scope

- design-system — create and maintain coherent visual tokens, themes and shared component states using the existing project system or WrongStack Design Studio.
- accessibility — implement and review accessible user interfaces with semantic controls, keyboard and focus behavior, readable content and assistive-technology checks.
- testing — verify plural categories, RTL layout reflow, missing-key fallbacks, and timezone/currency boundary formatting.
- nextjs-modern — build, migrate, and debug Next.js 16 App Router applications with React 19, Server Components, Server Actions, explicit caching, and production deployment.
