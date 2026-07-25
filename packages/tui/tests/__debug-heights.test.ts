// Quick diagnostic test - delete after debugging
import { describe, expect, it } from 'vitest';
import { EntryHeightCache } from '../src/height-cache.js';
import { computeLayout } from '../src/layout-engine.js';
import {
  anchorAtTopRow,
  contentRows,
  maxTopRow,
  planFromAnchor,
  type ScrollGeometry,
} from '../src/scroll-anchor.js';

describe('height debug', () => {
  it('estimates test entries', () => {
    const COLS = 110;
    const totalEst = Array.from({ length: 200 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      const mode = i % 4;
      let text;
      if (mode === 0) text = `M${n} tall\n\n\`\`\`\n${Array.from({ length: 10 }, (_, k) => `line ${k} of M${n}`).join('\n')}\n\`\`\``;
      else if (mode === 1) text = `M${n} short`;
      else if (mode === 2) text = `M${n} para one\n\nM${n} para two\n\nM${n} para three`;
      else text = `M${n} **bold** and \`inline\``;
      return computeLayout(i + 1, 'assistant', text, COLS).rows;
    });
    console.log('Total estimated:', totalEst.reduce((a, b) => a + b, 0), 'avg:', totalEst.reduce((a, b) => a + b, 0) / totalEst.length);
    console.log('Mode breakdown:');
    for (let m = 0; m < 4; m++) {
      const subset = totalEst.filter((_, i) => i % 4 === m);
      console.log(`  mode ${m}: avg=${subset.reduce((a, b) => a + b, 0) / subset.length}`);
    }
  });

  it('planFromAnchor for scrolled-at-top with 200 entries', () => {
    const COLS = 110;
    const VP = 150;
    const cache = new EntryHeightCache();
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    cache.sync(ids, 3);
    for (let i = 0; i < 200; i++) {
      const n = String(i + 1).padStart(3, '0');
      const mode = i % 4;
      let text;
      if (mode === 0) text = `M${n} tall\n\n\`\`\`\n${Array.from({ length: 10 }, (_, k) => `line ${k} of M${n}`).join('\n')}\n\`\`\``;
      else if (mode === 1) text = `M${n} short`;
      else if (mode === 2) text = `M${n} para one\n\nM${n} para two\n\nM${n} para three`;
      else text = `M${n} **bold** and \`inline\``;
      cache.record(i + 1, computeLayout(i + 1, 'assistant', text, COLS).rows);
    }
    const geom: ScrollGeometry = { cache, groupCount: 200, viewportRows: VP, tailRows: 0 };
    const total = contentRows(geom);
    console.log('total estimated rows:', total, 'maxTopRow:', maxTopRow(geom));
    const anchor = anchorAtTopRow(geom, 0);
    console.log('anchor at 0:', anchor);
    const plan = planFromAnchor(geom, anchor!, 0);
    console.log('plan: startIdx=', plan.startIdx, 'endIdx=', plan.endIdx, 'mountTail=', plan.mountTail);
    const coveredRows = cache.accumulatedHeight(plan.endIdx) - cache.accumulatedHeight(plan.startIdx);
    console.log('estimated rows mounted:', coveredRows, 'needed: 150 + 8 = 158');
    const mountedCount = plan.endIdx - plan.startIdx;
    const avgRowsPerGroup = coveredRows / mountedCount;
    console.log('avgRowsPerGroup:', avgRowsPerGroup, 'rowBudgetCount:', Math.ceil(158 / avgRowsPerGroup));
    // Simulate what the real measurements would be. Just look at a few
    const sampleActual = Array.from({ length: 30 }, (_, i) => {
      const n = String(i + 1).padStart(3, '0');
      const mode = i % 4;
      let text;
      if (mode === 0) text = `M${n} tall\n\n\`\`\`\n${Array.from({ length: 10 }, (_, k) => `line ${k} of M${n}`).join('\n')}\n\`\`\``;
      else if (mode === 1) text = `M${n} short`;
      else if (mode === 2) text = `M${n} para one\n\nM${n} para two\n\nM${n} para three`;
      else text = `M${n} **bold** and \`inline\``;
      // Approximate: assistant entries use computeEntryRows for 'assistant' kind
      // header(1) + body(wrapped at w-2) + chrome(2) = 3 + wrappedRows
      const w = COLS - 2;
      // Count newlines and wrap
      const lines = text.split('\n');
      let bodyRows = 0;
      for (const line of lines) {
        bodyRows += Math.max(1, Math.ceil(line.length / w));
      }
      return 2 + bodyRows; // header + body, no chrome adjustments
    });
    console.log('approximate actual rows for first 30:', sampleActual);
    console.log('first 30 actual total:', sampleActual.reduce((a, b) => a + b, 0));
    expect(true).toBe(true);
  });
});
