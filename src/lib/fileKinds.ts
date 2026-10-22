/** What a file is by its extension: the open / convert / drop paths share these lists. */

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif'];
export const DOCUMENT_EXTENSIONS = ['epub', 'eml', 'mht', 'mhtml', 'msg', 'xps', 'oxps'];
export const CAD_EXTENSIONS = ['dxf'];
export const OFFICE_EXTENSIONS = ['doc', 'docx', 'docm', 'dotx', 'rtf', 'odt', 'xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods', 'ppt', 'pptx', 'pptm', 'ppsx', 'odp'];
/** Rendered to PDF as web pages / Markdown / plain text (XML is read as an e-invoice instead). */
export const TEXT_EXTENSIONS = ['html', 'htm', 'xhtml', 'md', 'markdown', 'txt', 'log', 'json'];
export const EINVOICE_EXTENSIONS = ['xml', 'zip'];

/**
 * pdf: opened or inserted; image: placed on a page or made into pages;
 * office: converted by Office / LibreOffice (needs the file's location);
 * convert: converted in the app; einvoice: opened as an e-invoice.
 */
export type FileKind = 'pdf' | 'image' | 'office' | 'convert' | 'einvoice' | 'unsupported';

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function fileKind(name: string): FileKind {
  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (OFFICE_EXTENSIONS.includes(ext)) return 'office';
  if (DOCUMENT_EXTENSIONS.includes(ext) || CAD_EXTENSIONS.includes(ext) || TEXT_EXTENSIONS.includes(ext)) return 'convert';
  if (EINVOICE_EXTENSIONS.includes(ext)) return 'einvoice';
  return 'unsupported';
}

/** A guess from the MIME type a drag shows before the drop (names are not readable then); null: unknown. */
export function kindFromMime(type: string): FileKind | null {
  const t = type.toLowerCase();
  if (!t) return null;
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (/msword|ms-excel|ms-powerpoint|officedocument|opendocument|rtf|text\/csv/.test(t)) return 'office';
  if (/^text\/(html|plain|markdown)|application\/(json|epub|vnd\.ms-xpsdocument|oxps)|message\/rfc822|vnd\.ms-outlook/.test(t)) return 'convert';
  if (/xml|zip/.test(t)) return 'einvoice';
  if (/octet-stream/.test(t)) return null;
  return 'unsupported';
}
