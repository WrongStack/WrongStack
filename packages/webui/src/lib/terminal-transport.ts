import type { Terminal } from '@xterm/xterm';
import type { WSClientMessage, WSServerMessage } from '@/types';
import type { WSSendOptions } from './ws-client-contracts';
import type { WsStatus } from './ws-client-utils';

interface TerminalTransport {
  on(type: string, listener: (message: WSServerMessage) => void): () => void;
  onStatus(listener: (status: WsStatus) => void): () => void;
  send(message: WSClientMessage, options: WSSendOptions): boolean;
}

type TerminalExit = Extract<WSServerMessage, { type: 'terminal.exit' }>['payload'];

export function bindTerminalTransport({
  id,
  term,
  ws,
  onRunning,
  onOutput,
  onExit,
  onReplayGap,
}: {
  id: string;
  term: Pick<Terminal, 'cols' | 'rows' | 'options' | 'write' | 'onData' | 'onResize'>;
  ws: TerminalTransport;
  onRunning: () => void;
  onOutput: (data: string) => void;
  onExit: (exit: TerminalExit) => void;
  onReplayGap: () => void;
}): () => void {
  const resumeKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const onlineOnly = { queueIfDisconnected: false } as const;
  let ready = false;
  let opened = false;
  let stopped = false;
  let after = 0;
  const size = () => ({ cols: term.cols, rows: term.rows });
  let requestedSize = size();

  const offReady = ws.on('terminal.ready', (msg) => {
    if (msg.type !== 'terminal.ready' || msg.payload.id !== id || stopped) return;
    opened = true;
    ready = true;
    term.options.disableStdin = false;
    onRunning();
    if (msg.payload.lostOutput) onReplayGap();
    if (term.cols !== requestedSize.cols || term.rows !== requestedSize.rows) {
      ws.send({ type: 'terminal.resize', payload: { id, ...size() } }, onlineOnly);
    }
  });
  const offOutput = ws.on('terminal.output', (msg) => {
    if (msg.type !== 'terminal.output' || msg.payload.id !== id || stopped) return;
    if (msg.payload.sequence !== undefined) {
      if (msg.payload.sequence <= after) return;
      after = msg.payload.sequence;
    }
    term.write(msg.payload.data);
    onOutput(msg.payload.data);
  });
  const offExit = ws.on('terminal.exit', (msg) => {
    if (msg.type !== 'terminal.exit' || msg.payload.id !== id || stopped) return;
    stopped = true;
    ready = false;
    term.options.disableStdin = true;
    onExit(msg.payload);
  });
  const onData = term.onData((data) => {
    if (ready) ws.send({ type: 'terminal.input', payload: { id, data } }, onlineOnly);
  });
  const onResize = term.onResize(({ cols, rows }) => {
    if (ready) ws.send({ type: 'terminal.resize', payload: { id, cols, rows } }, onlineOnly);
  });
  const offStatus = ws.onStatus(({ state }) => {
    ready = false;
    term.options.disableStdin = true;
    if (state !== 'open' || stopped) return;
    requestedSize = size();
    ws.send(
      {
        type: 'terminal.create',
        payload: { id, ...requestedSize, resumeKey, resumeOnly: opened, after },
      },
      onlineOnly,
    );
  });

  return () => {
    offStatus();
    offReady();
    offOutput();
    offExit();
    onData.dispose();
    onResize.dispose();
    ws.send({ type: 'terminal.close', payload: { id } }, onlineOnly);
  };
}
