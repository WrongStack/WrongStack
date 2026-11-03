import { readFile, stat } from 'node:fs/promises';
import {
  projectToolUsageEvents,
  summarizeToolUsage,
  type ToolUsageEvent,
} from '../packages/core/dist/observability/index.js';

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
const catalogPath = flag('--catalog');
const journalPaths = args.flatMap((arg, i) =>
  arg === '--journal' && args[i + 1] ? [args[i + 1]!] : [],
);
if (!catalogPath || journalPaths.length === 0)
  throw new Error(
    'Usage: bun run tools:usage:report --catalog <catalog.json> --journal <session.jsonl> [--journal <another.jsonl>] [--from <ISO date>] [--to <ISO date>]',
  );
async function boundedRead(path: string) {
  if ((await stat(path)).size > 64 * 1024 * 1024)
    throw new Error('Report input exceeds 64 MiB; use a smaller explicit sample');
  return readFile(path, 'utf8');
}
const catalog = JSON.parse(await boundedRead(catalogPath));
if (!Array.isArray(catalog.tools)) throw new Error('Catalog must contain a tools array');
const journals: ToolUsageEvent[][] = [];
for (const path of journalPaths) {
  const events: ToolUsageEvent[] = [];
  let lineNumber = 0;
  for (const line of (await boundedRead(path)).split(/\r?\n/)) {
    lineNumber++;
    if (!line.trim()) continue;
    let event: ToolUsageEvent;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Invalid journal JSON at line ${lineNumber}; raw content omitted`);
    }
    events.push(...projectToolUsageEvents(event));
  }
  journals.push(events);
}
console.log(
  JSON.stringify(
    summarizeToolUsage(catalog.tools, journals, { from: flag('--from'), to: flag('--to') }),
    null,
    2,
  ),
);
