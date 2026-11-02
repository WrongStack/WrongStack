<!-- verified: 2026-11-02 | source: WebDX web-features 3.45.0, live npm release data -->

Baseline is a compatibility summary, not a substitute for the supported browser,
device and assistive-technology matrix. High means widely available; low means
newly available; false means limited across the complete tracked surface.
The table names exact compatibility keys where the aggregate feature includes
additional syntax with different support. Recheck the current data before an
architectural decision; do not infer unsupported behavior from an aggregate alone.

Source: [WebDX feature data](https://github.com/web-platform-dx/web-features)
via [npm release metadata](https://registry.npmjs.org/web-features/latest).

# CSS baseline

| Feature / exact surface | Current tier | Source feature id |
|---|---|---|
| Flexbox | Widely available (Baseline 2015-09-30) | flexbox |
| Grid | Widely available (Baseline 2017-10-17) | grid |
| Flexbox gap | Widely available (Baseline 2021-04-26) | flexbox-gap |
| Container queries | Widely available (Baseline 2023-02-14) | container-queries |
| :has() | Widely available (Baseline 2023-12-19) | has |
| Subgrid | Widely available (Baseline 2023-09-15) | subgrid |
| aspect-ratio | Widely available (Baseline 2021-09-20) | aspect-ratio |
| Logical properties | Widely available (Baseline 2021-09-20) | logical-properties |
| min/max/clamp | Widely available (Baseline 2020-07-28) | min-max-clamp |
| Cascade layers | Widely available (Baseline 2022-03-14) | cascade-layers |
| CSS nesting | Widely available (Baseline 2023-12-11) | nesting |
| Anchor naming | Newly available (Baseline 2026-01-13) | anchor-positioning / css.properties.anchor-name |
| anchor() for left | Newly available (Baseline 2026-01-13) | anchor-positioning / css.properties.left.anchor |
| position-anchor (complete tracked syntax) | Newly available (Baseline 2026-09-14) | anchor-positioning / css.properties.position-anchor |
| color-mix | Widely available (Baseline 2023-05-09) | color-mix |
| Relative colors | Newly available (Baseline 2024-09-16) | relative-color |
| light-dark | Newly available (Baseline 2024-05-13) | light-dark |
| text-wrap: balance | Newly available (Baseline 2024-05-13) | text-wrap-balance |
| text-wrap: pretty | Limited | text-wrap-pretty |
| text-box-trim | Newly available (Baseline 2026-08-18) | text-box / css.properties.text-box-trim |
| text-box-edge | Newly available (Baseline 2026-08-18) | text-box / css.properties.text-box-edge |
| @starting-style | Newly available (Baseline 2024-08-06) | starting-style |
| Scroll-driven animation | Limited | scroll-driven-animations |
| Same-document view transitions | Newly available (Baseline 2025-10-14) | view-transitions |
| Cross-document view transitions | Limited | cross-document-view-transitions |
| backdrop-filter | Newly available (Baseline 2024-09-16) | backdrop-filter |
| Masks | Widely available (Baseline 2023-12-07) | masks |
| content-visibility | Newly available (Baseline 2025-09-15) | content-visibility |

## Patterns worth keeping

**Fluid type without breakpoints**
```css
h1 { font-size: clamp(2rem, 1.2rem + 3vw, 3.5rem); }
```

**Component-level responsiveness**
```css
.card-host { container-type: inline-size; }
@container (min-width: 28rem) { .card { grid-template-columns: 12rem 1fr; } }
```

**Derived state colors from one token**
```css
.btn:hover { background: color-mix(in oklch, var(--color-primary) 88%, black); }
```

**Parent styling from child state**
```css
.field:has(input:invalid) { border-color: var(--color-danger); }
```

**Enhancement gate** — required for every "Limited" row
```css
@supports (animation-timeline: scroll()) { /* … */ }
```
