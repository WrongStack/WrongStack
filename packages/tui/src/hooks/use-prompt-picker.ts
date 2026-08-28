import { createRequire } from 'node:module';
import * as path from 'node:path';
import { DefaultPromptLoader } from '@wrongstack/core/execution';
import { PromptUsageStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { useCallback, useRef } from 'react';
import type { Action } from '../app-reducer.js';
import type { PromptPickEntry } from '../components/prompt-picker.js';

interface PromptLibraryEntry {
  slug: string;
  title: string;
  description: string;
  category: string;
  source: string;
  content: string;
  favorite: boolean;
}

interface PromptPickerOpenPayload {
  all: PromptPickEntry[];
  categories: string[];
  recentSlugs: string[];
}

export function buildPromptPickerPayload(
  all: PromptLibraryEntry[],
  recentSlugs: string[],
): PromptPickerOpenPayload {
  const entries: PromptPickEntry[] = all.map((e) => ({
    slug: e.slug,
    title: e.title,
    description: e.description,
    category: e.category,
    source: e.source,
    content: e.content,
    favorite: e.favorite,
  }));
  const hasFavorites = entries.some((e) => e.favorite);
  const categories = [
    'all',
    ...(recentSlugs.length > 0 ? ['🕘 recent'] : []),
    ...(hasFavorites ? ['★ favorites'] : []),
    ...Array.from(new Set(entries.map((e) => e.category))).sort(),
  ];
  return { all: entries, categories, recentSlugs };
}

interface UsePromptPickerOptions {
  projectRoot: string;
  dispatch: React.Dispatch<Action>;
}

/**
 * Lazily loads the prompt library and opens the TUI prompt picker.
 */
export function usePromptPicker({ projectRoot, dispatch }: UsePromptPickerOptions): {
  openPromptPicker: () => Promise<void>;
  setPromptFavorite: (slug: string, favorite: boolean) => Promise<void>;
} {
  const promptLoaderRef = useRef<DefaultPromptLoader | null>(null);
  const promptUsageRef = useRef<PromptUsageStore | null>(null);

  const getPromptLoader = useCallback((): DefaultPromptLoader | null => {
    if (!promptLoaderRef.current && projectRoot) {
      let bundledDir: string | undefined;
      try {
        const req = createRequire(import.meta.url);
        bundledDir = path.join(
          path.dirname(req.resolve('@wrongstack/core/package.json')),
          'data',
          'prompts',
        );
      } catch {
        bundledDir = undefined;
      }
      const paths = resolveWstackPaths({ projectRoot });
      promptLoaderRef.current = new DefaultPromptLoader({ paths, bundledDir });
      promptUsageRef.current = new PromptUsageStore(paths.promptUsage);
    }
    return promptLoaderRef.current;
  }, [projectRoot]);

  const openPromptPicker = useCallback(async (): Promise<void> => {
    const loader = getPromptLoader();
    if (!loader) return;
    loader.invalidateCache();
    const all = await loader.list();
    const recentSlugs =
      (await promptUsageRef.current?.recent(50).catch(() => []))?.map((r) => r.slug) ?? [];
    const payload = buildPromptPickerPayload(all, recentSlugs);
    dispatch({ type: 'promptPickerOpen', ...payload });
  }, [dispatch, getPromptLoader]);

  const setPromptFavorite = useCallback(
    async (slug: string, favorite: boolean): Promise<void> => {
      const loader = getPromptLoader();
      if (!loader) return;
      await loader.setFavorite(slug, favorite);
      await openPromptPicker();
    },
    [getPromptLoader, openPromptPicker],
  );

  return { openPromptPicker, setPromptFavorite };
}
