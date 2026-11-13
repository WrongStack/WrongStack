import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureProjectWiring,
  extractSourceWiring,
  renderKeptWiringReport,
  runKeptWiringCheck,
  verifyKeptWiring,
} from '../../src/execution/design-keep.js';

describe('design-keep — pre-redesign wiring snapshot & kept gate', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-keep-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('extracts routes, form fields, data-testids, and named handlers while ignoring comments', () => {
    const snap = extractSourceWiring([
      {
        path: 'src/Login.tsx',
        text: [
          '// <a href="/commented-out">Old</a>',
          'export function Login() {',
          '  return (',
          '    <form action="/api/login" onSubmit={handleLogin} data-testid="login-form">',
          '      <input name="email" type="email" />',
          '      <input name="password" type="password" />',
          '      <a href="/forgot-password">Forgot?</a>',
          '      <a href="#">Skip anchor</a>',
          '      <button type="button" onClick={openHelp}>Help</button>',
          '    </form>',
          '  );',
          '}',
        ].join('\n'),
      },
    ]);

    expect(snap.links).toEqual(['/forgot-password']);
    expect(snap.formFields).toEqual(['action:/api/login', 'email', 'password']);
    expect(snap.testIds).toEqual(['login-form']);
    expect(snap.handlers).toEqual(['handleLogin', 'openHelp']);
  });

  it('flags silently dropped wiring after a redesign unless explicitly waived via allowRemoved', () => {
    const before = extractSourceWiring([
      {
        path: 'src/Page.tsx',
        text: '<a href="/pricing">Pricing</a><input name="coupon" /><button onClick={applyCoupon} data-testid="apply-btn">Apply</button>',
      },
    ]);
    const after = extractSourceWiring([
      {
        path: 'src/Page.tsx',
        text: '<a href="/pricing">Plans</a><button onClick={applyCoupon}>Apply</button>',
      },
    ]);

    const report = verifyKeptWiring(before, after);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([
      { category: 'formField', value: 'coupon' },
      { category: 'testId', value: 'apply-btn' },
    ]);
    expect(renderKeptWiringReport(report)).toContain('Gate: FAIL');

    const waived = verifyKeptWiring(before, after, {
      allowRemoved: ['coupon', 'testId:apply-btn'],
    });
    expect(waived.ok).toBe(true);
    expect(waived.waived).toHaveLength(2);
    expect(renderKeptWiringReport(waived)).toContain('Gate: PASS');
  });

  it('round-trips .design/before.json via captureProjectWiring and runKeptWiringCheck', async () => {
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'src', 'Nav.tsx'),
      'export const Nav = () => <nav><a href="/docs">Docs</a><a href="/blog">Blog</a></nav>;\n',
    );
    const { relPath, snapshot } = await captureProjectWiring(tmp);
    expect(relPath).toBe('.design/before.json');
    expect(snapshot.links).toEqual(['/blog', '/docs']);

    await fs.writeFile(
      path.join(tmp, 'src', 'Nav.tsx'),
      'export const Nav = () => <nav><a href="/docs">Documentation</a></nav>;\n',
    );
    const failed = await runKeptWiringCheck(tmp);
    expect(failed.ok).toBe(false);
    expect(failed.missing).toEqual([{ category: 'link', value: '/blog' }]);
  });
});
