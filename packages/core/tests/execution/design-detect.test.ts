import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  activateDesign,
  clearActiveKit,
  detectFrontendFile,
  detectFrontendIntent,
  getDesignState,
  makeDesignDetectToolCallMiddleware,
  makeDesignDetectUserInputMiddleware,
  makeDesignStudioRequestMiddleware,
  makeDesignVerifyToolCallMiddleware,
  setActiveKit,
} from '../../src/execution/design-detect.js';
import { saveCapturedTokens } from '../../src/execution/design-project-store.js';
import type { DesignKitLoader } from '../../src/types/design-kit.js';
import type { Request } from '../../src/types/provider.js';

function fakeCtx(): { meta: Record<string, unknown> } {
  return { meta: {} };
}

const fakeLoader: DesignKitLoader = {
  list: async () => [],
  listEntries: async () => [],
  listSkipped: async () => [],
  find: async () => undefined,
  menuText: async () => '## Design kits (pick ONE)\n- **minimal-clarity** — calm',
  readBody: async () => '',
  readTokens: async () => undefined,
  foundationsText: async () => '',
  invalidateCache: () => {},
};

describe('detectFrontendIntent', () => {
  it('detects web UI intent and infers the web stack', () => {
    const hit = detectFrontendIntent('Build me a landing page with a hero section');
    expect(hit).not.toBeNull();
    expect(hit?.stack).toBe('web');
  });

  it('infers specific native stacks from keywords', () => {
    expect(detectFrontendIntent('make a flutter screen')?.stack).toBe('flutter');
    expect(detectFrontendIntent('an Expo react native app')?.stack).toBe('react-native');
    expect(detectFrontendIntent('a SwiftUI settings view')?.stack).toBe('swiftui');
    expect(detectFrontendIntent('a Jetpack Compose list')?.stack).toBe('compose');
  });

  it('returns null for non-UI prompts', () => {
    expect(detectFrontendIntent('fix the database migration script')).toBeNull();
    expect(detectFrontendIntent('refactor the retry policy')).toBeNull();
  });
});

describe('detectFrontendFile', () => {
  it('flags frontend file extensions and infers stack', () => {
    expect(detectFrontendFile('src/App.tsx')?.stack).toBe('web');
    expect(detectFrontendFile('styles/theme.css')?.stack).toBe('web');
    expect(detectFrontendFile('lib/home.dart')?.stack).toBe('flutter');
    expect(detectFrontendFile('Views/Home.swift')?.stack).toBe('swiftui');
  });

  it('ignores non-frontend files', () => {
    expect(detectFrontendFile('server/db.ts')).toBeNull();
    expect(detectFrontendFile('README.md')).toBeNull();
  });

  it('maps Kotlin files to the compose stack (and .kts is not a screen)', () => {
    expect(detectFrontendFile('app/src/main/java/com/example/MainActivity.kt')?.stack).toBe(
      'compose',
    );
    // Gradle Kotlin scripts are build config, not Compose UI.
    expect(detectFrontendFile('build.gradle.kts')).toBeNull();
  });
});

describe('detectFrontendFile — React Native project scoping', () => {
  it('scopes .tsx/.jsx writes to react-native when package.json depends on react-native', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-rn-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.76.0' } }),
      );
      expect(detectFrontendFile('src/App.tsx', root)?.stack).toBe('react-native');
      expect(detectFrontendFile('components/Button.jsx', root)?.stack).toBe('react-native');
      // Web-only extensions stay web even inside an RN project.
      expect(detectFrontendFile('styles/theme.css', root)?.stack).toBe('web');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('counts expo / nativewind in devDependencies as RN markers too', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-rn-expo-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ devDependencies: { expo: '~51.0.0' } }),
      );
      expect(detectFrontendFile('app/screen.tsx', root)?.stack).toBe('react-native');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps .tsx as web without an RN marker, and projectRoot stays optional', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-rn-web-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '^19.0.0', vite: '^6.0.0' } }),
      );
      expect(detectFrontendFile('src/App.tsx', root)?.stack).toBe('web');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    // No projectRoot → backward-compatible default.
    expect(detectFrontendFile('src/App.tsx')?.stack).toBe('web');
  });
});

describe('state helpers', () => {
  it('activate + setActiveKit + clearActiveKit mutate ctx.meta', () => {
    const ctx = fakeCtx();
    activateDesign(ctx, ['intent:ui'], 'web');
    let s = getDesignState(ctx);
    expect(s?.active).toBe(true);
    expect(s?.stack).toBe('web');

    setActiveKit(ctx, 'neo-brutalist', 'web');
    s = getDesignState(ctx);
    expect(s?.activeKit).toBe('neo-brutalist');

    clearActiveKit(ctx);
    expect(getDesignState(ctx)?.activeKit).toBeUndefined();
    expect(getDesignState(ctx)?.active).toBe(true); // detection survives
  });
});

describe('userInput middleware', () => {
  it('activates design state when the message has UI intent', async () => {
    const ctx = fakeCtx() as unknown as Context;
    const mw = makeDesignDetectUserInputMiddleware();
    await mw.handler({ text: 'design a dashboard UI', content: [], ctx }, async (p) => p);
    expect(getDesignState(ctx as unknown as { meta: Record<string, unknown> })?.active).toBe(true);
  });
});

describe('toolCall middleware', () => {
  it('activates when a frontend file is written', async () => {
    const ctx = fakeCtx() as unknown as Context;
    const mw = makeDesignDetectToolCallMiddleware();
    await mw.handler(
      {
        toolUse: { type: 'tool_use', id: 'x', name: 'write', input: { path: 'ui/Card.tsx' } },
        result: { type: 'tool_result', tool_use_id: 'x', content: [] },
        ctx,
      } as never,
      async (p) => p,
    );
    expect(getDesignState(ctx as unknown as { meta: Record<string, unknown> })?.active).toBe(true);
  });

  it('activates with the compose stack for a Kotlin write', async () => {
    const ctx = fakeCtx() as unknown as Context;
    const mw = makeDesignDetectToolCallMiddleware();
    await mw.handler(
      {
        toolUse: { type: 'tool_use', id: 'k', name: 'write', input: { path: 'ui/theme/Theme.kt' } },
        result: { type: 'tool_result', tool_use_id: 'k', content: [] },
        ctx,
      } as never,
      async (p) => p,
    );
    const s = getDesignState(ctx as unknown as { meta: Record<string, unknown> });
    expect(s?.active).toBe(true);
    expect(s?.stack).toBe('compose');
  });

  it('scopes a .tsx write to react-native in an RN project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-rn-mw-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ dependencies: { expo: '*' } }),
      );
      const ctx = { meta: {}, projectRoot: root } as unknown as Context;
      const mw = makeDesignDetectToolCallMiddleware();
      await mw.handler(
        {
          toolUse: {
            type: 'tool_use',
            id: 'x',
            name: 'write',
            input: { path: 'screens/Home.tsx' },
          },
          result: { type: 'tool_result', tool_use_id: 'x', content: [] },
          ctx,
        } as never,
        async (p) => p,
      );
      const s = getDesignState(ctx as unknown as { meta: Record<string, unknown> });
      expect(s?.active).toBe(true);
      expect(s?.stack).toBe('react-native');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('write-time verify middleware — captured tokens', () => {
  it('checks drift against the project\u2019s captured tokens when no kit is pinned', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-cap-mw-'));
    try {
      await saveCapturedTokens(root, {
        stack: 'web',
        files: ['src/index.css'],
        tokens: { light: { primary: '#ff0000' }, dark: { primary: '#ff0000' } },
      });
      await fs.writeFile(path.join(root, 'app.css'), '.x { color: #123123; }\n');
      const ctx = { meta: {}, projectRoot: root } as unknown as Context;
      const mw = makeDesignVerifyToolCallMiddleware();
      const out = (await mw.handler(
        {
          toolUse: { type: 'tool_use', id: 'w', name: 'write', input: { path: 'app.css' } },
          result: { type: 'tool_result', tool_use_id: 'w', content: '' },
          ctx,
        } as never,
        async (p) => p,
      )) as { result: { content: string } };
      expect(out.result.content).toContain('captured project tokens');
      expect(out.result.content).toContain('#123123');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('still notices once — naming capture — when neither kit nor capture exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-cap-mw2-'));
    try {
      await fs.writeFile(path.join(root, 'app.css'), '.x { color: #123123; }\n');
      const ctx = { meta: {}, projectRoot: root } as unknown as Context;
      const mw = makeDesignVerifyToolCallMiddleware();
      const payload = {
        toolUse: { type: 'tool_use', id: 'w', name: 'write', input: { path: 'app.css' } },
        result: { type: 'tool_result', tool_use_id: 'w', content: '' },
        ctx,
      } as never;
      const first = (await mw.handler(payload, async (p) => p)) as {
        result: { content: string };
      };
      expect(first.result.content).toContain('NOT being design-checked');
      expect(first.result.content).toContain('capture');
      // Once per session — a second write stays silent instead of nagging.
      const second = (await mw.handler(
        {
          toolUse: { type: 'tool_use', id: 'w', name: 'write', input: { path: 'app.css' } },
          result: { type: 'tool_result', tool_use_id: 'w', content: '' },
          ctx,
        } as never,
        async (p) => p,
      )) as { result: { content: string } };
      expect(second.result.content).toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('request inject middleware', () => {
  function baseReq(): Request {
    return { model: 'm', system: [{ type: 'text', text: 'BASE' }], messages: [] } as Request;
  }

  it('is a no-op when Design Studio is inactive', async () => {
    const ctx = fakeCtx() as unknown as Context;
    const mw = makeDesignStudioRequestMiddleware({ ctx, loader: fakeLoader });
    const out = await mw.handler(baseReq(), async (r) => r);
    expect(out.system).toHaveLength(1);
    expect(out.system?.[0]?.text).toBe('BASE');
  });

  it('injects the kit menu when active without a chosen kit', async () => {
    const ctx = fakeCtx() as unknown as Context;
    activateDesign(ctx as unknown as { meta: Record<string, unknown> }, ['intent:ui'], 'web');
    const mw = makeDesignStudioRequestMiddleware({ ctx, loader: fakeLoader });
    const out = await mw.handler(baseReq(), async (r) => r);
    expect(out.system).toHaveLength(2);
    const injected = out.system?.[1]?.text ?? '';
    expect(injected).toMatch(/Design Studio/i);
    expect(injected).toContain('minimal-clarity');
    expect(injected).toMatch(/WCAG/);
    // Does not mutate the shared base array.
    expect(out.system?.[0]?.text).toBe('BASE');
  });

  it('shrinks to a one-line reminder once a kit is active', async () => {
    const ctx = fakeCtx() as unknown as Context;
    setActiveKit(ctx as unknown as { meta: Record<string, unknown> }, 'neo-brutalist', 'web');
    const mw = makeDesignStudioRequestMiddleware({ ctx, loader: fakeLoader });
    const out = await mw.handler(baseReq(), async (r) => r);
    const injected = out.system?.[1]?.text ?? '';
    expect(injected).toMatch(/Active design kit: neo-brutalist/);
  });

  it('respects the enabled() gate', async () => {
    const ctx = fakeCtx() as unknown as Context;
    activateDesign(ctx as unknown as { meta: Record<string, unknown> }, ['intent:ui'], 'web');
    const mw = makeDesignStudioRequestMiddleware({ ctx, loader: fakeLoader, enabled: () => false });
    const out = await mw.handler(baseReq(), async (r) => r);
    expect(out.system).toHaveLength(1);
  });

  it('carries the current project brief across requests and kit changes without mutating history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-brief-'));
    try {
      await fs.mkdir(path.join(root, '.design'));
      const brief = path.join(root, '.design', 'brief.md');
      await fs.writeFile(brief, 'Task: reconcile warehouse shortages.');
      const ctx = { projectRoot: root, meta: {} } as unknown as Context;
      activateDesign(ctx, ['intent:ui'], 'web');
      const mw = makeDesignStudioRequestMiddleware({ ctx, loader: fakeLoader });
      const req = baseReq();
      const first = await mw.handler(req, async (r) => r);
      expect(first.system?.[1]?.text).toContain('reconcile warehouse shortages');
      await fs.writeFile(brief, 'Task: compare shipment exceptions.');
      setActiveKit(ctx, 'neo-brutalist', 'web');
      const second = await mw.handler(req, async (r) => r);
      expect(second.system?.[1]?.text).toContain('compare shipment exceptions');
      expect(second.system?.[1]?.text).not.toContain('reconcile warehouse shortages');
      expect(first.system?.[1]?.text).toContain('reconcile warehouse shortages');
      expect(req.system).toHaveLength(1);
      await fs.rm(brief);
      const third = await mw.handler(req, async (r) => r);
      expect(third.system?.[1]?.text).not.toContain('compare shipment exceptions');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('bounds a large brief and directs the model to read the remainder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-brief-'));
    try {
      await fs.mkdir(path.join(root, '.design'));
      await fs.writeFile(
        path.join(root, '.design', 'brief.md'),
        `Audience: operators\n${'x'.repeat(20000)}END`,
      );
      const ctx = { projectRoot: root, meta: {} } as unknown as Context;
      setActiveKit(ctx, 'minimal-clarity', 'web');
      const mw = makeDesignStudioRequestMiddleware({ ctx, loader: fakeLoader });
      const out = await mw.handler(baseReq(), async (r) => r);
      const injected = out.system?.[1]?.text ?? '';
      expect(injected).toContain('Audience: operators');
      expect(injected).toContain('truncated');
      expect(injected).not.toContain('END');
      expect(injected.length).toBeLessThan(10000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
