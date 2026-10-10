---
name: node-modern
description: |
  Use this skill when writing, reviewing, or refactoring Node.js code — modules, async flow, cancellation, file and process I/O, HTTP — on a current Node.js release.
  Triggers: user mentions "Node", "Node.js", "ESM", "CommonJS", "require", "import", "fetch", "AbortSignal", "AbortController", "stream", "child_process", "spawn", "fs", "event loop".
version: 2.1.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run]
trigger: "Use this skill when writing, reviewing, or refactoring Node.js code \u2014 modules, async flow, cancellation, file and process I/O, HTTP \u2014 on a current Node.js release."
metadata:
  routing-group: frontend
---

# Modern Node.js

## Selection card
- Task: Node runtime APIs, ESM and async cancellation.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Current Node.js (v26.11.1 as checked 2026-10-09) ships natively what older code pulled from npm:
native TypeScript type stripping (`node file.ts`), native `.env`
loading (`node --env-file`), built-in SQLite (`node:sqlite`), global WebSocket,
`Promise.withResolvers()`, global fetch, `AbortSignal.timeout`, `node:test`, Web Streams,
and `node --run`. Prefer the platform when its semantics fit; do not remove needed capabilities merely to reduce dependency count.

## Rules

1. **Pre-flight: Inspect repo runtime & live Node.js LTS schedule first.** Check `package.json`
   `"engines"`, `.nvmrc`, `.node-version`, and check `node -v` to determine the active engine.
   Check the official Node.js release schedule online to ensure target runtime aligns with
   active LTS or the requested latest stable channel; verify support status from the current release schedule.
2. Match the module system. In an ESM package (`"type": "module"` or `.mjs`)
   write ES `import` statements, with explicit file extensions on relative imports when the
   project compiles with NodeNext. Don't convert a CommonJS package to ESM as a
   side effect of another change.
3. Import built-ins with the `node:` prefix (`node:fs/promises`, `node:path`, `node:sqlite`).
3. Prefer native platform features over npm bloat:
   - Use native `node --env-file=.env` instead of installing `dotenv`.
   - Use native `globalThis.fetch()` instead of `axios` or `node-fetch`.
   - Native WebSocket covers standard clients; verify the required client/server features before replacing ws.
   - Use native `node:sqlite` for local structured caching and data storage.
   - Use native `node:crypto` `randomUUID()` instead of `uuid`.
   - Use `Promise.withResolvers()` instead of hand-rolled deferred promises.
4. Give every operation that can wait a deadline: pass an `AbortSignal` to
   fetch calls, child processes, and timers; combine user cancellation with a
   timeout using `AbortSignal.any`.
5. Handle `ENOENT` by reading inside try/catch and branching on `err.code`;
   checking `access` first is a race (TOCTOU).
6. Never block the event loop in a server or CLI hot path: no `*Sync` fs calls
   or CPU-heavy loops on request paths.
7. Pass arguments to child processes as an array (`execFile`/`spawn`), never by
   interpolating into a shell string.
8. Every promise is awaited, returned, or explicitly handled; let entry points
   report unhandled rejections instead of swallowing them.

## Patterns

```ts
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Deadline plus user cancellation.
export async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(10_000);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  return res.json();
}

// Missing file is an expected outcome, not an exception.
export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// Atomic replace: readers never observe a half-written file.
export async function writeAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

// Cancellable delay — the promise API takes a signal; the global setTimeout does not.
await delay(500, undefined, { signal: AbortSignal.timeout(5_000) });

// Arguments as an array — no shell, no injection.
const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5'], {
  signal: AbortSignal.timeout(15_000),
});

// Partial failure is acceptable: collect every outcome.
const results = await Promise.allSettled(urls.map((url) => getJson(url)));
const failed = results.filter((r) => r.status === 'rejected');
```

In ESM, `__dirname` doesn't exist: use `import.meta.dirname` on current Node, or
`path.dirname(fileURLToPath(import.meta.url))` on older releases.

## Anti-patterns

| Anti-pattern | Why it hurts | Instead |
|---|---|---|
| `fetch(url)` with no signal | Hangs forever on a stalled server | `AbortSignal.timeout()` |
| `exec(\`cmd ${input}\`)` | Shell injection | `execFile` with an argument array |
| `existsSync` then `readFile` | Race between check and use | try/catch on the read |
| `readFileSync` in a request handler | Blocks every other request | `node:fs/promises` |
| Catching an `AbortError` and continuing silently | Hides timeouts and cancellations | Rethrow, or report it as a timeout |
| `writeFile` directly over a config or state file | A crash leaves it truncated | Write to a temp file, then rename |

## Before returning

- [ ] Module system and Node version match what the project declares
- [ ] Built-ins imported with `node:`; no new dependency the platform covers
- [ ] Every network call, child process, and delay is cancellable or bounded
- [ ] Child-process arguments passed as arrays
- [ ] Missing-file and abort cases handled deliberately; no floating promises

## Current runtime and ownership

Latest stable checked 2026-10-09: Node.js 26.11.1 (Current), Bun 1.4.2,
pnpm 12.10.1. Refresh the official release/registry before recommendations.
Current and LTS are different channels; do not label Current as LTS.
Native TypeScript execution strips supported syntax; it does not typecheck or
implement tsconfig path aliases. Verify the real module/resolution contract.
Native WebSocket is a client API; server behavior may require a dependency.
For atomic replacement, use an exclusively created temp file in the same
directory and clean only owned intermediates on failure. Rename is not durability,
cross-filesystem atomicity or concurrency control. Recheck generation after awaits.

## Skills in scope

- `typescript-strict` — for typing Node.js APIs and boundaries
- `security-scanner` — for shell, path, and SSRF exposure in I/O code
- `testing` — for testing async and time-based logic with fake timers
