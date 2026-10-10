---
name: i18n-localization
description: "Implement localization with translated messages, locale-aware formatting and adaptable layouts. Use when supporting multiple languages, RTL or regional formats; preserve message identity and test realistic translated content rather than only replacing labels."
trigger: "Implement localization with translated messages, locale-aware formatting and adaptable layouts. Use when supporting multiple languages, RTL or regional formats; preserve message identity and test realistic translated content rather than only replacing labels."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "product"
---

# I18N Localization

## Selection card
- Task: Implement translation, plurals and bidirectional layout.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement localization with translated messages, locale-aware formatting and adaptable layouts.

Use current platform Intl and the project installed localization framework. Verify framework-specific server/client locale loading before changing packages.

## Rules

1. Model language, locale, timezone and currency as separate choices with documented fallback.
2. Use message/plural interpolation rather than concatenating translated fragments.
3. Keep numeric/date values structured until display; store currency/timezone semantics intentionally.
4. Design for expansion, RTL/bidirectional text, input methods and font glyph coverage.
5. Translate accessible names, validation/errors, email/notifications and metadata as relevant.
6. Avoid cache leakage across locale and avoid exposing private request data during server rendering.

## Workflow

1. Inventory user-visible strings and current locale routing/catalogs.
2. Implement messages and formatting with stable keys and appropriate locale context.
3. Test plural/zero cases, long labels, RTL and actual date/currency boundaries.
4. Verify fallback/missing keys and server hydration/cache behavior.
5. Run existing completeness checks and inspect representative rendered journeys.

## Before returning

Locale/data semantics preserved; catalogs complete or gaps explicit; RTL/long text and accessibility checked; server/client locale consistent.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Intl](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl), [W3C internationalization](https://www.w3.org/International/).

## Skills in scope

- design-system — create and maintain coherent visual tokens, themes and shared component states using the existing project system or WrongStack Design Studio.
- accessibility — implement and review accessible user interfaces with semantic controls, keyboard and focus behavior, readable content and assistive-technology checks.
- testing — testing contracts and verification.
- nextjs-modern — build, migrate, and debug Next.js 16 App Router applications with React 19, Server Components, Server Actions, explicit caching, and production deployment.
