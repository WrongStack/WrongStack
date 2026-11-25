// Pure prompt-picker data model (no Ink/React), shared by the picker view,
// the key hooks and the composer reducer.

export interface PromptPickEntry {
  slug: string;
  title: string;
  description: string;
  category: string;
  source: string;
  content: string;
  variants?: { simple: string; detailed: string; advanced: string } | undefined;
  favorite: boolean;
}

/**
 * Apply the picker's category filter. catIndex 0 (= "all") returns everything;
 * "★ favorites" filters by the favorite flag; "🕘 recent" orders by the
 * recently-used slug list (most-recent first).
 */
export function filterPromptPicker(
  all: PromptPickEntry[],
  categories: string[],
  catIndex: number,
  recentSlugs: string[] = [],
): PromptPickEntry[] {
  const cat = categories[catIndex];
  if (!cat || cat === 'all') return all;
  if (cat === '★ favorites') return all.filter((e) => e.favorite);
  if (cat === '🕘 recent') {
    const bySlug = new Map(all.map((e) => [e.slug, e]));
    return [...new Set(recentSlugs)]
      .map((s) => bySlug.get(s))
      .filter((e): e is PromptPickEntry => Boolean(e));
  }
  return all.filter((e) => e.category === cat);
}
