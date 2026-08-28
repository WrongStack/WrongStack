/**
 * Language-agnostic, multi-framework error classifier for /fix.
 * Patterns are checked in order — first match wins.
 * Supports: TypeScript, Rust, Go, Python, Ruby, Java, Kotlin, Swift,
 *           C/C++, PHP, C#, Scala, Perl, Haskell, Elixir, Node.js, React,
 *           Next.js, Vue, Angular, Docker, Git, CI/CD, and more.
 */

export interface Classification {
  category: ErrorCategory;
  subcategory: string;
  language: string;
  skillHints: string[];
  framework?: string | undefined;
  errorCode?: string | undefined;
  confidence: number;
  detail: string;
}

type ErrorCategory =
  | 'ts'
  | 'security'
  | 'runtime'
  | 'logic'
  | 'compile'
  | 'lint'
  | 'dep'
  | 'perf'
  | 'infra'
  | 'tech'
  | 'general';

const TS = ['typescript-strict'];
const TC = ['tech-stack'];
const BH = ['bug-hunter'];
const SS = ['security-scanner'];
const NM = ['node-modern'];
const RM = ['react-modern'];

interface Pat {
  pat: RegExp;
  cat: ErrorCategory;
  sub: string;
  lang?: string | undefined;
  fw?: string | undefined;
  hints: string[];
  detail: string | ((m: RegExpMatchArray) => string);
  code?: ((m: RegExpMatchArray) => string) | undefined;
  conf?: number | undefined;
}

/**
 * Pattern table — ORDER MATTERS.
 *
 * Priority rules:
 *  1. Specific error codes first (TS####, E####, C####)
 *  2. Security before generic runtime
 *  3. Language-agnostic patterns before language-specific ones
 *  4. Perf/logic generic before C-specific (memory leak → perf, not c/memory-safety)
 *  5. Specific network/file errors before generic module-not-found
 *  6. Infra last
 */
const P: Pat[] = [
  // ── TypeScript ──────────────────────────────────────────────────────────────
  {
    pat: /\bTS\d+\b/,
    cat: 'ts',
    sub: 'typescript',
    lang: 'typescript',
    hints: TS,
    detail: 'TypeScript error',
    code: (m) => m[0],
    conf: 1.0,
  },
  {
    pat: /\btypescript\b.*\berror\b|\berror\b.*\btypescript\b/i,
    cat: 'ts',
    sub: 'typescript',
    lang: 'typescript',
    hints: TS,
    detail: 'TypeScript error',
    conf: 0.9,
  },
  {
    pat: /\b: any\b|\bas any\b/,
    cat: 'ts',
    sub: 'unsafe-any',
    lang: 'typescript',
    hints: TS,
    detail: 'Unsafe `any` cast — type safety violation',
    conf: 0.85,
  },
  {
    pat: /\bnoimplicit|\bstrict\b.*\bcheck\b|\btsconfig\b/i,
    cat: 'ts',
    sub: 'strict-mode',
    lang: 'typescript',
    hints: TS,
    detail: 'TypeScript strict mode configuration issue',
    conf: 0.8,
  },

  // ── Rust ───────────────────────────────────────────────────────────────────
  {
    pat: /\bE\d{4,}\b/,
    cat: 'runtime',
    sub: 'panic',
    lang: 'rust',
    hints: BH,
    detail: 'Rust error',
    conf: 1.0,
    code: (m) => m[0],
  },
  {
    pat: /\bthread.*panicked|panicked at /i,
    cat: 'runtime',
    sub: 'panic',
    lang: 'rust',
    hints: BH,
    detail: 'Rust panic',
    conf: 1.0,
  },
  {
    pat: /\brustc.*error|compilation failed.*rust/i,
    cat: 'compile',
    sub: 'rust-compile',
    lang: 'rust',
    hints: BH,
    detail: 'Rust compiler error',
    conf: 1.0,
  },

  // ── Go ──────────────────────────────────────────────────────────────────────
  {
    pat: /\bgo build\b.*fail|golang.*error/i,
    cat: 'compile',
    sub: 'go-compile',
    lang: 'go',
    hints: BH,
    detail: 'Go build error',
    conf: 0.95,
  },
  {
    pat: /\bnil pointer|nil dereference|invalid memory address/i,
    cat: 'runtime',
    sub: 'nil-pointer',
    lang: 'go',
    hints: BH,
    detail: 'Go nil pointer dereference',
    conf: 0.9,
  },

  // ── Python ────────────────────────────────────────────────────────────────
  {
    pat: /\btraceback \(most recent call last\)/i,
    cat: 'runtime',
    sub: 'python-traceback',
    lang: 'python',
    hints: BH,
    detail: 'Python runtime error / traceback',
    conf: 1.0,
  },
  {
    pat: /\bpython.*error|python.*exception|modulenot founderror|importerror/i,
    cat: 'runtime',
    sub: 'python-traceback',
    lang: 'python',
    hints: BH,
    detail: 'Python runtime error',
    conf: 1.0,
  },
  {
    pat: /\battributeerror\b|\btypeerror\b.*python|python.*type error/i,
    cat: 'runtime',
    sub: 'python-type',
    lang: 'python',
    hints: BH,
    detail: 'Python type/error',
    conf: 0.9,
  },
  {
    pat: /\bpip install|requirement.*not found|package.*not found.*python/i,
    cat: 'dep',
    sub: 'python-dep',
    lang: 'python',
    hints: BH,
    detail: 'Python dependency error',
    conf: 0.9,
  },
  {
    pat: /\bpylint|pyright|mypy.*error|flake8/i,
    cat: 'lint',
    sub: 'python-lint',
    lang: 'python',
    hints: BH,
    detail: 'Python linter error',
    conf: 0.85,
  },

  // ── Ruby ──────────────────────────────────────────────────────────────────
  {
    pat: /\b(nomethoderror|noconversion|undefined method|private method|rbenv|rubygems)/i,
    cat: 'runtime',
    sub: 'ruby-error',
    lang: 'ruby',
    hints: BH,
    detail: (m) => `Ruby error: ${m[1] ?? m[0]}`,
    conf: 0.9,
  },
  {
    pat: /\bgem install|bundler.*error|gemspec.*error/i,
    cat: 'dep',
    sub: 'ruby-dep',
    lang: 'ruby',
    hints: BH,
    detail: 'Ruby gem/bundler error',
    conf: 0.85,
  },

  // ── Java / Kotlin ────────────────────────────────────────────────────────
  {
    pat: /\bnullpointerexception|npe\b/i,
    cat: 'runtime',
    sub: 'null-pointer',
    lang: 'java',
    hints: BH,
    detail: 'NullPointerException',
    conf: 1.0,
  },
  {
    pat: /\bjava\.lang\.|exception in thread|java\.util\.|java\.io\./i,
    cat: 'runtime',
    sub: 'java-exception',
    lang: 'java',
    hints: BH,
    detail: 'Java/Kotlin runtime exception',
    conf: 1.0,
  },
  {
    pat: /\b(maven|gradle|ant).*error|dependency.*not found|compile.*fail.*java/i,
    cat: 'dep',
    sub: 'java-build',
    lang: 'java',
    hints: BH,
    detail: 'Java build/dependency error',
    conf: 0.9,
  },
  {
    pat: /\bkotlin\b.*\berror\b|\bkotlin compiler\b/i,
    cat: 'compile',
    sub: 'kotlin-compile',
    lang: 'kotlin',
    hints: BH,
    detail: 'Kotlin compiler error',
    conf: 0.95,
  },

  // ── C / C++ ─────────────────────────────────────────────────────────────
  {
    pat: /\bc\d+\b/i,
    cat: 'compile',
    sub: 'c-compile',
    lang: 'c',
    hints: BH,
    detail: 'C/C++ compiler error',
    conf: 1.0,
    code: (m) => m[0],
  },
  {
    pat: /\b(gcc|g\+\+|clang|msvc|visual studio).*error|fatal error c\d+/i,
    cat: 'compile',
    sub: 'c-compile',
    lang: 'c',
    hints: BH,
    detail: 'C/C++ compiler error',
    conf: 1.0,
  },
  {
    pat: /\bsegmentation fault|segfault|sigsegv|core dumped/i,
    cat: 'runtime',
    sub: 'segfault',
    lang: 'c',
    hints: BH,
    detail: 'Segmentation fault (C/C++)',
    conf: 1.0,
  },

  // ── C# ──────────────────────────────────────────────────────────────────
  {
    pat: /\b(csharp|dotnet|\.net).*error|cs\d+\b|nullable warning/i,
    cat: 'compile',
    sub: 'csharp-compile',
    lang: 'csharp',
    hints: BH,
    detail: 'C# / .NET compile error',
    conf: 0.9,
  },

  // ── PHP ────────────────────────────────────────────────────────────────
  {
    pat: /\bphp.*error|fatal error.*php|parse error.*php/i,
    cat: 'runtime',
    sub: 'php-error',
    lang: 'php',
    hints: BH,
    detail: 'PHP runtime/parse error',
    conf: 1.0,
  },

  // ── Scala ─────────────────────────────────────────────────────────────
  {
    pat: /\bscala.*error|type mismatch.*scala|could not find.*scala/i,
    cat: 'compile',
    sub: 'scala-compile',
    lang: 'scala',
    hints: BH,
    detail: 'Scala compile error',
    conf: 0.9,
  },

  // ── Node.js / JavaScript Runtime ────────────────────────────────────────
  {
    pat: /\b(node:|node\.js|err_)/i,
    cat: 'runtime',
    sub: 'node-runtime',
    lang: 'javascript',
    hints: NM,
    detail: 'Node.js runtime error',
    conf: 1.0,
  },
  {
    pat: /\bcannot read property|cannot set property|cannot call method/i,
    cat: 'runtime',
    sub: 'undefined-call',
    lang: 'javascript',
    hints: NM,
    detail: 'JavaScript undefined access error',
    conf: 0.95,
  },
  {
    pat: /\beconnrefused|etimedout|enotfound|econnreset|dns lookup/i,
    cat: 'infra',
    sub: 'network',
    lang: 'javascript',
    hints: NM,
    detail: 'Node.js network error',
    conf: 0.95,
  },
  {
    pat: /\beacces|eisdir|eperm/i,
    cat: 'infra',
    sub: 'file-system',
    lang: 'javascript',
    hints: NM,
    detail: 'File system / OS error',
    conf: 0.95,
  },

  // ── React / Next.js ──────────────────────────────────────────────────────
  {
    pat: /\breact-dom|react\.development|invalid hook call/i,
    cat: 'runtime',
    sub: 'react-error',
    lang: 'javascript',
    hints: RM,
    detail: 'React runtime error',
    conf: 0.9,
  },
  {
    pat: /\bnext\.js|nextjs|error in.*next|getstaticpaths|getserversideprops/i,
    cat: 'runtime',
    sub: 'nextjs-error',
    lang: 'javascript',
    hints: RM,
    detail: 'Next.js error',
    conf: 0.95,
  },

  // ── Security — BEFORE generic catch-alls ─────────────────────────────
  {
    pat: /\b(sql injection|xss|csrf|injection)\b/i,
    cat: 'security',
    sub: 'injection',
    lang: undefined,
    hints: SS,
    detail: 'Injection vulnerability',
    conf: 1.0,
  },
  {
    pat: /\b(secret|apikey|api_key|token|password|credential|jwt)\b/i,
    cat: 'security',
    sub: 'secret-exposure',
    lang: undefined,
    hints: SS,
    detail: 'Secret / credential exposure',
    conf: 1.0,
  },
  {
    pat: /\b(eval|innerhtml|document\.write| dangerouslysetinnerhtml)\b/i,
    cat: 'security',
    sub: 'injection',
    lang: undefined,
    hints: SS,
    detail: 'Injection vulnerability',
    conf: 1.0,
  },
  {
    pat: /\bcors.*misconfig|access-control-allow-origin/i,
    cat: 'security',
    sub: 'cors-misconfig',
    lang: undefined,
    hints: SS,
    detail: 'CORS misconfiguration',
    conf: 0.9,
  },
  {
    pat: /\bapikey\b|\bapi_key\b|\bhardcoded\b.*\bkey\b/i,
    cat: 'security',
    sub: 'secret-exposure',
    lang: undefined,
    hints: SS,
    detail: 'Secret / credential exposure',
    conf: 1.0,
  },

  // ── Null/undefined access — BEFORE generic typeerror catch-all ─────────────
  {
    pat: /\b(null is not|null.*not.*function|undefined is not|is not a function)\b/i,
    cat: 'runtime',
    sub: 'null-undefined-access',
    lang: 'javascript',
    hints: BH,
    detail: 'Null/undefined access error',
    conf: 0.9,
  },

  // ── Generic JS errors ────────────────────────────────────────────────
  {
    pat: /\b(typeerror|referenceerror|syntaxerror|urierror|rangeerror|evalerror)\b/i,
    cat: 'runtime',
    sub: 'js-error',
    lang: 'javascript',
    hints: NM,
    detail: 'JavaScript runtime error',
    conf: 0.95,
  },

  // ── Tech stack validation — BEFORE generic dep patterns ─────────────
  // Technology choice questions: "should I use X?", "is Y deprecated?", etc.
  {
    pat: /\b(should I (use|install|add|pick|choose)|is .+ (still (good|maintained|supported|relevant)|deprecated|dead|obsolete|outdated)|what replaces|alternative to|instead of)\b/i,
    cat: 'tech',
    sub: 'tech-choice',
    lang: undefined,
    hints: TC,
    detail: 'Technology choice validation',
    conf: 0.85,
  },
  {
    pat: /\bwhat (is the latest|are the latest|version of|versions of)|what version|upgrade to latest|downgrade to|which version of\b/i,
    cat: 'tech',
    sub: 'version-check',
    lang: undefined,
    hints: TC,
    detail: 'Version verification needed',
    conf: 0.9,
  },
  {
    pat: /\b(adding|installing|using|switching to|migrating to) (a |an |the )?(package|dependency|library|module|framework|gem|crate)\b/i,
    cat: 'tech',
    sub: 'tech-choice',
    lang: undefined,
    hints: TC,
    detail: 'Technology choice validation',
    conf: 0.8,
  },
  // Commands that imply tech choices: "pip install X", "cargo add X", etc.
  {
    pat: /\b(pip install|pip3 install|pipenv install|poetry add|uv add)\s+[a-zA-Z0-9_-]+/i,
    cat: 'tech',
    sub: 'python-pkg',
    lang: 'python',
    hints: TC,
    detail: 'Python package choice — validate before installing',
    conf: 0.85,
  },
  {
    pat: /\b(cargo add|cargo install)\s+[a-zA-Z0-9_-]+/i,
    cat: 'tech',
    sub: 'rust-crate',
    lang: 'rust',
    hints: TC,
    detail: 'Rust crate choice — validate before installing',
    conf: 0.85,
  },
  {
    pat: /\b(go get|go install)\s+[a-zA-Z0-9_./-]+/i,
    cat: 'tech',
    sub: 'go-module',
    lang: 'go',
    hints: TC,
    detail: 'Go module choice — validate before installing',
    conf: 0.85,
  },
  {
    pat: /\b(gem install|bundle add)\s+[a-zA-Z0-9_-]+/i,
    cat: 'tech',
    sub: 'ruby-gem',
    lang: 'ruby',
    hints: TC,
    detail: 'Ruby gem choice — validate before installing',
    conf: 0.85,
  },
  {
    pat: /\b(npm install|pnpm add|yarn add)\s+[a-zA-Z0-9@/_-]+/i,
    cat: 'tech',
    sub: 'js-pkg',
    lang: 'javascript',
    hints: TC,
    detail: 'JS package choice — validate before installing',
    conf: 0.85,
  },
  {
    pat: /\b(composer require|nuget install|dotnet add package)\s+[a-zA-Z0-9./_-]+/i,
    cat: 'tech',
    sub: 'pkg-choice',
    lang: undefined,
    hints: TC,
    detail: 'Package choice — validate before installing',
    conf: 0.85,
  },

  // ── Dependency / Import ───────────────────────────────────────────────
  {
    pat: /\bcannot find module|modulenotfounderror|no such module|missing module/i,
    cat: 'dep',
    sub: 'module-not-found',
    lang: undefined,
    hints: BH,
    detail: 'Module / import resolution failure',
    conf: 0.9,
  },
  {
    pat: /\bfailed to resolve|resolves to|dependency.*not found/i,
    cat: 'dep',
    sub: 'module-not-found',
    lang: undefined,
    hints: BH,
    detail: 'Dependency resolution failure',
    conf: 0.85,
  },

  // ── Lint ────────────────────────────────────────────────────────────────
  {
    pat: /\b(lint|warning|eslint|prettier|ruff|pylint|golangci-lint).*(error|fail|warn)/i,
    cat: 'lint',
    sub: 'linter-error',
    lang: undefined,
    hints: BH,
    detail: 'Linter error / warning',
    conf: 0.85,
  },

  // ── Performance ────────────────────────────────────────────────────────
  {
    pat: /\b(memory leak|oom|out of memory|heap overflow|stack overflow|infinite loop|bottleneck|performance issue)\b/i,
    cat: 'perf',
    sub: 'performance-issue',
    lang: undefined,
    hints: BH,
    detail: 'Performance / memory issue',
    conf: 0.85,
  },

  // ── Logic / wrong behavior ─────────────────────────────────────────────
  {
    pat: /\b(wrong|incorrect|unexpected|silent fail|bug|defect|logic error)\b/i,
    cat: 'logic',
    sub: 'wrong-behavior',
    lang: undefined,
    hints: BH,
    detail: 'Logic / behavioral bug',
    conf: 0.8,
  },
  {
    pat: /\b(off.?by.?one|boundary error|index error)\b/i,
    cat: 'logic',
    sub: 'wrong-behavior',
    lang: undefined,
    hints: BH,
    detail: 'Off-by-one error',
    conf: 0.9,
  },

  // ── C memory-safety (specific, after generic memory leak patterns above) ─
  {
    pat: /\b(heap-buffer-overflow|use-after-free|double-free)\b/i,
    cat: 'perf',
    sub: 'memory-safety',
    lang: 'c',
    hints: BH,
    detail: 'Memory safety issue (C/C++)',
    conf: 1.0,
  },

  // ── Infra — AFTER more specific categories ─────────────────────────────
  {
    pat: /\b(env|environment|config|dotenv|yml|yaml|json.*config|docker|k8s|kubernetes)\b/i,
    cat: 'infra',
    sub: 'config-error',
    lang: undefined,
    hints: BH,
    detail: 'Infrastructure / configuration error',
    conf: 0.8,
  },
  {
    pat: /\b(git.*conflict|merge conflict|rebase.*fail|branch.*error|git.*error)\b/i,
    cat: 'infra',
    sub: 'git-error',
    lang: undefined,
    hints: BH,
    detail: 'Git error',
    conf: 0.9,
  },
  {
    pat: /\b(ci.?cd|pipeline|github action|circleci|jenkins|gitlab ci)\b/i,
    cat: 'infra',
    sub: 'config-error',
    lang: undefined,
    hints: BH,
    detail: 'CI/CD pipeline error',
    conf: 0.9,
  },
];

/**
 * Classify a raw error message into structured metadata.
 * Patterns are checked in order — first match wins.
 */
export function classifyError(input: string): Classification {
  const s = input.trim();

  for (const p of P) {
    const m = p.pat.exec(s);
    if (!m) continue;
    const detailStr = typeof p.detail === 'function' ? p.detail(m) : p.detail;
    return {
      category: p.cat,
      subcategory: p.sub,
      language: p.lang ?? 'unknown',
      framework: p.fw,
      skillHints: p.hints,
      errorCode: p.code ? p.code(m) : extractCode(s),
      confidence: p.conf ?? 0.8,
      detail: detailStr,
    };
  }

  return {
    category: 'general',
    subcategory: 'unknown',
    language: 'unknown',
    skillHints: BH,
    confidence: 0.3,
    detail: 'General problem (unclassified)',
  };
}

function extractCode(s: string): string | undefined {
  const ts = /\bTS\d+\b|\bCS\d+\b/.exec(s);
  if (ts !== null) return ts[0];
  const rust = /\bE\d{4,}\b/.exec(s);
  if (rust !== null) return rust[0];
  const c = /\bc\d+\b/i.exec(s);
  if (c !== null) return c[0];
  return undefined;
}

/** True if the fix likely needs multi-file analysis → delegate to subagent */
export function needsSubagent(c: Classification): boolean {
  return c.confidence < 0.85;
}

/** True if the fix can be done inline in a single step */
export function isSimpleFix(c: Classification): boolean {
  return (
    (c.category === 'ts' && c.confidence >= 0.9) ||
    (c.category === 'runtime' &&
      c.subcategory === 'null-undefined-access' &&
      c.confidence >= 0.85) ||
    (c.category === 'tech' && c.confidence >= 0.85)
  );
}
