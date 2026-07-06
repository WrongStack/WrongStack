---
name: node-modern
description: |
  Use this skill when writing, reviewing, or refactoring Node.js >= 22
  TypeScript code in WrongStack. Triggers: ESM imports, fetch usage, AbortSignal,
  node: protocol, Web Streams, or any async patterns.
version: 1.1.0
---

# Modern Node.js (>= 22) — WrongStack

## Overview

Node.js >= 22 patterns: ESM-only imports, native fetch with AbortSignal, Web Streams, and async patterns. WrongStack uses ESM throughout — no CommonJS in new code.

## Rules

1. Always use ESM (`import` with `.js` extension) — never `require()`.
2. Always use `node:` protocol for built-in modules.
3. Always use `AbortSignal.timeout()` for long-running operations (fetch, spawn, setTimeout).
4. Never use axios, node-fetch, or got — native fetch is sufficient.
5. Always handle `ENOENT` on file reads — use try/catch or `access` first.
6. Use `Promise.allSettled` when partial failure is acceptable.

## Patterns

### Do

```typescript
// ✅ ESM with .js extension and node: protocol
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { helper } from './helper.js';

// ✅ Native fetch with AbortSignal
const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

// ✅ Atomic write
const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
await writeFile(tmp, data);
await rename(tmp, target);

// ✅ Parallel with allSettled
const results = await Promise.allSettled(tasks.map(t => t.run()));
```

### Don't

```typescript
// ❌ CommonJS
const fs = require('fs/promises');

// ❌ No AbortSignal — hangs forever on timeout
await fetch(url);

// ❌ axios in new code
const res = await axios.get(url);

// ❌ Swallowing AbortError silently
try {
  await fetch(url);
} catch (e) {
  // AbortError means timeout — log it or handle explicitly
}
```

## Imports — always ESM

```ts
// ✅ Always — node: protocol for built-ins
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

// ✅ ESM with .js extension in relative imports
import { helper } from './helper.js';
import { types } from '../types/index.js';

// ❌ Never — CommonJS
const fs = require('fs/promises');
```

## fetch — native only

```ts
// ✅ Native fetch (Node 18+)
const res = await fetch('https://api.example.com/data', {
  signal: AbortSignal.timeout(5000),
});

// ❌ Never — axios, node-fetch, got
const res = await axios.get('https://api.example.com/data');
```

## AbortSignal — everywhere that takes time

```ts
// ✅ Timeout on fetch
await fetch(url, { signal: AbortSignal.timeout(5000) });

// ✅ Timeout on child_process
const child = spawn('pnpm', ['test'], { signal: AbortSignal.timeout(30_000) });

// ✅ Combined signals
const combined = AbortSignal.any([userSignal, timeoutSignal]);

// ✅ setTimeout with signal (Node 22+)
setTimeout(handler, 1000, { signal: userSignal });
```

## Async patterns

```ts
// ✅ Atomic write pattern
import { rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
await writeFile(tmp, data);
await rename(tmp, target);

// ✅ Sequential with error handling
for (const file of files) {
  try {
    await processFile(file);
  } catch (err) {
    console.error(`Failed ${file}: ${err}`);
  }
}

// ✅ Parallel with allSettled (when partial failure is ok)
const results = await Promise.allSettled(tasks.map(t => t.run()));
const failures = results.filter(r => r.status === 'rejected');
```

## Web Streams

```ts
// ✅ Readable stream from fetch
const response = await fetch('https://api.example.com/stream');
const reader = response.body!.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value));
}
```

## Anti-patterns

| Anti-pattern | Why bad | Fix |
|---|---|---|
| `require()` in new code | WrongStack uses ESM | Use `import` with `.js` extension |
| `__dirname` without `fileURLToPath` | ESM doesn't have `__dirname` | `path.dirname(fileURLToPath(import.meta.url))` |
| Mixing `fs.readFile` callback with `await` | Callback API doesn't return a promise | Use `fs.promises.readFile` |
| Swallowing `AbortError` silently | Means timeout/abort happened | Log it or handle explicitly |
| `process.cwd()` without fallback | May not match user's cwd | Accept `cwd` as a parameter |
| Not handling `ENOENT` on file reads | File may not exist | Use try/catch or `access` first |

## package.json scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "test": "vitest run"
  }
}
```

## TypeScript config for Node 22+

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

## Skills in scope

- `typescript-strict` — strict TypeScript patterns
- `react-modern` — React Server Components with Node.js
- `bug-hunter` — catching async/await bugs, unhandled rejections
- `sdd` — for setting up new Node.js features with a spec first
- `output-standards` — for standardized `<nextsteps>` formatting