import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsm = vi.hoisted(() => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock('node:fs', async (o) => ({
  ...(await o()),
  readFileSync: fsm.readFileSync,
  writeFileSync: fsm.writeFileSync,
}));

import templatePlugin from '../src/template-engine';

interface Tool {
  name: string;
  execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

let metrics: { gauge: ReturnType<typeof vi.fn> };
let promptContributor: (() => Promise<Array<{ type: string; text: string }>>) | undefined;

function setup(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  metrics = { gauge: vi.fn() };
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: {} },
    log: { info: vi.fn() },
    metrics,
    registerSystemPromptContributor: (fn: () => Promise<Array<{ type: string; text: string }>>) => {
      promptContributor = fn;
    },
  };
  templatePlugin.setup(api as never);
  return tools;
}

beforeEach(() => {
  fsm.readFileSync.mockReset();
  fsm.writeFileSync.mockReset();
  promptContributor = undefined;
});

describe('template_expand', () => {
  it('validates template and variables', async () => {
    const tools = setup();
    expect((await tools.template_expand!.execute({ variables: {} })).error).toMatch(
      /template is required/,
    );
    expect(
      (await tools.template_expand!.execute({ template: 'x', variables: 'no' })).error,
    ).toMatch(/variables is required/);
  });

  it('substitutes variables and leaves unresolved placeholders', async () => {
    const tools = setup();
    const res = await tools.template_expand!.execute({
      template: 'Hi {{name}}, {{missing}}',
      variables: { name: 'Bob' },
    });
    expect(res.result).toBe('Hi Bob, {{missing}}');
    expect(res.variableCount).toBe(1);
  });

  it('expands conditionals on truthy and falsy values', async () => {
    const tools = setup();
    const t =
      '{{#if on}}YES{{/if}}{{#if off}}NO{{/if}}{{#if blank}}B{{/if}}{{#if zero}}Z{{/if}}{{#if no}}N{{/if}}';
    const res = await tools.template_expand!.execute({
      template: t,
      variables: { on: 'x', off: 'false', blank: '', zero: '0', no: 'false' },
    });
    expect(res.result).toBe('YES');
  });

  it('expands a comma-list loop and a single-value loop', async () => {
    const tools = setup();
    const listRes = await tools.template_expand!.execute({
      template: '{{#each items}}- {{items}}{{/each}}',
      variables: { items: 'a,b,c' },
      raw: true,
    });
    expect(listRes.result).toBe('- a\n- b\n- c');

    const singleRes = await tools.template_expand!.execute({
      template: '{{#each items}}[{{items}}]{{/each}}',
      variables: { items: 'solo' },
      raw: true,
    });
    expect(singleRes.result).toBe('[solo]');

    const emptyRes = await tools.template_expand!.execute({
      template: 'before{{#each items}}x{{/each}}after',
      variables: { items: '' },
      raw: true,
    });
    expect(emptyRes.result).toBe('beforeafter');
  });

  it('HTML-escapes by default and leaves raw output untouched', async () => {
    const tools = setup();
    const escaped = await tools.template_expand!.execute({
      template: '{{v}}',
      variables: { v: '<a href="x">&' },
    });
    expect(escaped.result).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
    const raw = await tools.template_expand!.execute({
      template: '{{v}}',
      variables: { v: '<a>&' },
      raw: true,
    });
    expect(raw.result).toBe('<a>&');
  });

  it('writes to a relative output_path', async () => {
    const tools = setup();
    const res = await tools.template_expand!.execute({
      template: 'hi {{n}}',
      variables: { n: 'x' },
      output_path: 'out/result.txt',
    });
    expect(res.ok).toBe(true);
    expect(res.output_path).toBe('out/result.txt');
    expect(fsm.writeFileSync).toHaveBeenCalledWith('out/result.txt', 'hi x', 'utf-8');
  });

  it('rejects absolute or traversing output paths', async () => {
    const tools = setup();
    expect(
      (
        await tools.template_expand!.execute({
          template: 'x',
          variables: {},
          output_path: '/etc/passwd',
        })
      ).error,
    ).toMatch(/relative path/);
    expect(
      (
        await tools.template_expand!.execute({
          template: 'x',
          variables: {},
          output_path: '../escape',
        })
      ).error,
    ).toMatch(/relative path/);
  });
});

describe('template_render', () => {
  it('validates template_path and variables', async () => {
    const tools = setup();
    expect((await tools.template_render!.execute({ variables: {} })).error).toMatch(
      /template_path is required/,
    );
    expect(
      (await tools.template_render!.execute({ template_path: 'a', variables: 5 })).error,
    ).toMatch(/variables is required/);
  });

  it('reads, renders and returns the result', async () => {
    fsm.readFileSync.mockReturnValue('Hello {{who}}');
    const tools = setup();
    const res = await tools.template_render!.execute({
      template_path: 't.tmpl',
      variables: { who: 'World' },
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe('Hello World');
  });

  it('errors when the template file cannot be read', async () => {
    fsm.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const tools = setup();
    const res = await tools.template_render!.execute({ template_path: 'missing', variables: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Could not read template file/);
  });

  it('rejects absolute or traversing template paths before reading', async () => {
    const tools = setup();
    expect(
      (await tools.template_render!.execute({ template_path: '/etc/passwd', variables: {} })).error,
    ).toMatch(/relative path/);
    expect(
      (await tools.template_render!.execute({ template_path: '../secret.tmpl', variables: {} }))
        .error,
    ).toMatch(/relative path/);
    expect(fsm.readFileSync).not.toHaveBeenCalled();
  });

  it('writes the rendered output to a relative path', async () => {
    fsm.readFileSync.mockReturnValue('raw {{v}}');
    const tools = setup();
    const res = await tools.template_render!.execute({
      template_path: 't',
      variables: { v: 'x' },
      output_path: 'r.txt',
      raw: true,
    });
    expect(res.ok).toBe(true);
    expect(fsm.writeFileSync).toHaveBeenCalledWith('r.txt', 'raw x', 'utf-8');
  });

  it('rejects a traversing output path on render', async () => {
    fsm.readFileSync.mockReturnValue('x');
    const tools = setup();
    const res = await tools.template_render!.execute({
      template_path: 't',
      variables: {},
      output_path: '../x',
    });
    expect(res.error).toMatch(/relative path/);
  });
});

describe('template_create / template_list', () => {
  it('validates name and content', async () => {
    const tools = setup();
    expect((await tools.template_create!.execute({ content: 'x' })).error).toMatch(
      /name is required/,
    );
    expect((await tools.template_create!.execute({ name: 'n', content: 5 })).error).toMatch(
      /content is required/,
    );
  });

  it('creates then updates a template, and lists it', async () => {
    const tools = setup();
    const created = await tools.template_create!.execute({
      name: 'greeting',
      content: 'hi {{n}}',
      description: 'a greeting',
    });
    expect(created.message).toMatch(/Created template/);
    expect(metrics.gauge).toHaveBeenCalledWith('template_count', 1);

    const updated = await tools.template_create!.execute({
      name: 'greeting',
      content: 'hello {{n}}',
    });
    expect(updated.message).toMatch(/Updated template/);
    expect(updated.createdAt).toBe(created.createdAt); // createdAt preserved on update

    const list = await tools.template_list!.execute({});
    expect(list.count).toBe(1);
    expect((list.templates as Array<{ name: string }>)[0]!.name).toBe('greeting');
  });

  it('lists nothing when the store is empty', async () => {
    const tools = setup();
    expect((await tools.template_list!.execute({})).count).toBe(0);
  });
});

describe('system prompt contributor', () => {
  it('contributes a text block describing the tools', async () => {
    setup();
    expect(promptContributor).toBeDefined();
    const blocks = await promptContributor!();
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toMatch(/template_expand/);
  });
});
