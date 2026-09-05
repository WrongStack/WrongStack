import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildChildEnv } from '@wrongstack/core/utils';

export interface ClipboardImage {
  base64: string;
  mediaType: 'image/png';
  bytes: number;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const platform = process.platform;
  if (platform === 'win32') return readWindows();
  if (platform === 'darwin') return readDarwin();
  if (platform === 'linux') return readLinux();
  return null;
}

/**
 * Write plain text to the system clipboard. Returns `true` on success, `false`
 * when the platform is unsupported, no clipboard tool is available, or the
 * child process failed. Mirrors `readClipboardText`'s platform matrix
 * (PowerShell on Windows, `pbcopy` on macOS, `wl-copy`/`xclip` on Linux) and is
 * used by the TUI to copy a chat card's content when its copy icon is clicked —
 * terminals in raw mode never perform a native copy, so we do it ourselves.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  const platform = process.platform;
  if (platform === 'win32') {
    // Read the payload from stdin so arbitrary text (quotes, newlines,
    // non-ASCII) never has to be escaped into the command line. Force UTF-8 so
    // multibyte characters survive the pipe.
    const ps =
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
      '$in = [Console]::In.ReadToEnd(); ' +
      'Set-Clipboard -Value $in';
    return runCmdWithInput('powershell', ['-NoProfile', '-Command', ps], text);
  }
  if (platform === 'darwin') {
    return runCmdWithInput('pbcopy', [], text);
  }
  if (platform === 'linux') {
    const tries: Array<[string, string[]]> = [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
    ];
    for (const [cmd, args] of tries) {
      if (await runCmdWithInput(cmd, args, text)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Read plain text from the system clipboard. Returns `null` when the clipboard
 * holds no text (or only an image), the read failed, or the platform is
 * unsupported. Used by the TUI's Ctrl+V handler: terminals in raw mode deliver
 * Ctrl+V to the app as a control byte rather than performing a native paste, so
 * we read the clipboard ourselves.
 */
export async function readClipboardText(): Promise<string | null> {
  const platform = process.platform;
  if (platform === 'win32') {
    // -Raw preserves embedded newlines; force UTF-8 so non-ASCII survives the
    // pipe. PowerShell appends one trailing newline to stdout — strip it.
    const ps = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw';
    const out = await runCmd('powershell', ['-NoProfile', '-Command', ps]);
    if (out == null) return null;
    const text = out.replace(/\r?\n$/, '');
    return text.length > 0 ? text : null;
  }
  if (platform === 'darwin') {
    const out = await runCmd('pbpaste', []);
    return out && out.length > 0 ? out : null;
  }
  if (platform === 'linux') {
    const tries: Array<[string, string[]]> = [
      ['wl-paste', ['--no-newline']],
      ['xclip', ['-selection', 'clipboard', '-o']],
    ];
    for (const [cmd, args] of tries) {
      const out = await runCmd(cmd, args);
      if (out && out.length > 0) return out;
    }
    return null;
  }
  return null;
}

async function readWindows(): Promise<ClipboardImage | null> {
  const tmp = path.join(os.tmpdir(), `wstack-clip-${randomUUID()}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { Write-Output "NO_IMAGE"; exit 0 }',
    `$img.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'Write-Output "OK"',
  ].join('; ');
  try {
    const out = await runCmd('powershell', ['-NoProfile', '-Command', ps]);
    if (!out || out.trim() === 'NO_IMAGE') return null;
    if (!out.includes('OK')) return null;
    return await readPngFile(tmp);
  } finally {
    // PowerShell can save the image and then fail before printing OK. Do not
    // leave that temporary PNG behind on the early-return path.
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function readDarwin(): Promise<ClipboardImage | null> {
  const tmp = path.join(os.tmpdir(), `wstack-clip-${randomUUID()}.png`);
  const script = [
    'try',
    `  set the_file to (open for access POSIX file "${tmp}" with write permission)`,
    '  write (the clipboard as «class PNGf») to the_file',
    '  close access the_file',
    'on error',
    '  try',
    '    close access POSIX file "' + tmp + '"',
    '  end try',
    '  return "NO_IMAGE"',
    'end try',
    'return "OK"',
  ].join('\n');
  try {
    const out = await runCmd('osascript', ['-e', script]);
    if (out?.trim() !== 'OK') return null;
    return await readPngFile(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function readLinux(): Promise<ClipboardImage | null> {
  const tmp = path.join(os.tmpdir(), `wstack-clip-${randomUUID()}.png`);
  const tries: Array<[string, string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  for (const [cmd, args] of tries) {
    const ok = await runCmdToFile(cmd, args, tmp).catch(() => false);
    if (ok) return readPngFile(tmp);
  }
  return null;
}

async function readPngFile(p: string): Promise<ClipboardImage | null> {
  try {
    const buf = await fs.readFile(p);
    if (buf.length === 0) {
      await fs.unlink(p).catch(() => undefined);
      return null;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      await fs.unlink(p).catch(() => undefined);
      throw new Error(`Clipboard image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`);
    }
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      await fs.unlink(p).catch(() => undefined);
      return null;
    }
    await fs.unlink(p).catch(() => undefined);
    return { base64: buf.toString('base64'), mediaType: 'image/png', bytes: buf.length };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Hard ceiling for a clipboard subprocess. Reading the clipboard must never
 * hang the TUI: on a headless/loaded CI runner the PowerShell/xclip/wl-paste
 * read can stall indefinitely (no display, slow shell start). After this we
 * kill the child and resolve the safe default.
 */
const CLIPBOARD_CMD_TIMEOUT_MS = 5_000;

function runCmd(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Decode across chunk boundaries: a multi-byte UTF-8 sequence is routinely
    // split between two pipe reads (the default read is 64KiB), and decoding
    // each chunk in isolation would turn both halves into U+FFFD. StringDecoder
    // holds the partial sequence until the next chunk completes it.
    const decoder = new StringDecoder('utf8');
    let out = '';
    let outBytes = 0;
    let settled = false;
    let killedByTimeout = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killCap);
      child.stdout?.off('data', onStdoutData);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, CLIPBOARD_CMD_TIMEOUT_MS);
    // Safety cap: if the child ignores SIGTERM, do not hang forever.
    const killCap = setTimeout(() => finish(null), CLIPBOARD_CMD_TIMEOUT_MS + 2_000);
    const onStdoutData = (c: Buffer | string): void => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      outBytes += chunk.byteLength;
      if (outBytes > MAX_TEXT_BYTES) {
        out = '';
        child.kill('SIGTERM');
        finish(null);
        return;
      }
      out += decoder.write(chunk);
    };
    child.stdout.on('data', onStdoutData);
    child.on('error', () => finish(null));
    child.on('exit', (code) => {
      if (killedByTimeout) return finish(null);
      // Flush any trailing partial sequence the child never completed.
      out += decoder.end();
      finish(code === 0 ? out : null);
    });
  });
}

/**
 * Spawn `cmd` and feed `input` to its stdin, resolving `true` when the child
 * exits 0 within the timeout and `false` on spawn error, non-zero exit, or
 * timeout. Used by `writeClipboardText`; stdin is the payload channel so text
 * never touches the command line.
 */
function runCmdWithInput(cmd: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: buildChildEnv(),
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    let killedByTimeout = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killCap);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, CLIPBOARD_CMD_TIMEOUT_MS);
    const killCap = setTimeout(() => finish(false), CLIPBOARD_CMD_TIMEOUT_MS + 2_000);
    child.on('error', () => finish(false));
    child.on('exit', (code) => {
      if (killedByTimeout) return finish(false);
      finish(code === 0);
    });
    // Writing to stdin can EPIPE if the child already exited; swallow it and
    // let the exit handler decide the outcome.
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

function runCmdToFile(cmd: string, args: string[], outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let killedByTimeout = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killCap);
      child.stdout?.off('data', onStdoutData);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, CLIPBOARD_CMD_TIMEOUT_MS);
    // Safety cap: if the child ignores SIGTERM, do not hang forever.
    const killCap = setTimeout(() => finish(false), CLIPBOARD_CMD_TIMEOUT_MS + 2_000);
    const onStdoutData = (c: Buffer): void => {
      outputBytes += c.byteLength;
      if (outputBytes > MAX_IMAGE_BYTES) {
        chunks.length = 0;
        child.kill('SIGTERM');
        finish(false);
        return;
      }
      chunks.push(c);
    };
    child.stdout.on('data', onStdoutData);
    child.on('error', () => finish(false));
    child.on('exit', async (code) => {
      if (killedByTimeout) return finish(false);
      if (code !== 0 || chunks.length === 0) return finish(false);
      try {
        await fs.writeFile(outPath, Buffer.concat(chunks));
        finish(true);
      } catch {
        finish(false);
      }
    });
  });
}
