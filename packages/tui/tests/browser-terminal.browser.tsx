import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { type Browser, chromium } from '@playwright/test';
import { describe, expect, it, onTestFinished } from 'vitest';
import { Input, type KeyEvent } from '../src/components/input.js';
import { type RealTtyView, renderRealTty, settle } from './helpers/real-tty.js';

// Use the real browser-terminal dependency already installed for the WebUI.
const webuiRequire = createRequire(new URL('../../webui/package.json', import.meta.url));
const xtermJs = readFileSync(webuiRequire.resolve('@xterm/xterm/lib/xterm.js'));
const xtermCss = readFileSync(webuiRequire.resolve('@xterm/xterm/css/xterm.css'));

interface TerminalPage {
  terminal: {
    cols: number;
    focus(): void;
    paste(text: string): void;
    resize(cols: number, rows: number): void;
    write(data: string, done: () => void): void;
    buffer: {
      active: {
        length: number;
        getLine(
          row: number,
        ): { translateToString(trim: boolean, start: number, end: number): string } | undefined;
      };
    };
  };
}

describe('TUI in real Chromium / xterm.js', () => {
  it('paints the browser glyph profile and preserves keys, wheel and resize over fragmented input', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/xterm.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(xtermJs);
      } else if (req.url === '/xterm.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(xtermCss);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><link rel="stylesheet" href="/xterm.css">
          <div id="terminal"></div><script src="/xterm.js"></script><script>
          window.terminal = new Terminal({ cols: 80, rows: 24, fontFamily: 'monospace', fontSize: 14 });
          terminal.open(document.getElementById('terminal'));
          terminal.onData(data => window.sendInput(data));
          terminal.focus();
          </script>`);
      }
    });
    let browser: Browser | undefined;
    let view: RealTtyView | undefined;
    onTestFinished(async () => {
      view?.unmount();
      await browser?.close();
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback listener');
    browser = await chromium.launch({ headless: true });
    const errors: string[] = [];
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const events: Array<{ input: string; key: KeyEvent }> = [];
    const terminalView = renderRealTty(
      <Input value="alpha beta" cursor={10} onKey={(input, key) => events.push({ input, key })} />,
      { columns: 80, rows: 24, debug: false },
    );
    view = terminalView;
    let outputIndex = 0;
    let splitInput = false;
    await page.exposeFunction('sendInput', (data: string) => {
      // Model a WebSocket/PTY bridge splitting every escape byte into a read.
      for (const chunk of splitInput ? [...data] : [data]) terminalView.stdin.write(chunk);
    });
    const paint = async () => {
      await settle();
      const output = terminalView.stdout.frames
        .slice(outputIndex)
        .join('')
        .replace(/\r?\n/g, '\r\n');
      outputIndex = terminalView.stdout.frames.length;
      await page.evaluate(
        (data) =>
          new Promise<void>((resolve) => {
            (globalThis as unknown as TerminalPage).terminal.write(data, resolve);
          }),
        output,
      );
    };
    const screen = () =>
      page.evaluate(() => {
        const terminal = (globalThis as unknown as TerminalPage).terminal;
        const buffer = terminal.buffer.active;
        return Array.from(
          { length: buffer.length },
          (_, row) => buffer.getLine(row)?.translateToString(true, 0, terminal.cols) ?? '',
        );
      });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          (globalThis as unknown as TerminalPage).terminal.write('\x1b[?1049h', resolve);
        }),
    );
    await paint();
    expect((await screen()).join('\n')).toContain('alpha beta');
    expect((await screen()).join('\n')).toContain('ASK WRONGSTACK');

    for (const fragmented of [false, true]) {
      splitInput = fragmented;
      events.length = 0;
      await page.keyboard.press('Home');
      await page.keyboard.press('End');
      await page.keyboard.press('Control+ArrowLeft');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('F2');
      await expect.poll(() => events.length).toBe(5);
      expect(
        events.map(({ key }) => [
          key.home,
          key.end,
          key.ctrl && key.leftArrow,
          key.backspace,
          key.fn === 2,
        ]),
      ).toEqual([
        [true, false, false, false, false],
        [false, true, false, false, false],
        [false, false, true, false, false],
        [false, false, false, true, false],
        [false, false, false, false, true],
      ]);
    }

    // Enable the same modes the production launch owns, then use xterm's
    // actual paste and DOM wheel paths, not hand-made reports.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          (globalThis as unknown as TerminalPage).terminal.write(
            '\x1b[?2004h\x1b[?1000h\x1b[?1006h',
            resolve,
          );
        }),
    );
    events.length = 0;
    await page.evaluate(() =>
      (globalThis as unknown as TerminalPage).terminal.paste('browser paste'),
    );
    await expect.poll(() => events.some(({ input }) => input === 'browser paste')).toBe(true);
    await page.locator('.xterm-screen').hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(() => events.some(({ key }) => key.mouse?.kind === 'wheel')).toBe(true);

    for (const columns of [40, 100, 80]) {
      await page.evaluate(
        (cols) => (globalThis as unknown as TerminalPage).terminal.resize(cols, 24),
        columns,
      );
      terminalView.resize(columns, 24);
      await paint();
      const lines = (await screen()).filter((line) => line.includes('alpha beta'));
      expect(lines, JSON.stringify(await screen())).toHaveLength(1);
      expect(lines[0]?.length).toBe(columns);
      expect(lines[0]?.endsWith('│')).toBe(true);
    }
    expect(errors).toEqual([]);
  });
});
