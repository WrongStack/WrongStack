/**
 * Tree-sitter ref extraction (P3.9) — the 10 WASM languages now emit
 * call/import/heritage refs from the visitor (per-language `refRules`),
 * which is what makes `codebase-incoming-calls` / `codebase-outgoing-calls`
 * work for callers in those languages.
 *
 * Two layers:
 *  1. Unit: parse a fixture per language, assert the exact refs the rules
 *     emit (leaf names, modules, callTypes, lines).
 *  2. End-to-end: two Java files through parseFileContent → IndexStore
 *     commitBatch → findIncomingCallsByName / findOutgoingCallsByName.
 *
 * Elixir and Shell deliberately have NO refRules (their `call`-shaped nodes
 * are noise, not signal) — asserted here so the absence stays intentional.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFileContent } from '../src/codebase-index/parser-dispatch.js';
import type { Ref } from '../src/codebase-index/schema.js';
import { parseSymbols } from '../src/codebase-index/tree-sitter-parser.js';
import { IndexStore } from '../src/codebase-index/writer.js';

type RefMap = Map<string, Ref[]>;

async function refsFor(lang: string, content: string): Promise<RefMap> {
  const parsed = await parseSymbols({
    file: `D:/virtual/refs/sample.${lang}`,
    content,
    lang: lang as Parameters<typeof parseSymbols>[0]['lang'],
  });
  const byType = new Map<string, Ref[]>();
  for (const ref of parsed.refs ?? []) {
    const list = byType.get(ref.callType) ?? [];
    list.push(ref);
    byType.set(ref.callType, list);
  }
  return byType;
}

describe('tree-sitter ref extraction (P3.9)', () => {
  it('C: call refs with leaf names and #include imports', async () => {
    const refs = await refsFor(
      'c',
      '#include "engine/core.h"\nint helper(int x) { return x + 1; }\nint main(void) { return helper(1); }\n',
    );
    const calls = refs.get('call') ?? [];
    expect(calls.some((r) => r.toName === 'helper')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'engine/core.h' && r.toName === 'core')).toBe(true);
  });

  it('C++: call refs plus base-class inheritance', async () => {
    const refs = await refsFor(
      'cpp',
      '#include "base.h"\nclass Derived : public Base {\npublic:\n  int run() { return compute(); }\n};\n',
    );
    expect((refs.get('call') ?? []).some((r) => r.toName === 'compute')).toBe(true);
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
  });

  it('Java: method calls, imports, extends/implements', async () => {
    const refs = await refsFor(
      'java',
      'import java.util.List;\npublic class Main extends Base implements Runnable {\n  public void run() { System.out.println("x"); render(); }\n}\n',
    );
    expect((refs.get('call') ?? []).some((r) => r.toName === 'println')).toBe(true);
    expect((refs.get('call') ?? []).some((r) => r.toName === 'render')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'java.util.List' && r.toName === 'List')).toBe(true);
    expect((refs.get('inherit') ?? []).some((r) => r.toName === 'Base')).toBe(true);
    expect((refs.get('implement') ?? []).some((r) => r.toName === 'Runnable')).toBe(true);
  });

  it('C#: invocation calls, using imports, base list', async () => {
    const refs = await refsFor(
      'csharp',
      'using System.Text;\npublic class Repo : Base, IRepo {\n  public string Load() { return Fetch(); }\n}\n',
    );
    expect((refs.get('call') ?? []).some((r) => r.toName === 'Fetch')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'System.Text' && r.toName === 'Text')).toBe(true);
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(inherit.some((r) => r.toName === 'IRepo')).toBe(true);
  });

  it('PHP: function calls, use imports, implements', async () => {
    const refs = await refsFor(
      'php',
      '<?php\nuse App\\Contracts\\Renderable;\nclass Card implements Renderable {\n  public function draw() { return strtoupper($this->name); }\n}\n',
    );
    expect((refs.get('call') ?? []).some((r) => r.toName === 'strtoupper')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.toName === 'Renderable')).toBe(true);
    expect((refs.get('implement') ?? []).some((r) => r.toName === 'Renderable')).toBe(true);
  });

  it('Ruby: call refs, require imports, superclass', async () => {
    const refs = await refsFor(
      'ruby',
      "require 'json'\nclass Client < Base\n  def load(x)\n    JSON.parse(x)\n  end\nend\n",
    );
    const calls = refs.get('call') ?? [];
    expect(calls.some((r) => r.toName === 'parse')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'json' && r.toName === 'json')).toBe(true);
    expect((refs.get('inherit') ?? []).some((r) => r.toName === 'Base')).toBe(true);
  });

  it('Swift: call refs, import declarations, inheritance clause', async () => {
    const refs = await refsFor(
      'swift',
      'import Foundation\nclass Loader: DataLoader {\n  func run() { return fetch() }\n}\n',
    );
    expect((refs.get('call') ?? []).some((r) => r.toName === 'fetch')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'Foundation' && r.toName === 'Foundation')).toBe(true);
    expect((refs.get('inherit') ?? []).some((r) => r.toName === 'DataLoader')).toBe(true);
  });

  it('Kotlin: call expressions, imports, superclass', async () => {
    const refs = await refsFor(
      'kotlin',
      'import kotlin.math.max\nclass Service : Handler {\n  fun run(a: Int): Int { return process(a) }\n}\n',
    );
    expect((refs.get('call') ?? []).some((r) => r.toName === 'process')).toBe(true);
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.toName === 'max')).toBe(true);
    expect((refs.get('inherit') ?? []).some((r) => r.toName === 'Handler')).toBe(true);
  });

  it('Elixir and shell stay ref-less by design (noise, not signal)', async () => {
    const ex = await refsFor('elixir', 'defmodule Sample do\n  def go(x), do: x + 1\nend\n');
    expect(ex.size).toBe(0);
    const sh = await refsFor('shell', 'run_job() {\n  echo "done"\n}\nrun_job\n');
    expect(sh.size).toBe(0);
  });

  it('refs carry language + line; same-node duplicates collapse, same-line distinct calls do not', async () => {
    const refs = await refsFor('java', 'public class A { void go() { ping(); ping(); } }\n');
    const calls = (refs.get('call') ?? []).filter((r) => r.toName === 'ping');
    // Two `ping()` statements on one line are DIFFERENT nodes: both are
    // kept (the pre-owner dedupe key includes the node position, so it can
    // never drop a distinct statement's edge before owner assignment).
    expect(calls.length).toBe(2);
    expect(calls[0]!.lang).toBe('java');
    expect(calls[0]!.line).toBeGreaterThan(0);
    expect(calls[0]!.line).toBe(calls[1]!.line);
  });
});

describe('P3.9 follow-ups: aliases, modifiers, qualified heritage, C++ call forms', () => {
  it('Java: static import binds the member, not the "static" prefix', async () => {
    const refs = await refsFor(
      'java',
      'import static java.util.Collections.emptyList;\nclass D { void go() { Object o = emptyList(); } }\n',
    );
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'java.util.Collections.emptyList')).toBe(true);
    expect(imports.some((r) => r.toName === 'emptyList')).toBe(true);
    expect(imports.every((r) => !r.module.startsWith('static'))).toBe(true);
  });

  it('C#: using static and using alias resolve the original target', async () => {
    const refs = await refsFor(
      'csharp',
      'using static System.Char;\nusing Txt = System.Text;\nclass R { }\n',
    );
    const imports = refs.get('import') ?? [];
    // using static System.Char → binds Char, module unpolluted.
    expect(imports.some((r) => r.module === 'System.Char' && r.toName === 'Char')).toBe(true);
    // using Txt = System.Text → the alias is local only; the ref targets Text.
    expect(imports.some((r) => r.module === 'System.Text' && r.toName === 'Text')).toBe(true);
    expect(imports.some((r) => r.toName === 'Txt')).toBe(false);
  });

  it('PHP: use-as alias targets the original class with the full module path', async () => {
    const refs = await refsFor(
      'php',
      '<?php\nuse App\\Models\\User as U;\nclass C { function load(): void { $x = 1; } }\n',
    );
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'App\\Models\\User' && r.toName === 'User')).toBe(true);
    expect(imports.some((r) => r.toName === 'U')).toBe(false);
    expect(imports.some((r) => r.toName === 'User as U')).toBe(false);
  });

  it('Kotlin: import-as alias targets the original declaration', async () => {
    const refs = await refsFor('kotlin', 'import com.example.Foo as Bar\nclass D { }\n');
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'com.example.Foo' && r.toName === 'Foo')).toBe(true);
    expect(imports.some((r) => r.toName === 'Bar')).toBe(false);
  });

  it('Java: qualified extends/implements resolve to the declared leaf, no segment noise', async () => {
    const refs = await refsFor(
      'java',
      'class D extends com.example.Base implements org.ext.IFace {}\n',
    );
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(inherit.some((r) => r.toName === 'com')).toBe(false);
    expect(inherit.some((r) => r.toName === 'example')).toBe(false);
    const implement = refs.get('implement') ?? [];
    expect(implement.some((r) => r.toName === 'IFace')).toBe(true);
    expect(implement.some((r) => r.toName === 'ext')).toBe(false);
  });

  it('C#/PHP: qualified base names resolve to the leaf, not dotted text', async () => {
    const cs = await refsFor('csharp', 'class Repo : App.Base { }\n');
    const csInherit = cs.get('inherit') ?? [];
    expect(csInherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(csInherit.some((r) => r.toName === 'App.Base')).toBe(false);

    const php = await refsFor('php', '<?php\nclass C extends App\\Base { }\n');
    const phpInherit = php.get('inherit') ?? [];
    expect(phpInherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(phpInherit.some((r) => r.toName === 'App')).toBe(false);
  });

  it('Kotlin: qualified delegation specifier resolves the leaf user_type', async () => {
    const refs = await refsFor('kotlin', 'class D : com.example.Base {}\n');
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(inherit.some((r) => r.toName === 'example')).toBe(false);
  });

  it('Ruby: scope_resolution superclass resolves the leaf constant', async () => {
    const refs = await refsFor('ruby', 'class Foo < Bar::Baz\nend\n');
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Baz')).toBe(true);
    expect(inherit.some((r) => r.toName === 'Bar')).toBe(false);
  });

  it('C++: -> member calls and :: qualified calls emit the method name', async () => {
    const refs = await refsFor(
      'cpp',
      'class T { public: int run(); static int stat(); };\nint helper();\nint main() {\n  T obj;\n  obj->run();\n  T::stat();\n  helper();\n  return 0;\n}\n',
    );
    const calls = refs.get('call') ?? [];
    // obj->run() → run (the declared method), never "obj->run".
    expect(calls.some((r) => r.toName === 'run')).toBe(true);
    expect(calls.some((r) => r.toName === 'obj->run')).toBe(false);
    // T::stat() → stat; T is the scope, not the referenced symbol.
    expect(calls.some((r) => r.toName === 'stat')).toBe(true);
    expect(calls.some((r) => r.toName === 'T::stat')).toBe(false);
    // Plain calls keep working.
    expect(calls.some((r) => r.toName === 'helper')).toBe(true);
  });
});

describe('Chimera mediums: generic type arguments, grouped imports, namespaced calls', () => {
  it('Java: generic type arguments in heritage are not phantom refs', async () => {
    const refs = await refsFor('java', 'class D extends Base<Foo> implements Iface<Bar> {}\n');
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(inherit.some((r) => r.toName === 'Foo')).toBe(false);
    const implement = refs.get('implement') ?? [];
    expect(implement.some((r) => r.toName === 'Iface')).toBe(true);
    expect(implement.some((r) => r.toName === 'Bar')).toBe(false);
  });

  it('C#: generic base list emits the generic name, never its arguments', async () => {
    const refs = await refsFor('csharp', 'class R : Base<Item>, IFoo<string> { }\n');
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(inherit.some((r) => r.toName === 'Item')).toBe(false);
    expect(inherit.some((r) => r.toName === 'IFoo')).toBe(true);
    // C# allows predefined types as arguments (`string`) — never a ref.
    expect(inherit.some((r) => r.toName === 'string')).toBe(false);
  });

  it('C++: template base emits Base, never the template argument Foo', async () => {
    // tree-sitter-cpp heritage: (base_class_clause (template_type name:
    // (type_identifier) arguments: (template_argument_list (type_descriptor
    // type: (type_identifier))))). The argument subtree type is DISTINCT
    // from java/c#/kotlin's type_argument_list — without its own skip
    // entry, Foo leaks as a phantom inherit ref.
    const refs = await refsFor('cpp', 'class D : Base<Foo> {};\n');
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Base')).toBe(true);
    expect(inherit.some((r) => r.toName === 'Foo')).toBe(false);
  });

  it('Kotlin: generic delegation specifier emits Handler, not Event', async () => {
    const refs = await refsFor('kotlin', 'class D : Handler<Event> {}\n');
    const inherit = refs.get('inherit') ?? [];
    expect(inherit.some((r) => r.toName === 'Handler')).toBe(true);
    expect(inherit.some((r) => r.toName === 'Event')).toBe(false);
  });

  it('PHP: grouped use binds each member with its own alias handling', async () => {
    const refs = await refsFor('php', '<?php\nuse App\\{Foo, Bar as B};\n');
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'App\\Foo' && r.toName === 'Foo')).toBe(true);
    expect(imports.some((r) => r.module === 'App\\Bar' && r.toName === 'Bar')).toBe(true);
    // The alias B is local-only; the fused single-emission form is gone.
    expect(imports.some((r) => r.toName === 'B')).toBe(false);
    expect(imports.length).toBe(2);
  });

  it('PHP: mixed grouped use strips per-member modifiers', async () => {
    const refs = await refsFor('php', '<?php\nuse App\\{Foo, function bar};\n');
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'App\\bar' && r.toName === 'bar')).toBe(true);
    expect(imports.some((r) => r.module === 'App\\function bar')).toBe(false);
  });

  it('Swift: kind-qualified import binds the member, not the kind', async () => {
    const refs = await refsFor('swift', 'import class Foundation.URLSession\n');
    const imports = refs.get('import') ?? [];
    expect(
      imports.some((r) => r.module === 'Foundation.URLSession' && r.toName === 'URLSession'),
    ).toBe(true);
    expect(imports.some((r) => r.module === 'class Foundation.URLSession')).toBe(false);
  });

  it('PHP: namespaced function call emits the leaf name', async () => {
    const refs = await refsFor('php', '<?php\nApp\\Util\\greet();\n');
    expect((refs.get('call') ?? []).some((r) => r.toName === 'greet')).toBe(true);
    expect((refs.get('call') ?? []).some((r) => r.toName === 'Util\\greet')).toBe(false);
  });

  it('PHP: namespaced constructor emits the class leaf', async () => {
    const refs = await refsFor('php', '<?php\n$x = new App\\Model\\User();\n');
    expect((refs.get('call') ?? []).some((r) => r.toName === 'User')).toBe(true);
    expect((refs.get('call') ?? []).some((r) => r.toName === 'App\\Model\\User')).toBe(false);
  });

  it('PHP: multi-clause use binds EACH clause, never a fused module', async () => {
    // Verified AST: namespace_use_declaration carries multiple
    // namespace_use_clause children; the refRule fires on the declaration
    // node whose text spans them all. Before the split this fused into ONE
    // bogus module and dropped every clause but the last.
    const refs = await refsFor('php', '<?php\nuse App\\Foo, App\\Bar;\n');
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'App\\Foo' && r.toName === 'Foo')).toBe(true);
    expect(imports.some((r) => r.module === 'App\\Bar' && r.toName === 'Bar')).toBe(true);
    expect(imports.some((r) => (r.module ?? '').includes(','))).toBe(false);
  });

  it('PHP: mixed multi-clause use strips per-clause modifiers', async () => {
    const refs = await refsFor('php', '<?php\nuse function App\\foo, const App\\BAR;\n');
    const imports = refs.get('import') ?? [];
    expect(imports.some((r) => r.module === 'App\\foo' && r.toName === 'foo')).toBe(true);
    expect(imports.some((r) => r.module === 'App\\BAR' && r.toName === 'BAR')).toBe(true);
    expect(imports.some((r) => (r.module ?? '').startsWith('function'))).toBe(false);
    expect(imports.some((r) => (r.module ?? '').includes('const'))).toBe(false);
  });

  it('C#: comma inside generic arguments does not split a using-alias', async () => {
    // `using L = List<int, string>;` is ONE clause whose generic argument
    // list contains a comma — the split's `<` guard must exempt it.
    const refs = await refsFor(
      'csharp',
      'using L = System.Collections.Generic.List<int, string>;\n',
    );
    const imports = refs.get('import') ?? [];
    expect(imports.length).toBe(1);
    expect(imports[0]!.toName).toBe('List');
    expect(imports[0]!.module).toBe('System.Collections.Generic.List<int, string>');
  });

  it('C#: comma in a non-generic alias target does not split (the = guard)', async () => {
    // `using Pair = (int, string);` has NO `<`, so only the `=` guard keeps
    // this single clause out of the PHP multi-clause split. Dropping the `=`
    // check would emit two junk fragments (`(int` / `string)`). The pin is
    // the count: exactly one import ref, never two.
    const refs = await refsFor('csharp', 'using Pair = (int, string);\n');
    const imports = refs.get('import') ?? [];
    expect(imports.length).toBe(1);
    expect(imports.some((r) => r.toName === '(int' || r.toName === 'string)')).toBe(false);
  });
});

describe('incoming/outgoing calls through the index (Java via tree-sitter)', () => {
  it('resolves cross-file Java call edges end to end', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tsrefs-'));
    const store = new IndexStore(root);
    try {
      const greeterFile = path.join(root, 'Greeter.java');
      const mainFile = path.join(root, 'Main.java');
      const greeter = await parseFileContent(
        greeterFile,
        'package app;\npublic class Greeter {\n  public String greet(String name) { return "hi " + name; }\n}\n',
        'java',
      );
      const main = await parseFileContent(
        mainFile,
        'package app;\npublic class Main {\n  public String run(String who) {\n    Greeter g = new Greeter();\n    return g.greet(who);\n  }\n}\n',
        'java',
      );
      // The call ref must exist before the store sees it.
      expect((main.refs ?? []).some((r) => r.callType === 'call' && r.toName === 'greet')).toBe(
        true,
      );

      store.commitBatch(
        [
          {
            file: greeterFile,
            lang: 'java',
            symbols: greeter.symbols,
            refs: greeter.refs ?? [],
            mtimeMs: Date.now(),
            symbolCount: greeter.symbols.length,
            contentHash: '',
          },
          {
            file: mainFile,
            lang: 'java',
            symbols: main.symbols,
            refs: main.refs ?? [],
            mtimeMs: Date.now(),
            symbolCount: main.symbols.length,
            contentHash: '',
          },
        ],
        { deleteForFiles: [greeterFile, mainFile] },
      );

      // Incoming: who calls greet? → run (in Main).
      const incoming = store.findIncomingCallsByName('greet');
      expect(incoming.symbolFound).toBe(true);
      expect(incoming.calls.some((c) => c.symbol.name === 'run')).toBe(true);

      // Outgoing: what does run call? → greet (in Greeter).
      const outgoing = store.findOutgoingCallsByName('run');
      expect(outgoing.symbolFound).toBe(true);
      expect(outgoing.calls.some((c) => c.symbol.name === 'greet')).toBe(true);
    } finally {
      store.close();
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
