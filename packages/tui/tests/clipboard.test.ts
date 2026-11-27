import { describe, expect, it } from 'vitest';
import {
  clipboardFailureMessage,
  clipboardFailureNotice,
  readClipboardImage,
  writeClipboardText,
  writeClipboardTextOutcome,
} from '../src/clipboard.js';

describe('readClipboardImage', () => {
  it('returns null or a valid PNG image, never throws on an empty clipboard', async () => {
    // We can't reliably stage an image on every CI machine, so the contract
    // we test here is: the function is safe to call and either returns
    // a structured ClipboardImage or null. It must NOT throw when the
    // clipboard is empty / no image is present / tooling is missing.
    // The single sanctioned throw is the >10MB size guard — the developer's
    // real clipboard may legitimately hold a huge image while the suite
    // runs, so treat that documented error as a pass, not a flake.
    let result: Awaited<ReturnType<typeof readClipboardImage>>;
    try {
      result = await readClipboardImage();
    } catch (err) {
      expect((err as Error).message).toMatch(/exceeds \d+MB limit/);
      return;
    }
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.mediaType).toBe('image/png');
      expect(typeof result.base64).toBe('string');
      expect(result.base64.length).toBeGreaterThan(0);
      expect(result.bytes).toBeGreaterThan(0);
    }
  }, 15_000);

  it('returns null on unsupported platforms', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
      const result = await readClipboardImage();
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});

describe('writeClipboardText', () => {
  function harness(nativeWorks: boolean, isTTY = true) {
    const nativeGot: string[] = [];
    const written: string[] = [];
    const deps = {
      native: async (text: string) => {
        nativeGot.push(text);
        return nativeWorks;
      },
      stdout: {
        isTTY,
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        },
      } as never,
    };
    return { deps, nativeGot, written };
  }

  it('hands the OS clipboard clean text: no ANSI, no NUL or other control bytes', async () => {
    const h = harness(true);
    const raw = '\u001b[31mred\u001b[0m\tcell\u0000cut here?\r\nnext\u0007line';
    await expect(writeClipboardText(raw, h.deps)).resolves.toBe(true);
    expect(h.nativeGot).toEqual(['red\tcellcut here?\r\nnextline']);
    expect(h.written).toEqual([]);
  });

  it('falls back to OSC 52 on a terminal when no clipboard tool works', async () => {
    const h = harness(false);
    await expect(writeClipboardText('héllo\u0000', h.deps)).resolves.toBe(true);
    expect(h.written).toEqual([`\u001b]52;c;${Buffer.from('héllo').toString('base64')}\u0007`]);
  });

  it('reports failure when there is no terminal to ask, or the text is too long for OSC 52', async () => {
    const piped = harness(false, false);
    await expect(writeClipboardText('x', piped.deps)).resolves.toBe(false);
    expect(piped.written).toEqual([]);

    const huge = harness(false);
    await expect(writeClipboardText('x'.repeat(80_000), huge.deps)).resolves.toBe(false);
    expect(huge.written).toEqual([]);
  });
});

describe('writeClipboardTextOutcome', () => {
  function harness(nativeWorks: boolean, isTTY = true) {
    const written: string[] = [];
    const deps = {
      native: async () => nativeWorks,
      stdout: {
        isTTY,
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        },
      } as never,
    };
    return { deps, written };
  }

  it('reports success for the native path and the OSC 52 fallback', async () => {
    const native = harness(true);
    await expect(writeClipboardTextOutcome('hello', native.deps)).resolves.toEqual({ ok: true });
    expect(native.written).toEqual([]);

    const osc = harness(false);
    await expect(writeClipboardTextOutcome('hello', osc.deps)).resolves.toEqual({ ok: true });
    expect(osc.written).toEqual([`\u001b]52;c;${Buffer.from('hello').toString('base64')}\u0007`]);
  });

  it('reports too-large (not a silent false) when over the OSC 52 cap, and never chunks', async () => {
    const huge = harness(false);
    await expect(writeClipboardTextOutcome('x'.repeat(80_000), huge.deps)).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    // No partial/chunked sequences may leak out — one over-cap payload is
    // dropped entirely, never split across multiple OSC 52 writes.
    expect(huge.written).toEqual([]);
  });

  it('reports unavailable when there is no TTY to ask', async () => {
    const piped = harness(false, false);
    await expect(writeClipboardTextOutcome('x', piped.deps)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(piped.written).toEqual([]);
  });

  it('keeps the boolean wrapper consistent with the outcome', async () => {
    const ok = harness(true);
    await expect(writeClipboardText('x', ok.deps)).resolves.toBe(true);
    const tooLarge = harness(false);
    await expect(writeClipboardText('x'.repeat(80_000), tooLarge.deps)).resolves.toBe(false);
    const piped = harness(false, false);
    await expect(writeClipboardText('x', piped.deps)).resolves.toBe(false);
  });
});

describe('clipboard failure messages', () => {
  it('mentions the size limit for over-cap failures', () => {
    expect(clipboardFailureMessage('too-large')).toMatch(/Copy failed/);
    expect(clipboardFailureMessage('too-large')).toMatch(/size limit/);
    expect(clipboardFailureMessage('too-large')).toMatch(/75 KB/);
    expect(clipboardFailureNotice('too-large')).toMatch(/too large/);
  });

  it('distinguishes a missing clipboard from an over-cap payload', () => {
    expect(clipboardFailureMessage('unavailable')).toMatch(/Copy failed/);
    expect(clipboardFailureMessage('unavailable')).not.toMatch(/size limit/);
    expect(clipboardFailureNotice('unavailable')).toMatch(/no clipboard available/);
  });
});
