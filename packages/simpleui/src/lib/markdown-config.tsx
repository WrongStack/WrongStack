import type { ComponentPropsWithoutRef } from 'react';
import rehypePrettyCode from 'rehype-pretty-code';
import remarkGfm from 'remark-gfm';
import { getMarkdownHighlighter } from './markdown-highlighter.js';

/**
 * Shared markdown rendering configuration for the leader transcript
 * (`chat-message-list`) and the subagent panes (`agent-chat-pane`).
 *
 * The plugin arrays and component maps must keep a stable identity across
 * renders: react-markdown re-runs its processors whenever the `remarkPlugins`,
 * `rehypePlugins` or `components` prop identity changes, so array literals
 * created inline in JSX would force every memo'd message to re-process its
 * markdown on each render.
 */

/** Shiki theme name for syntax-highlighted code blocks. */
export function codeTheme(theme: 'dark' | 'light'): 'github-light' | 'github-dark-dimmed' {
  return theme === 'light' ? 'github-light' : 'github-dark-dimmed';
}

export const markdownRemarkPlugins = [remarkGfm];

type RehypePlugins = [[typeof rehypePrettyCode, Parameters<typeof rehypePrettyCode>[0]]];

const rehypePluginsByTheme = new Map<'dark' | 'light', RehypePlugins>();

export function markdownRehypePlugins(theme: 'dark' | 'light'): RehypePlugins {
  const cached = rehypePluginsByTheme.get(theme);
  if (cached) return cached;
  const plugins: RehypePlugins = [
    [
      rehypePrettyCode,
      {
        theme: codeTheme(theme),
        keepBackground: false,
        // rehype-pretty-code types this against the full shiki bundle's
        // Highlighter; our fine-grained HighlighterCore is structurally
        // compatible for everything the plugin calls (codeToHast,
        // getLoadedLanguages, loadLanguage).
        getHighlighter: () => getMarkdownHighlighter(),
      } as unknown as Parameters<typeof rehypePrettyCode>[0],
    ],
  ];
  rehypePluginsByTheme.set(theme, plugins);
  return plugins;
}

export const markdownComponents = {
  a: ({ children, ...props }: ComponentPropsWithoutRef<'a'>) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};
