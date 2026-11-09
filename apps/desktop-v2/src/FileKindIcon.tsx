import {
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
} from 'lucide-react';

const KINDS: ReadonlyArray<[RegExp, typeof FileCode2, string]> = [
  [/\.(json|jsonc|json5)$/i, FileJson, 'json'],
  [/\.(md|mdx|txt|rst|adoc)$/i, FileText, 'text'],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i, FileImage, 'image'],
  [/\.(zip|tar|gz|tgz|7z|rar)$/i, FileArchive, 'archive'],
  [/(\.lock|lock\.json|\.lockb)$/i, FileLock, 'lock'],
  [/\.(sh|bash|zsh|ps1|cmd|bat)$/i, FileTerminal, 'shell'],
  [/(\.(ya?ml|toml|ini|env|conf)|^\.[\w.-]+rc|\.config\.[cm]?[jt]s)$/i, FileCog, 'config'],
  [/\.(tsx?|mts|cts)$/i, FileCode2, 'ts'],
  [/\.(jsx?|mjs|cjs)$/i, FileCode2, 'js'],
  [/\.(css|scss|less)$/i, FileCode2, 'css'],
  [/\.(rs|go|py|rb|java|kt|swift|c|cc|cpp|h|cs)$/i, FileCode2, 'code'],
];

/**
 * A file's icon by its kind, tinted as in the WebUI's explorer (JSON, Markdown, TypeScript…),
 * instead of one grey glyph for every file.
 */
export function FileKindIcon({ name, size }: { name: string; size: number }) {
  const base = name.split(/[\\/]/).at(-1) ?? name;
  const found = KINDS.find(([pattern]) => pattern.test(base));
  const Icon = found?.[1] ?? FileCode2;
  return <Icon size={size} className={`file-kind file-kind-${found?.[2] ?? 'other'}`} />;
}
