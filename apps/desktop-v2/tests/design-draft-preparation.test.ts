// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDesignDraftPreparation } from '../src/useDesignDraftPreparation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Target = Parameters<typeof useDesignDraftPreparation>[0];
let root: Root | undefined;
let invoke: ((text: string) => Promise<boolean>) | undefined;

function Probe({ target }: { target: Target }) {
  invoke = useDesignDraftPreparation(target);
  return null;
}
async function render(target: Target) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe, { target })));
}
const fixture = () => ({
  owner: 'conversation-a',
  draft: 'Keep the original draft',
  conflict: false,
  validate: vi.fn(async () => true),
  save: vi.fn(async (_text: string) => true),
  onPrepared: vi.fn(),
});

describe('prepare a design request in the owning draft', () => {
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    invoke = undefined;
  });

  it('appends once and completes only after persistence acknowledges it', async () => {
    const target = fixture();
    const saved = Promise.withResolvers<boolean>();
    target.save.mockReturnValueOnce(saved.promise);
    await render(target);
    const first = invoke!('Extract design DNA');
    await expect(invoke!('duplicate')).resolves.toBe(false);
    expect(target.save).toHaveBeenCalledExactlyOnceWith(
      'Keep the original draft\n\nExtract design DNA',
    );
    expect(target.onPrepared).not.toHaveBeenCalled();
    saved.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(target.onPrepared).toHaveBeenCalledOnce();
  });

  it.each(['draft', 'owner', 'conflict'] as const)(
    'refuses a pending append after %s changes',
    async (change) => {
      const target = fixture();
      const checking = Promise.withResolvers<boolean>();
      target.validate.mockReturnValueOnce(checking.promise);
      await render(target);
      const request = invoke!('Extract design DNA');
      await render({
        ...target,
        ...(change === 'draft'
          ? { draft: 'Newer unsent text' }
          : change === 'owner'
            ? { owner: 'conversation-b' }
            : { conflict: true }),
      });
      checking.resolve(true);
      await expect(request).resolves.toBe(false);
      expect(target.save).not.toHaveBeenCalled();
      expect(target.onPrepared).not.toHaveBeenCalled();
    },
  );

  it('does not run an old navigation callback after the conversation closes', async () => {
    const target = fixture();
    const saved = Promise.withResolvers<boolean>();
    target.save.mockReturnValueOnce(saved.promise);
    await render(target);
    const request = invoke!('Extract design DNA');
    await Promise.resolve();
    expect(target.save).toHaveBeenCalledOnce();
    await act(async () => root!.unmount());
    root = undefined;
    saved.resolve(true);
    await expect(request).resolves.toBe(true);
    expect(target.onPrepared).not.toHaveBeenCalled();
  });
});
