/**
 * Long localized labels: on a screen shown in German (among the longest of the shipped
 * languages), every label-like text (buttons, tabs, links, form labels, headings) must fit. A
 * text cut off by a clipping box without an ellipsis, or spilling out of its own box onto its
 * neighbours, is reported with the screen and the element. A truncation with an ellipsis is
 * reported when the full text is offered nowhere else (no `title`, no accessible name with it).
 */
export async function measureLabelFit(page) {
  return page.evaluate(() => {
    const LABELS =
      'button, a, [role="tab"], [role="menuitem"], [role="option"], label, legend, summary, th, h1, h2, h3, h4';
    // Content areas whose text is the user's own, not a label.
    const SKIP =
      '.monaco-editor, .xterm, .react-flow__viewport, pre, code, textarea, [contenteditable="true"]';
    const describe = (element) =>
      element.tagName.toLowerCase() +
      (element.className && typeof element.className === 'string'
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '');
    // Glyph boxes and a content-sized box can differ by a pixel or two with nothing hidden.
    const SLACK = 2;
    const findings = [];
    const reported = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const host = node.parentElement;
      if (!text || !host || host.closest(SKIP)) continue;
      const label = host.closest(LABELS);
      if (!label || reported.has(label)) continue;
      if (!label.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
      if (!rects.length) continue;
      const box = {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
        top: Math.min(...rects.map((rect) => rect.top)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      };
      const fullText = label.textContent?.trim() ?? '';
      const named = (element) =>
        [element.getAttribute('title'), element.getAttribute('aria-label')].some((value) =>
          value?.includes(text),
        );
      let kind = '';
      for (
        let element = host;
        element && element !== document.body;
        element = element.parentElement
      ) {
        const style = getComputedStyle(element);
        if (
          ['auto', 'scroll'].includes(style.overflowX) ||
          ['auto', 'scroll'].includes(style.overflowY)
        )
          break; // Text past a scrolling box is reached by scrolling it.
        const clipX = ['hidden', 'clip'].includes(style.overflowX);
        const clipY = ['hidden', 'clip'].includes(style.overflowY);
        if (!clipX && !clipY) continue;
        const frame = element.getBoundingClientRect();
        // Visually hidden helpers and collapsed panels hide their text on purpose.
        if (frame.width <= 2 || frame.height <= 2) break;
        const outside =
          box.right <= frame.left ||
          box.left >= frame.right ||
          box.bottom <= frame.top ||
          box.top >= frame.bottom;
        if (outside) break;
        const cut =
          (clipX && (box.right > frame.right + SLACK || box.left < frame.left - SLACK)) ||
          (clipY && (box.bottom > frame.bottom + SLACK || box.top < frame.top - SLACK));
        if (!cut) continue;
        if (
          style.textOverflow === 'ellipsis' &&
          clipX &&
          !(clipY && box.bottom > frame.bottom + SLACK)
        ) {
          let ancestor = host;
          let offered = false;
          while (ancestor && !offered) {
            offered = named(ancestor);
            if (ancestor === label) break;
            ancestor = ancestor.parentElement;
          }
          if (!offered) kind = 'truncated';
        } else kind = 'clipped';
        break;
      }
      if (!kind) {
        const own = label.getBoundingClientRect();
        if (own.width > 2 && (box.right > own.right + SLACK || box.left < own.left - SLACK))
          kind = 'overflows';
      }
      if (!kind) continue;
      reported.add(label);
      findings.push({
        kind,
        text: fullText.slice(0, 80),
        element: describe(label),
        width: Math.round(label.getBoundingClientRect().width),
      });
    }
    return findings;
  });
}
