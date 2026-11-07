import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { inheritedEnv, javaToolchainProblem, registryJavaHome } from '../src/child-env.js';
import { execCommand } from '../src/exec-command.js';

const saved = {
  NODE_ENV: process.env['NODE_ENV'],
  WRONGSTACK_NODE_ENV_DEFAULTED: process.env['WRONGSTACK_NODE_ENV_DEFAULTED'],
  SystemDrive: process.env['SystemDrive'],
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('inheritedEnv', () => {
  it('drops the NODE_ENV the CLI injected so npm installs devDependencies', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['WRONGSTACK_NODE_ENV_DEFAULTED'] = '1';
    const env = inheritedEnv();
    expect(env['NODE_ENV']).toBeUndefined();
    expect(env['WRONGSTACK_NODE_ENV_DEFAULTED']).toBeUndefined();
    // The live process keeps it; only children lose it.
    expect(process.env['NODE_ENV']).toBe('production');
  });

  it('keeps a NODE_ENV the operator exported themselves', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['WRONGSTACK_NODE_ENV_DEFAULTED'];
    expect(inheritedEnv()['NODE_ENV']).toBe('test');
  });

  it('turns the Gradle daemon off without dropping the operator GRADLE_OPTS', () => {
    const before = process.env['GRADLE_OPTS'];
    try {
      delete process.env['GRADLE_OPTS'];
      expect(inheritedEnv()['GRADLE_OPTS']).toBe('-Dorg.gradle.daemon=false');
      process.env['GRADLE_OPTS'] = '-Xmx1g';
      expect(inheritedEnv()['GRADLE_OPTS']).toBe('-Xmx1g -Dorg.gradle.daemon=false');
      process.env['GRADLE_OPTS'] = '-Dorg.gradle.daemon=true';
      expect(inheritedEnv()['GRADLE_OPTS']).toBe('-Dorg.gradle.daemon=true');
    } finally {
      if (before === undefined) delete process.env['GRADLE_OPTS'];
      else process.env['GRADLE_OPTS'] = before;
    }
  });

  it.runIf(process.platform === 'win32')(
    'reads JAVA_HOME from the registry, user before machine, expanding variables',
    () => {
      // Environment expansion is the contract; the test must supply its variable.
      process.env['SystemDrive'] = 'C:';
      const seen: string[] = [];
      const found = registryJavaHome((key) => {
        seen.push(key);
        return key.startsWith('HKCU') ? undefined : '%SystemDrive%\\jdk-21\\';
      });
      expect(seen[0]).toBe('HKCU\\Environment');
      expect(found).toBe(`${process.env['SystemDrive']}\\jdk-21\\`);
      expect(registryJavaHome(() => undefined)).toBeNull();
    },
  );

  it('reaches grader commands', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['WRONGSTACK_NODE_ENV_DEFAULTED'] = '1';
    const result = await execCommand({
      command: process.execPath,
      args: ['-e', "process.stdout.write(String(process.env.NODE_ENV ?? 'unset'))"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      shell: false,
    });
    expect(result.stdout).toBe('unset');
  });
});

describe('javaToolchainProblem', () => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-jdk-'));
  const jdk = path.join(root, 'jdk');
  const jre = path.join(root, 'jre');
  for (const [home, tools] of [
    [jdk, ['java', 'javac']],
    [jre, ['java']],
  ] as const) {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    for (const tool of tools) fs.writeFileSync(path.join(home, 'bin', `${tool}${exe}`), '');
  }

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts a JDK and rejects a JRE in JAVA_HOME', () => {
    expect(javaToolchainProblem({ JAVA_HOME: jdk })).toBeUndefined();
    expect(javaToolchainProblem({ JAVA_HOME: jre })).toMatch(/is not a JDK/);
  });

  it('without JAVA_HOME, judges the first java on PATH the way gradlew picks it', () => {
    const PATH = (dirs: string[]) => dirs.map((d) => path.join(d, 'bin')).join(path.delimiter);
    expect(javaToolchainProblem({ PATH: PATH([jre, jdk]) })).toMatch(/JRE without javac/);
    expect(javaToolchainProblem({ PATH: PATH([jdk, jre]) })).toBeUndefined();
    expect(javaToolchainProblem({ PATH: root })).toMatch(/no Java found/);
  });
});
