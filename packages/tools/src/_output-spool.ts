/**
 * _output-spool — file-based capture of FULL command output.
 *
 * Command tools (bash/exec and the _spawn-stream consumers) cap what they
 * keep in memory and what reaches the model (COMMAND_OUTPUT_MAX_BYTES head+
 * tail). Everything past the cap used to be silently dropped, which pushed
 * agents to re-run commands with bigger buffers or stuff huge outputs into
 * chat history. The spool keeps the host's memory and the context window
 * small while losing nothing: once a command's output exceeds the in-memory
 * threshold, the FULL stream is written to a log file under
 * `~/.wrongstack/tool-output/` and the capped tool result carries a
 * `[full output: <path>]` marker so the model can read/grep the file
 * selectively instead of dumping it into context.
 *
 * Properties:
 *   - zero disk I/O for small outputs (file is created lazily on first byte
 *     past the threshold; the buffered head is flushed at that moment)
 *   - bounded memory: the head buffer never exceeds the threshold, and disk
 *     backpressure drops chunks past a 4 MB writable-buffer high-water mark
 *     (counted and reported in the marker) instead of queueing them on the heap
 *   - best-effort: any fs error disables the spool silently — command tools
 *     must never fail because diagnostics couldn't be written
 *   - retention: spool files older than 7 days are swept once per process
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

const SPOOL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Stop queueing chunks on the heap when the fs stream falls this far behind. */
const SPOOL_WRITE_HWM_BYTES = 4 * 1024 * 1024;

let sweepStarted = false;

/** Directory for spooled command output (under the wstack global root). */
export function toolOutputDir(): string {
  return path.join(wstackGlobalRoot(), 'tool-output');
}

/** Reset module state — test hook (per-process sweep memo + nothing else). */
export function _resetOutputSpoolForTests(): void {
  sweepStarted = false;
}

function sweepOldSpoolFiles(dir: string): void {
  if (sweepStarted) return;
  sweepStarted = true;
  void (async () => {
    try {
      const now = Date.now();
      for (const name of await fsp.readdir(dir)) {
        if (!name.endsWith('.log')) continue;
        const p = path.join(dir, name);
        try {
          const st = await fsp.stat(p);
          if (now - st.mtimeMs > SPOOL_RETENTION_MS) await fsp.unlink(p);
        } catch {
          /* concurrently removed — ignore */
        }
      }
    } catch {
      /* directory doesn't exist yet — nothing to sweep */
    }
  })();
}

interface SpoolInfo {
  /** Absolute path of the spool file. */
  path: string;
  /** Total bytes of output produced (including what reached the file). */
  bytes: number;
  /** Bytes dropped due to disk backpressure (0 in the normal case). */
  droppedBytes: number;
}

interface OutputSpool {
  /** Feed every raw output chunk. Never throws. */
  write(text: string): void;
  /**
   * Close the file (if one was opened) and return its info, or null when the
   * output never exceeded the threshold. Idempotent.
   */
  finalize(): SpoolInfo | null;
}

interface CreateOutputSpoolOptions {
  /** Tool name used in the spool filename (sanitized). */
  tool: string;
  /**
   * Output size at which the spool activates. Should match the tool's
   * in-memory cap so files are only created for output the model can't
   * already see in full. Default 32 KB.
   */
  thresholdBytes?: number | undefined;
}

/**
 * Render the marker line appended to a capped tool result. Kept in one place
 * so every command tool phrases it identically (and tests can match it).
 */
export function spoolNote(info: SpoolInfo): string {
  const dropped =
    info.droppedBytes > 0 ? `, ~${info.droppedBytes} bytes dropped under backpressure` : '';
  return `\n[output truncated — full ${info.bytes} bytes at ${info.path}${dropped}; read/grep that file selectively instead of re-running with more output]`;
}

export function createOutputSpool(opts: CreateOutputSpoolOptions): OutputSpool {
  const threshold = opts.thresholdBytes ?? 32_768;
  const safeTool = opts.tool.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'tool';

  let head = '';
  let headBytes = 0;
  let totalBytes = 0;
  let droppedBytes = 0;
  let stream: WriteStream | null = null;
  let filePath: string | null = null;
  let failed = false;
  let finalized = false;

  const open = (): void => {
    if (stream || failed) return;
    try {
      const dir = toolOutputDir();
      // Synchronous on purpose: createWriteStream would race an async mkdir
      // and error with ENOENT. This runs at most once per oversized command,
      // and after the first call the dir exists (mkdirSync is a no-op stat).
      mkdirSync(dir, { recursive: true });
      sweepOldSpoolFiles(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 6);
      filePath = path.join(dir, `${stamp}-${safeTool}-${rand}.log`);
      stream = createWriteStream(filePath, { flags: 'w', encoding: 'utf8' });
      stream.on('error', () => {
        // Disk full / permission — disable the spool, keep the tool alive.
        failed = true;
        stream = null;
        filePath = null;
      });
      // Flush the buffered head first so the file is the complete output.
      stream.write(head);
    } catch {
      failed = true;
      stream = null;
      filePath = null;
    }
  };

  return {
    write(text: string): void {
      if (finalized || !text) return;
      const textBytes = Buffer.byteLength(text, 'utf8');
      totalBytes += textBytes;
      if (!stream && !failed) {
        if (headBytes + textBytes <= threshold) {
          head += text;
          headBytes += textBytes;
          return;
        }
        head += text; // include the crossing chunk so the file misses nothing
        open();
        head = ''; // flushed into the stream by open(); release the heap copy
        return;
      }
      if (stream) {
        if (stream.writableLength > SPOOL_WRITE_HWM_BYTES) {
          droppedBytes += textBytes;
          return;
        }
        stream.write(text);
      }
    },
    finalize(): SpoolInfo | null {
      if (finalized) {
        return filePath ? { path: filePath, bytes: totalBytes, droppedBytes } : null;
      }
      finalized = true;
      head = '';
      if (!stream || !filePath) return null;
      try {
        stream.end();
      } catch {
        /* already closed */
      }
      return { path: filePath, bytes: totalBytes, droppedBytes };
    },
  };
}
