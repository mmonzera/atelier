import type { Page } from 'playwright-core';

export interface SnapshotElement {
  ref: string;
  tag: string;
  role: string;
  type?: string;
  name: string;
  value?: string;
  disabled?: boolean;
}

export interface PageSnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  text: string;
  formatted: string;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[contenteditable="true"]',
].join(', ');

export async function capturePageSnapshot(
  page: Page,
  maxChars = 6000,
): Promise<PageSnapshotResult> {
  const limit = Math.max(500, Math.min(20_000, maxChars));

  const data = await page.evaluate(
    ({ selector, textLimit }: { selector: string; textLimit: number }) => {
      for (const old of document.querySelectorAll('[data-atelier-ref]')) {
        old.removeAttribute('data-atelier-ref');
      }

      const isVisible = (el: Element): boolean => {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rects = htmlEl.getClientRects();
        if (!rects || rects.length === 0) return false;
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const elements: Array<{
        ref: string;
        tag: string;
        role: string;
        type?: string;
        name: string;
        value?: string;
        disabled?: boolean;
      }> = [];

      const candidates = Array.from(document.querySelectorAll(selector));
      let counter = 0;

      for (const el of candidates) {
        if (counter >= 150) break;
        if (!isVisible(el)) continue;
        const tag = el.tagName.toLowerCase();
        const inputEl = el as HTMLInputElement;
        if (tag === 'input' && inputEl.type === 'hidden') continue;

        counter += 1;
        const ref = `e${counter}`;
        el.setAttribute('data-atelier-ref', ref);

        const role =
          el.getAttribute('role') ||
          (tag === 'a'
            ? 'link'
            : tag === 'button'
              ? 'button'
              : tag === 'select'
                ? 'combobox'
                : tag === 'textarea'
                  ? 'textbox'
                  : tag === 'input'
                    ? inputEl.type === 'checkbox'
                      ? 'checkbox'
                      : inputEl.type === 'radio'
                        ? 'radio'
                        : inputEl.type === 'submit' || inputEl.type === 'button'
                          ? 'button'
                          : 'textbox'
                    : 'interactive');

        const ariaLabel = el.getAttribute('aria-label')?.trim();
        const placeholder = el.getAttribute('placeholder')?.trim();
        const titleAttr = el.getAttribute('title')?.trim();
        let labelText = '';
        if (tag === 'input' && inputEl.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`);
          labelText = lbl?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        }
        const innerText = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
        const name = (ariaLabel || labelText || innerText || placeholder || titleAttr || el.getAttribute('name') || '')
          .slice(0, 120);

        let value: string | undefined;
        if (tag === 'input') {
          if (inputEl.type === 'password') {
            value = '[password]';
          } else if (inputEl.type === 'checkbox' || inputEl.type === 'radio') {
            value = inputEl.checked ? 'checked' : 'unchecked';
          } else if (inputEl.value) {
            value = inputEl.value.slice(0, 80);
          }
        } else if (tag === 'textarea' || tag === 'select') {
          const val = (el as HTMLTextAreaElement | HTMLSelectElement).value;
          if (val) value = val.slice(0, 80);
        }

        const disabled = Boolean((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true');

        elements.push({
          ref,
          tag,
          role,
          ...(tag === 'input' && inputEl.type ? { type: inputEl.type } : {}),
          name,
          ...(value !== undefined ? { value } : {}),
          ...(disabled ? { disabled: true } : {}),
        });
      }

      const rawText = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
      const truncated = rawText.length > textLimit;
      const text = truncated ? `${rawText.slice(0, textLimit)}\n… [terpotong]` : rawText;

      return {
        url: window.location.href,
        title: document.title || '',
        elements,
        text,
      };
    },
    { selector: INTERACTIVE_SELECTOR, textLimit: limit },
  );

  const elementLines = data.elements.map((e) => {
    const parts = [`[${e.ref}]`, `<${e.tag}${e.type ? ` type="${e.type}"` : ''}>`, e.role];
    if (e.name) parts.push(`"${e.name}"`);
    if (e.value !== undefined) parts.push(`value=${JSON.stringify(e.value)}`);
    if (e.disabled) parts.push('(disabled)');
    return parts.join(' ');
  });

  const formatted = [
    `URL: ${data.url}`,
    `Title: ${data.title}`,
    '',
    `Elemen interaktif (${data.elements.length}):`,
    elementLines.length > 0 ? elementLines.join('\n') : '(tidak ada elemen interaktif terlihat)',
    '',
    'Teks halaman:',
    data.text || '(halaman kosong)',
  ].join('\n');

  return {
    ...data,
    formatted,
  };
}
