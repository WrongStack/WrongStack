import * as fs from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { parseFileContent } from './parser-dispatch.js';
import type { ParserWorkerRequest, ParserWorkerResponse } from './parser-worker-protocol.js';

const port = parentPort;
if (!port) throw new Error('codebase-index parser worker must be started as a worker thread');

port.on('message', async (message: ParserWorkerRequest) => {
  let content: string;
  try {
    content = await fs.readFile(message.file, 'utf8');
  } catch (error) {
    const response: ParserWorkerResponse = {
      id: message.id,
      ok: false,
      stage: 'read',
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
    return;
  }

  try {
    const parsed = await parseFileContent(message.file, content, message.lang);
    const response: ParserWorkerResponse = { id: message.id, ok: true, parsed };
    port.postMessage(response);
  } catch (error) {
    const response: ParserWorkerResponse = {
      id: message.id,
      ok: false,
      stage: 'parse',
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});
