import * as monaco from 'monaco-editor';

// ===========================================================================
// WrongStack Monaco Editor Themes
// Matches the CSS syntax-highlight.css theme for dark/light modes.
// Uses the same color palette: warm graphite (dark) / warm paper (light)
// with signal-amber accents.
// ===========================================================================

// ── Dark theme: warm graphite ─────────────────────────────────────────
// Background: hsl(225 17% 8%) = #121318
// Foreground: hsl(40 22% 92%) = #eeede7
// Primary:    hsl(36 96% 56%) = #f2a23a (signal amber)

monaco.editor.defineTheme('wrongstack-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // ── Comments ──
    { token: 'comment', foreground: '6e717a', fontStyle: 'italic' },
    { token: 'comment.line', foreground: '6e717a', fontStyle: 'italic' },
    { token: 'comment.block', foreground: '6e717a', fontStyle: 'italic' },
    { token: 'comment.documentation', foreground: '6e717a', fontStyle: 'italic' },

    // ── Strings (green) ──
    { token: 'string', foreground: '64d488' },
    { token: 'string.escape', foreground: '49d3c5' },
    { token: 'string.template', foreground: '64d488' },

    // ── Numbers (signal amber) ──
    { token: 'number', foreground: 'f2a23a' },
    { token: 'number.hex', foreground: 'f2a23a' },
    { token: 'number.float', foreground: 'f2a23a' },

    // ── Keywords (pink) ──
    { token: 'keyword', foreground: 'f28dbc' },
    { token: 'keyword.control', foreground: 'f28dbc' },
    { token: 'keyword.operator', foreground: '9ea0a8' },

    // ── Types (blue-teal) ──
    { token: 'type', foreground: '6cb6ff' },
    { token: 'type.identifier', foreground: '6cb6ff' },
    { token: 'type.parameter', foreground: 'eeede7' },

    // ── Functions (blue-teal) ──
    { token: 'function', foreground: '6cb6ff' },
    { token: 'predefined', foreground: '6cb6ff' },

    // ── Variables / identifiers ──
    { token: 'variable', foreground: 'eeede7' },
    { token: 'variable.parameter', foreground: 'f2a23a' },
    { token: 'variable.readonly', foreground: 'f2a23a' },
    { token: 'variable.language', foreground: 'f28dbc' },

    // ── Tags (HTML/JSX) — warm rose ──
    { token: 'tag', foreground: 'f47a95' },
    { token: 'metatag', foreground: 'f47a95' },
    { token: 'tag.html', foreground: 'f47a95' },
    { token: 'tag.jsx', foreground: 'f47a95' },
    { token: 'tag.tsx', foreground: 'f47a95' },

    // ── Attributes / properties ▸ amber ──
    { token: 'attribute.name', foreground: 'ffb055' },
    { token: 'attribute.value', foreground: '64d488' },
    { token: 'attribute.name.html', foreground: 'ffb055' },
    { token: 'attribute.name.jsx', foreground: 'ffb055' },

    // ── Regex (teal) ──
    { token: 'regexp', foreground: '49d3c5' },

    // ── Delimiters / punctuation ──
    { token: 'delimiter', foreground: '9ea0a8' },
    { token: 'delimiter.bracket', foreground: '9ea0a8' },
    { token: 'delimiter.parenthesis', foreground: '9ea0a8' },
    { token: 'delimiter.curly', foreground: '9ea0a8' },
    { token: 'delimiter.square', foreground: '9ea0a8' },
    { token: 'delimiter.array', foreground: '9ea0a8' },

    // ── Operators ──
    { token: 'operator', foreground: '9ea0a8' },

    // ── Constants / builtins ──
    { token: 'constant', foreground: 'f2a23a' },
    { token: 'constant.language', foreground: 'f28dbc' },
    { token: 'support', foreground: '6cb6ff' },
    { token: 'support.function', foreground: '6cb6ff' },
    { token: 'support.type', foreground: '6cb6ff' },
    { token: 'support.constant', foreground: 'f2a23a' },
    { token: 'support.variable', foreground: 'eeede7' },

    // ── Storage modifiers (public, private, static, etc.) ──
    { token: 'storage', foreground: 'f28dbc' },
    { token: 'storage.modifier', foreground: 'f28dbc' },
    { token: 'storage.type', foreground: '6cb6ff' },

    // ── Entity (class names, etc.) ──
    { token: 'entity.name.type', foreground: '6cb6ff' },
    { token: 'entity.name.function', foreground: '6cb6ff' },
    { token: 'entity.other.inherited-class', foreground: '6cb6ff' },
    { token: 'entity.name.tag', foreground: 'f47a95' },
    { token: 'entity.other.attribute-name', foreground: 'ffb055' },

    // ── Invalid ──
    { token: 'invalid', foreground: 'd63c3c' },
    { token: 'invalid.deprecated', foreground: 'd63c3c' },

    // ── Markdown ──
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'header', foreground: '6cb6ff', fontStyle: 'bold' },
    { token: 'link', foreground: '49d3c5', fontStyle: 'underline' },

    // ── Semantic tokens (TypeScript semantic highlighting) ──
    { token: 'class', foreground: '6cb6ff' },
    { token: 'interface', foreground: '49d3c5' },
    { token: 'enum', foreground: 'f2a23a' },
    { token: 'enumMember', foreground: 'f2a23a' },
    { token: 'typeParameter', foreground: 'f2a23a' },
    { token: 'namespace', foreground: '6cb6ff' },
    { token: 'method', foreground: '6cb6ff' },
    { token: 'property', foreground: 'eeede7' },
    { token: 'property.readonly', foreground: 'f2a23a' },
    { token: 'property.static', foreground: 'eeede7' },
    { token: 'parameter', foreground: 'f2a23a' },
    { token: 'variable.defaultLibrary', foreground: '6cb6ff' },
    { token: 'function.defaultLibrary', foreground: '6cb6ff' },
    { token: 'macro', foreground: 'c4a0ff' },
    { token: 'decorator', foreground: 'c4a0ff' },
    { token: 'label', foreground: 'f2a23a' },

    // ── Deprecated / unused ──
    { token: 'comment.deprecated', foreground: '6e717a', fontStyle: 'italic strikethrough' },
    { token: 'variable.deprecated', foreground: '6e717a', fontStyle: 'strikethrough' },
  ],
  colors: {
    // Editor chrome
    'editor.background': '#121318',
    'editor.foreground': '#eeede7',
    'editorCursor.foreground': '#f2a23a',
    'editor.selectionBackground': '#f2a23a25',
    'editor.selectionHighlightBackground': '#f2a23a15',
    'editor.inactiveSelectionBackground': '#f2a23a10',
    'editor.lineHighlightBackground': '#1a1c23',
    'editorLineNumber.foreground': '#4a4d55',
    'editorLineNumber.activeForeground': '#9ea0a8',
    'editorRuler.foreground': '#1e2028',
    'editorBracketMatch.background': '#f2a23a15',
    'editorBracketMatch.border': '#f2a23a30',
    'editor.findMatchBackground': '#f2a23a30',
    'editor.findMatchHighlightBackground': '#f2a23a15',
    'editorWidget.background': '#1a1c23',
    'editorWidget.border': '#262830',
    'editorSuggestWidget.background': '#1a1c23',
    'editorSuggestWidget.border': '#262830',
    'editorSuggestWidget.selectedBackground': '#262830',
    'editorHoverWidget.background': '#1a1c23',
    'editorHoverWidget.border': '#262830',

    // Scrollbar
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#4a4d5530',
    'scrollbarSlider.hoverBackground': '#f2a23a50',
    'scrollbarSlider.activeBackground': '#f2a23a70',

    // Minimap
    'minimap.background': '#121318',

    // Diff
    'diffEditor.insertedTextBackground': '#64d48815',
    'diffEditor.removedTextBackground': '#d63c3c15',

    // Sidebar
    'sideBar.background': '#121318',
    'sideBar.border': '#1e2028',

    // Input
    'input.background': '#1a1c23',
    'input.border': '#262830',
    'input.foreground': '#eeede7',
    'input.placeholderForeground': '#6e717a',

    // Focus / active
    focusBorder: '#f2a23a40',
    'list.activeSelectionBackground': '#262830',
    'list.hoverBackground': '#1e2028',

    // Dropdown
    'dropdown.background': '#1a1c23',
    'dropdown.border': '#262830',

    // Badge
    'badge.background': '#f2a23a',
    'badge.foreground': '#1a1208',

    // ── Bracket pair colorization ─ 6-level rainbow, tonal palette ──
    'editorBracketHighlighting.foreground1': '#f2a23a',
    'editorBracketHighlighting.foreground2': '#6cb6ff',
    'editorBracketHighlighting.foreground3': '#f28dbc',
    'editorBracketHighlighting.foreground4': '#64d488',
    'editorBracketHighlighting.foreground5': '#49d3c5',
    'editorBracketHighlighting.foreground6': '#c4a0ff',
    'editorBracketPairGuide.background1': '#f2a23a18',
    'editorBracketPairGuide.background2': '#6cb6ff18',
    'editorBracketPairGuide.background3': '#f28dbc18',
    'editorBracketPairGuide.background4': '#64d48818',
    'editorBracketPairGuide.background5': '#49d3c518',
    'editorBracketPairGuide.background6': '#c4a0ff18',
    'editorBracketPairGuide.activeBackground1': '#f2a23a30',
    'editorBracketPairGuide.activeBackground2': '#6cb6ff30',
    'editorBracketPairGuide.activeBackground3': '#f28dbc30',
    'editorBracketPairGuide.activeBackground4': '#64d48830',
    'editorBracketPairGuide.activeBackground5': '#49d3c530',
    'editorBracketPairGuide.activeBackground6': '#c4a0ff30',
  },
});

// ── Light theme: warm paper ───────────────────────────────────────────
// Background: hsl(40 33% 97%) = #f7f7f5
// Foreground: hsl(222 24% 13%) = #1a1c23
// Primary:    hsl(28 92% 46%) = #e07b0e (deep signal amber)

monaco.editor.defineTheme('wrongstack-light', {
  base: 'vs',
  inherit: true,
  rules: [
    // ── Comments ──
    { token: 'comment', foreground: '9a9d99', fontStyle: 'italic' },
    { token: 'comment.line', foreground: '9a9d99', fontStyle: 'italic' },
    { token: 'comment.block', foreground: '9a9d99', fontStyle: 'italic' },
    { token: 'comment.documentation', foreground: '9a9d99', fontStyle: 'italic' },

    // ── Strings (green) ──
    { token: 'string', foreground: '3b8c5a' },
    { token: 'string.escape', foreground: '17998e' },
    { token: 'string.template', foreground: '3b8c5a' },

    // ── Numbers (signal amber) ──
    { token: 'number', foreground: 'd97a12' },
    { token: 'number.hex', foreground: 'd97a12' },
    { token: 'number.float', foreground: 'd97a12' },

    // ── Keywords (pink) ──
    { token: 'keyword', foreground: 'd65a9a' },
    { token: 'keyword.control', foreground: 'd65a9a' },
    { token: 'keyword.operator', foreground: '6b6d72' },

    // ── Types (blue) ──
    { token: 'type', foreground: '3178c6' },
    { token: 'type.identifier', foreground: '3178c6' },
    { token: 'type.parameter', foreground: '1a1c23' },

    // ── Functions (blue) ──
    { token: 'function', foreground: '3178c6' },
    { token: 'predefined', foreground: '3178c6' },

    // ── Variables ──
    { token: 'variable', foreground: '1a1c23' },
    { token: 'variable.parameter', foreground: 'd97a12' },
    { token: 'variable.readonly', foreground: 'd97a12' },
    { token: 'variable.language', foreground: 'd65a9a' },

    // ── Tags (HTML/JSX) — warm rose ──
    { token: 'tag', foreground: 'c93a5e' },
    { token: 'metatag', foreground: 'c93a5e' },
    { token: 'tag.html', foreground: 'c93a5e' },
    { token: 'tag.jsx', foreground: 'c93a5e' },
    { token: 'tag.tsx', foreground: 'c93a5e' },

    // ── Attributes ▸ amber ──
    { token: 'attribute.name', foreground: 'd4893a' },
    { token: 'attribute.value', foreground: '3b8c5a' },
    { token: 'attribute.name.html', foreground: 'd4893a' },
    { token: 'attribute.name.jsx', foreground: 'd4893a' },

    // ── Regex (teal) ──
    { token: 'regexp', foreground: '17998e' },

    // ── Delimiters ──
    { token: 'delimiter', foreground: '6b6d72' },
    { token: 'delimiter.bracket', foreground: '6b6d72' },
    { token: 'delimiter.parenthesis', foreground: '6b6d72' },
    { token: 'delimiter.curly', foreground: '6b6d72' },
    { token: 'delimiter.square', foreground: '6b6d72' },
    { token: 'delimiter.array', foreground: '6b6d72' },

    // ── Operators ──
    { token: 'operator', foreground: '6b6d72' },

    // ── Constants / builtins ──
    { token: 'constant', foreground: 'd97a12' },
    { token: 'constant.language', foreground: 'd65a9a' },
    { token: 'support', foreground: '3178c6' },
    { token: 'support.function', foreground: '3178c6' },
    { token: 'support.type', foreground: '3178c6' },
    { token: 'support.constant', foreground: 'd97a12' },
    { token: 'support.variable', foreground: '1a1c23' },

    // ── Storage ──
    { token: 'storage', foreground: 'd65a9a' },
    { token: 'storage.modifier', foreground: 'd65a9a' },
    { token: 'storage.type', foreground: '3178c6' },

    // ── Entity ──
    { token: 'entity.name.type', foreground: '3178c6' },
    { token: 'entity.name.function', foreground: '3178c6' },
    { token: 'entity.other.inherited-class', foreground: '3178c6' },
    { token: 'entity.name.tag', foreground: 'c93a5e' },
    { token: 'entity.other.attribute-name', foreground: 'd4893a' },

    // ── Invalid ──
    { token: 'invalid', foreground: 'd63c3c' },
    { token: 'invalid.deprecated', foreground: 'd63c3c' },

    // ── Markdown ──
    { token: 'emphasis', fontStyle: 'italic' },
    { token: 'strong', fontStyle: 'bold' },
    { token: 'header', foreground: '3178c6', fontStyle: 'bold' },
    { token: 'link', foreground: '17998e', fontStyle: 'underline' },

    // ── Semantic tokens (TypeScript semantic highlighting) ──
    { token: 'class', foreground: '3178c6' },
    { token: 'interface', foreground: '17998e' },
    { token: 'enum', foreground: 'd97a12' },
    { token: 'enumMember', foreground: 'd97a12' },
    { token: 'typeParameter', foreground: 'd97a12' },
    { token: 'namespace', foreground: '3178c6' },
    { token: 'method', foreground: '3178c6' },
    { token: 'property', foreground: '1a1c23' },
    { token: 'property.readonly', foreground: 'd97a12' },
    { token: 'property.static', foreground: '1a1c23' },
    { token: 'parameter', foreground: 'd97a12' },
    { token: 'variable.defaultLibrary', foreground: '3178c6' },
    { token: 'function.defaultLibrary', foreground: '3178c6' },
    { token: 'macro', foreground: '8b5cf6' },
    { token: 'decorator', foreground: '8b5cf6' },
    { token: 'label', foreground: 'd97a12' },

    // ── Deprecated / unused ──
    { token: 'comment.deprecated', foreground: '9a9d99', fontStyle: 'italic strikethrough' },
    { token: 'variable.deprecated', foreground: '9a9d99', fontStyle: 'strikethrough' },
  ],
  colors: {
    // Editor chrome
    'editor.background': '#f7f7f5',
    'editor.foreground': '#1a1c23',
    'editorCursor.foreground': '#e07b0e',
    'editor.selectionBackground': '#e07b0e18',
    'editor.selectionHighlightBackground': '#e07b0e10',
    'editor.inactiveSelectionBackground': '#e07b0e08',
    'editor.lineHighlightBackground': '#f0efe9',
    'editorLineNumber.foreground': '#bab8b0',
    'editorLineNumber.activeForeground': '#6b6d72',
    'editorRuler.foreground': '#e8e6de',
    'editorBracketMatch.background': '#e07b0e12',
    'editorBracketMatch.border': '#e07b0e25',
    'editor.findMatchBackground': '#e07b0e25',
    'editor.findMatchHighlightBackground': '#e07b0e12',
    'editorWidget.background': '#f7f7f5',
    'editorWidget.border': '#ddd9d0',
    'editorSuggestWidget.background': '#f7f7f5',
    'editorSuggestWidget.border': '#ddd9d0',
    'editorSuggestWidget.selectedBackground': '#eeece2',
    'editorHoverWidget.background': '#f7f7f5',
    'editorHoverWidget.border': '#ddd9d0',

    // Scrollbar
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#bab8b040',
    'scrollbarSlider.hoverBackground': '#e07b0e50',
    'scrollbarSlider.activeBackground': '#e07b0e70',

    // Minimap
    'minimap.background': '#f7f7f5',

    // Diff
    'diffEditor.insertedTextBackground': '#3b8c5a12',
    'diffEditor.removedTextBackground': '#d63c3c12',

    // Sidebar
    'sideBar.background': '#f7f7f5',
    'sideBar.border': '#e8e6de',

    // Input
    'input.background': '#ffffff',
    'input.border': '#ddd9d0',
    'input.foreground': '#1a1c23',
    'input.placeholderForeground': '#9a9d99',

    // Focus
    focusBorder: '#e07b0e35',
    'list.activeSelectionBackground': '#eeece2',
    'list.hoverBackground': '#f0efe9',

    // Dropdown
    'dropdown.background': '#ffffff',
    'dropdown.border': '#ddd9d0',

    // Badge
    'badge.background': '#e07b0e',
    'badge.foreground': '#ffffff',

    // ── Bracket pair colorization ─ 6-level rainbow, tonal palette ──
    'editorBracketHighlighting.foreground1': '#d97a12',
    'editorBracketHighlighting.foreground2': '#3178c6',
    'editorBracketHighlighting.foreground3': '#d65a9a',
    'editorBracketHighlighting.foreground4': '#3b8c5a',
    'editorBracketHighlighting.foreground5': '#17998e',
    'editorBracketHighlighting.foreground6': '#8b5cf6',
    'editorBracketPairGuide.background1': '#d97a1215',
    'editorBracketPairGuide.background2': '#3178c615',
    'editorBracketPairGuide.background3': '#d65a9a15',
    'editorBracketPairGuide.background4': '#3b8c5a15',
    'editorBracketPairGuide.background5': '#17998e15',
    'editorBracketPairGuide.background6': '#8b5cf615',
    'editorBracketPairGuide.activeBackground1': '#d97a1228',
    'editorBracketPairGuide.activeBackground2': '#3178c628',
    'editorBracketPairGuide.activeBackground3': '#d65a9a28',
    'editorBracketPairGuide.activeBackground4': '#3b8c5a28',
    'editorBracketPairGuide.activeBackground5': '#17998e28',
    'editorBracketPairGuide.activeBackground6': '#8b5cf628',
  },
});

/**
 * Returns the resolved Monaco theme name based on the current app theme.
 * Call this inside a component that has access to document.documentElement.
 */
export function getMonacoTheme(): string {
  if (typeof document === 'undefined') return 'wrongstack-dark';
  return document.documentElement.classList.contains('dark')
    ? 'wrongstack-dark'
    : 'wrongstack-light';
}
