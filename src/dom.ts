/**
 * DOM helpers extracted from client.ts. Kept transport-free so client.ts
 * stays focused on bridge wiring; `dsgo.content.applyBlockStyles` delegates
 * straight to `applyBlockStyles` here.
 */

import type { Post, PostContentStyles } from './types';

/**
 * Inject the host's block + theme stylesheets into the current document so
 * post HTML rendered into it picks up WP's normal block styling.
 *
 * Idempotent and dedup'd: a `data-dsgo-style` attribute is stamped on every
 * inserted node with a stable key (the URL for `<link>`s, a content hash for
 * `<style>`s) so repeated calls — including ones triggered by SPA route
 * changes — never duplicate nodes.
 *
 * Returns the count of new nodes appended this call (0 when the input is
 * null/empty or all nodes were already present).
 */
export function applyBlockStyles(input: PostContentStyles | Post | null | undefined): number {
  if (typeof document === 'undefined' || input == null) return 0;
  const styles: PostContentStyles | null =
    'content_styles' in (input as object)
      ? (input as Post).content_styles
      : (input as PostContentStyles);
  if (!styles) return 0;

  const head = document.head ?? document.getElementsByTagName('head')[0];
  if (!head) return 0;

  let appended = 0;
  const existing = new Set<string>();
  head.querySelectorAll('[data-dsgo-style]').forEach((el) => {
    const k = (el as HTMLElement).getAttribute('data-dsgo-style');
    if (k) existing.add(k);
  });

  for (const url of styles.links ?? []) {
    if (typeof url !== 'string' || url === '') continue;
    if (existing.has('link:' + url)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.setAttribute('data-dsgo-style', 'link:' + url);
    head.appendChild(link);
    existing.add('link:' + url);
    appended++;
  }

  if (typeof styles.inline === 'string' && styles.inline !== '') {
    const key = 'inline:' + cheapHash(styles.inline);
    if (!existing.has(key)) {
      const style = document.createElement('style');
      style.setAttribute('data-dsgo-style', key);
      style.textContent = styles.inline;
      head.appendChild(style);
      appended++;
    }
  }
  return appended;
}

export function cheapHash(s: string): string {
  // FNV-1a 32-bit; collision risk doesn't matter — we only need stable
  // dedup keys for inline-style payloads within one document.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
