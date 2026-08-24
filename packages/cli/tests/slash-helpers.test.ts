import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countToolResults,
  countToolUses,
  countTurnPairs,
  detectProjectFacts,
  estimateTokens,
  renderAgentsTemplate,
  statusIcon,
} from '../src/slash-commands/helpers.js';

type Msg = Context['messages'][number];

// Strip ANSI escapes so colored output assertions stay portable.
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('slash-commands/helpers — message counters', () => {
  it('countTurnPairs returns 0 for no user/assistant', () => {
    const msgs: Msg[] = [{ role: 'system', content: 'hi' } as Msg];
    expect(countTurnPairs(msgs)).toBe(0);
  });

  it('countTurnPairs floors odd counts', () => {
    const msgs: Msg[] = [
      { role: 'user', content: 'a' } as Msg,
      { role: 'assistant', content: 'b' } as Msg,
      { role: 'user', content: 'c' } as Msg,
    ];
    expect(countTurnPairs(msgs)).toBe(1);
  });

  it('countTurnPairs ignores system messages in the pair count', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 's' } as Msg,
      { role: 'user', content: 'u' } as Msg,
      { role: 'assistant', content: 'a' } as Msg,
    ];
    expect(countTurnPairs(msgs)).toBe(1);
  });

  it('countTurnPairs counts a single tool-using turn as one pair, not one per tool call', () => {
    // One real user<->assistant exchange that called a tool. The tool-result
    // frame is role:'user', so the old implementation counted 4 messages
    // (user + assistant + tool_result + assistant) => 2 pairs. It must count
    // the single turn: user + 2 assistant messages (tool_result excluded) => 1.
    const msgs: Msg[] = [
      { role: 'user', content: 'Run the failing test' } as Msg,
      { role: 'assistant', content: 'Let me check' } as Msg,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      } as Msg,
      { role: 'assistant', content: 'Done.' } as Msg,
    ];
    expect(countTurnPairs(msgs)).toBe(1);
  });

  it('countTurnPairs counts each normal user prompt as a pair across tool chains', () => {
    // Two real turns, each with a tool round-trip. Tool-result frames are
    // excluded (role:'user' but only tool_result blocks), so the two user
    // prompts + two assistant answers are counted (4) => 2 pairs.
    const msgs: Msg[] = [
      { role: 'user', content: 'q1' } as Msg,
      { role: 'assistant', content: 'a1' } as Msg,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }],
      } as Msg,
      { role: 'user', content: 'q2' } as Msg,
      { role: 'assistant', content: 'a2' } as Msg,
    ];
    expect(countTurnPairs(msgs)).toBe(2);
  });

  it('countToolUses counts tool_use blocks across messages', () => {
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'x' },
          { type: 'tool_use', id: '1', name: 'foo', input: {} },
          { type: 'tool_use', id: '2', name: 'bar', input: {} },
        ],
      } as Msg,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '3', name: 'baz', input: {} }],
      } as Msg,
    ];
    expect(countToolUses(msgs)).toBe(3);
  });

  it('countToolUses ignores string-content messages', () => {
    const msgs: Msg[] = [{ role: 'assistant', content: 'plain text' } as Msg];
    expect(countToolUses(msgs)).toBe(0);
  });

  it('countToolResults counts tool_result blocks', () => {
    const msgs: Msg[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: '1', content: 'ok' },
          { type: 'tool_result', tool_use_id: '2', content: 'ok2' },
        ],
      } as Msg,
    ];
    expect(countToolResults(msgs)).toBe(2);
  });
});

describe('slash-commands/helpers — estimateTokens', () => {
  it('estimates 0 for empty input', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('uses ceil(len/3.5) for string content', () => {
    // chars/3.5: 4 chars → ceil(4/3.5) = 2, 5 chars → ceil(5/3.5) = 2
    const msgs: Msg[] = [{ role: 'user', content: 'abcd' } as Msg];
    expect(estimateTokens(msgs)).toBe(2);
    const msgs2: Msg[] = [{ role: 'user', content: 'abcde' } as Msg];
    expect(estimateTokens(msgs2)).toBe(2);
  });

  it('sums text block lengths', () => {
    // chars/3.5: each 4-char block → ceil(4/3.5) = 2 tokens
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'aaaa' },
          { type: 'text', text: 'bbbb' },
        ],
      } as Msg,
    ];
    expect(estimateTokens(msgs)).toBe(4); // 2 + 2
  });

  it('counts tool_use and tool_result blocks by serialized length', () => {
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'foo', input: { x: 1 } }],
      } as Msg,
    ];
    const out = estimateTokens(msgs);
    expect(out).toBeGreaterThan(0);
  });

  it('handles mixed string + block messages', () => {
    // chars/3.5: 'abcd' → 2, 'efgh' → 2 → total 4
    const msgs: Msg[] = [
      { role: 'user', content: 'abcd' } as Msg,
      { role: 'assistant', content: [{ type: 'text', text: 'efgh' }] } as Msg,
    ];
    expect(estimateTokens(msgs)).toBe(4);
  });
});

describe('slash-commands/helpers — statusIcon', () => {
  it('returns green dot for healthy', () => {
    const s = stripAnsi(statusIcon('healthy'));
    expect(s).toBe('●');
  });
  it('returns yellow dot for degraded', () => {
    const s = stripAnsi(statusIcon('degraded'));
    expect(s).toBe('●');
  });
  it('returns red dot for anything else', () => {
    const s = stripAnsi(statusIcon('offline'));
    expect(s).toBe('●');
    const s2 = stripAnsi(statusIcon(''));
    expect(s2).toBe('●');
  });
  it('always contains the bullet glyph regardless of status', () => {
    expect(statusIcon('healthy')).toContain('●');
    expect(statusIcon('degraded')).toContain('●');
    expect(statusIcon('down')).toContain('●');
  });
});

describe('slash-commands/helpers — renderAgentsTemplate', () => {
  it('emits a markdown document with section headers', () => {
    const out = renderAgentsTemplate({ hints: [] });
    expect(out.startsWith('# AGENTS.md')).toBe(true);
    expect(out).toContain('## Project brief');
    expect(out).toContain('## Commands');
  });

  it('renders TODO placeholder when a command is missing', () => {
    const out = renderAgentsTemplate({ hints: [] });
    expect(out).toContain('| Build | _TODO_ |');
    expect(out).toContain('| Test | _TODO_ |');
  });

  it('renders backticks around supplied commands', () => {
    const out = renderAgentsTemplate({
      hints: ['package.json'],
      build: 'pnpm run build',
      test: 'pnpm test',
      lint: 'pnpm run lint',
      run: 'pnpm run dev',
    });
    expect(out).toContain('| Build | `pnpm run build` |');
    expect(out).toContain('| Test | `pnpm test` |');
    expect(out).toContain('| Lint | `pnpm run lint` |');
    expect(out).toContain('| Run locally | `pnpm run dev` |');
  });

  it('renders detected languages and scan-derived key files', () => {
    const out = renderAgentsTemplate({
      hints: ['source scan: Python (12)'],
      languages: ['Python (12)', 'Shell (3)'],
      entryPoints: ['main.py'],
      topDirs: ['src', 'scripts'],
    });
    expect(out).toContain('detected: Python (12), Shell (3)');
    expect(out).toContain('| `main.py` | _Likely entry point (detected)_ |');
    expect(out).toContain('| `src/` | _Top-level directory (detected)_ |');
    expect(out).toContain('| `scripts/` | _Top-level directory (detected)_ |');
    // Generic placeholders are replaced when real layout is known.
    expect(out).not.toContain('| _src/_ | _Main source entry point(s)_ |');
  });
});

describe('slash-commands/helpers — detectProjectFacts', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ws-helpers-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns empty hints for an unknown directory', async () => {
    const facts = await detectProjectFacts(tmp);
    expect(facts.hints).toEqual([]);
    expect(facts.build).toBeUndefined();
    expect(facts.test).toBeUndefined();
  });

  it('detects pnpm from pnpm-lock.yaml + package.json scripts', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .', dev: 'vite' },
      }),
    );
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('pnpm run build');
    expect(facts.test).toBe('pnpm test');
    expect(facts.lint).toBe('pnpm run lint');
    expect(facts.run).toBe('pnpm run dev');
    expect(facts.hints).toContain('package.json scripts');
  });

  it('defaults to npm when no lockfile is present', async () => {
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('npm run build');
  });

  it('honors packageManager field', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        packageManager: 'yarn@4.0.0',
        scripts: { build: 'tsc' },
      }),
    );
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('yarn run build');
  });

  it('skips the default "no test specified" placeholder', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    );
    const facts = await detectProjectFacts(tmp);
    // The language registry fills test from the JavaScript profile (npm run test)
    // even though hasUsableScript filtered it — the registry derives the command
    // from the script name, not its content.
    expect(facts.test).toBe('npm run test');
  });

  it('detects go.mod and provides go-flavored commands', async () => {
    await writeFile(path.join(tmp, 'go.mod'), 'module example.com/x\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('go build ./...');
    expect(facts.test).toBe('go test ./...');
    expect(facts.run).toBe('go run .');
    expect(facts.hints).toContain('go');
  });

  it('detects Cargo.toml and provides rust commands', async () => {
    await writeFile(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('cargo build --message-format=json');
    expect(facts.test).toBe('cargo test');
    expect(facts.lint).toBe('cargo clippy --message-format=json');
    expect(facts.run).toBe('cargo run');
    expect(facts.hints).toContain('rust');
  });

  it('detects pyproject.toml', async () => {
    await writeFile(path.join(tmp, 'pyproject.toml'), '[project]\nname="x"\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.test).toBe('pytest .');
    expect(facts.lint).toBe('ruff check .');
    expect(facts.hints).toContain('python');
  });

  it('detects Makefile targets and falls back to bare "make"', async () => {
    await writeFile(path.join(tmp, 'Makefile'), 'test:\n\techo hi\n\nlint:\n\techo lint\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('make');
    expect(facts.test).toBe('make test');
    expect(facts.lint).toBe('make lint');
    expect(facts.hints).toContain('Makefile');
  });

  it('Makefile detection does not overwrite earlier detections', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
    );
    await writeFile(path.join(tmp, 'Makefile'), 'build:\n\techo make-build\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('npm run build');
    expect(facts.test).toBe('npm test');
    expect(facts.hints).toContain('Makefile');
  });
});

describe('slash-commands/helpers — detectProjectFacts source scan fallback', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ws-scan-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('names the dominant language for a manifest-less project', async () => {
    await mkdir(path.join(tmp, 'src'), { recursive: true });
    await writeFile(path.join(tmp, 'src', 'core.py'), 'x = 1\n');
    await writeFile(path.join(tmp, 'src', 'util.py'), 'y = 2\n');
    await writeFile(path.join(tmp, 'helper.sh'), 'echo hi\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.languages).toEqual(['Python (2)', 'Shell (1)']);
    expect(facts.hints).toContain('source scan: Python (2), Shell (1)');
    // No manifest → commands stay undefined (never fabricated).
    expect(facts.build).toBeUndefined();
    expect(facts.test).toBeUndefined();
  });

  it('detects entry points and top-level directories', async () => {
    await mkdir(path.join(tmp, 'cmd'), { recursive: true });
    await writeFile(path.join(tmp, 'main.go'), 'package main\n');
    await writeFile(path.join(tmp, 'cmd', 'index.rs'), 'fn main() {}\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.entryPoints).toContain('main.go');
    expect(facts.entryPoints).toContain('cmd/index.rs');
    expect(facts.topDirs).toContain('cmd');
  });

  it('ignores node_modules, .git and build output when scanning', async () => {
    await mkdir(path.join(tmp, 'node_modules', 'dep'), { recursive: true });
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await writeFile(path.join(tmp, 'node_modules', 'dep', 'a.js'), '');
    await writeFile(path.join(tmp, '.git', 'b.js'), '');
    await writeFile(path.join(tmp, 'app.lua'), 'print(1)\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.languages).toEqual(['Lua (1)']);
    expect(facts.topDirs ?? []).not.toContain('node_modules');
  });

  it('does not scan when a manifest already supplied commands', async () => {
    await writeFile(path.join(tmp, 'go.mod'), 'module example.com/x\n');
    await writeFile(path.join(tmp, 'extra.py'), 'x = 1\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('go build ./...');
    expect(facts.languages).toBeUndefined();
  });

  it('returns no scan fields when no recognized source files exist', async () => {
    await writeFile(path.join(tmp, 'notes.txt'), 'hello\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.languages).toBeUndefined();
    expect(facts.entryPoints).toBeUndefined();
  });
});

describe('slash-commands/helpers — detectProjectFacts extra manifests', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ws-manifest-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('detects Maven pom.xml', async () => {
    await writeFile(path.join(tmp, 'pom.xml'), '<project/>\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('mvn package -q -DskipTests');
    expect(facts.test).toBe('mvn test -q');
    expect(facts.hints).toContain('java');
  });

  it('detects Gradle and prefers the wrapper', async () => {
    await writeFile(path.join(tmp, 'build.gradle.kts'), '');
    await writeFile(path.join(tmp, 'gradlew'), '#!/bin/sh\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('gradlew build');
    expect(facts.test).toBe('gradlew test');
  });

  it('falls back to bare gradle without a wrapper', async () => {
    await writeFile(path.join(tmp, 'build.gradle'), '');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('gradle build');
  });

  it('detects a .NET project from a .csproj file', async () => {
    await writeFile(path.join(tmp, 'App.csproj'), '<Project/>\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('dotnet build --no-restore');
    expect(facts.test).toBe('dotnet test --no-restore');
    expect(facts.run).toBe('dotnet run --no-restore');
    expect(facts.hints).toContain('csharp');
  });

  it('detects Elixir mix.exs', async () => {
    await writeFile(path.join(tmp, 'mix.exs'), 'defmodule X.MixProject do\nend\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('mix compile');
    expect(facts.test).toBe('mix test');
    // no lint operation in the Elixir profile
    expect(facts.lint).toBeUndefined();
  });

  it('detects Swift Package.swift', async () => {
    await writeFile(path.join(tmp, 'Package.swift'), '// swift-tools-version:5.9\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('swift build -c release');
    expect(facts.test).toBe('swift test');
  });

  it('detects pip-style Python without pyproject.toml', async () => {
    await writeFile(path.join(tmp, 'requirements.txt'), 'requests\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.test).toBe('pytest .');
    expect(facts.hints).toContain('python');
  });

  it('detects composer scripts', async () => {
    await writeFile(
      path.join(tmp, 'composer.json'),
      JSON.stringify({ scripts: { test: 'phpunit', lint: 'phpcs' } }),
    );
    const facts = await detectProjectFacts(tmp);
    expect(facts.test).toBe('php vendor/bin/phpunit');
    // no lint operation in the PHP profile
    expect(facts.lint).toBeUndefined();
  });
});

describe('slash-commands/helpers — detectProjectFacts CI workflow parser', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ws-ci-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeWorkflow(name: string, body: string): Promise<void> {
    await mkdir(path.join(tmp, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(tmp, '.github', 'workflows', name), body);
  }

  it('extracts commands from inline and block-scalar run steps', async () => {
    await writeWorkflow(
      'ci.yml',
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: bazel build //...',
        '      - name: tests',
        '        run: |',
        '          echo "starting"',
        '          bazel test //...',
        '      - run: buf lint',
      ].join('\n'),
    );
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('bazel build //...');
    expect(facts.test).toBe('bazel test //...');
    expect(facts.lint).toBe('buf lint');
    expect(facts.hints).toContain('.github/workflows');
  });

  it('only fills gaps left by manifests, never overrides them', async () => {
    await writeFile(path.join(tmp, 'go.mod'), 'module example.com/x\n');
    await writeWorkflow('ci.yml', ['steps:', '  - run: golangci-lint run'].join('\n'));
    const facts = await detectProjectFacts(tmp);
    // go.mod set build/test via the Go profile; the Go profile also provides
    // lint (go vet ./...), so CI's golangci-lint doesn't override it.
    expect(facts.build).toBe('go build ./...');
    expect(facts.test).toBe('go test ./...');
    expect(facts.lint).toBe('go vet ./...');
  });

  it('does not add the workflows hint when no command matched', async () => {
    await writeWorkflow('ci.yml', ['steps:', '  - run: ./deploy.sh production'].join('\n'));
    const facts = await detectProjectFacts(tmp);
    expect(facts.hints).not.toContain('.github/workflows');
  });
});
