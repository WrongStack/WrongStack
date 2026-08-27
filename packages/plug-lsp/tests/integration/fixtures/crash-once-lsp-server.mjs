import * as fs from 'node:fs';

const marker = process.argv[2];
const shouldCrash = marker && fs.existsSync(marker);
if (shouldCrash) fs.unlinkSync(marker);

let buffer = Buffer.alloc(0);
const documents = new Map();

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep === -1) return;
    const header = buffer.subarray(0, sep).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(sep + 4);
      continue;
    }
    const len = Number(match[1]);
    const total = sep + 4 + len;
    if (buffer.length < total) return;
    const body = buffer.subarray(sep + 4, total).toString('utf8');
    buffer = buffer.subarray(total);
    handle(JSON.parse(body));
  }
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function handle(msg) {
  if (msg.method === 'initialize') {
    respond(msg.id, {
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true,
        definitionProvider: true,
      },
    });
    if (shouldCrash) setTimeout(() => process.exit(42), 25);
    return;
  }
  if (msg.method === 'shutdown') {
    respond(msg.id, null);
    return;
  }
  if (msg.method === 'exit') process.exit(0);
  if (msg.method === 'textDocument/didOpen') {
    documents.set(msg.params.textDocument.uri, msg.params.textDocument.text);
    return;
  }
  if (msg.method === 'textDocument/hover') {
    respond(msg.id, { contents: { kind: 'markdown', value: 'recovered hover' } });
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    respond(msg.id, [
      { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
    ]);
  }
}
