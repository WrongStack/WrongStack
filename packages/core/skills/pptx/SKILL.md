---
name: pptx
description: "PowerPoint .pptx decks with PptxGenJS or python-pptx: slide masters, layouts, placeholders, native charts, notes, 16:9 sizing. Use when building a pitch, briefing or executive deck, filling a corporate template, turning a document into slides, or fixing text overflow, wrong slide size or broken layouts. Not for documents meant to be read as pages (use docx or pdf)."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request names a .pptx or .potx file, a slide deck or presentation, or PptxGenJS or python-pptx code."
metadata:
  routing-group: media
---

# PowerPoint Decks (PPTX)

## Selection card
- Task: Build or edit slide decks that tell one argument, sit on the template's masters and render without overflow.
- Start: Write the title of every slide first (the storyline); if a template exists, list its layouts and placeholder idx, type and name before placing anything.
- Finish: the deck renders with no overflow or overlap on any slide, titles read as the story, charts are native and notes are present; checks below pass.

## Overview

A deck is an argument made of one-message slides built on the template's masters and placeholders: action titles carry the story, layouts come from the slide master, and overflow only shows up after rendering.
Libraries: PptxGenJS for Node and python-pptx for Python (checked 2026-11-02: pptxgenjs 4.0.1, python-pptx 1.0.2).
A slide that needs a paragraph to be understood belongs in a document or in the speaker notes.

## Rules

1. Template first. When an organization template (.potx or .pptx) exists, build every slide from its layouts and fill its placeholders; free text boxes over a blank layout lose theme fonts, outline view, re-theming and reading order.
2. Know the slide size. python-pptx's default template is 4:3 (10 x 7.5 in), so set `prs.slide_width = Inches(13.333)` and `prs.slide_height = Inches(7.5)` or start from a 16:9 file. PptxGenJS `LAYOUT_16x9` is 10 x 5.625 in while `LAYOUT_WIDE` is 13.33 x 7.5 in, PowerPoint's own 16:9; coordinates written for one break on the other.
3. One message per slide, stated as a full-sentence action title ("EU churn fell 3 points after the pricing change"), with evidence underneath. Reading only the titles must tell the story.
4. Libraries do not detect overflow. Autofit settings (PptxGenJS `fit: 'shrink'`, python-pptx `MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE`) are applied when PowerPoint re-lays out text, so other renderers show the overflow. Size boxes for the content and render every slide.
5. Native objects over pictures: charts as chart objects with their data, tables as tables, images only for photos and diagrams, alt text on every picture.
6. Fonts are not embedded by generators. Use the theme fonts or fonts installed on the presenting machine; substitution reflows every slide.
7. Presented decks: about six lines per slide at 18 pt or larger; reading decks may be denser but still one message per slide. Detail goes into speaker notes or an appendix.
8. Editing an existing deck keeps its masters, layouts and theme; do not copy slide XML between presentations, because relationships to layouts, images and charts break.

## First moves by situation

| Request or symptom | First moves |
|---|---|
| New deck without a template | `LAYOUT_WIDE`; define one or two masters with title and body placeholders, slide number and footer; storyboard titles before content |
| Corporate template | For each layout print `layout.name` and every placeholder's `placeholder_format.idx`, `.type` and `name`; map content kinds to layouts |
| Text overflows | Render; cut copy, split the slide, or move detail to notes; do not shrink presented body text below 18 pt |
| Content stretched or off-slide | Compare `prs.slide_width`/`slide_height` with the template; recheck EMU math (914400 per inch) |
| Chart | python-pptx `CategoryChartData` with `shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, ...)`; PptxGenJS `slide.addChart(pres.charts.BAR, data, opts)`; units and source in a footnote |
| Document to deck | Extract one claim per slide plus its evidence; put supporting detail in an appendix |
| Accessibility review | Unique title per slide, reading order equals shape order, alt text, 4.5:1 text contrast, no information carried by color alone |
| Duplicate a slide | python-pptx has no supported duplicate call; add a slide on the same layout and rebuild its content |

## Patterns and pitfalls

- **Placeholder identity** — names differ between templates; `idx` is the stable key within a layout. Unused placeholders still appear in outline and screen-reader order, so remove them.
- **Title detection** — python-pptx `shapes.title` only returns the placeholder with idx 0; PptxGenJS master placeholders get other indexes, so look up the placeholder whose type is TITLE when inspecting.
- **PptxGenJS masters** — `defineSlideMaster({ title, background, objects, slideNumber })`, placeholders declared in `objects`, then `addSlide({ masterName })` and `addText(text, { placeholder: 'body' })`.
- **Mutated options** — PptxGenJS can modify option objects passed to it; build fresh option objects per call instead of sharing one.
- **Colors** — PptxGenJS expects hex without the leading `#` (`'0F172A'`).
- **Units** — PptxGenJS positions in inches (or percentage strings); python-pptx in EMU via `Inches`, `Pt`, `Emu`.
- **Images** — give one dimension and derive the other from the aspect ratio, or use PptxGenJS `sizing: { type: 'contain', w, h }`; check source resolution for projection.
- **Bullets and levels** — PptxGenJS `bullet: true` per text run with an indent level; python-pptx paragraph `level`; never type bullet characters.
- **Notes** — PptxGenJS `slide.addNotes('...')`; python-pptx `slide.notes_slide.notes_text_frame.text`.
- **Leftovers** — template sample slides, hidden slides, comments and internal remarks in notes ship with the file; remove them before external delivery.

## Pattern (PptxGenJS master with placeholders)

```ts
import pptxgen from 'pptxgenjs';

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';                                         // 13.33 x 7.5 in
pres.defineSlideMaster({
  title: 'CONTENT',
  background: { color: 'FFFFFF' },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.4, w: 12.1, h: 1.0, fontSize: 28, bold: true }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.6, y: 1.6, w: 12.1, h: 5.2, fontSize: 18 }, text: '' } },
  ],
  slideNumber: { x: 12.4, y: 7.0, fontSize: 10 },
});
const s = pres.addSlide({ masterName: 'CONTENT' });
s.addText('EU churn fell 3 points after the pricing change', { placeholder: 'title' });
s.addText(
  [
    { text: 'Churn 9.1% to 6.0% from Q2 to Q3', options: { bullet: true } },
    { text: 'Largest drop on annual plans', options: { bullet: true } },
  ],
  { placeholder: 'body' },
);
s.addNotes('Source: billing warehouse, Q2-Q3 2026 cohorts.');
await pres.writeFile({ fileName: 'deck.pptx' });
```

## Workflow

1. Clarify audience, setting (presented or read), length, template and the single decision or takeaway.
2. Write the storyline as slide titles; check it reads as an argument.
3. Map each slide to a layout; inspect placeholders; choose native charts and tables.
4. Build slides, notes and alt text; keep text within placeholder bounds.
5. Render every slide to images and review for overflow, overlap, contrast and consistency.
6. Remove leftovers; report slide count, template used, fonts and anything not rendered.

## Proof

- Structure: `python -c "from pptx import Presentation; p = Presentation('deck.pptx'); print(p.slide_width, p.slide_height); [print(i, s.slide_layout.name, [(ph.placeholder_format.idx, str(ph.placeholder_format.type), ph.text_frame.text[:40] if ph.has_text_frame else '') for ph in s.placeholders]) for i, s in enumerate(p.slides, 1)]"`
- Storyline: read the TITLE placeholder text of every slide in order; it must stand alone.
- Render: `soffice --headless --convert-to pdf --outdir render deck.pptx`, then `pdftoppm -png -r 60 render/deck.pdf render/slide` and view every slide.
- Overview: `magick montage render/slide-*.png -tile 4x -geometry 480x270+6+6 render/overview.png` for consistency across slides.
- Fonts: `pdffonts render/deck.pdf` shows no unexpected substitutes.

## Stop and ask

- The template's aspect ratio or branding conflicts with the request.
- Required data for charts is missing and would have to be invented.
- Template fonts are not available on the rendering or presenting machine.
- Speaker notes or hidden slides contain internal remarks and the deck goes external.

## Before returning

- [ ] Slide size matches the template or the agreed 16:9 size; nothing stretched
- [ ] Every slide built on a layout with filled placeholders; unused placeholders removed
- [ ] Titles read as the storyline; one message per slide
- [ ] Every slide rendered and viewed: no overflow, overlap or clipped text
- [ ] Charts and tables are native objects; images carry alt text
- [ ] Speaker notes present where detail was cut; leftovers removed
- [ ] Fonts available or substitutions reported

## Sources

[PptxGenJS](https://gitbrent.github.io/PptxGenJS/), [python-pptx](https://python-pptx.readthedocs.io/).

## Skills in scope

- office-documents — cross-format document generation and verification.
- theme-factory — slide palettes and display/body font pairings.
- brand-guidelines — official slide tokens, surfaces and badge styling.
- doc-coauthoring — shaping the argument before it becomes slides.
