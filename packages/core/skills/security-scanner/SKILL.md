---
name: security-scanner
description: |
  Use this skill when scanning code or configuration for security vulnerabilities
  in WrongStack. Triggers: user says "security", "vulnerability", "CVE", "secret",
  "injection", "XSS", "SQL injection", "audit security", "supply chain".
version: 1.2.0
---

# Security Scanner — WrongStack

## Overview

Scans code, configs, and dependencies for security issues. Reports with severity (CRITICAL/HIGH/MEDIUM/LOW) and concrete remediation steps. Pairs with `npm audit` for supply chain scanning.

## Rules

1. Always provide remediation — "found X" without "do Y" is useless.
2. Verify regex matches before flagging — generic patterns cause false positives.
3. Don't scan `node_modules` — use `npm audit` for supply chain issues.
4. Don't flag test fixtures — mock credentials in tests are acceptable.
5. Always run dependency audit — supply chain is a real attack vector.
6. Flag config issues (TLS disabled, HTTP in production) as CRITICAL.
7. Never echo a full secret into the report — redact it (short prefix + char count, e.g. `ghp_…36 chars`). Cite `file:line` you have read; don't flag from a pattern guess.

## Patterns

### Do

```typescript
// ✅ SAFE — parameterized query
db.query("SELECT * FROM users WHERE id = $1", [userId]);

// ✅ SAFE — escape user input
element.textContent = userInput;

// ✅ SAFE — execFile with args array
execFile('find', ['.', '-name', userInput], { signal: AbortSignal.timeout(5000) });
```

### Don't

```typescript
// ❌ CRITICAL — hardcoded AWS credentials
const awsKey = "[REDACTED:aws_access_key]";

// ❌ CRITICAL — private key committed
const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...";

// ❌ HIGH — XSS via innerHTML
element.innerHTML = userInput;

// ❌ HIGH — shell injection
exec(`find . -name ${userInput}`);

// ❌ HIGH — SQL injection
const query = "SELECT * FROM users WHERE id = " + userId;
```

## Workflow

```
1. Scope:  Accept paths or use sensible defaults
2. Secrets:  Regex scan for credential patterns
3. Injection:  Pattern match dangerous constructs
4. Config:  Check TLS, crypto, auth configurations
5. Audit:  Run package audit
6. Report:  Prioritized markdown with remediation
```

## Severity levels

| Level | Meaning | Action |
|-------|---------|--------|
| **CRITICAL** | Active exploit possible | Fix immediately |
| **HIGH** | Vulnerability likely exploitable | Fix before release |
| **MEDIUM** | Risk exists but harder to exploit | Fix soon |
| **LOW** | Best practice violation | Consider fixing |

## Secret patterns

```
| Pattern | Example | Level |
|---------|---------|-------|
| GitHub token | `ghp_[a-zA-Z0-9]{36}` | CRITICAL |
| AWS Access Key | `[A-Z0-9]{20}` | CRITICAL |
| AWS Secret | base64 40-char | CRITICAL |
| Private Key PEM | `-----BEGIN.*PRIVATE KEY-----` | CRITICAL |
| JWT | `eyJ[a-zA-Z0-9_-]+` | HIGH |
| Generic API Key | 32+ random chars | MEDIUM |
| Bearer token | `Authorization: Bearer xxx` | HIGH |
```

## Real examples

```typescript
// ❌ CRITICAL — hardcoded AWS credentials
const awsKey = "[REDACTED:aws_access_key]";

// ❌ CRITICAL — private key committed
const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...";

// ❌ HIGH — JWT in code
const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";

// ❌ HIGH — XSS via innerHTML
element.innerHTML = userInput;

// ❌ HIGH — shell injection
exec(`find . -name ${userInput}`);

// ❌ HIGH — SQL injection
const query = "SELECT * FROM users WHERE id = " + userId;

// ✅ SAFE — parameterized query
db.query("SELECT * FROM users WHERE id = $1", [userId]);

// ✅ SAFE — escape user input
element.textContent = userInput;
```

## Injection vectors

| Construct | Safe alternative |
|-----------|-------------------|
| `eval(str)` | `new Function()` or parse then evaluate |
| `innerHTML = x` | `textContent` or DOMPurify.sanitize |
| `exec(\`cmd ${input}\`)` | `execFile` with args array |
| `SQL = "SELECT * FROM " + table` | parameterized query |
| `fs.readFile(path + userInput)` | `path.resolve` + allowlist |

## Configuration checks

```
- TLS verification disabled? → CRITICAL for production
- HTTP instead of HTTPS? → MEDIUM for production
- Secrets in env vars logged to console? → CRITICAL
- Hardcoded credentials in config? → CRITICAL
- Overly permissive CORS? → MEDIUM
- Missing rate limiting? → MEDIUM-HIGH
```

## Anti-patterns

- **Don't scan `node_modules`** — use `npm audit` instead
- **Don't report without remediation** — "found X" is useless without "do Y"
- **Don't ignore false positives** — verify regex matches before flagging (especially generic patterns)
- **Don't skip dependency scanning** — supply chain is a real attack vector
- **Don't flag test fixtures** — mock credentials in tests are ok, but not in production code

## Remediation template

```
## Remediation Checklist
- [ ] Remove hardcoded credentials from `src/config.ts`
- [ ] Move secrets to environment variables, add to .gitignore
- [ ] Use parameterized queries in `src/db/` files
- [ ] Add rate limiting to `src/api/` routes

<nextsteps>
1. Fix the hardcoded API key in src/config.ts
2. Fix the shell injection in src/auth/login.ts
3. Fix the missing rate limiting in src/api/routes.ts
</nextsteps>
```

## Skills in scope

- `bug-hunter` — for general code quality bugs found during security scan
- `audit-log` — for dependency version audit trails
- `git-flow` — for committing security patches properly
- `output-standards` — for standardized `<nextsteps>` formatting
