import { toErrorMessage } from '@wrongstack/core/utils';
import type { MCPServer } from './server-dispatch.js';

export interface ServeStdioHandle {
  /** Stop reading and detach listeners. Does not exit the process. */
  close(): void;
  /** Resolves when the input stream ends (EOF). */
  done: Promise<void>;
}

export interface ServeStdioOptions {
  stdin?: NodeJS.ReadableStream | undefined;
  stdout?: NodeJS.WritableStream | undefined;
}

/**
 * Run an `MCPServer` over stdio: newline-delimited JSON-RPC in on stdin,
 * responses out on stdout. CRITICAL: nothing else may write to stdout while
 * this runs — it is the JSON-RPC channel. Route all logging to stderr.
 */
export function serveStdio(server: MCPServer, opts: ServeStdioOptions = {}): ServeStdioHandle {
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  let buffer = '';
  let bufferBytes = 0;
  let closed = false;
  let bufferTooLarge = false;
  // Chunks arrive at arbitrary BYTE boundaries, so one multi-byte character can
  // straddle two `data` events. Decoding each chunk on its own turned the split
  // bytes into U+FFFD, and U+FFFD is a legal character inside a JSON string —
  // so the request still parsed and the tool ran with silently corrupted
  // arguments instead of failing loudly. A streaming decoder holds the partial
  // sequence until its continuation bytes arrive.
  const decoder = new TextDecoder();
  // Serialize writes so concurrent async handlers don't interleave lines.
  let writeChain: Promise<void> = Promise.resolve();
  const inFlightHandlers = new Set<Promise<void>>();

  const writeLine = (s: string) => {
    writeChain = writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            stdout.write(`${s}\n`, () => resolve());
          }),
      )
      .catch((err) => {
        const msg = toErrorMessage(err);
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'mcp_server.stdout_write_failed',
            message: msg,
            timestamp: new Date().toISOString(),
          }),
        );
      });
  };

  const overflow = () => {
    bufferTooLarge = true;
    buffer = '';
    bufferBytes = 0;
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'mcp_server.line_buffer_overflow',
        message: `stdio line exceeded ${HTTP_BODY_CAP} bytes — aborting stream`,
        timestamp: new Date().toISOString(),
      }),
    );
    // Pause and tear down further reads so the caller sees a clean end.
    // `destroy()` is called WITHOUT an error so the stream's 'error' event
    // isn't emitted (PassThrough/mocked streams would otherwise emit
    // unhandled 'error' that callers must drain).
    try {
      (stdin as { pause?: () => void }).pause?.();
      (stdin as { destroy?: () => void }).destroy?.();
    } catch {
      /* ignore */
    }
    onEnd();
  };

  const onData = (chunk: Buffer | string) => {
    // A misbehaving peer that streams bytes forever without `\n` would
    // otherwise balloon `buffer` indefinitely. Mirror the HTTP body cap
    // (`HTTP_BODY_CAP` below) — once exceeded, abandon the line, drop the
    // unread tail, and shut down so the caller can react.
    //
    // The cap bounds ONE line, so it is checked per complete line and on the
    // unterminated tail after complete lines are consumed (as `SSEReader`
    // does). Checked on the whole buffer first, the read that finished a
    // near-cap request together with the next pipelined request crossed the
    // cap and tore the stream down without answering either.
    if (bufferTooLarge) return;
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;
    bufferBytes += Buffer.byteLength(text, 'utf8');
    let start = 0;
    let idx = buffer.indexOf('\n', start);
    while (idx !== -1) {
      let end = idx;
      if (end > start && buffer.charCodeAt(end - 1) === 13 /* \r */) end--;
      const line = buffer.slice(start, end);
      if (Buffer.byteLength(line, 'utf8') > HTTP_BODY_CAP) {
        overflow();
        return;
      }
      start = idx + 1;
      idx = buffer.indexOf('\n', start);
      if (!line.trim()) continue;
      const handler = server
        .handleMessage(line)
        .then((res) => {
          // Always flush responses for in-flight requests, even after
          // the stream ended: `done` waits on writeChain, so dropping a
          // late response here would mean `done` resolves without that
          // line ever landing on stdout. Stopping new reads is `onEnd`'s
          // job — not gating writes.
          if (res !== null) writeLine(res);
        })
        .catch((err) => {
          // Malformed JSON from a peer — log and continue so one bad line
          // doesn't kill the entire session.
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'mcp_server.handle_message_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .finally(() => {
          inFlightHandlers.delete(handler);
        });
      inFlightHandlers.add(handler);
    }
    if (start > 0) {
      bufferBytes -= Buffer.byteLength(buffer.slice(0, start), 'utf8');
      buffer = buffer.slice(start);
    }
    if (bufferBytes > HTTP_BODY_CAP) overflow();
  };

  let resolveDone!: () => void;
  // `done` resolves once the stream has closed, every async request handler
  // has settled, and its resulting writes have drained. Waiting only on the
  // current writeChain is insufficient: a slow handler may enqueue its write
  // after stdin has already emitted `end`.
  const done = new Promise<void>((resolve) => {
    resolveDone = () => {
      void Promise.allSettled([...inFlightHandlers])
        .then(() => writeChain)
        .then(() => resolve());
    };
  });

  const detachListeners = () => {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
  };

  const onEnd = () => {
    if (closed) return;
    closed = true;
    detachListeners();
    const tail = decoder.decode();
    if (tail && !bufferTooLarge) {
      const tailBytes = Buffer.byteLength(tail, 'utf8');
      if (bufferBytes + tailBytes > HTTP_BODY_CAP) {
        buffer = '';
        bufferBytes = 0;
        bufferTooLarge = true;
      } else {
        buffer += tail;
        bufferBytes += tailBytes;
      }
    }
    if (!bufferTooLarge && buffer.trim()) {
      const line = buffer.trim();
      buffer = '';
      bufferBytes = 0;
      const handler = server
        .handleMessage(line)
        .then((res) => {
          if (res !== null) writeLine(res);
        })
        .catch((err) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'mcp_server.handle_message_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .finally(() => {
          inFlightHandlers.delete(handler);
        });
      inFlightHandlers.add(handler);
    }
    resolveDone();
  };

  stdin.on('data', onData);
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  if (typeof (stdin as { resume?: () => void }).resume === 'function') {
    (stdin as { resume: () => void }).resume();
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      detachListeners();
      buffer = '';
      bufferBytes = 0;
      resolveDone();
    },
    done,
  };
}

// ── HTTP transport ──────────────────────────────────────────────────────────

export const HTTP_BODY_CAP = 4 * 1024 * 1024;
