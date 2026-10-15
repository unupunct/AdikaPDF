/**
 * A guide page as safe HTML: Markdown through marked (its own instance, GFM),
 * headings with the same anchors as parsePage, pictures pointed at the
 * bundled assets, then the app's HTML sanitiser (no scripts, no remote
 * pictures, no event handlers).
 */
import { Marked, type Tokens } from 'marked';
import { sanitizeHtml } from '@/lib/pdf/email';
import { plainInline, resolveImage, slugify } from './guide';

export function renderGuideHtml(markdown: string, images: Record<string, string>): string {
  const used = new Map<string, number>();
  const md = new Marked({ gfm: true, async: false });
  md.use({
    renderer: {
      heading(this: { parser: { parseInline: (t: Tokens.Heading['tokens']) => string } }, token: Tokens.Heading) {
        const base = slugify(plainInline(token.text));
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        return `<h${token.depth} id="${id}" tabindex="-1">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
    },
  });
  const html = md.parse(markdown.replace(/^﻿/, '')) as string;
  return sanitizeHtml(html, { allowRemote: false, resolveRef: (ref) => resolveImage(ref, images), blocked: 0 });
}
