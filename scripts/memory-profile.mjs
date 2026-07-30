#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cliEntry = resolve(root, 'packages', 'cli', 'dist', 'index.js');

function usage() {
  return `Usage: pnpm profile:memory [options] [-- <wstack args>]

Options:
  --max-old-space-mb <n>  Reproduction heap ceiling (default: 1024)
  --snapshot-count <n>    Near-limit heap snapshots (default: 2)
  --inspect-port <n>      Loopback inspector port (default: 9229)
  --heap-prof             Write an allocation-sampling profile on clean exit
  --output <path>         Artifact directory (default: timestamped .reports path)
  --help                  Show this help

Build @wrongstack/cli first when profiling source changes.
`;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    maxOldSpaceMb: 1024,
    snapshotCount: 2,
    inspectPort: 9229,
    heapProf: false,
    output: undefined,
    cliArgs: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true, options };
    if (arg === '--') {
      options.cliArgs.push(...argv.slice(index + 1));
      break;
    }
    // pnpm strips its own `--` separator before invoking this script.
    if (!arg.startsWith('--')) {
      options.cliArgs.push(...argv.slice(index));
      break;
    }
    if (arg === '--heap-prof') {
      options.heapProf = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value after ${arg}`);
    if (arg === '--max-old-space-mb') {
      options.maxOldSpaceMb = positiveInteger(value, arg);
    } else if (arg === '--snapshot-count') {
      options.snapshotCount = positiveInteger(value, arg);
    } else if (arg === '--inspect-port') {
      options.inspectPort = positiveInteger(value, arg);
    } else if (arg === '--output') {
      options.output = resolve(value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { help: false, options };
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  await access(cliEntry);
  const output = parsed.options.output ?? resolve(root, '.reports', 'memory-live', timestampSlug());
  await mkdir(output, { recursive: true });
  const heapLogPath = resolve(output, 'heap.jsonl');
  const nodeArgs = [
    `--max-old-space-size=${parsed.options.maxOldSpaceMb}`,
    `--inspect=127.0.0.1:${parsed.options.inspectPort}`,
    `--heapsnapshot-near-heap-limit=${parsed.options.snapshotCount}`,
    `--diagnostic-dir=${output}`,
  ];
  if (parsed.options.heapProf) {
    nodeArgs.push('--heap-prof', `--heap-prof-dir=${output}`);
  }
  nodeArgs.push(cliEntry, ...parsed.options.cliArgs);

  process.stdout.write(
    [
      `[memory-profile] artifacts: ${output}`,
      `[memory-profile] watchdog: ${heapLogPath}`,
      `[memory-profile] inspector: chrome://inspect -> 127.0.0.1:${parsed.options.inspectPort}`,
      `[memory-profile] heap ceiling: ${parsed.options.maxOldSpaceMb} MiB`,
      '',
    ].join('\n'),
  );

  const child = spawn(process.execPath, nodeArgs, {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WRONGSTACK_MEMORY_PROFILE: '1',
      WRONGSTACK_HEAP_LOG_PATH: heapLogPath,
    },
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    process.stderr.write(`[memory-profile] failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) process.stderr.write(`[memory-profile] child terminated by ${signal}\n`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  process.stderr.write(
    `[memory-profile] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
