// Test fixture: answers `initialize` immediately but delays the `shutdown`
// response, so a caller that does not sequence stop -> start can be caught.
let buffer = Buffer.alloc(0);

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

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
    return;
  }
  if (msg.method === 'shutdown') {
    setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: null }), 250);
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
}
