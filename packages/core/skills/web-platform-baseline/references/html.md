<!-- verified: 2026-11-02 | source: WebDX web-features 3.45.0, live npm release data -->

Baseline is a compatibility summary, not a substitute for the supported browser,
device and assistive-technology matrix. High means widely available; low means
newly available; false means limited across the complete tracked surface.
The table names exact compatibility keys where the aggregate feature includes
additional syntax with different support. Recheck the current data before an
architectural decision; do not infer unsupported behavior from an aggregate alone.

Source: [WebDX feature data](https://github.com/web-platform-dx/web-features)
via [npm release metadata](https://registry.npmjs.org/web-features/latest).

# HTML and platform APIs

| Feature / exact surface | Current tier | Source feature id |
|---|---|---|
| dialog/showModal | Widely available (Baseline 2022-03-14) | dialog |
| Popover | Newly available (Baseline 2025-01-27) | popover |
| field-sizing | Newly available (Baseline 2026-06-16) | field-sizing |
| datalist | Limited | datalist |
| Lazy image/iframe loading | Widely available (Baseline 2023-12-19) | loading-lazy |
| fetchpriority | Newly available (Baseline 2024-10-29) | fetch-priority |
| details/summary | Widely available (Baseline 2020-01-15) | details |
| Exclusive details (name) | Newly available (Baseline 2024-09-03) | details-name |
| inert | Widely available (Baseline 2023-04-11) | inert |
| structuredClone | Widely available (Baseline 2022-03-14) | structured-clone |
| Intl core | Widely available (Baseline 2017-09-28) | intl |
| Intl.DurationFormat | Newly available (Baseline 2025-03-04) | intl-duration-format |
| Same-document view transitions | Newly available (Baseline 2025-10-14) | view-transitions |
| Cross-document view transitions | Limited | cross-document-view-transitions |
| Speculation Rules | Limited | speculation-rules |

## Semantic and integration checks

- Native dialog provides a useful modal boundary, but still needs an accessible
  name, intentional initial/return focus and verified scrolling behavior.
- Popover manages display/light-dismiss; choose semantics and keyboard behavior
  from the actual widget. It is not automatically a menu or accessible combobox.
- Native datalist support does not establish consistent screen-reader behavior.
- Server validation remains necessary even when browser constraint validation runs.
- Choose image dimensions, srcset/sizes and loading priority from the actual
  content; the LCP resource generally should not be lazy-loaded.
- Clipboard access needs the supported secure-context/permission path and a
  visible success/error result.
- Use native controls, associated labels, meaningful landmarks and heading order.
  One h1 is a useful page convention, not a standalone WCAG success criterion.
- For new features, check the exact syntax and target versions in MDN and the
  relevant specification; CSS @supports cannot prove JavaScript API semantics.

When a row is limited, define a usable fallback. Do not add a framework or
polyfill unless the actual product requirements need it.
