import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/input.js';
import { type Key, useInput } from '../src/ink.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/**
 * Ink broadcasts input to every mounted handler. A paste used to reach them
 * all, so a shortcut handler read a pasted "Y" as approve and a pasted "y"
 * as confirm. Pastes now reach only handlers that own a text field.
 */
function Probe({ events, paste }: { events: Array<[string, Key]>; paste?: boolean }) {
  useInput((input, key) => events.push([input, key]), paste ? { paste: true } : undefined);
  return null;
}

describe('paste delivery is opt-in', () => {
  it('a shortcut handler never sees a paste; the composer and opted-in fields do', async () => {
    const shortcut: Array<[string, Key]> = [];
    const field: Array<[string, Key]> = [];
    const composer: string[] = [];
    const view = renderRealTty(
      <>
        <Input value="" cursor={0} onKey={(input, key) => key.paste && composer.push(input)} />
        <Probe events={shortcut} />
        <Probe events={field} paste />
      </>,
    );
    try {
      await settle();
      view.stdin.write('\x1b[200~Y\x1b[201~');
      await settle();
      expect(shortcut).toEqual([]);
      expect(field).toEqual([['Y', expect.objectContaining({ paste: true })]]);
      expect(composer).toEqual(['Y']);

      // Typed keys still reach every handler.
      view.stdin.write('q');
      await settle();
      expect(shortcut.map(([input]) => input)).toEqual(['q']);
    } finally {
      view.unmount();
    }
  });
});
