/**
 * Minimal type declarations for turndown@7.
 * turndown does not ship TypeScript definitions; @types/turndown covers v5.
 * These declarations cover the API surface used in fetch.ts.
 */

declare module 'turndown' {
  interface Options {
    /** Use fenced code blocks (```) vs indented code. Default: 'indented' */
    codeBlockStyle?: 'fenced' | 'indented' | undefined;
    /** Whether to keep HTML inside paragraphs. Default: false */
    keepKeep?: boolean | undefined;
    /** headingStyle: 'setext' | 'atx' */
    headingStyle?: 'setext' | 'atx' | undefined;
    /** bulletListMarker: '-' | '*' | '+' */
    bulletListMarker?: '-' | '*' | '+' | undefined;
    /** linkStyle: 'inlined' | 'referenced' */
    linkStyle?: 'inlined' | 'referenced' | undefined;
  }

  interface TurndownService {
    /**
     * Convert HTML string to Markdown.
     * @param html - The HTML to convert
     * @returns Markdown string
     */
    turndown(html: string): string;
    /**
     * Add a conversion rule.
     * @param ruleName - Unique name for the rule
     * @param rule - Rule definition
     */
    addRule(
      ruleName: string,
      rule: {
        filter: string | string[] | ((node: unknown) => boolean);
        replacement: (content: string, node: unknown, options: unknown) => string;
      },
    ): this;
    /**
     * Remove elements matching the filter entirely — their content is
     * discarded rather than converted.
     * @param filter - Tag name(s) or a predicate over DOM nodes
     */
    remove(filter: string | string[] | ((node: { nodeName: string }) => boolean)): this;
    /**
     * Use another TurndownService's rules.
     */
    use(service: TurndownService): this;
  }

  interface TurndownServiceConstructor {
    /**
     * Create a new TurndownService instance.
     * @param options - Conversion options
     */
    new (options?: Options): TurndownService;
  }

  const TurndownService: TurndownServiceConstructor;
  export default TurndownService;
}
