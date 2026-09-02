/**
 * Stack detection and the profiling-command table.
 *
 * The reason this exists rather than being left to the model: "profile it
 * first" is only actionable if you know the command. An agent that has to guess
 * the profiler for a stack it half-recognises will either guess a plausible
 * wrong flag or skip profiling and optimise on intuition — which is the failure
 * the whole ratchet is built to prevent. Detection is cheap, deterministic, and
 * turns "please profile this" into a command the user can paste.
 *
 * @module performance/perf-stack
 */
import * as fs from 'node:fs/promises';

export type PerfStackId =
  | 'node'
  | 'go'
  | 'rust'
  | 'python'
  | 'php'
  | 'dotnet'
  | 'java'
  | 'ruby'
  | 'generic';

export interface PerfStackProfile {
  id: PerfStackId;
  label: string;
  /** The file whose presence identified the stack. */
  detectedBy: string;
  /** CPU profiling entry points, most useful first. */
  cpu: string[];
  /** Memory / allocation profiling entry points. */
  memory: string[];
  /** Benchmark harnesses that produce a comparable number. */
  benchmark: string[];
}

interface StackDefinition extends Omit<PerfStackProfile, 'detectedBy'> {
  /** Exact filenames that identify the stack. */
  markers: string[];
  /** Extensions that identify the stack when no exact marker matched. */
  markerExtensions?: string[];
}

const STACKS: StackDefinition[] = [
  {
    id: 'go',
    label: 'Go',
    markers: ['go.mod'],
    cpu: ['go test -cpuprofile cpu.out -bench .', 'go tool pprof -http=: cpu.out'],
    memory: ['go test -memprofile mem.out -benchmem -bench .', 'GODEBUG=gctrace=1 ./app'],
    benchmark: ['go test -bench . -benchmem -count=5 ./...', 'benchstat old.txt new.txt'],
  },
  {
    id: 'rust',
    label: 'Rust',
    markers: ['Cargo.toml'],
    cpu: ['cargo flamegraph --bench <name>', 'perf record -g -- ./target/release/<bin>'],
    memory: ['valgrind --tool=massif ./target/release/<bin>', 'heaptrack ./target/release/<bin>'],
    benchmark: ['cargo bench', 'critcmp base new'],
  },
  {
    id: 'python',
    label: 'Python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
    cpu: [
      'py-spy record -o profile.svg -- python <entry>',
      'python -m cProfile -s cumtime <entry>',
    ],
    memory: ['memray run <entry> && memray flamegraph <out>', 'python -X tracemalloc <entry>'],
    benchmark: ['pytest --benchmark-only', 'hyperfine "python <entry>"'],
  },
  {
    id: 'php',
    label: 'PHP',
    markers: ['composer.json'],
    cpu: ['php -d xdebug.mode=profile <entry>', 'blackfire run php <entry>'],
    memory: ['php -d memory_limit=-1 <entry> # then memory_get_peak_usage(true)'],
    benchmark: ['k6 run load.js', 'ab -n 1000 -c 20 <url>'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    markers: ['global.json'],
    markerExtensions: ['.csproj', '.fsproj', '.sln'],
    cpu: ['dotnet-trace collect -- dotnet <dll>', 'dotnet-counters monitor -p <pid>'],
    memory: ['dotnet-gcdump collect -p <pid>', 'dotnet-counters monitor --counters System.Runtime'],
    benchmark: ['dotnet run -c Release --project <benchmark-project>  # BenchmarkDotNet'],
  },
  {
    id: 'java',
    label: 'Java / JVM',
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    cpu: ['java -XX:+FlightRecorder -XX:StartFlightRecording=duration=60s,filename=r.jfr <main>'],
    memory: ['jcmd <pid> GC.heap_info', 'jmap -histo:live <pid>'],
    benchmark: ['mvn -Pbench test  # JMH', 'hyperfine "java -jar app.jar"'],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    markers: ['Gemfile'],
    cpu: ['stackprof --text tmp/stackprof.dump', 'rbspy record -- ruby <entry>'],
    memory: ['ruby -r memory_profiler -e "MemoryProfiler.report { ... }.pretty_print"'],
    benchmark: ['ruby -r benchmark/ips <bench>', 'hyperfine "ruby <entry>"'],
  },
  {
    id: 'node',
    label: 'Node / TypeScript',
    markers: ['package.json'],
    cpu: ['node --cpu-prof --cpu-prof-dir=.perf <entry>', 'npx 0x -- node <entry>'],
    memory: ['node --heap-prof --heap-prof-dir=.perf <entry>', 'node --trace-gc <entry>'],
    benchmark: ['vitest bench --run', 'hyperfine "node <entry>"', 'npx autocannon <url>'],
  },
];

/** The always-available fallback, so an unrecognised repo still gets commands. */
export const GENERIC_STACK: PerfStackProfile = {
  id: 'generic',
  label: 'Any stack',
  detectedBy: 'fallback',
  cpu: ['perf record -g -- <cmd>', 'strace -c -- <cmd>'],
  memory: ['/usr/bin/time -v <cmd>  # Maximum resident set size'],
  benchmark: ['hyperfine --warmup 3 --runs 10 "<cmd>"', 'k6 run load.js', 'wrk -t4 -c64 <url>'],
};

/**
 * Detect the stacks present in a directory.
 *
 * Returns every match, not just the first: a repo with `package.json` next to
 * `go.mod` is a repo where the interesting bottleneck could be on either side,
 * and offering only one set of commands would quietly narrow the hunt.
 */
export async function detectPerfStacks(dir: string): Promise<PerfStackProfile[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [GENERIC_STACK];
  }
  const present = new Set(names);
  const found: PerfStackProfile[] = [];

  for (const stack of STACKS) {
    const marker =
      stack.markers.find((name) => present.has(name)) ??
      (stack.markerExtensions
        ? names.find((name) => stack.markerExtensions?.some((ext) => name.endsWith(ext)))
        : undefined);
    if (marker === undefined) continue;
    const { markers: _markers, markerExtensions: _ext, ...profile } = stack;
    found.push({ ...profile, detectedBy: marker });
  }

  return found.length > 0 ? found : [GENERIC_STACK];
}

/**
 * Render detected stacks as a markdown block for injection into a prompt.
 *
 * Kept terse on purpose — it rides along with an already-long prompt, and a
 * command list nobody reads costs the same context as one they do.
 */
export function renderStackGuidance(profiles: readonly PerfStackProfile[]): string {
  const lines: string[] = ['## Profiling commands for this repository', ''];
  for (const profile of profiles) {
    lines.push(`### ${profile.label} (detected via \`${profile.detectedBy}\`)`);
    lines.push(`- CPU: ${profile.cpu.map((cmd) => `\`${cmd}\``).join(' · ')}`);
    lines.push(`- Memory: ${profile.memory.map((cmd) => `\`${cmd}\``).join(' · ')}`);
    lines.push(`- Benchmark: ${profile.benchmark.map((cmd) => `\`${cmd}\``).join(' · ')}`);
    lines.push('');
  }
  lines.push(
    'Use these as the starting point. If a repository script already wraps one',
    '(a `bench`, `profile`, or `load-test` script), prefer the script — it encodes',
    'the fixed input and warmup this project already agreed on.',
  );
  return lines.join('\n');
}
