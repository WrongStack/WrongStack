import { type HighlighterCore, createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import css from 'shiki/langs/css.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import diff from 'shiki/langs/diff.mjs';
import dockerfile from 'shiki/langs/dockerfile.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import scss from 'shiki/langs/scss.mjs';
import sql from 'shiki/langs/sql.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import githubDarkDimmed from 'shiki/themes/github-dark-dimmed.mjs';
import githubLight from 'shiki/themes/github-light.mjs';

/**
 * Fine-grained shared shiki highlighter for markdown code blocks.
 *
 * Built from `shiki/core` + a curated language set + the two themes SimpleUI
 * actually uses, with the pure-JS regex engine (no oniguruma wasm). The full
 * `shiki` bundle registers ~340 languages and ~100 themes (~10MB before
 * gzip); this subset covers everything an agent typically emits. Unknown
 * languages fall back to plain text via rehype-pretty-code's
 * `loadLanguage` error handling.
 */

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * github-light with the four token colors that miss WCAG AA on SimpleUI's
 * light code background (`--code-bg` #f0ede5, 12px code text) deepened in
 * place — same hues, deeper values, every other token stock:
 *
 *   #d73a49 keyword/storage/operator punctuation → #b32d3d  (3.91 → ~5.3:1)
 *   #6a737d comment                              → #59636d  (4.12 → ~5.2:1)
 *   #e36209 variable / markdown list markers     → #a34a00  (2.98 → ~5.1:1)
 *   #22863a entity.name.tag / regexp escapes     → #1a6b2e  (3.95 → ~5.6:1)
 *
 * Registered under its own name so `codeTheme('light')` can opt into it
 * explicitly; dark ships the untouched github-dark-dimmed theme.
 */
const AA_LIGHT_TOKEN_COLORS: Readonly<Record<string, string>> = {
  '#d73a49': '#b32d3d',
  '#6a737d': '#59636d',
  '#e36209': '#a34a00',
  '#22863a': '#1a6b2e',
};

const githubLightAa: typeof githubLight = {
  ...githubLight,
  name: 'github-light-aa',
  tokenColors: (githubLight.tokenColors ?? []).map((token) => {
    const foreground = token.settings?.foreground?.toLowerCase();
    const replacement = foreground !== undefined ? AA_LIGHT_TOKEN_COLORS[foreground] : undefined;
    return replacement
      ? { ...token, settings: { ...token.settings, foreground: replacement } }
      : token;
  }),
};

export function getMarkdownHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubDarkDimmed, githubLightAa],
    langs: [
      bash,
      c,
      cpp,
      css,
      csharp,
      diff,
      dockerfile,
      go,
      html,
      java,
      javascript,
      json,
      jsx,
      kotlin,
      markdown,
      php,
      python,
      ruby,
      rust,
      scss,
      sql,
      toml,
      tsx,
      typescript,
      xml,
      yaml,
    ],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}
