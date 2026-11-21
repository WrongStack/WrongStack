import type { BrowserElementSelection } from '@wrongstack/primitives';

const STYLE_KEYS = [
  'display',
  'position',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'padding',
  'margin',
  'border',
  'border-radius',
  'gap',
  'align-items',
  'justify-content',
];

/** The program runs in the page's main world, where the page can patch the builtins it
 * uses: re-apply every bound and type here, in our own realm (F564). */
export function boundBrowserSelection(
  raw: unknown,
): Omit<BrowserElementSelection, 'url' | 'title' | 'capturedAt' | 'image'> {
  const field = (from: unknown, key: string) => (from as Record<string, unknown> | null)?.[key];
  const text = (from: unknown, key: string, max: number) => {
    const value = field(from, key);
    return typeof value === 'string' ? value.slice(0, max) : '';
  };
  const box = <K extends string>(from: unknown, keys: K[]) =>
    Object.fromEntries(
      keys.map((key) => {
        const value = field(from, key);
        return [key, typeof value === 'number' && Number.isFinite(value) ? value : 0];
      }),
    ) as Record<K, number>;
  const styles = field(raw, 'styles');
  return {
    selector: text(raw, 'selector', 2048),
    tag: text(raw, 'tag', 100),
    role: text(raw, 'role', 100),
    text: text(raw, 'text', 1000),
    styles: Object.fromEntries(STYLE_KEYS.map((key) => [key, text(styles, key, 200)])),
    bounds: box(field(raw, 'bounds'), ['x', 'y', 'width', 'height']),
    viewport: box(field(raw, 'viewport'), ['width', 'height']),
  };
}

/** Fixed browser-side read program. Only validated numeric coordinates are inserted. */
export function browserPointExpression(x: number, y: number): string {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
    throw new Error('Browser coordinates must be finite fractions from 0 to 1');
  return `(${INSPECT_POINT})(${JSON.stringify({ x, y })})`;
}

const INSPECT_POINT = `({x,y}) => {
  const width = innerWidth, height = innerHeight;
  let element = document.elementFromPoint(Math.min(width-1, x*width), Math.min(height-1, y*height));
  if (!element) throw new Error('No visible element at this point');
  for (let depth=0; depth<16 && element.shadowRoot; depth++) {
    const next = element.shadowRoot.elementFromPoint(Math.min(width-1,x*width), Math.min(height-1,y*height));
    if (!next || next === element) break;
    element = next;
  }
  const selectorFor = (node) => {
    const parts = [];
    for (let depth=0; node && depth<32; depth++) {
      const root = node.getRootNode();
      if (node.id && root.querySelectorAll('#'+CSS.escape(node.id)).length === 1) {
        parts.unshift('#'+CSS.escape(node.id));
        if (root.host) { parts.unshift('>>'); node = root.host; continue; }
        break;
      }
      const tag = node.localName;
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((child) => child.localName === tag) : [node];
      parts.unshift(tag+(siblings.length>1 ? ':nth-of-type('+(siblings.indexOf(node)+1)+')' : ''));
      if (node.parentElement) { parts.unshift('>'); node = node.parentElement; }
      else if (root.host) { parts.unshift('>>'); node = root.host; }
      else break;
    }
    if (parts[0] === '>' || parts[0] === '>>') parts.shift();
    return parts.join(' ');
  };
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const styles = {};
  for (const key of ${JSON.stringify(STYLE_KEYS)})
    styles[key] = style.getPropertyValue(key).slice(0,200);
  const privateField = element.closest('input,textarea,[contenteditable]');
  return { selector:selectorFor(element).slice(0,2048), tag:element.localName,
    role:(element.getAttribute('role')||'').slice(0,100),
    text:privateField ? '' : (element.innerText || '').slice(0,1000), styles,
    bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, viewport:{width,height} };
}`;
