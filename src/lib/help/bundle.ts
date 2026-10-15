/**
 * The guide bundled into the app: every docs/guide/<lang>/*.md as text and
 * every picture in docs/guide/img/<lang>/ as an asset URL (works offline).
 */
const markdown = import.meta.glob('/docs/guide/*/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const pictures = import.meta.glob('/docs/guide/img/*/*.png', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** Path → Markdown of every guide page. */
export const GUIDE_FILES: Record<string, string> = markdown;

/** "en/efactura-create.png" → URL of the bundled picture. */
export const GUIDE_IMAGES: Record<string, string> = Object.fromEntries(
  Object.entries(pictures).map(([path, url]) => {
    const m = /\/img\/([^/]+)\/([^/]+)$/.exec(path);
    return [m ? `${m[1]}/${m[2]}` : path, url];
  }),
);
