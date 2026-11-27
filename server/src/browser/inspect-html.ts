import type { Page } from 'playwright-core';

export interface DesignTokens {
  backgroundColors: string[];
  textColors: string[];
  borderColors: string[];
  fontFamilies: string[];
  fontSizes: string[];
  borderRadii: string[];
}

export interface InspectedElementStyle {
  tag: string;
  role?: string;
  type?: string;
  label?: string;
  styles: {
    backgroundColor?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    borderRadius?: string;
    border?: string;
    padding?: string;
    boxShadow?: string;
    display?: string;
  };
}

export interface PageHtmlInspectResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  selector: string | null;
  html: string;
  htmlTruncated: boolean;
  tokens: DesignTokens;
  keyElements: InspectedElementStyle[];
  formatted: string;
}

export type RawHtmlInspectPayload = Omit<PageHtmlInspectResult, 'formatted'>;

export function formatHtmlInspectResult(data: RawHtmlInspectPayload): PageHtmlInspectResult {
  const lines: string[] = [
    `URL: ${data.url}`,
    `Title: ${data.title}`,
    `Viewport: ${data.viewport.width}x${data.viewport.height}`,
  ];
  if (data.selector) {
    lines.push(`Selector: ${data.selector}`);
  }
  lines.push('');
  lines.push('Design Tokens (computed CSS):');
  lines.push(JSON.stringify(data.tokens, null, 2));

  if (data.keyElements.length > 0) {
    lines.push('');
    lines.push(`Key Elements (${data.keyElements.length}):`);
    lines.push(JSON.stringify(data.keyElements, null, 2));
  }

  lines.push('');
  lines.push(
    data.htmlTruncated
      ? `Cleaned HTML (truncated to ${data.html.length} chars):`
      : `Cleaned HTML (${data.html.length} chars):`,
  );
  lines.push('```html');
  lines.push(data.html);
  lines.push('```');

  return {
    ...data,
    formatted: lines.join('\n'),
  };
}

export async function extractCleanedHtmlAndTokens(
  page: Page,
  opts?: { selector?: string; maxHtmlChars?: number },
): Promise<PageHtmlInspectResult> {
  const selector = opts?.selector?.trim() || null;
  const maxHtmlChars = Math.max(2000, Math.min(60_000, opts?.maxHtmlChars ?? 20_000));

  const raw = await page.evaluate(
    ({ sel, limit }: { sel: string | null; limit: number }) => {
      const rootEl: Element | null = sel ? document.querySelector(sel) : document.body;
      if (!rootEl) {
        throw new Error(
          sel ? `Selector "${sel}" tidak ditemukan di halaman.` : 'Elemen body halaman tidak tersedia.',
        );
      }

      const isVisible = (el: Element): boolean => {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const isTransparent = (color: string): boolean =>
        !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';

      const addFreq = (map: Map<string, number>, val: string) => {
        const trimmed = val.trim();
        if (!trimmed) return;
        map.set(trimmed, (map.get(trimmed) ?? 0) + 1);
      };

      const topKeys = (map: Map<string, number>, max: number): string[] =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, max)
          .map(([k]) => k);

      const bgFreq = new Map<string, number>();
      const textFreq = new Map<string, number>();
      const borderFreq = new Map<string, number>();
      const fontFreq = new Map<string, number>();
      const sizeFreq = new Map<string, number>();
      const radiusFreq = new Map<string, number>();

      const keyElements: Array<{
        tag: string;
        role?: string;
        type?: string;
        label?: string;
        styles: Record<string, string>;
      }> = [];

      const keySelector = 'h1, h2, h3, header, nav, main, form, input, textarea, select, button, a[href]';
      const keySet = new Set<Element>(Array.from(rootEl.querySelectorAll(keySelector)));
      if (rootEl.matches(keySelector)) keySet.add(rootEl);

      const allElements: Element[] = [rootEl, ...Array.from(rootEl.querySelectorAll('*'))];
      let walked = 0;

      for (const el of allElements) {
        if (walked >= 200) break;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
        if (!isVisible(el)) continue;
        walked += 1;

        const cs = window.getComputedStyle(el);
        if (!isTransparent(cs.backgroundColor)) addFreq(bgFreq, cs.backgroundColor);
        if (!isTransparent(cs.color)) addFreq(textFreq, cs.color);
        if (cs.borderTopWidth !== '0px' && !isTransparent(cs.borderTopColor)) {
          addFreq(borderFreq, cs.borderTopColor);
        }
        if (cs.fontFamily) addFreq(fontFreq, cs.fontFamily);
        if (cs.fontSize) addFreq(sizeFreq, cs.fontSize);
        if (cs.borderRadius && cs.borderRadius !== '0px') addFreq(radiusFreq, cs.borderRadius);

        if (keySet.has(el) && keyElements.length < 40) {
          const inputEl = el as HTMLInputElement;
          if (tag === 'input' && inputEl.type === 'hidden') continue;
          const rawLabel =
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            (el as HTMLElement).innerText ||
            el.getAttribute('name') ||
            '';
          const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80);
          const role = el.getAttribute('role') || undefined;
          const type = tag === 'input' ? (inputEl.type || 'text').toLowerCase() : undefined;

          const styles: Record<string, string> = {};
          if (!isTransparent(cs.backgroundColor)) styles.backgroundColor = cs.backgroundColor;
          if (!isTransparent(cs.color)) styles.color = cs.color;
          if (cs.fontFamily) styles.fontFamily = cs.fontFamily;
          if (cs.fontSize) styles.fontSize = cs.fontSize;
          if (cs.fontWeight && cs.fontWeight !== '400') styles.fontWeight = cs.fontWeight;
          if (cs.borderRadius && cs.borderRadius !== '0px') styles.borderRadius = cs.borderRadius;
          if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') {
            styles.border = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
          }
          if (cs.padding && cs.padding !== '0px') styles.padding = cs.padding;
          if (cs.boxShadow && cs.boxShadow !== 'none') styles.boxShadow = cs.boxShadow;
          if (cs.display) styles.display = cs.display;

          keyElements.push({
            tag,
            ...(role ? { role } : {}),
            ...(type ? { type } : {}),
            ...(label ? { label } : {}),
            styles,
          });
        }
      }

      // Build cleaned HTML clone
      const clone = rootEl.cloneNode(true) as Element;
      const stripTags = clone.querySelectorAll('script, style, noscript, template, iframe');
      for (const node of stripTags) node.remove();

      const sanitizeNode = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        if (el.hasAttribute('hidden')) {
          el.remove();
          return;
        }
        const styleAttr = (el.getAttribute('style') ?? '').toLowerCase();
        if (/display\s*:\s*none/.test(styleAttr) || /visibility\s*:\s*hidden/.test(styleAttr)) {
          el.remove();
          return;
        }
        if (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'password') {
          el.removeAttribute('value');
        }
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'nonce' || name === 'data-atelier-ref') {
            el.removeAttribute(attr.name);
            continue;
          }
          if (name.startsWith('data-') && attr.value.length > 80) {
            el.removeAttribute(attr.name);
            continue;
          }
          if ((name === 'src' || name === 'href') && attr.value.startsWith('data:')) {
            el.setAttribute(attr.name, 'data:[omitted]');
          }
        }
        if (tag === 'svg' && el.outerHTML.length > 500) {
          el.innerHTML = '<!-- svg omitted -->';
          return;
        }
        for (const child of Array.from(el.children)) {
          sanitizeNode(child);
        }
      };

      sanitizeNode(clone);

      const rawHtml = clone.outerHTML
        .replace(/<!--(?!\s*svg omitted\s*-->)[\s\S]*?-->/g, '')
        .replace(/\s*\n\s*/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      const htmlTruncated = rawHtml.length > limit;
      const html = htmlTruncated ? `${rawHtml.slice(0, limit)}\n<!-- truncated -->` : rawHtml;

      return {
        url: window.location.href,
        title: document.title || '',
        viewport: { width: window.innerWidth, height: window.innerHeight },
        selector: sel,
        html,
        htmlTruncated,
        tokens: {
          backgroundColors: topKeys(bgFreq, 12),
          textColors: topKeys(textFreq, 10),
          borderColors: topKeys(borderFreq, 8),
          fontFamilies: topKeys(fontFreq, 6),
          fontSizes: topKeys(sizeFreq, 12),
          borderRadii: topKeys(radiusFreq, 8),
        },
        keyElements,
      };
    },
    { sel: selector, limit: maxHtmlChars },
  );

  return formatHtmlInspectResult(raw);
}
