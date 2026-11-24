/**
 * Static security pattern tables `SkillGenerator.generate()` assembles into a
 * fallback skill: hardcoded secrets, injection vectors and insecure
 * configuration, each with stack-specific additions.
 */
import type { SecurityPattern, TechStack } from './types.js';

/** Every JS/TS source form: `.ts`/`.js` alone left .tsx/.jsx/.mjs/.cjs unmatched. */
const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function getSecretPatterns(stack: TechStack): SecurityPattern[] {
  const commonSecrets: SecurityPattern = {
    id: 'hardcoded-secrets',
    name: 'Hardcoded Secrets',
    severity: 'critical',
    description: 'Detects hardcoded API keys, tokens, passwords, and private keys',
    patterns: [
      // `['"]?` after the key word: a quoted key (`"password": "..."`, every
      // JSON/YAML/dict secret) never matched, though `.json` is listed (F1288).
      /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)['"]?\s*[:=]\s*['"][a-zA-Z0-9_-]{8,}['"]/gi,
      // Any key-type words (OPENSSH, EC, DSA, ENCRYPTED, PGP … BLOCK), not
      // just RSA: ssh-keygen has written OPENSSH keys by default since 7.8.
      /-----BEGIN\s+(?:[A-Z0-9]+\s+){0,3}PRIVATE\s+KEY(?:\s+BLOCK)?-----/g,
      /ghp_[a-zA-Z0-9]{36}/g,
      /glpat-[a-zA-Z0-9_-]{20}/g,
      /sk-[a-zA-Z0-9]{32,}/g,
      // Current OpenAI / Anthropic formats carry `-`/`_`, which the legacy
      // rule above stops at; unquoted in `.env`, nothing else reports them.
      /(?<![A-Za-z0-9_-])sk-(?:proj|svcacct|admin|ant-api\d+)-[A-Za-z0-9_-]{20,}/g,
      /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
      /AIza[0-9A-Za-z\-_]{35}/g,
      // F86: ASIA STS temporary credentials share AKIA's shape; whsec_ is a
      // Stripe webhook signing secret (forged-event authority).
      /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
      /whsec_[A-Za-z0-9]{24,}/g,
    ],
    fileExtensions: [
      ...JS_EXTENSIONS,
      '.py',
      '.go',
      '.rs',
      '.java',
      '.cs',
      '.php',
      '.rb',
      '.env',
      '.json',
      '.yaml',
      '.yml',
    ],
    falsePositiveMarkers: ['example', 'placeholder', 'dummy', 'test', 'mock', 'fake', 'sample'],
    remediation: 'Move secrets to environment variables or a secrets manager.',
    category: 'secrets',
    confidence: 'medium',
  };

  const stackSpecific: Partial<Record<TechStack, SecurityPattern[]>> = {
    nodejs: [
      {
        id: 'jwt-secret',
        name: 'Hardcoded JWT Secret',
        severity: 'high',
        description: 'Detects hardcoded secrets in JWT signing/verification',
        patterns: [
          /jwt\.sign\s*\([^,]+,\s*['"][^'"]+['"]/g,
          /jwt\.verify\s*\([^,]+,\s*['"][^'"]+['"]/g,
        ],
        fileExtensions: [...JS_EXTENSIONS],
        falsePositiveMarkers: ['process.env'],
        remediation: 'Use environment variables for JWT secret keys.',
        category: 'secrets',
        confidence: 'high',
      },
      {
        id: 'npmrc-credentials',
        name: 'npmrc Credentials',
        severity: 'high',
        description: 'Detects auth tokens in .npmrc files',
        patterns: [/:\/\/[^/]+\/:_authToken\s*=\s*[^\s]+/g],
        fileExtensions: ['.npmrc'],
        falsePositiveMarkers: ['${', '$AUTH_TOKEN'],
        remediation:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal .npmrc interpolation syntax shown to the user.
          'Use environment variable interpolation in .npmrc: //registry.npmjs.org/:_authToken=${NPM_TOKEN}',
        category: 'secrets',
        confidence: 'high',
      },
    ],
    python: [
      {
        id: 'python-secret-env',
        name: 'Hardcoded SECRET_KEY in Django/Flask',
        severity: 'critical',
        description: 'Detects hardcoded SECRET_KEY in Python web frameworks',
        patterns: [/SECRET_KEY\s*=\s*['"][^'"]{8,}['"]/g],
        fileExtensions: ['.py'],
        falsePositiveMarkers: ['os.environ', 'os.getenv', 'config('],
        remediation: 'Load SECRET_KEY from environment: os.environ.get("SECRET_KEY")',
        category: 'secrets',
        confidence: 'high',
      },
    ],
    rust: [
      {
        id: 'rust-env-secrets',
        name: 'Hardcoded Secrets in Rust',
        severity: 'critical',
        description: 'Detects hardcoded credentials in Rust source files',
        patterns: [/const\s+[A-Z_]*SECRET[A-Z_]*\s*:\s*&str\s*=\s*["'][^"']+["']/g],
        fileExtensions: ['.rs'],
        falsePositiveMarkers: ['std::env::var'],
        remediation: 'Use std::env::var to read secrets at runtime.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    go: [
      {
        id: 'go-hardcoded-secret',
        name: 'Hardcoded Secret in Go',
        severity: 'critical',
        description: 'Detects hardcoded secret constants in Go',
        patterns: [/const\s+[a-zA-Z_]*[sS]ecret[a-zA-Z_]*\s*=\s*["'][^"']+["']/g],
        fileExtensions: ['.go'],
        falsePositiveMarkers: ['os.Getenv'],
        remediation: 'Use os.Getenv to read secrets at runtime.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    java: [
      {
        id: 'java-system-getenv',
        name: 'Hardcoded Secrets in Java',
        severity: 'critical',
        description: 'Detects hardcoded secret fields in Java classes',
        patterns: [
          /(?:private|public|protected)\s+(?:static\s+)?(?:final\s+)?String\s+[A-Z_]*SECRET[A-Z_]*\s*=\s*["'][^"']+["']/g,
        ],
        fileExtensions: ['.java'],
        falsePositiveMarkers: ['System.getenv', 'System.getProperty'],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Spring placeholder syntax shown to the user.
        remediation: 'Use System.getenv() or Spring @Value("${...}") for secrets.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
    dotnet: [
      {
        id: 'dotnet-config-secrets',
        name: 'Hardcoded Secrets in .NET',
        severity: 'critical',
        description: 'Detects hardcoded secret constants in C#',
        patterns: [
          /(?:const|readonly)\s+string\s+[A-Za-z_]*[sS]ecret[A-Za-z_]*\s*=\s*["'][^"']+["']/g,
        ],
        fileExtensions: ['.cs'],
        falsePositiveMarkers: ['Configuration[', 'Environment.GetEnvironmentVariable'],
        remediation: 'Use IConfiguration or user secrets in .NET.',
        category: 'secrets',
        confidence: 'medium',
      },
    ],
  };

  return [commonSecrets, ...(stackSpecific[stack] ?? [])].map((pattern) => ({
    ...pattern,
    category: 'secrets',
    confidence: pattern.confidence,
  }));
}

export function getInjectionPatterns(stack: TechStack): SecurityPattern[] {
  const commonInjection: SecurityPattern = {
    id: 'command-injection',
    name: 'Command Injection',
    severity: 'critical',
    description: 'Detects execution of system commands with concatenated user input',
    patterns: [
      /exec\s*\([^)]*\+/g,
      /execSync\s*\([^)]*\+/g,
      /spawn\s*\([^,]+,\s*\{[^}]*shell:\s*true/g,
      /system\s*\([^)]*\+/g,
      /popen\s*\([^)]*\+/g,
    ],
    fileExtensions: [...JS_EXTENSIONS, '.php', '.py', '.rb'],
    falsePositiveMarkers: ['escapeshellarg', 'escapeshellcmd', 'sanitize'],
    remediation: 'Use parameterized commands with argument arrays instead of string interpolation.',
    category: 'injection',
    confidence: 'medium',
  };

  const stackSpecific: Partial<Record<TechStack, SecurityPattern[]>> = {
    nodejs: [
      {
        id: 'eval-user-input',
        name: 'Eval with User Input',
        severity: 'critical',
        description: 'Detects eval() or Function() constructor with variables',
        patterns: [/eval\s*\([^'"][^)]*\)/g, /new\s+Function\s*\([^'"][^)]*\)/g],
        fileExtensions: [...JS_EXTENSIONS],
        falsePositiveMarkers: ['JSON.parse'],
        remediation: 'Never eval user input. Use JSON.parse for data, or proper sandboxing.',
        category: 'injection',
        confidence: 'high',
      },
      {
        id: 'sql-injection-template',
        name: 'SQL Injection via Template Literal',
        severity: 'critical',
        description: 'Detects SQL queries built with template literals containing expressions',
        patterns: [
          /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s+.*?\$\{/gi,
          /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g,
        ],
        fileExtensions: [...JS_EXTENSIONS],
        falsePositiveMarkers: ['sql`', 'Prisma.sql`'],
        remediation: 'Use parameterized queries: query("SELECT * FROM users WHERE id = $1", [id])',
        category: 'injection',
        confidence: 'high',
      },
      {
        id: 'nosql-injection',
        name: 'NoSQL Injection',
        severity: 'high',
        description: 'Detects NoSQL query injection via user input',
        patterns: [/find\s*\(\s*\{.*\$where/g, /collection\.(?:find|aggregate)\s*\([^)]*\$/g],
        fileExtensions: [...JS_EXTENSIONS],
        falsePositiveMarkers: [],
        remediation: 'Sanitize and validate all user input before NoSQL queries.',
        category: 'injection',
        confidence: 'medium',
      },
    ],
    python: [
      {
        id: 'python-sql-injection',
        name: 'Python SQL Injection',
        severity: 'critical',
        description: 'Detects SQL queries built with string formatting',
        patterns: [
          /execute\s*\(\s*f(?:"[^"\r\n]*\{[^}]+\}|'[^'\r\n]*\{[^}]+\})/g,
          /execute\s*\(\s*(?:"[^"\r\n]*"|'[^'\r\n]*')\s*%/g,
          /cursor\.execute\s*\([^)]*\+[^)]*\)/g,
        ],
        fileExtensions: ['.py'],
        falsePositiveMarkers: ['parameterized'],
        remediation: 'Use parameterized queries with cursor.execute(query, params).',
        category: 'injection',
        confidence: 'high',
      },
      {
        id: 'pickle-deserialization',
        name: 'Pickle Deserialization',
        severity: 'critical',
        description: 'Detects insecure pickle deserialization',
        patterns: [/pickle\.load\s*\(/g, /pickle\.loads\s*\(/g, /unpickle\.load\s*\(/g],
        fileExtensions: ['.py'],
        falsePositiveMarkers: [],
        remediation:
          'Never unpickle data from untrusted sources. Use JSON or custom serialization.',
        category: 'injection',
        confidence: 'high',
      },
    ],
    go: [
      {
        id: 'go-sql-injection',
        name: 'Go SQL Injection',
        severity: 'critical',
        description: 'Detects SQL queries with string concatenation',
        patterns: [/db\.Query\s*\([^)]*\+[^)]*\)/g, /QueryContext?\s*\([^)]*\+[^)]*\)/g],
        fileExtensions: ['.go'],
        falsePositiveMarkers: ['$1', '$2', '?', 'params'],
        remediation:
          'Use parameterized queries: db.QueryContext(ctx, "SELECT * FROM users WHERE id=?", userID)',
        category: 'injection',
        confidence: 'high',
      },
    ],
    java: [
      {
        id: 'java-sql-injection',
        name: 'Java SQL Injection',
        severity: 'critical',
        description: 'Detects SQL with string concatenation in JDBC',
        patterns: [
          /createStatement\s*\(\s*\).*\.executeQuery\s*\([^)]*\+/g,
          /Statement\s*\([^)]*\+/g,
        ],
        fileExtensions: ['.java'],
        falsePositiveMarkers: ['PreparedStatement', '?'],
        remediation: 'Use PreparedStatement with parameters.',
        category: 'injection',
        confidence: 'high',
      },
    ],
    rust: [
      {
        id: 'rust-command-injection',
        name: 'Rust Command Injection',
        severity: 'critical',
        description: 'Detects Command::new with string interpolation',
        patterns: [/Command::new\s*\([^)]*\)\s*\.(?:arg|args)\s*\([^)]*\+/g, /Command::from\s*\(/g],
        fileExtensions: ['.rs'],
        // Was ['Command::new', 'args\\(']. Markers are plain substring checks on
        // the matched line, and the first pattern REQUIRES `Command::new(` — so
        // every match was suppressed by its own marker and the detector could
        // never fire on the case it exists for. `'args\\('` is the literal text
        // `args\(` and never matched anything. The regex already requires `+`
        // inside `.arg(`/`.args(`, so the safe `.args(&[...])` form is not matched.
        falsePositiveMarkers: [],
        remediation: 'Use Command::new(array).args(&[...]) to avoid shell injection.',
        category: 'injection',
        confidence: 'high',
      },
    ],
    dotnet: [
      {
        id: 'csharp-sql-injection',
        name: 'C# SQL Injection',
        severity: 'critical',
        description: 'Detects SQL with string concatenation in C#',
        patterns: [/SqlCommand\s*\([^)]*\+[^)]*\)/g, /\.ExecuteQuery\s*\([^)]*\+[^)]*\)/g],
        fileExtensions: ['.cs'],
        // No bare '@' marker: it was meant for `@id` parameters, but both patterns
        // already require `+`, so '@' could only ever suppress REAL concatenations
        // — C# verbatim strings (`@"SELECT ..." + id`, the usual way to write SQL)
        // and lines mixing a parameter with a concatenated value.
        falsePositiveMarkers: ['parameters.Add', 'SqlParameter'],
        remediation: 'Use parameterized queries with SqlParameter.',
        category: 'injection',
        confidence: 'high',
      },
    ],
  };

  return [commonInjection, ...(stackSpecific[stack] ?? [])].map((pattern) => ({
    ...pattern,
    category: 'injection',
    confidence: pattern.confidence,
  }));
}

export function getConfigPatterns(_stack: TechStack): SecurityPattern[] {
  const commonConfig: SecurityPattern[] = [
    {
      id: 'insecure-tls',
      name: 'Insecure TLS Configuration',
      severity: 'high',
      description: 'Detects disabled TLS verification or weak TLS settings',
      patterns: [
        /rejectUnauthorized\s*[:=]\s*false/g,
        /secure\s*[:=]\s*false/g,
        /ssl\s*[:=]\s*false/g,
        /TLS\s*\[\s*['"]?1\.0['"]?\]/gi,
        /InsecureRequestWarning\.disable/g,
      ],
      fileExtensions: [...JS_EXTENSIONS, '.py', '.go', '.java'],
      falsePositiveMarkers: ['NODE_TLS_REJECT_UNAUTHORIZED'],
      remediation: 'Always verify TLS certificates in production. Use proper certificate stores.',
      category: 'config',
      confidence: 'medium',
    },
    {
      id: 'debug-enabled',
      name: 'Debug Mode Enabled',
      severity: 'medium',
      description: 'Detects debug flags that may expose sensitive information',
      patterns: [/debug\s*[:=]\s*true/g, /DEBUG\s*[:=]\s*true/g, /development\s*mode/g],
      fileExtensions: [...JS_EXTENSIONS, '.py', '.env', '.json'],
      falsePositiveMarkers: ['process.env.NODE_ENV !== "production"', 'if (process.env.DEBUG)'],
      remediation: 'Disable debug mode in production. Use proper log levels.',
      category: 'config',
      confidence: 'low',
    },
  ];

  return commonConfig;
}
