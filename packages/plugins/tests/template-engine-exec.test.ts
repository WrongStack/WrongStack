import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsm = vi.hoisted(() => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock('node:fs', async (o) => ({
  ...(await o()),
  readFileSync: fsm.readFileSync,
  writeFileSync: fsm.writeFileSync,
}));
vi.mock('node:fs/promises', async (o) => ({
  ...(await o()),
  readFile: vi.fn(async (p: string, encoding?: string) => fsm.readFileSync(p, encoding)),
  writeFile: vi.fn(async (p: string, data: string, encoding?: string) => {
    fsm.writeFileSync(p, data, encoding);
  }),
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
    await expect(tools.template_expand!.execute({ variables: {} })).rejects.toThrow(
      /template is required/,
    );
    await expect(
      tools.template_expand!.execute({ template: 'x', variables: 'no' }),
    ).rejects.toThrow(/variables is required/);
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

    // The documented block syntax binds the {{item}} iteration variable —
    // for a one-element list too, matching the comma-list branch.
    const singleItemRes = await tools.template_expand!.execute({
      template: '{{#each items}}- {{item}}{{/each}}',
      variables: { items: 'solo' },
      raw: true,
    });
    expect(singleItemRes.result).toBe('- solo');

    const listItemRes = await tools.template_expand!.execute({
      template: '{{#each items}}- {{item}}{{/each}}',
      variables: { items: 'a,b' },
      raw: true,
    });
    expect(listItemRes.result).toBe('- a\n- b');

    const emptyRes = await tools.template_expand!.execute({
      template: 'before{{#each items}}x{{/each}}after',
      variables: { items: '' },
      raw: true,
    });
    expect(emptyRes.result).toBe('beforeafter');
  });

  it('expands a newline-separated list loop once per line', async () => {
    const tools = setup();
    const lf = await tools.template_expand!.execute({
      template: '{{#each items}}- {{item}}{{/each}}',
      variables: { items: 'a\nb\nc' },
      raw: true,
    });
    expect(lf.result).toBe('- a\n- b\n- c');

    // The loop-variable reference style matches the comma branch.
    const refStyle = await tools.template_expand!.execute({
      template: '{{#each items}}- {{items}}{{/each}}',
      variables: { items: 'a\nb\nc' },
      raw: true,
    });
    expect(refStyle.result).toBe('- a\n- b\n- c');

    // CRLF endings and a trailing separator do not create a phantom item.
    const crlf = await tools.template_expand!.execute({
      template: '{{#each items}}- {{item}}{{/each}}',
      variables: { items: 'a\r\nb\r\nc\r\n' },
      raw: true,
    });
    expect(crlf.result).toBe('- a\n- b\n- c');

    // Blank lines are separators, not items: no iterations at all.
    const blanks = await tools.template_expand!.execute({
      template: 'before{{#each items}}x{{/each}}after',
      variables: { items: '\n\n' },
      raw: true,
    });
    expect(blanks.result).toBe('beforeafter');

    // A single line with a trailing newline iterates exactly once.
    const trailing = await tools.template_expand!.execute({
      template: '{{#each items}}- {{item}}{{/each}}',
      variables: { items: 'solo\n' },
      raw: true,
    });
    expect(trailing.result).toBe('- solo');

    // Comma separation keeps precedence for mixed-separator values.
    const mixed = await tools.template_expand!.execute({
      template: '{{#each items}}- {{item}}{{/each}}',
      variables: { items: 'a,b\nc' },
      raw: true,
    });
    expect(mixed.result).toBe('- a\n- b\nc');
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

  it('escapes substituted values, not the template text around them', async () => {
    const tools = setup();
    const res = await tools.template_expand!.execute({
      template:
        '<li class="x">{{v}}</li>{{#each tags}}<b>{{item}}</b>{{/each}} const a: Array<string> = [];',
      variables: { v: 'a<b', tags: '<i>' },
    });
    expect(res.result).toBe(
      '<li class="x">a&lt;b</li><b>&lt;i&gt;</b> const a: Array<string> = [];',
    );
  });

  it('does not double-interpolate placeholders inside expanded {{#each}} item values', async () => {
    const tools = setup();
    const rawRes = await tools.template_expand!.execute({
      template: '{{head}}:{{#each items}}- {{prefix}} {{item}}{{/each}}\nDone: {{secret}}',
      variables: {
        head: 'List',
        prefix: 'item',
        items: 'alpha,{{secret}},{{item}}',
        item: 'OUTER_ITEM',
        secret: 'TOP_SECRET',
      },
      raw: true,
    });
    expect(rawRes.result).toBe(
      'List:- item alpha\n- item {{secret}}\n- item {{item}}\nDone: TOP_SECRET',
    );

    const escapedRes = await tools.template_expand!.execute({
      template: '{{#each items}}<li>{{item}}</li>{{/each}}<span>{{secret}}</span>',
      variables: {
        items: '<b>ok</b>,{{secret}}',
        secret: '<TOP_SECRET>',
      },
    });
    expect(escapedRes.result).toBe(
      '<li>&lt;b&gt;ok&lt;/b&gt;</li>\n<li>{{secret}}</li><span>&lt;TOP_SECRET&gt;</span>',
    );
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
    await expect(
      tools.template_expand!.execute({ template: 'x', variables: {}, output_path: '/etc/passwd' }),
    ).rejects.toThrow(/relative path/);
    await expect(
      tools.template_expand!.execute({ template: 'x', variables: {}, output_path: '../escape' }),
    ).rejects.toThrow(/relative path/);
  });

  it('throws when the output file cannot be written', async () => {
    fsm.writeFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const tools = setup();
    await expect(
      tools.template_expand!.execute({ template: 'x', variables: {}, output_path: 'out.txt' }),
    ).rejects.toThrow(/Could not write out\.txt: .*EACCES/);
  });
});

describe('template_render', () => {
  it('validates template_path and variables', async () => {
    const tools = setup();
    await expect(tools.template_render!.execute({ variables: {} })).rejects.toThrow(
      /template_path is required/,
    );
    await expect(
      tools.template_render!.execute({ template_path: 'a', variables: 5 }),
    ).rejects.toThrow(/variables is required/);
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
    await expect(
      tools.template_render!.execute({ template_path: 'missing', variables: {} }),
    ).rejects.toThrow(/Could not read template file/);
  });

  it('rejects absolute or traversing template paths before reading', async () => {
    const tools = setup();
    await expect(
      tools.template_render!.execute({ template_path: '/etc/passwd', variables: {} }),
    ).rejects.toThrow(/relative path/);
    await expect(
      tools.template_render!.execute({ template_path: '../secret.tmpl', variables: {} }),
    ).rejects.toThrow(/relative path/);
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
    await expect(
      tools.template_render!.execute({ template_path: 't', variables: {}, output_path: '../x' }),
    ).rejects.toThrow(/relative path/);
  });
});

describe('template_create / template_list', () => {
  it('validates name and content', async () => {
    const tools = setup();
    await expect(tools.template_create!.execute({ content: 'x' })).rejects.toThrow(
      /name is required/,
    );
    await expect(tools.template_create!.execute({ name: 'n', content: 5 })).rejects.toThrow(
      /content is required/,
    );
    await expect(
      tools.template_create!.execute({ name: 'n', content: 'x'.repeat(256 * 1024 + 1) }),
    ).rejects.toThrow(/content exceeds/);
  });

  it('caps the number of retained templates', async () => {
    const tools = setup();
    for (let index = 0; index < 256; index++) {
      await expect(
        tools.template_create!.execute({ name: `template-${index}`, content: 'x' }),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      tools.template_create!.execute({ name: 'overflow', content: 'x' }),
    ).rejects.toThrow(/template limit/);
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
