import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGuide, fold, groupOf, guideLangFor, imageKey, PAGE_ORDER, pageKey, parsePage, parseTopic, resolveImage, resolveLink, searchGuide, slugify } from '@/lib/help/guide';
import { HELP_CONTEXT, HELP_TOPICS, helpTopicFor } from '@/lib/help/context';
import { renderGuideHtml } from '@/lib/help/render';
import { GUIDE_FILES, GUIDE_IMAGES } from '@/lib/help/bundle';
import { useHelp } from '@/store/help';

const page = (md: string) => parsePage('p', 'en', md);

describe('guide pages', () => {
  it('slugs headings as GitHub does', () => {
    expect(slugify('Sign with a certificate file (.pfx or .p12)')).toBe('sign-with-a-certificate-file-pfx-or-p12');
    expect(slugify('Simple electronic signature (Fill & Sign)')).toBe('simple-electronic-signature-fill--sign');
    expect(slugify('Semnătură cu certificat în Windows')).toBe('semnătură-cu-certificat-în-windows');
    expect(slugify('Step 1: register')).toBe('step-1-register');
  });

  it('reads the title, headings with unique anchors and plain-text sections', () => {
    const p = page('# Title\n\nIntro **bold** [link](x.md).\n\n## One\n\nText `code`.\n\n## One\n\n| a | b |\n| --- | --- |\n| c | d |\n\n```\n## not a heading\n```\n');
    expect(p.title).toBe('Title');
    expect(p.headings.map((h) => h.id)).toEqual(['title', 'one', 'one-1']);
    expect(p.sections.map((s) => s.anchor)).toEqual([null, 'one', 'one-1']);
    expect(p.sections[0].text).toBe('Intro bold link.');
    expect(p.sections[1].text).toBe('Text code.');
    expect(p.sections[2].text).toContain('c d');
    expect(p.sections[2].text).not.toContain('---');
  });

  it('knows the page and language of a path', () => {
    expect(pageKey('/docs/guide/ro/efactura-create.md')).toEqual({ lang: 'ro', id: 'efactura-create' });
    expect(pageKey('C:\\x\\docs\\guide\\en\\index.md')).toEqual({ lang: 'en', id: 'index' });
    expect(pageKey('/docs/guide/img/en/a.png')).toBeNull();
  });
});

describe('language', () => {
  const files = {
    '/docs/guide/en/index.md': '# Start',
    '/docs/guide/en/signing-sign.md': '# Sign',
    '/docs/guide/en/efactura-read.md': '# Read',
    '/docs/guide/ro/index.md': '# Început',
    '/docs/guide/ro/signing-sign.md': '# Semnare',
  };

  it('uses the interface language when the guide has it, page by page', () => {
    const g = buildGuide(files, 'ro');
    expect(g.lang).toBe('ro');
    expect(g.fallback).toBe(false);
    expect(g.byId.get('index')?.title).toBe('Început');
    // No Romanian page: the English one.
    expect(g.byId.get('efactura-read')).toMatchObject({ lang: 'en', title: 'Read' });
  });

  it('falls back to English for languages without a guide', () => {
    for (const l of ['de', 'fr', 'hu', 'it', 'es']) {
      const g = buildGuide(files, l);
      expect(g.lang).toBe('en');
      expect(g.fallback).toBe(true);
      expect(g.byId.get('index')?.title).toBe('Start');
    }
    expect(guideLangFor('en')).toBe('en');
    expect(guideLangFor('ro')).toBe('ro');
    expect(guideLangFor('de')).toBe('en');
  });

  it('orders the pages as the table of contents and groups them', () => {
    const g = buildGuide(files, 'en');
    expect(g.pages.map((p) => p.id)).toEqual(['index', 'efactura-read', 'signing-sign']);
    expect(groupOf('index')).toBe('start');
    expect(groupOf('getting-started')).toBe('start');
    expect(groupOf('efactura-create')).toBe('efactura');
    expect(groupOf('signing-verify')).toBe('signing');
  });
});

describe('search', () => {
  const guide = buildGuide(
    {
      '/docs/guide/ro/a.md': '# Semnătură digitală\n\nText despre token.\n\n## Marcă temporală\n\nServerul de marcă temporală.',
      '/docs/guide/ro/b.md': '# Factura\n\n## Trimitere în SPV\n\nÎncărcarea în SPV la ANAF. SPV.',
    },
    'ro',
  );

  it('ignores case and diacritics', () => {
    expect(fold('Semnătură ȘI Țară')).toBe('semnatura si tara');
    const hits = searchGuide(guide, 'semnatura');
    expect(hits[0]).toMatchObject({ page: 'a', title: 'Semnătură digitală' });
    expect(searchGuide(guide, 'MARCA temporala')[0]).toMatchObject({ page: 'a', anchor: 'marcă-temporală', heading: 'Marcă temporală' });
  });

  it('needs every word and ranks headings first', () => {
    expect(searchGuide(guide, 'spv token')).toEqual([]);
    const spv = searchGuide(guide, 'spv');
    expect(spv[0]).toMatchObject({ page: 'b', anchor: 'trimitere-în-spv' });
    expect(spv[0].snippet).toMatch(/SPV/);
    expect(searchGuide(guide, '   ')).toEqual([]);
  });
});

describe('links and images', () => {
  const known = new Set(['index', 'signing-sign', 'efactura-create']);

  it('resolves links between pages, headings and the web', () => {
    expect(resolveLink('signing-sign.md', 'index', known)).toEqual({ kind: 'page', page: 'signing-sign', anchor: null });
    expect(resolveLink('./efactura-create.md#lines', 'index', known)).toEqual({ kind: 'page', page: 'efactura-create', anchor: 'lines' });
    expect(resolveLink('../ro/signing-sign.md', 'index', known)).toEqual({ kind: 'page', page: 'signing-sign', anchor: null });
    expect(resolveLink('#after-a-crash', 'getting-started', known)).toEqual({ kind: 'page', page: 'getting-started', anchor: 'after-a-crash' });
    expect(resolveLink('#semn%C4%83tur%C4%83', 'index', known)).toEqual({ kind: 'page', page: 'index', anchor: 'semnătură' });
    expect(resolveLink('https://www.anaf.ro/', 'index', known)).toEqual({ kind: 'external', url: 'https://www.anaf.ro/' });
    expect(resolveLink('missing.md', 'index', known)).toEqual({ kind: 'none' });
    expect(resolveLink('javascript:alert(1)', 'index', known)).toEqual({ kind: 'none' });
    expect(resolveLink('file:///C:/x.md', 'index', known)).toEqual({ kind: 'none' });
  });

  it('finds bundled pictures, the English one when a translation has none', () => {
    const images = { 'en/a.png': '/assets/a-en.png', 'ro/a.png': '/assets/a-ro.png', 'en/b.png': '/assets/b-en.png' };
    expect(imageKey('../img/ro/a.png')).toBe('ro/a.png');
    expect(resolveImage('../img/ro/a.png', images)).toBe('/assets/a-ro.png');
    expect(resolveImage('../img/ro/b.png', images)).toBe('/assets/b-en.png');
    expect(resolveImage('https://example.com/x.png', images)).toBeNull();
  });

  it('renders safe HTML with heading anchors and bundled pictures', () => {
    const html = renderGuideHtml('# Title\n\n## Lines\n\n![Shot](../img/en/a.png)\n\n<script>alert(1)</script>\n\n<img src="https://tracker.example/x.png">\n\n[x](javascript:alert(1)) <a href="#" onclick="alert(1)">y</a>', { 'en/a.png': 'assets/a.png' });
    expect(html).toContain('<h2 id="lines"');
    expect(html).toContain('src="assets/a.png"');
    expect(html).not.toMatch(/<script|onclick|javascript:|tracker\.example/);
  });

  it('parses topics', () => {
    expect(parseTopic('signing-sign#sign-with-a-usb-token-or-smart-card')).toEqual({ page: 'signing-sign', anchor: 'sign-with-a-usb-token-or-smart-card' });
    expect(parseTopic(null)).toEqual({ page: 'index', anchor: null });
  });
});

// ---------------------------------------------------------------- the real guide

const pages = (lang: 'en' | 'ro') => buildGuide(Object.fromEntries(Object.entries(GUIDE_FILES).filter(([p]) => p.includes(`/${lang}/`))), lang);
const idsOf = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

describe('the bundled guide', () => {
  it('has every page in English and Romanian', () => {
    const en = pages('en').pages.map((p) => p.id).sort();
    const ro = pages('ro').pages.map((p) => p.id).sort();
    expect(en).toEqual([...PAGE_ORDER].sort());
    expect(ro).toEqual(en);
  });

  it('pages are short task pages', () => {
    for (const lang of ['en', 'ro'] as const) {
      for (const p of pages(lang).pages) {
        const words = p.sections.map((s) => `${s.heading} ${s.text}`).join(' ').split(/\s+/).filter(Boolean).length;
        expect(words, `${lang}/${p.id}`).toBeGreaterThan(300);
        expect(words, `${lang}/${p.id}`).toBeLessThan(1300);
      }
    }
  });

  it('every link leads to an existing page and heading, every picture exists', () => {
    const problems: string[] = [];
    for (const lang of ['en', 'ro'] as const) {
      const g = pages(lang);
      const anchors = new Map(g.pages.map((p) => [p.id, idsOf(renderGuideHtml(p.markdown, GUIDE_IMAGES))]));
      for (const p of g.pages) {
        for (const m of p.markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
          const href = m[1];
          if (m[0].startsWith('!')) {
            const key = imageKey(href);
            if (!key || !GUIDE_IMAGES[key]) problems.push(`${lang}/${p.id}: picture ${href}`);
            else if (!key.startsWith(`${lang}/`)) problems.push(`${lang}/${p.id}: picture of another language ${href}`);
            continue;
          }
          const t = resolveLink(href, p.id, g.byId);
          if (t.kind === 'none') problems.push(`${lang}/${p.id}: link ${href}`);
          if (t.kind === 'page' && t.anchor && !anchors.get(t.page)?.has(t.anchor)) problems.push(`${lang}/${p.id}: anchor ${href}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every picture in docs/guide/img is used and exists in both languages', () => {
    const dir = join(process.cwd(), 'docs', 'guide', 'img');
    const en = readdirSync(join(dir, 'en')).sort();
    const ro = readdirSync(join(dir, 'ro')).sort();
    expect(ro).toEqual(en);
    const all = Object.values(GUIDE_FILES).join('\n');
    expect(en.filter((f) => !all.includes(`/${f})`))).toEqual([]);
  });
});

describe('context help', () => {
  /** Topics named in the dialogs' help="…" props. */
  const dialogTopics = () => {
    const dir = join(process.cwd(), 'src', 'components');
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.tsx')) for (const m of readFileSync(join(d, e.name), 'utf8').matchAll(/\shelp="([^"]+)"/g)) out.push(m[1]);
      }
    };
    walk(dir);
    return out;
  };

  it('maps the dialogs to pages', () => {
    expect(helpTopicFor('anaf')).toBe('efactura-anaf-send');
    expect(helpTopicFor('einvoiceNew')).toBe('efactura-create');
    expect(helpTopicFor('batchsign')).toBe('signing-batch');
    expect(helpTopicFor('verify')).toBe('signing-verify');
    expect(helpTopicFor('compress')).toBe('index');
    expect(helpTopicFor(null)).toBe('index');
  });

  it('every topic of a dialog exists in both languages, with its heading', () => {
    const topics = [...Object.values(HELP_CONTEXT), ...Object.values(HELP_TOPICS), ...dialogTopics()];
    expect(dialogTopics().length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const lang of ['en', 'ro'] as const) {
      const g = pages(lang);
      for (const t of topics) {
        const { page, anchor } = parseTopic(t);
        const p = g.byId.get(page);
        if (!p) problems.push(`${lang}: page ${t}`);
        else if (anchor && !idsOf(renderGuideHtml(p.markdown, GUIDE_IMAGES)).has(anchor)) problems.push(`${lang}: heading ${t}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('help history', () => {
  it('goes back and forward', () => {
    const h = useHelp.getState();
    h.close();
    h.openHelp('signing-sign#x');
    expect(useHelp.getState()).toMatchObject({ open: true, page: 'signing-sign', anchor: 'x', back: [] });
    useHelp.getState().go('signing-verify');
    useHelp.getState().go('index');
    useHelp.getState().goBack();
    expect(useHelp.getState().page).toBe('signing-verify');
    useHelp.getState().goBack();
    expect(useHelp.getState()).toMatchObject({ page: 'signing-sign', anchor: 'x' });
    useHelp.getState().goForward();
    expect(useHelp.getState().page).toBe('signing-verify');
    // A new page drops the forward list.
    useHelp.getState().go('efactura-read');
    expect(useHelp.getState().forward).toEqual([]);
    // Opening from a dialog while open navigates (and can go back).
    useHelp.getState().openHelp('efactura-anaf-send');
    expect(useHelp.getState().page).toBe('efactura-anaf-send');
    useHelp.getState().goBack();
    expect(useHelp.getState().page).toBe('efactura-read');
    useHelp.getState().close();
  });
});
