import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { type Browser, chromium, type Page } from '@playwright/test';
import { Box, render, Text } from 'ink';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createGraphemeStableStdout } from '../src/grapheme-stable-stdout.js';
import { AUTOWRAP_OFF } from '../src/terminal-modes.js';
import { settle } from './helpers/real-tty.js';

const webuiRequire = createRequire(new URL('../../webui/package.json', import.meta.url));
const xtermJs = readFileSync(webuiRequire.resolve('@xterm/xterm/lib/xterm.js'));
const xtermCss = readFileSync(webuiRequire.resolve('@xterm/xterm/css/xterm.css'));

// Clusters string-width and xterm.js measure differently, plus controls.
const ROWS = [
  'plain ascii control row',
  'vs16 ⚠️ warn ❤️ love',
  'skin 👍🏽 tone ✌🏿 peace',
  'zwj 👨‍👩‍👧 family 🧑🏽‍💻 dev',
  'keycap 1️⃣ flag 🇹🇷 tr',
  'wide 🚀 rocket ✅ done ⚡',
  'cjk 中文字符 日本語 한국어',
];
// The same rows mid-stream: each sequence is still missing its last code
// point, so the next frame completes a cluster inside an unchanged prefix.
const STREAMING = [
  'plain ascii control row',
  'vs16 ⚠',
  'skin 👍',
  'zwj 👨‍👩',
  'keycap 1',
  'wide 🚀 rocket',
  'cjk 中文字符',
];
const COLS = 48;
const SEQUENCE_MARK = /^(?:‍|︎|️|⃣|[\u{1F3FB}-\u{1F3FF}])/u;
const ESCAPE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b[ -/]*[0-~]/g;

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = COLS;
  rows = 12;
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

interface TerminalPage {
  terminal: {
    cols: number;
    write(data: string, done: () => void): void;
    buffer: {
      active: {
        length: number;
        getLine(row: number):
          | {
              isWrapped: boolean;
              translateToString(trim: boolean): string;
              getCell(col: number): { getChars(): string } | undefined;
            }
          | undefined;
      };
    };
  };
}

function Rows({ rows }: { rows: readonly string[] }): React.ReactElement {
  return (
    <Box borderStyle="single" flexDirection="column" width={COLS}>
      {rows.map((row, index) => (
        // Rows are positional: the streaming frame updates each one in place.
        <Text key={index} wrap="truncate">
          {row}
        </Text>
      ))}
    </Box>
  );
}

async function paint(page: Page, data: string): Promise<void> {
  // A Linux PTY's ONLCR turns each LF into CRLF on the way.
  const bytes = data.replace(/\r?\n/g, '\r\n');
  await page.evaluate(
    (text) =>
      new Promise<void>((resolve) =>
        (globalThis as unknown as TerminalPage).terminal.write(text, resolve),
      ),
    bytes,
  );
}

function grid(page: Page) {
  return page.evaluate(() => {
    const terminal = (globalThis as unknown as TerminalPage).terminal;
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, y) => {
      const line = buffer.getLine(y);
      let border = -1;
      for (let x = 0; x < terminal.cols; x++) {
        if (line?.getCell(x)?.getChars() === '│') border = x;
      }
      return { text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped, border };
    });
  });
}

describe('emoji rows in real Chromium / xterm.js (direct PTY bytes)', () => {
  it('keeps every bordered row the grid width, also while clusters stream in', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/xterm.js') {
        res.end(xtermJs);
        return;
      }
      if (req.url === '/xterm.css') {
        res.end(xtermCss);
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
        <div id="t"></div><script src="/xterm.js"></script><script>
        window.terminal = new Terminal({ cols: ${COLS}, rows: 12, fontFamily: 'monospace' });
        terminal.open(document.getElementById('t'));
        </script>`);
    });
    let browser: Browser | undefined;
    const stdout = new FakeStdout();
    const instance = render(<Rows rows={STREAMING} />, {
      // The production mount: Ink writes through the grapheme layer, and it
      // repaints only the changed tail of a line (as tuiRenderOptions sets).
      stdout: createGraphemeStableStdout(stdout as unknown as NodeJS.WriteStream),
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: true,
    });
    onTestFinished(async () => {
      instance.unmount();
      await browser?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback listener');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await settle(80);
    // What the TUI owns at launch: alternate screen with autowrap off.
    await paint(page, `\x1b[?1049h${AUTOWRAP_OFF}${stdout.chunks.join('')}`);
    let painted = stdout.chunks.length;

    instance.rerender(<Rows rows={ROWS} />);
    await settle(80);
    const update = stdout.chunks.slice(painted);
    painted = stdout.chunks.length;
    // Ink repainted line tails from a column inside the row, not whole lines.
    expect(update.join('')).toMatch(/\x1b\[(?:[2-9]|\d{2,})G/);
    await paint(page, update.join(''));

    // No write starts its text in the middle of a cluster.
    for (const chunk of stdout.chunks) {
      for (const run of chunk.split(ESCAPE)) expect(run).not.toMatch(SEQUENCE_MARK);
    }
    const rows = await grid(page);
    const body = rows.filter((row) => row.text.startsWith('│'));
    expect(body.map((row) => row.text.slice(1).split(' ')[0])).toEqual(
      ROWS.map((row) => row.split(' ')[0]),
    );
    // The right border of every row sits in the last column, as Ink laid it out.
    expect(body.map((row) => row.border)).toEqual(ROWS.map(() => COLS - 1));
    expect(rows.filter((row) => row.wrapped)).toEqual([]);
  }, 60_000);
});
