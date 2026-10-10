---
name: pptx
description: "Author and design high-impact PowerPoint presentations (.pptx) with modern 16:9 layouts, strong typographic hierarchy, visual cards, and zero wall-of-bullet-point slides. Use when creating pitch decks, technical briefings, executive presentations, or keynote slide decks."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "creating pitch decks, technical briefings, executive presentations, or keynote slide decks."
metadata:
  routing-group: media
---

# PowerPoint Presentation Engineering (PPTX) — WrongStack

## Selection card
- Task: Design and generate modern, high-impact 16:9 slide decks (.pptx).
- Start: Define audience (investor, executive, technical team), deck narrative arc, and color palette.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Slide decks are visual instruments for persuasion and information density, not spoken teleprompters.
Banish standard AI slide tropes: walls of generic bullet points, clip-art icons in colored circles,
and center-aligned paragraph blobs. Use PptxGenJS (npm) or python-pptx to build structured,
16:9 widescreen decks with editorial typography, metric callouts, and clean card containers.

## Design & Storytelling Rules

1. **Aspect Ratio & Layout Geometry**:
   - Always enforce widescreen 16:9 (`layout: 'LAYOUT_16x9'`, width: 10.0 in, height: 5.625 in or 13.33 x 7.5 in).
   - Maintain a minimum 0.8-inch outer margin for breathing room.
2. **Typography Hierarchy**:
   - Limit to 2 font families: one distinctive title face and one readable sans-serif body face.
   - Distinct size hierarchy: Slide Category Tracker (12-14pt uppercase), Slide Headline (28-36pt bold), Supporting Subhead (16-18pt), Body (12-14pt).
3. **Information Chunking Over Bullet Lists**:
   - Use multi-column card layouts (3 or 4 cards per row) with subtle background tint and border.
   - Emphasize big numbers: large metric value (48-60pt bold accent color) stacked above a short 2-line explanation.
   - For processes, use horizontal chronological chevron or numbered step blocks.
4. **Deliberate Color Restraint**:
   - 1 Dark background color (e.g. Navy `#0F172A` or Dark Charcoal `#121212`) or clean light canvas (`#F8FAFC`).
   - 1 High-contrast primary text color (`#F8FAFC` or `#0F172A`).
   - 1 Vibrant accent color (e.g. Electric Emerald `#10B981`, Hyper Coral `#FF5A5F`, or Cobalt `#2563EB`) used exclusively for focal points and primary metrics.

## Implementation Pattern (npm pptxgenjs)

```typescript
import pptxgen from 'pptxgenjs';

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';

// Slide 1: High-Impact Metric Slide
const slide = pres.addSlide();
slide.background = { color: '0F172A' };

// Eyebrow Tracker
slide.addText('PERFORMANCE OVERVIEW', {
  x: 0.8, y: 0.6, w: 8.0, h: 0.3,
  fontSize: 11, fontFace: 'Calibri', color: '94A3B8', bold: true
});

// Main Narrative Headline
slide.addText('Sub-20ms Latency Achieved Across Global Edge Nodes', {
  x: 0.8, y: 0.9, w: 10.5, h: 0.8,
  fontSize: 26, fontFace: 'Calibri', color: 'F8FAFC', bold: true
});

// Card 1: Metric Card
slide.addShape(pres.ShapeType.rect, {
  x: 0.8, y: 2.0, w: 3.6, h: 2.8,
  fill: { color: '1E293B' }, line: { color: '334155', width: 1 }
});
slide.addText('18ms', {
  x: 1.1, y: 2.3, w: 3.0, h: 0.9,
  fontSize: 48, fontFace: 'Calibri', color: '10B981', bold: true
});
slide.addText('Global P95 API Latency', {
  x: 1.1, y: 3.2, w: 3.0, h: 0.4,
  fontSize: 14, fontFace: 'Calibri', color: 'F8FAFC', bold: true
});
slide.addText('Reduced by 85% following Cloudflare Workers edge KV migration.', {
  x: 1.1, y: 3.6, w: 3.0, h: 0.8,
  fontSize: 12, fontFace: 'Calibri', color: '94A3B8'
});

await pres.writeFile({ fileName: 'architecture_briefing.pptx' });
```

## Acceptance checks

- Presentation is strictly formatted in 16:9 widescreen layout.
- Slides replace wall-of-bullet text with structured cards, visual metrics, and clear hierarchy.
- Content elements respect safe margins with zero text clipping or overlapping boxes.
- Output file opens seamlessly in Microsoft PowerPoint, Google Slides, and Apple Keynote.
