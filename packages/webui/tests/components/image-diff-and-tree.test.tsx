import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImageDiffView } from '../../src/components/ImageDiffView';
import { buildCompactFileTree, type CompactTreeNode } from '../../src/lib/compact-file-tree';

const file = (path: string, added = 1, deleted = 0) => ({ path, added, deleted });

/** The tree as indented lines, to compare in one go. */
function outline(nodes: CompactTreeNode<ReturnType<typeof file>>[], depth = 0): string[] {
  return nodes.flatMap((n) =>
    n.kind === 'file'
      ? [`${'  '.repeat(depth)}${n.name}`]
      : [
          `${'  '.repeat(depth)}${n.name}/ (${n.fileCount}, +${n.added} -${n.deleted})`,
          ...outline(n.children, depth + 1),
        ],
  );
}

describe('buildCompactFileTree', () => {
  it('folds single-child directory chains and sorts folders before files', () => {
    const tree = buildCompactFileTree([
      file('packages/webui/src/components/A.tsx', 3, 1),
      file('packages/webui/src/lib/b.ts', 2),
      file('README.md'),
      file('packages/cli/src/index.ts'),
      file('docs/guide/intro.md', 0, 4),
    ]);
    expect(outline(tree)).toEqual([
      'docs/guide/ (1, +0 -4)',
      '  intro.md',
      'packages/ (3, +6 -1)',
      '  cli/src/ (1, +1 -0)',
      '    index.ts',
      '  webui/src/ (2, +5 -1)',
      '    components/ (1, +3 -1)',
      '      A.tsx',
      '    lib/ (1, +2 -0)',
      '      b.ts',
      'README.md',
    ]);
    // Git's untracked directory entry stays one entry with a name.
    expect(outline(buildCompactFileTree([file('.wrongstack/'), file('tools/x/')]))).toEqual([
      'tools/ (1, +1 -0)',
      '  x/',
      '.wrongstack/',
    ]);
    // A folded directory keeps its full path, for keys and collapse state.
    const packages = tree[1];
    expect(
      packages?.kind === 'dir' && packages.children[0]?.kind === 'dir'
        ? packages.children[0].path
        : '',
    ).toBe('packages/cli/src');
    // Windows backslash paths and trailing backslashes normalize into the same compact tree (F89).
    expect(
      outline(
        buildCompactFileTree([
          file('packages\\webui\\src\\App.tsx', 2, 1),
          file('packages\\webui\\src\\untracked\\', 0, 0),
        ]),
      ),
    ).toEqual(['packages/webui/src/ (2, +2 -1)', '  App.tsx', '  untracked/']);
  });
});

describe('ImageDiffView', () => {
  const old = 'data:image/png;base64,AAAA';
  const next = 'data:image/png;base64,BBBB';

  it('shows both versions side by side, and stacks them in onion-skin mode', () => {
    render(
      <ImageDiffView path="logo.png" image={{ old, new: next, oldBytes: 2048, newBytes: 4096 }} />,
    );
    const [before, after] = screen.getAllByRole('img') as HTMLImageElement[];
    expect(before?.src).toBe(old);
    expect(after?.src).toBe(next);
    expect(screen.getByText('2.0 KiB')).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /onion/i }));
    const slider = screen.getByRole('slider') as HTMLInputElement;
    const top = screen.getAllByRole('img')[1] as HTMLImageElement;
    expect(top.style.opacity).toBe('0.5');
    fireEvent.change(slider, { target: { value: '80' } });
    expect(top.style.opacity).toBe('0.8');
  });

  it('shows the one side of an added image, without modes', () => {
    render(<ImageDiffView path="new.png" image={{ new: next, newBytes: 10 }} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /onion/i })).toBeNull();
    expect(screen.getByText('New image')).toBeTruthy();
  });
});
