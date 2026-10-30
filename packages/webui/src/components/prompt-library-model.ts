interface PromptVar {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
  enum?: string[];
  multiline?: boolean;
}

export interface PromptMeta {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  source: string;
  favorite: boolean;
  variables: PromptVar[];
}

export interface CategoryCount {
  id: string;
  label: string;
  count: number;
}

export const SOURCE_GLYPH: Record<string, string> = {
  builtin: '📦',
  user: '👤',
  project: '📁',
  synced: '☁',
};

/** A variable row in the authoring form (enum kept as a CSV string for editing). */
interface VarDraft {
  id: string;
  name: string;
  description: string;
  required: boolean;
  multiline: boolean;
  enumCsv: string;
}

export interface PromptDraft {
  title: string;
  description: string;
  category: string;
  tagsCsv: string;
  content: string;
  vars: VarDraft[];
}

export const emptyDraft: PromptDraft = {
  title: '',
  description: '',
  category: '',
  tagsCsv: '',
  content: '',
  vars: [],
};

/** Fill {{name}} placeholders locally; leave unknown placeholders intact. */
export function render(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, raw: string) =>
    Object.hasOwn(values, raw.trim()) && values[raw.trim()]
      ? (values[raw.trim()] as string)
      : whole,
  );
}
