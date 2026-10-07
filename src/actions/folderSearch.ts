/** Home → Search folders: an index of the PDFs in chosen folders, searched instantly. */
import { usePDFStore } from '@/store/usePDFStore';
import { openPdfPath, withBusy } from './document';
import { appDataRead, appDataWrite, listDir, readFile } from '@/lib/platform';
import { emptyIndex, indexPlan, type SearchIndex } from '@/lib/searchIndex';

const FILE = 'search-index.json';
let cache: SearchIndex | null = null;

export async function loadSearchIndex(): Promise<SearchIndex> {
  if (cache) return cache;
  try {
    const raw = await appDataRead(FILE);
    cache = raw.length ? (JSON.parse(new TextDecoder().decode(raw)) as SearchIndex) : emptyIndex();
  } catch {
    cache = emptyIndex();
  }
  return cache;
}

async function save(index: SearchIndex): Promise<void> {
  cache = index;
  await appDataWrite(FILE, new TextEncoder().encode(JSON.stringify(index)));
}

export async function setSearchFolders(folders: string[]): Promise<SearchIndex> {
  const index = await loadSearchIndex();
  const next = { ...index, folders };
  // Files outside the folders are no longer searched.
  const inside = (p: string) => folders.some((f) => p.toLowerCase().startsWith(f.toLowerCase().replace(/[\\/]*$/, '\\')));
  next.files = Object.fromEntries(Object.entries(index.files).filter(([p]) => inside(p)));
  await save(next);
  return next;
}

/** All PDFs under a folder (subfolders too). */
async function findPdfs(folder: string, out: Array<{ path: string; size: number; modified: number }>, depth = 0): Promise<void> {
  if (depth > 12) return;
  let entries;
  try {
    entries = await listDir(folder);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDir) {
      if (!/^(\$RECYCLE\.BIN|System Volume Information|node_modules|\.git)$/i.test(e.name)) await findPdfs(e.path, out, depth + 1);
    } else if (/\.pdf$/i.test(e.name) && e.size < 300 * 1024 * 1024) out.push({ path: e.path, size: e.size, modified: e.modified });
  }
}

/** Reads the text of new and changed PDFs; drops the removed ones. */
export async function updateSearchIndex(): Promise<SearchIndex | undefined> {
  const index = await loadSearchIndex();
  if (!index.folders.length) return index;
  return withBusy('Updating the search index…', async (progress, signal) => {
    const found: Array<{ path: string; size: number; modified: number }> = [];
    progress('Looking for PDF files…', null);
    for (const f of index.folders) await findPdfs(f, found);
    const plan = indexPlan(index, found);
    const next: SearchIndex = { ...index, files: { ...index.files } };
    for (const p of plan.toDrop) delete next.files[p];
    const meta = new Map(found.map((f) => [f.path, f]));
    const { openPdf } = await import('@/lib/pdf/pdfService');
    for (let i = 0; i < plan.toRead.length; i++) {
      // Cancelled: what was read so far stays in the index (saved below).
      if (signal.aborted) {
        await save(next);
        signal.throwIfAborted();
      }
      const path = plan.toRead[i];
      progress(`Reading ${path.split(/[\\/]/).pop()} (${i + 1} of ${plan.toRead.length})`, (i + 1) / plan.toRead.length);
      const m = meta.get(path)!;
      try {
        const pdf = await openPdf(await readFile(path));
        try {
          const pages: string[] = [];
          for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            const tc = await page.getTextContent();
            pages.push(tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join(''));
            page.cleanup();
          }
          next.files[path] = { path, size: m.size, modified: m.modified, pages };
        } finally {
          await pdf.loadingTask.destroy();
        }
      } catch (e) {
        next.files[path] = { path, size: m.size, modified: m.modified, pages: [], error: e instanceof Error ? e.name === 'PasswordRequiredError' ? 'password protected' : e.message : String(e) };
      }
      // Saved now and then, so a long first run is not lost.
      if (i % 25 === 24) await save(next);
    }
    next.updated = Date.now();
    await save(next);
    return next;
  });
}

/** Opens a result at its page. */
export async function openSearchResult(path: string, page: number): Promise<void> {
  if (!(await openPdfPath(path))) return;
  // The viewer shows the first page once the document is laid out; jump after that.
  const go = () => {
    const s = usePDFStore.getState();
    const target = s.pages[page - 1];
    if (!target) return;
    s.setCurrentPage(target.id);
    s.scrollToPage(target.id);
  };
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  go();
  setTimeout(go, 250);
}
