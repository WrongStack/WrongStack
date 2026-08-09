/**
 * Day 2-3 smoke test: the universal visitor produces at least one symbol
 * for every one of the 10 new languages.
 *
 * This is intentionally a thin coverage spec. Day 4-8 will replace each
 * `it()` here with a focused fixture exercising every entry in the
 * per-language `NodeQueries` table.
 */

import { describe, expect, it } from 'vitest';
import { parseSymbols } from '../src/codebase-index/tree-sitter-parser.js';

interface Case {
  lang: 'c' | 'cpp' | 'java' | 'csharp' | 'php' | 'ruby' | 'swift' | 'kotlin' | 'elixir' | 'shell';
  label: string;
  src: string;
  /** Substring that must appear in some symbol's `name` field. */
  expectAny: string;
}

const CASES: Case[] = [
  {
    lang: 'c',
    label: 'C',
    src: 'int answer() { return 42; }\n\nstruct Point { int x; int y; };\n\ntypedef unsigned long ulong;\n',
    expectAny: 'answer',
  },
  {
    lang: 'cpp',
    label: 'C++',
    src: 'namespace app {\n  class Widget {\n  public:\n    void render();\n  };\n\n  int compute(int x) { return x * 2; }\n}\n',
    expectAny: 'Widget',
  },
  {
    lang: 'java',
    label: 'Java',
    src: 'package demo;\npublic class App {\n  public static void main(String[] args) { run(); }\n  private static int run() { return 1; }\n}\n',
    expectAny: 'App',
  },
  {
    lang: 'csharp',
    label: 'C#',
    src: 'namespace Demo {\n  class App {\n    void Main() { }\n  }\n}\n',
    expectAny: 'Demo',
  },
  {
    lang: 'php',
    label: 'PHP',
    src: '<?php\nnamespace App;\nfunction greet(string $name): string { return "hi $name"; }\nclass Greeter {}\n',
    expectAny: 'greet',
  },
  {
    lang: 'ruby',
    label: 'Ruby',
    src: 'module App\n  def self.hello(name)\n    puts "hi #{name}"\n  end\nend\n',
    expectAny: 'hello',
  },
  {
    lang: 'swift',
    label: 'Swift',
    src: 'class App {\n  func greet() -> String { return "hi" }\n}\n',
    expectAny: 'App',
  },
  {
    lang: 'kotlin',
    label: 'Kotlin',
    src: 'fun greet(name: String): String = "hi $name"\nclass App {}\n',
    expectAny: 'greet',
  },
  {
    lang: 'elixir',
    label: 'Elixir',
    src: 'defmodule MyApp do\n  def greet(name), do: "hi #{name}"\n  defp secret, do: 42\nend\n',
    expectAny: 'greet',
  },
  {
    lang: 'shell',
    label: 'Shell',
    src: 'greet() {\n  echo "hi"\n}\n',
    expectAny: 'greet',
  },
];

describe('tree-sitter universal visitor — Day 2-3 smoke', () => {
  for (const c of CASES) {
    it(`${c.label}: emits at least one symbol containing "${c.expectAny}"`, async () => {
      const result = await parseSymbols({
        file: `/tmp/test.${c.lang}`,
        content: c.src,
        lang: c.lang,
      });
      expect(result.symbols.length).toBeGreaterThan(0);
      const names = result.symbols.map((s) => s.name);
      expect(names.some((n) => n.includes(c.expectAny))).toBe(true);
    });
  }
});
