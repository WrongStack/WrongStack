import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from '@playwright/test';
import { spawn } from 'node-pty';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const requireWebui = createRequire(new URL('../../webui/package.json', import.meta.url));
const xtermJs = readFileSync(requireWebui.resolve('@xterm/xterm/lib/xterm.js'));
const xtermCss = readFileSync(requireWebui.resolve('@xterm/xterm/css/xterm.css'));

interface TerminalClient {
  terminal: {
    cols: number;
    resize(cols: number, rows: number): void;
    buffer: {
      active: {
        length: number;
        getLine(
          row: number,
        ): { isWrapped: boolean; translateToString(trim: boolean): string } | undefined;
      };
    };
  };
}

/**
 * The full App in a real PTY painted by xterm.js, with model output whose
 * emoji the terminal measures differently from the layout. One disputed row
 * used to auto-wrap and shift or tear the whole frame; every size must now
 * keep the frame whole.
 */
describe('full App with disputed-width emoji through PTY / xterm.js', () => {
  it('keeps the frame whole at every size', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wstack-tui-graphemes-'));
    const wss = new WebSocketServer({ noServer: true });
    let replay = '';
    let lastOutput = Date.now();
    let browser: Browser | undefined;
    let exited = false;
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
        <div id="terminal"></div><script src="/xterm.js"></script><script>
        const terminal = window.terminal = new Terminal({ cols: 100, rows: 32, fontFamily: 'monospace' });
        terminal.open(document.getElementById('terminal'));
        const socket = new WebSocket('ws://' + location.host);
        socket.onmessage = e => terminal.write(e.data);
        terminal.onData(d => { if (socket.readyState === 1) socket.send(d); });
        </script>`);
    });
    server.on('upgrade', (request, socket, head) =>
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request)),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture listener');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      WRONGSTACK_HOME: join(root, 'home'),
      WRONGSTACK_TUI_TERMINAL: 'browser',
      WRONGSTACK_TUI_ICON_STYLE: '',
      WSTACK_ICONS: 'auto',
      WRONGSTACK_NO_TITLE: '1',
      WRONGSTACK_PTY_TEST_SIDEBAR: 'true',
      WRONGSTACK_PTY_TEST_RICH: '1',
    };
    delete env.NO_COLOR;
    delete env.WRONGSTACK_TUI_GRAPHEMES;
    const terminal = spawn(
      resolveBunExecutable(),
      [fileURLToPath(new URL('./helpers/browser-pty-app.tsx', import.meta.url)), root],
      { name: 'xterm-256color', cols: 100, rows: 32, cwd: repo, env },
    );
    const terminalExit = new Promise<void>((resolve) =>
      terminal.onExit(() => {
        exited = true;
        resolve();
      }),
    );
    terminal.onData((data) => {
      lastOutput = Date.now();
      replay += data;
      for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    wss.on('connection', (ws) => {
      ws.send(replay);
      ws.on('message', (data) => terminal.write(data.toString()));
    });
    onTestFinished(async () => {
      if (!exited) terminal.kill();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await browser?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.race([terminalExit, new Promise((resolve) => setTimeout(resolve, 5000))]);
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // The App's project daemons may still hold their databases open; the
        // OS temp directory is cleaned without us.
      }
    });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const screen = () =>
      page.evaluate(() => {
        const buffer = (globalThis as unknown as TerminalClient).terminal.buffer.active;
        return Array.from({ length: buffer.length }, (_, row) => {
          const line = buffer.getLine(row);
          return { text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false };
        });
      });
    // Output going quiet is the frame being done; text polls alone pass on a
    // stale frame that still holds the expected words.
    const quiet = async () => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 150));
      while (Date.now() - lastOutput < 600 && Date.now() - start < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await expect
      .poll(async () => (await screen()).map((row) => row.text).join('\n'), { timeout: 20_000 })
      .toContain('LAST-RICH-LINE');

    for (const [cols, rows] of [
      [100, 32],
      [160, 48],
      [80, 24],
      [60, 20],
      [40, 16],
      [120, 40],
    ] as const) {
      await page.evaluate(
        ([c, r]) => (globalThis as unknown as TerminalClient).terminal.resize(c, r),
        [cols, rows] as const,
      );
      terminal.resize(cols, rows);
      await quiet();
      const grid = await screen();
      const text = grid.map((row) => row.text);
      const where = `${cols}x${rows} (${root})\n${text.join('\n')}`;
      expect(
        grid.filter((row) => row.wrapped).map((row) => row.text),
        where,
      ).toEqual([]);
      expect(
        text.filter((line) => line.includes('╭─ ◆')),
        where,
      ).toHaveLength(1);
      expect(text.at(-1), where).toMatch(/[◖◗]/);
      expect(
        text.some((line) => line.includes('LAST-RICH-LINE')),
        where,
      ).toBe(true);
      // A torn row splits a word across two screen rows.
      for (const line of text.filter((row) => /RIGHT-ED|IGHT-EDGE/.test(row))) {
        expect(line, where).toContain('RIGHT-EDGE');
      }
    }
    expect(errors).toEqual([]);
  }, 120_000);
});
