import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
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
    rows: number;
    paste(text: string): void;
    clearSelection(): void;
    getSelection(): string;
    buffer: {
      active: {
        length: number;
        getLine(row: number):
          | {
              translateToString(trim: boolean, start: number, end: number): string;
              getCell(col: number): { isInverse(): number } | undefined;
            }
          | undefined;
      };
    };
  };
  socket: WebSocket;
  connect(): void;
  connected: boolean;
}

describe('full App through PTY / WebSocket / xterm.js', () => {
  it('keeps multiline paste, history scrolling, selection and reconnects usable', async () => {
    const base = join(repo, '.temp_files', 'tui-browser-terminals');
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, 'pty-'));
    const trace = join(root, 'terminal.bin');
    const wss = new WebSocketServer({ noServer: true });
    const clients = new Set<WebSocket>();
    let replay = '';
    let inputMessages = 0;
    let browser: Browser | undefined;
    let terminal: ReturnType<typeof spawn> | undefined;
    let terminalExit: Promise<void> | undefined;
    let exitCode: number | undefined;
    const server = createServer((req, res) => {
      if (req.url === '/xterm.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(xtermJs);
      } else if (req.url === '/xterm.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(xtermCss);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><link rel="stylesheet" href="/xterm.css"><div id="terminal"></div>
          <script src="/xterm.js"></script><script>
          let terminal;
          window.connect = () => {
            if (terminal) terminal.dispose();
            terminal = window.terminal = new Terminal({ cols: 100, rows: 32, fontFamily: 'monospace', fontSize: 14 });
            terminal.open(document.getElementById('terminal'));
            const socket = window.socket = new WebSocket('ws://' + location.host);
            window.connected = false;
            socket.onopen = () => { window.connected = true; terminal.focus(); };
            socket.onclose = () => { window.connected = false; };
            socket.onmessage = e => terminal.write(e.data);
            terminal.onData(data => { if (socket.readyState === 1) socket.send(data); });
          };
          connect();
          </script>`);
      }
    });
    onTestFinished(async () => {
      if (terminal && exitCode === undefined) terminal.kill();
      for (const client of clients) client.terminate();
      wss.close();
      await browser?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (terminalExit) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`PTY did not exit: ${root}`)), 5000);
          void terminalExit!.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    });
    server.on('upgrade', (request, socket, head) =>
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request)),
    );
    wss.on('connection', (ws) => {
      clients.add(ws);
      ws.send(replay);
      ws.on('message', (data) => {
        inputMessages++;
        appendFileSync(join(root, 'input.jsonl'), `${JSON.stringify(data.toString())}\n`);
        terminal?.write(data.toString());
      });
      ws.on('close', () => clients.delete(ws));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture listener');
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      WRONGSTACK_HOME: join(root, 'home'),
      WRONGSTACK_TUI_TERMINAL: 'browser',
      WRONGSTACK_TUI_ICON_STYLE: 'browser',
      WRONGSTACK_NO_TITLE: '1',
      FORCE_COLOR: '3',
      COLORTERM: 'truecolor',
    };
    delete childEnv.NO_COLOR;
    terminal = spawn(
      resolveBunExecutable(),
      [fileURLToPath(new URL('./helpers/browser-pty-app.tsx', import.meta.url)), root],
      {
        name: 'xterm-256color',
        cols: 100,
        rows: 32,
        cwd: repo,
        env: childEnv,
      },
    );
    terminal.onData((data) => {
      appendFileSync(trace, data);
      replay += data;
      for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    terminalExit = new Promise<void>((resolve) =>
      terminal!.onExit((event) => {
        exitCode = event.exitCode;
        resolve();
      }),
    );
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const screen = () =>
      page.evaluate(() => {
        const terminal = (globalThis as unknown as TerminalClient).terminal;
        return Array.from(
          { length: terminal.buffer.active.length },
          (_, row) =>
            terminal.buffer.active.getLine(row)?.translateToString(true, 0, terminal.cols) ?? '',
        );
      });
    const records = () =>
      readFileSync(join(root, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              calls?: number;
              blocks?: Array<{ type: string; text?: string }>;
            },
        );
    const runs = () => records().filter((event) => event.type === 'run');
    const checked = (name: string) =>
      appendFileSync(join(root, 'checks.jsonl'), `${JSON.stringify({ name, status: 'passed' })}\n`);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect
      .poll(async () => (await screen()).join('\n'), {
        timeout: 20_000,
        message: `Full App boot (${root})`,
      })
      .toContain('[Text]');
    expect(records()[0]).toMatchObject({ type: 'boot', stdinTTY: true, stdoutTTY: true });
    await page.screenshot({ path: join(root, 'boot.png') });
    const paste = 'first browser line\nsecond browser line\nthird browser line';
    await page.evaluate(
      (text) => (globalThis as unknown as TerminalClient).terminal.paste(text),
      paste,
    );
    await expect.poll(async () => (await screen()).join('\n')).toContain('pasted #1');
    expect(records().filter((event) => event.type === 'run')).toHaveLength(0);
    await page.keyboard.press('Enter');
    await expect.poll(() => records().filter((event) => event.type === 'run')).toHaveLength(1);
    expect(
      records()
        .find((event) => event.type === 'run')
        ?.blocks?.map((block) => block.text ?? '')
        .join(''),
    ).toContain(paste);
    await expect.poll(async () => (await screen()).join('\n')).toContain('PTY completed request 1');
    await page.screenshot({ path: join(root, 'submitted.png') });
    checked('multiline paste waits for Enter and submits all line breaks once');

    const tail = (await screen()).join('\n');
    await page.keyboard.press('PageUp');
    await expect.poll(async () => (await screen()).join('\n')).not.toBe(tail);
    const paged = (await screen()).filter((line) => line.includes('PTY answer')).join('\n');
    const terminalBox = await page.locator('.xterm-screen').boundingBox();
    if (!terminalBox) throw new Error('No xterm screen geometry');
    await page.mouse.move(
      terminalBox.x + terminalBox.width / 2,
      terminalBox.y + terminalBox.height / 3,
    );
    await page.mouse.wheel(0, -600);
    await expect
      .poll(async () => (await screen()).filter((line) => line.includes('PTY answer')).join('\n'))
      .not.toBe(paged);
    expect(runs()).toHaveLength(1);
    await page.screenshot({ path: join(root, 'scrolled.png') });
    checked('PageUp and native wheel events scroll managed transcript');

    const selectionLines = await screen();
    const row = selectionLines.findIndex((line) => line.includes('selectable transcript text'));
    const col = selectionLines[row]?.indexOf('selectable') ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);
    const cellWidth = terminalBox.width / 100;
    const cellHeight = terminalBox.height / 32;
    await page.keyboard.down('Shift');
    try {
      await page.mouse.move(
        terminalBox.x + (col + 0.2) * cellWidth,
        terminalBox.y + (row + 0.5) * cellHeight,
      );
      await page.mouse.down();
      await page.mouse.move(
        terminalBox.x + (col + 10.8) * cellWidth,
        terminalBox.y + (row + 0.5) * cellHeight,
        { steps: 12 },
      );
      await page.mouse.up();
    } finally {
      await page.keyboard.up('Shift');
    }
    await page.screenshot({ path: join(root, 'selection.png') });
    await expect
      .poll(() =>
        page.evaluate(() => (globalThis as unknown as TerminalClient).terminal.getSelection()),
      )
      .toContain('selectable');
    checked('Shift-drag selects visible transcript text while mouse tracking is active');

    await page.evaluate(() => (globalThis as unknown as TerminalClient).terminal.clearSelection());
    await page.mouse.move(
      terminalBox.x + (col + 0.5) * cellWidth,
      terminalBox.y + (row + 0.5) * cellHeight,
    );
    await page.mouse.down();
    try {
      await page.mouse.move(
        terminalBox.x + (col + 8.5) * cellWidth,
        terminalBox.y + (row + 0.5) * cellHeight,
        { steps: 8 },
      );
      await expect
        .poll(() =>
          page.evaluate(
            ([r, c]) =>
              (globalThis as unknown as TerminalClient).terminal.buffer.active
                .getLine(r!)
                ?.getCell(c!)
                ?.isInverse(),
            [row, col + 2],
          ),
        )
        .toBeGreaterThan(0);
      await page.screenshot({ path: join(root, 'app-selection.png') });
      // Cancel in the gutter before release, keeping the user's OS clipboard
      // untouched while verifying the App's real drag/SGR highlight path.
      await page.mouse.move(
        terminalBox.x + terminalBox.width - cellWidth / 2,
        terminalBox.y + (row + 0.5) * cellHeight,
        { steps: 8 },
      );
    } finally {
      await page.mouse.up();
    }
    checked('App text selection highlights the dragged transcript cells and cancels at the gutter');

    // Keep this fixture's PTY alive across a transport disconnect. This models
    // persistent remote terminal hosts; WebUI's per-client shell policy differs.
    await page.keyboard.type('reconnect draft');
    await expect.poll(async () => (await screen()).join('\n')).toContain('reconnect draft');
    await page.evaluate(() => (globalThis as unknown as TerminalClient).socket.close());
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
      .toBe(false);
    await page.evaluate(() => (globalThis as unknown as TerminalClient).connect());
    await expect.poll(async () => (await screen()).join('\n')).toContain('reconnect draft');
    expect(records().filter((event) => event.type === 'boot')).toHaveLength(1);
    expect(runs()).toHaveLength(1);
    await page.keyboard.type(' after reconnect');
    await page.keyboard.press('Enter');
    await expect.poll(() => runs()).toHaveLength(2);
    expect(
      runs()[1]
        ?.blocks?.map((block) => block.text ?? '')
        .join(''),
    ).toContain('reconnect draft after reconnect');
    await expect.poll(async () => (await screen()).join('\n')).toContain('PTY completed request 2');
    checked('reconnect replays the retained PTY without losing or double-submitting the draft');

    const beforePartial = inputMessages;
    await page.evaluate(() =>
      (globalThis as unknown as TerminalClient).socket.send('\x1b[200~first reconnect line\r'),
    );
    await expect.poll(() => inputMessages).toBeGreaterThan(beforePartial);
    await page.evaluate(() => (globalThis as unknown as TerminalClient).socket.close());
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
      .toBe(false);
    // Exercise a real network pause longer than the old 500 ms paste-idle path.
    await page.waitForTimeout(650);
    expect(runs()).toHaveLength(2);
    await page.evaluate(() => (globalThis as unknown as TerminalClient).connect());
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as TerminalClient).connected))
      .toBe(true);
    await page.evaluate(() =>
      (globalThis as unknown as TerminalClient).socket.send('second reconnect line\x1b[201~'),
    );
    await expect
      .poll(async () =>
        (await screen()).some((line) => line.startsWith('│ >') && line.includes('pasted #')),
      )
      .toBe(true);
    expect(runs()).toHaveLength(2);
    await page.keyboard.press('Enter');
    await expect.poll(() => runs()).toHaveLength(3);
    expect(
      runs()[2]
        ?.blocks?.map((block) => block.text ?? '')
        .join(''),
    ).toContain('first reconnect line\nsecond reconnect line');
    await expect.poll(async () => (await screen()).join('\n')).toContain('PTY completed request 3');
    checked('a partial multiline paste survives a 650 ms disconnect and completes exactly once');
    await page.keyboard.type('newline-only paste');
    await page.evaluate(() => (globalThis as unknown as TerminalClient).terminal.paste('\n'));
    await expect
      .poll(async () =>
        (await screen()).some((line) => line.startsWith('│ >') && line.includes('pasted #')),
      )
      .toBe(true);
    expect(runs()).toHaveLength(3);
    await page.keyboard.press('Enter');
    await expect.poll(() => runs()).toHaveLength(4);
    expect(
      runs()[3]
        ?.blocks?.map((block) => block.text ?? '')
        .join(''),
    ).toContain('newline-only paste');
    await expect.poll(async () => (await screen()).join('\n')).toContain('PTY completed request 4');
    checked('a newline-only paste stays data and does not submit the existing draft');
    await page.screenshot({ path: join(root, 'reconnected.png') });
    expect(errors).toEqual([]);
  }, 60_000);
});
