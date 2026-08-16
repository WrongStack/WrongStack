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

export function getMarkdownHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubDarkDimmed, githubLight],
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
