/**
 * Mailbox status/awareness mail is prose, not JSON.
 *
 * The 2026-08-20 clutter audit found exactly one raw-JSON status producer
 * (`broadcastTodoUpdate` sending `JSON.stringify({kind:"kanban.todos.updated",
 * ...})`); every other broadcast site already wrote prose. Recipients are
 * agents reading their context — a JSON envelope renders as opaque braces
 * they must mentally deserialize, and nothing on the receive side parses
 * these bodies (WebUI kanban events travel a separate WS channel).
 *
 * This file is the drift guard: it scans PRODUCTION sources (tests and
 * dist excluded, same walker policy as `mailbox-ipc-boundary.test.ts`) for
 * mailbox send call sites whose `body:` is a `JSON.stringify(...)` call and
 * fails on any offender. New mailbox broadcasts must write a human-readable
 * summary; machine payloads belong on their own event/WS channel, not in
 * mail bodies.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SCAN_ROOTS = ['packages', 'apps', 'scripts'];

/** Prose about the convention is fine; only executable sends count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

async function productionSourceFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'tests') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await productionSourceFiles(absolute)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

/**
 * A mailbox send whose body is stringified JSON. Matches `.send({ … body:
 * JSON.stringify(…` within one bounded window — the same proximity-regex
 * posture the IPC boundary test uses. `fetch`/WS transports that stringify
 * payloads without a `body:` key inside a `.send({` object literal do not
 * match.
 */
const JSON_BODY_SEND = /\.send\(\s*\{[\s\S]{0,500}?body\s*:\s*JSON\.stringify\s*\(/u;

describe('mailbox send bodies are human-readable', () => {
  it('finds no production mailbox.send call site with a JSON.stringify body', async () => {
    const files = (
      await Promise.all(
        SCAN_ROOTS.map((directory) => productionSourceFiles(path.join(ROOT, directory))),
      )
    ).flat();

    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(ROOT, file).replaceAll('\\', '/');
      const executableSource = stripComments(await fs.readFile(file, 'utf8'));
      if (JSON_BODY_SEND.test(executableSource)) {
        offenders.push(
          `${relative}: mailbox send body is JSON.stringify(...) — write a prose summary instead; ` +
            'machine payloads belong on their own event/WS channel',
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
