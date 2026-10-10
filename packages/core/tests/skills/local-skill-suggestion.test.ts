import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createLocalSkillSuggestionSetup,
  recommendLocalSkills,
} from '../../src/skills/suggest/local.js';
import { LOCAL_SKILL_RULES } from '../../src/skills/suggest/local-rules.js';
import { isVolatileSystemBlock } from '../../src/types/blocks.js';
import type { Config } from '../../src/types/config/root.js';
import type { Request } from '../../src/types/provider.js';
import type { SkillLoader, SkillManifest } from '../../src/types/skill.js';

const catalog: SkillManifest[] = LOCAL_SKILL_RULES.map((rule) => ({
  name: rule.name,
  source: 'bundled',
  description: rule.name,
  path: `/bundle/${rule.name}/SKILL.md`,
  version: '1.0.0',
  audience: ['plugin-author', 'wrongstack-mailbox', 'wrongstack-mailbox-mcp'].includes(rule.name)
    ? 'roster'
    : undefined,
}));

describe('local bundled skill recommendations', () => {
  it('covers every current bundled id with a unique maintained rule', () => {
    const root = fileURLToPath(new URL('../../skills/', import.meta.url));
    const names = fs.readdirSync(root).filter((name) => fs.existsSync(`${root}/${name}/SKILL.md`));
    expect(LOCAL_SKILL_RULES.map((rule) => rule.name).sort()).toEqual(names.sort());
  });

  it.each([
    ['Build a Next.js App Router settings route', 'nextjs-modern'],
    ['Next.js16 ile uygulamayı kur', 'nextjs-modern'],
    ['Render a Remotion product intro clip', 'media-production'],
    ['Motion Canvas ile sıralama sahnesini canlandır', 'motion-canvas-video'],
    ['Manim kullanarak formülü canlandır', 'manim-video'],
    ['SSH bağlantısını kur ve host key doğrula', 'ssh-operations'],
    ['Configure Docker Compose service readiness', 'compose-operations'],
    ['Build a React Native app screen', 'react-native-expo'],
    ['Implement a PostgreSQL query index', 'database-development'],
    ['Write unit tests for the retry policy', 'testing'],
    ['Commit this for the next release', 'git-flow'],
    ['Build a C# minimal API', 'dotnet-backend'],
    ['Add spring transitions to this React interface with reduced motion', 'motion-design'],
    ['Implement a Spring Boot validation endpoint', 'java-spring'],
    ['Create generative art with p5.js', 'algorithmic-art'],
    ['Apply brand guidelines to this interface', 'brand-guidelines'],
    ['Design a poster for the launch', 'canvas-design'],
    ['Review critical assumptions in this plan', 'discernment-nudge'],
    ['Create a coauthored technical specification', 'doc-coauthoring'],
    ['Write a Word document', 'docx'],
    ['Write an internal communications update', 'internal-comms'],
    ['Implement an LLM runtime', 'llm-runtime'],
    ['Generate an animated GIF', 'micro-animation-gif'],
    ['Generate a PDF report', 'pdf'],
    ['Create a PowerPoint presentation deck', 'pptx'],
    ['Create a theme pack for this app', 'theme-factory'],
    ['Build an interactive HTML artifact', 'web-artifacts'],
    ['Test the browser E2E flow', 'webapp-testing'],
    ['Create an Excel spreadsheet', 'xlsx'],
  ])('routes %s to %s', (text, expected) => {
    expect(recommendLocalSkills(text, catalog, ['skill'])?.names[0]).toBe(expected);
  });

  it.each([
    'hello',
    'devam et',
    'What is Next.js?',
    'Write a birthday greeting',
    'Explain a monad',
    'Tell me a joke about Docker',
    '$nextjs-modern build this page',
  ])('stays silent for %s', (text) => {
    expect(recommendLocalSkills(text, catalog, ['skill'])).toBeUndefined();
  });

  it('uses the router for multiple domains and unknown implementation scope', () => {
    const result = recommendLocalSkills(
      'Build a Next.js page and render a Remotion demo',
      catalog,
      ['skill'],
    );
    expect(result).toMatchObject({ reason: 'multi-domain' });
    expect(result?.names).toEqual(['skill-router', 'media-production', 'nextjs-modern']);
    expect(
      recommendLocalSkills('Build a Zig parser in this repository', catalog, ['skill'])?.names,
    ).toEqual(['skill-router']);
  });

  it('does not recommend shadowed, hidden or tool-ineligible entries', () => {
    const entries = catalog.map((skill) =>
      skill.name === 'nextjs-modern' ? { ...skill, source: 'project' as const } : skill,
    );
    expect(
      recommendLocalSkills('Build a Next.js page', entries, ['skill'])?.names ?? [],
    ).not.toContain('nextjs-modern');
    expect(
      recommendLocalSkills('Create a WrongStack plugin hook', catalog, ['skill'])?.names ?? [],
    ).not.toContain('plugin-author');
    expect(recommendLocalSkills('Build a Next.js route', catalog, [])).toBeUndefined();
    const unavailable = [
      { ...catalog.find((skill) => skill.name === 'nextjs-modern')!, requiredTools: ['bash'] },
    ];
    expect(recommendLocalSkills('Build a Next.js route', unavailable, ['skill'])).toBeUndefined();
  });
  it('ignores technology names inside fenced examples', () => {
    expect(
      recommendLocalSkills('Build a Next.js route.\n```java\nSpring Boot server\n```', catalog, [
        'skill',
      ])?.names,
    ).toEqual(['nextjs-modern']);
  });
});

function harness(body = '# Instructions\nVerify the actual route before claiming done.') {
  const entries = [{ ...catalog.find((skill) => skill.name === 'nextjs-modern')! }];
  let tools = ['skill'];
  const readBody = vi.fn(async () => body);
  const loader = { list: async () => entries, readBody } as unknown as SkillLoader;
  const config = { features: { skills: true }, typesafe: { enabled: false } } as Config;
  const deps = { config, skillLoader: loader, getAvailableToolNames: () => tools };
  const request: Request = {
    model: 'm',
    messages: [{ role: 'user', content: 'Build a Next.js route' }],
    system: [{ type: 'text', text: 'Stable prefix' }],
  };
  return {
    entries,
    request,
    readBody,
    deps,
    setTools: (next: string[]) => {
      tools = next;
    },
  };
}

async function capture(h: ReturnType<typeof harness>) {
  let result: Request | undefined;
  await createLocalSkillSuggestionSetup(h.deps)!.handler(h.request, async (request) => {
    result = request;
    return { content: [], stopReason: 'end_turn' } as never;
  });
  return result!;
}

describe('automatic local skill prompt injection', () => {
  it('preloads actual instructions without search, a TypeSafe account or a network call', async () => {
    const h = harness(
      '---\nname: nextjs-modern\n---\n# Local instructions\nVerify cache isolation.',
    );
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    const seen = await capture(h);
    expect(seen.system?.[0]).toBe(h.request.system?.[0]);
    expect(seen.system?.[1]?.text).toContain('Primary instructions (nextjs-modern)');
    expect(seen.system?.[1]?.text).toContain('Verify cache isolation.');
    expect(seen.system?.[1]?.text).not.toContain('name: nextjs-modern');
    expect(isVolatileSystemBlock(seen.system![1]!)).toBe(true);
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });

  it('does not represent oversized or unreadable bodies as fully loaded', async () => {
    const h = harness('SECRET_TAIL'.repeat(2000));
    expect((await capture(h)).system?.[1]?.text).toContain('not included in full');
    expect((await capture(h)).system?.[1]?.text).not.toContain('SECRET_TAIL');
    h.readBody.mockRejectedValueOnce(new Error('unreadable'));
    expect((await capture(h)).system?.[1]?.text).toContain('load nextjs-modern');
  });

  it.each(['version', 'source', 'tools', 'message'])(
    'rejects a %s change while reading the body',
    async (kind) => {
      const h = harness();
      h.readBody.mockImplementationOnce(async () => {
        if (kind === 'version') h.entries[0]!.version = '2.0.0';
        if (kind === 'source') h.entries[0]!.source = 'project';
        if (kind === 'tools') h.setTools([]);
        if (kind === 'message') h.request.messages[0]!.content = 'Actually, explain a monad';
        return '# Stale instructions';
      });
      expect(await capture(h)).toBe(h.request);
    },
  );

  it('respects feature switches, explicit selections and completed remote advice', async () => {
    const h = harness();
    expect(
      createLocalSkillSuggestionSetup({
        ...h.deps,
        config: { ...h.deps.config, skills: { localSuggest: false } },
      }),
    ).toBeUndefined();
    expect(
      createLocalSkillSuggestionSetup({
        ...h.deps,
        config: { ...h.deps.config, features: { ...h.deps.config.features, skills: false } },
      }),
    ).toBeUndefined();
    h.request.messages[0]!.content = '$nextjs-modern build this route';
    expect(await capture(h)).toBe(h.request);
    h.request.messages[0]!.content = 'Build a Next.js route';
    h.request.system!.push({
      type: 'text',
      text: '<skill_relevance>\nUse another skill.\n</skill_relevance>',
    });
    expect(await capture(h)).toBe(h.request);
    expect(h.readBody).not.toHaveBeenCalled();
  });

  it('replaces its own prior advice on retries and removes it for a non-task message', async () => {
    const h = harness();
    h.request.system = (await capture(h)).system;
    const retry = await capture(h);
    expect(retry.system).toHaveLength(2);
    h.request.system = retry.system;
    h.request.messages[0]!.content = 'hello';
    const nextTurn = await capture(h);
    expect(nextTurn.system).toHaveLength(1);
    expect(nextTurn.system?.[0]?.text).toBe('Stable prefix');
  });

  it('keeps its advice through a tool-loop iteration ending in a tool_result', async () => {
    // A tool-loop iteration ends with a user message carrying only tool_result
    // blocks. The latest user TEXT is still the turn's request, so the advice
    // must not be stripped as if the user had said nothing.
    const h = harness();
    h.request.system = (await capture(h)).system;
    h.request.messages.push({ role: 'assistant', content: 'running the tool' }, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    } as never);
    const afterTool = await capture(h);
    expect(afterTool.system).toHaveLength(2);
    expect(afterTool.system?.[1]?.text).toContain('Primary instructions (nextjs-modern)');
  });

  it('propagates a downstream/provider error exactly once', async () => {
    const h = harness();
    h.request.messages[0]!.content = 'hello';
    const next = vi.fn(async () => {
      throw new Error('provider failed');
    });
    await expect(createLocalSkillSuggestionSetup(h.deps)!.handler(h.request, next)).rejects.toThrow(
      'provider failed',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
