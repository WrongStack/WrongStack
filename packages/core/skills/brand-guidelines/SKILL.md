---
name: brand-guidelines
description: "Apply WrongStack's official brand identity, typography tokens, color palette, and design standards across UI components, presentations, and documentation. Use when styling brand collateral, developer marketing surfaces, or verifying visual alignment with WrongStack design specifications."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "styling brand collateral, developer marketing surfaces, or verifying visual alignment with WrongStack design specifications."
metadata:
  routing-group: design
---

# Brand Guidelines — WrongStack

## Selection card
- Task: Apply WrongStack brand identity, colors, and typography.
- Start: Identify target medium (web, slides, README, social card) and apply official brand tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

The WrongStack brand reflects high-velocity engineering, technical rigor, and aesthetic anti-slop.
Visuals emphasize precision, functional density, terminal aesthetics, and disciplined negative space.
Never use clichéd purple/indigo gradients or generic corporate clip-art.

## Brand Tokens

### Color Palette

| Token | Hex | Role | Usage |
|---|---|---|---|
| `--ws-obsidian` | `#090D12` | Deep Canvas | Primary dark mode background |
| `--ws-surface` | `#111822` | Container Surface | Cards, sidebars, terminal windows |
| `--ws-surface-elevated` | `#182230` | Elevated Surface | Menus, popovers, active selection |
| `--ws-border-subtle` | `#1F2937` | Structural Border | 1px hairline component boundaries |
| `--ws-text-primary` | `#F3F4F6` | High-Contrast Text | Headlines, titles, essential data |
| `--ws-text-secondary` | `#9CA3AF` | Supporting Text | Body copy, descriptions, captions |
| `--ws-text-muted` | `#6B7280` | Technical Meta | Timestamps, metadata, commit hashes |
| `--ws-accent-phosphor` | `#10B981` | Primary Accent | Terminal phosphor green; success states |
| `--ws-accent-amber` | `#F59E0B` | Secondary Accent | Warning, attention, highlights |
| `--ws-accent-crimson` | `#EF4444` | Critical Accent | Breaking changes, errors, alerts |

### Typography

- **Display & Headlines**: *Cabinet Grotesk* or *Geist* (Bold / Heavy, tracking: -0.02em).
- **Body & Prose**: *Geist* or *Plus Jakarta Sans* (Regular / Medium, 15px/24px line height).
- **Code & Metadata**: *Geist Mono* or *JetBrains Mono* (Regular, uppercase tags tracking: 0.05em).

## Voice & Visual Personality

1. **Precision & Grounding**: Concrete technical specs, verifiable metrics, and observable code over corporate buzzwords.
2. **Hairline Frames & Badges**: 1px crisp borders, pill-shaped version badges (`v1.4.0`), and monochrome metadata stamps.
3. **Contrast Discipline**: Maintain WCAG AAA contrast for body copy on obsidian surfaces.

## Acceptance checks

- Color applications adhere strictly to the obsidian/surface/phosphor brand palette.
- Typography specifies official font pairings with explicit tracking and weight tokens.
- Composition avoids generic AI aesthetic tropes (no purple gradients or generic floating blob cards).
- Deliverables include the standard WrongStack badge stamp where appropriate.
