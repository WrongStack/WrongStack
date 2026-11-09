import { resourceMatches } from './resource-model';
import { text } from './session';

export const FILE_GROUPS = {
  all: 'All files',
  documents: 'Documents',
  images: 'Images',
  code: 'Code & config',
  other: 'Other files',
} as const;
export type FileGroup = keyof typeof FILE_GROUPS;

export function fileGroup(path: string): Exclude<FileGroup, 'all'> {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() || '';
  const extension = name.includes('.') ? name.split('.').at(-1) : '';
  if (
    /^(readme|license|changelog|authors|contributing)(\.|$)/.test(name) ||
    /^(md|mdx|txt|rst|pdf|docx?|odt|rtf|csv|xlsx?|pptx?)$/.test(extension || '')
  )
    return 'documents';
  if (/^(png|jpe?g|gif|webp|svg|avif|ico|bmp|tiff?)$/.test(extension || '')) return 'images';
  if (
    /^(tsx?|jsx?|mjsx?|cjsx?|jsonc?|ya?ml|toml|html?|css|scss|sass|less|vue|svelte|astro|py|go|rs|java|kt|cs|c|cpp|h|hpp|sh|ps1|sql|xml|ini|env|lock)$/.test(
      extension || '',
    ) ||
    /^(dockerfile|makefile|\.gitignore|\.env)(\.|$)/.test(name)
  )
    return 'code';
  return 'other';
}

export function filterResources(
  items: Record<string, unknown>[],
  query: string,
  category: string,
  favorites: boolean,
) {
  return items.filter(
    (item) =>
      resourceMatches(item, query) &&
      (!category || text(item.category) === category) &&
      (!favorites || item.favorite === true),
  );
}

export function memoryKindLabel(kind: unknown) {
  const labels: Record<string, string> = {
    preference: 'Preference',
    decision: 'Decision',
    convention: 'Project habit',
    workflow: 'Workflow',
    warning: 'Watch out',
    bug_root_cause: 'Solved issue',
    file_note: 'File note',
    summary: 'Summary',
    fact: 'Fact',
  };
  const key = text(kind).trim();
  if (Object.hasOwn(labels, key)) return labels[key]!;
  return key.replaceAll('_', ' ').trim() || 'Knowledge';
}
