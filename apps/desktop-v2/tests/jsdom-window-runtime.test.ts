// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Exercise the installed runtime rather than Vitest's environment shim.
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('Bun jsdom Window event contract', () => {
  it.each([undefined, 'outside-only', 'dangerously'] as const)(
    'adds, dispatches and removes Window listeners in %s mode without accepting forged receivers',
    (runScripts) => {
      const dom = new JSDOM('<!doctype html><p>Control</p>', { runScripts });
      try {
        let calls = 0;
        const listener = () => calls++;
        dom.window.addEventListener('proof', listener);
        dom.window.dispatchEvent(new dom.window.Event('proof'));
        dom.window.removeEventListener('proof', listener);
        dom.window.dispatchEvent(new dom.window.Event('proof'));
        expect(calls).toBe(1);
        expect(dom.window.document.querySelector('p')?.textContent).toBe('Control');
        expect(() =>
          dom.window.EventTarget.prototype.addEventListener.call({}, 'proof', () => undefined),
        ).toThrow(/valid instance of EventTarget/);
      } finally {
        dom.window.close();
      }
    },
  );
});
