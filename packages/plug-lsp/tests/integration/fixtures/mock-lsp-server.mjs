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

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function diagnostic(uri) {
  return {
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
    severity: 1,
    source: 'mock',
    code: 'MOCK001',
    message: 'mock diagnostic',
    data: uri,
  };
}

function handle(msg) {
  if (msg.method === 'initialize') {
    respond(msg.id, {
      capabilities: {
        textDocumentSync: 1,
        diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
        completionProvider: { triggerCharacters: ['.', '_'] },
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: true,
        executeCommandProvider: { commands: ['mock.command'] },
      },
      serverInfo: { name: 'mock-lsp' },
    });
    notify('window/logMessage', { type: 3, message: 'mock initialized' });
    notify('textDocument/publishDiagnostics', { uri: 'not-file://raw', diagnostics: [] });
    notify('textDocument/publishDiagnostics', { uri: 'file:///ignored.ts', diagnostics: 'bad' });
    return;
  }
  if (msg.method === 'shutdown') {
    respond(msg.id, null);
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
  if (msg.method === 'textDocument/didOpen') {
    const doc = msg.params.textDocument;
    documents.set(doc.uri, doc.text);
    notify('textDocument/publishDiagnostics', { uri: doc.uri, diagnostics: [diagnostic(doc.uri)] });
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    const uri = msg.params.textDocument.uri;
    documents.set(uri, msg.params.contentChanges[0].text);
    notify('textDocument/publishDiagnostics', { uri, diagnostics: [diagnostic(uri)] });
    return;
  }
  if (msg.method === 'textDocument/diagnostic') {
    respond(msg.id, { kind: 'full', items: [diagnostic(msg.params.textDocument.uri)] });
    return;
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    respond(msg.id, [
      { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
    ]);
    return;
  }
  if (msg.method === 'textDocument/references') {
    const uri = msg.params.textDocument.uri;
    respond(msg.id, [
      { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
      { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } } },
    ]);
    return;
  }
  if (msg.method === 'textDocument/hover') {
    respond(msg.id, { contents: { kind: 'markdown', value: '```ts\nconst answer: number\n```' } });
    return;
  }
  if (msg.method === 'textDocument/completion') {
    respond(msg.id, {
      isIncomplete: false,
      items: [
        {
          label: 'answer',
          kind: 6,
          detail: 'const answer: number',
          insertText: 'answer',
        },
      ],
    });
    return;
  }
  if (msg.method === 'textDocument/documentSymbol') {
    respond(msg.id, [
      {
        name: 'answer',
        kind: 13,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
      },
    ]);
    return;
  }
  if (msg.method === 'workspace/symbol') {
    const root = msg.params.query || 'answer';
    respond(msg.id, [
      {
        name: root,
        kind: 13,
        location: {
          uri: [...documents.keys()][0] || 'file:///mock.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        },
      },
    ]);
    return;
  }
  if (msg.method === 'textDocument/rename') {
    const uri = msg.params.textDocument.uri;
    respond(msg.id, {
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
            newText: msg.params.newName,
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'textDocument/codeAction') {
    const uri = msg.params.textDocument.uri;
    respond(msg.id, [
      {
        title: 'Replace answer',
        kind: 'quickfix',
        edit: {
          changes: {
            [uri]: [
              {
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
                newText: 'fixed',
              },
            ],
          },
        },
      },
    ]);
    return;
  }
  if (msg.method === 'workspace/executeCommand') {
    respond(msg.id, null);
    return;
  }
  if (msg.method === 'custom/echo') {
    respond(msg.id, msg.params);
  }
}
