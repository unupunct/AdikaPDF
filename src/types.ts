/**
 * Core domain model for Adika PDF Editor.
 *
 * Coordinate system: every editor object lives in the *display space* of its
 * page at scale 1 — origin top-left, y pointing down, units are PDF points,
 * and the page's total rotation already applied. Objects carry their own
 * rotation (degrees clockwise about their top-left origin), so rotating a page
 * in the organiser just rotates the objects with it.
 */

export type Rotation = 0 | 90 | 180 | 270;

export type ToolId =
  | 'selectText'
  | 'select'
  | 'pan'
  | 'text'
  | 'editText'
  | 'editImage'
  | 'editVector'
  | 'image'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'highlight'
  | 'pen'
  | 'redact'
  | 'signature'
  | 'field-text'
  | 'field-checkbox'
  | 'field-radio'
  | 'field-dropdown'
  | 'field-signature'
  | 'field-button'
  | 'field-barcode'
  | 'note'
  | 'typewriter'
  | 'markup-highlight'
  | 'markup-underline'
  | 'markup-strikeout'
  | 'markup-squiggly'
  | 'stamp'
  | 'link'
  | 'crop'
  | 'textbox'
  | 'callout'
  | 'cloud'
  | 'polygon'
  | 'polyline'
  | 'attach'
  | 'snapshot'
  | 'measure-distance'
  | 'measure-perimeter'
  | 'measure-area';

export type RibbonTab = 'home' | 'view' | 'edit' | 'comment' | 'sign' | 'organize' | 'forms' | 'security' | 'convert';

export type FontFamily = 'sans' | 'serif' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';

/** A source PDF loaded into the session (the opened file, or a merged one). */
export interface SourceDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  /** The password it was opened with (memory only: handed to another window, never written to disk). */
  password?: string;
  /** The bytes are the file as opened from disk (not rewritten), so an incremental update can be appended. */
  original?: boolean;
}

/** One page of the working document, pointing at a page of a source (or blank). */
export interface PageRef {
  id: string;
  kind: 'source' | 'blank';
  /** Source document id for `kind: 'source'`. */
  sourceId: string | null;
  /** 0-based page index inside the source. */
  sourceIndex: number;
  /** Intrinsic /Rotate of the source page (never changes). */
  baseRotation: Rotation;
  /** Rotation added by the user. Total = (base + user) % 360. */
  userRotation: Rotation;
  /** Unrotated page size in points (CropBox). */
  width: number;
  height: number;
  /**
   * Annotations of the source page (pdf.js ids, "12R") that Adika has taken
   * over: edited through an object whose `fileAnnot` points at it, or deleted
   * when no object does. pdf.js no longer draws them.
   */
  takenAnnots?: string[];
}

interface BaseObject {
  id: string;
  pageId: string;
  x: number;
  y: number;
  /** Degrees, clockwise, about (x, y). */
  rotation: number;
  opacity: number;
  locked?: boolean;
  /** Layer (optional content group) the object is drawn in when saved; page content objects only. */
  layer?: string;
  /** A comment that was already in the file: saved back into that annotation. */
  fileAnnot?: FileAnnotLink;
}

/** Link from an editor object to the annotation of the file it was made from. */
export interface FileAnnotLink {
  /** pdf.js id of the annotation ("12R"). */
  ref: string;
  /** Its /Subtype. */
  subtype: string;
  /** The object as it was taken over (JSON, without id, page and this link): unchanged objects leave the file alone. */
  base: string;
}

export interface TextObject extends BaseObject {
  type: 'text';
  width: number;
  height: number;
  text: string;
  fontFamily: FontFamily;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  color: string;
  align: TextAlign;
  lineHeight: number;
  /** Optional box fill, used by "edit existing text" to cover the original run. */
  background: string | null;
  /** Saved as a FreeText annotation (typewriter) instead of page content, so other PDF apps can edit it. */
  annotation?: boolean;
  /** Author of a typewriter comment. */
  author?: string;
  /** Text box / callout comment: border colour of the box (null = no border). */
  border?: string | null;
  /** Callout comment: the point the leader line points to, relative to (x, y). */
  callout?: { x: number; y: number } | null;
  /**
   * Replacement text (Edit text, Find & replace): page areas (display space)
   * whose original letters are deleted from the page content when saving.
   */
  replaces?: Array<{ x: number; y: number; width: number; height: number }>;
  /**
   * Edit text: the style the text has in the document. Changing only its
   * colour or size keeps the document's own font; another typeface, bold or
   * italic is written in Adika's font.
   */
  original?: { fontFamily: FontFamily; bold: boolean; italic: boolean; fontSize: number; color: string };
}

/** Comment metadata shared by annotation-type objects. */
export interface CommentMeta {
  author: string;
  /** ISO timestamps. */
  createdAt: string;
  modifiedAt: string;
  /** Review status, saved as a review-state reply. */
  reviewStatus?: import('@/lib/pdf/review').ReviewState;
}

/** Sticky note (PDF /Text annotation): an icon on the page with a popup text. */
export interface NoteObject extends BaseObject, CommentMeta {
  type: 'note';
  width: number;
  height: number;
  text: string;
  color: string;
}

export type MarkupKind = 'highlight' | 'underline' | 'strikeout' | 'squiggly';

/** Text markup over selected text (PDF /Highlight, /Underline, /StrikeOut, /Squiggly). */
export interface MarkupObject extends BaseObject, CommentMeta {
  type: 'markup';
  kind: MarkupKind;
  /** Bounding box of all quads (x, y are its top-left). */
  width: number;
  height: number;
  /** Line boxes relative to (x, y), display points. */
  quads: Array<{ x: number; y: number; width: number; height: number }>;
  color: string;
  /** The marked-up text (for the comments list). */
  selectedText: string;
  /** Optional comment on the markup. */
  text: string;
}

/** Rubber stamp (PDF /Stamp annotation): a word box such as APPROVED, or a picture. */
export interface StampObject extends BaseObject, CommentMeta {
  type: 'stamp';
  width: number;
  height: number;
  /** Stamp word ("APPROVED"); empty for picture stamps. */
  label: string;
  /** Second line, e.g. "Ana Pop, 28.09.2026 14:05". */
  subtitle: string;
  color: string;
  /** Standard stamp name written as /Name (Approved, Draft, …). */
  name: string;
  /** Picture stamp (PNG or JPEG data URL). */
  src?: string;
  /** Optional comment on the stamp. */
  text: string;
}

/** Hyperlink area (PDF /Link annotation) to a web address or a page of this document. */
export interface LinkObject extends BaseObject {
  type: 'link';
  width: number;
  height: number;
  target: { kind: 'url'; url: string } | { kind: 'page'; pageId: string };
}

/** Polygon, polyline or cloud comment (PDF /Polygon, /PolyLine, /Square with a cloudy border). */
export interface PolyObject extends BaseObject, CommentMeta {
  type: 'poly';
  kind: 'polygon' | 'polyline' | 'cloud';
  /** Local vertices [x0, y0, x1, y1, …] relative to (x, y); a cloud keeps its 4 box corners. */
  points: number[];
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  fill: string | null;
  /** Optional comment. */
  text: string;
}

/** Measurement (PDF /Line, /PolyLine or /Polygon with a /Measure dictionary, like Acrobat's Measure tool). */
export interface MeasureObject extends BaseObject, CommentMeta {
  type: 'measure';
  kind: 'distance' | 'perimeter' | 'area';
  /** Local vertices [x0, y0, x1, y1, …] relative to (x, y). */
  points: number[];
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  /** Drawing scale used for the value. */
  scale: import('@/lib/measure').MeasureScale;
  /** Optional comment. */
  text: string;
}

/** File attachment comment (PDF /FileAttachment annotation): a paperclip icon carrying a file. */
export interface AttachmentObject extends BaseObject, CommentMeta {
  type: 'attachment';
  width: number;
  height: number;
  fileName: string;
  mime: string;
  /** File content, base64. */
  data: string;
  size: number;
  color: string;
  /** Description shown as the comment. */
  text: string;
}

export interface ImageObject extends BaseObject {
  type: 'image';
  width: number;
  height: number;
  /** PNG or JPEG data URL. */
  src: string;
  /** Crop rectangle in source-image pixels. */
  crop: { x: number; y: number; width: number; height: number } | null;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ShapeObject extends BaseObject {
  type: 'rect' | 'ellipse' | 'highlight';
  width: number;
  height: number;
  stroke: string | null;
  strokeWidth: number;
  fill: string | null;
}

/**
 * A drawing that was already in the PDF (Edit → Edit drawing): its path in
 * the object's own box at its natural size, scaled to width × height.
 */
export interface VectorObject extends BaseObject {
  type: 'vector';
  width: number;
  height: number;
  /** Absolute M / L / C / Z path data, 0..naturalWidth × 0..naturalHeight, y down. */
  path: string;
  naturalWidth: number;
  naturalHeight: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  evenOdd: boolean;
}

export interface LineObject extends BaseObject {
  type: 'line' | 'arrow';
  /** Local coordinates relative to (x, y): [x1, y1, x2, y2]. */
  points: [number, number, number, number];
  stroke: string;
  strokeWidth: number;
}

export interface PenObject extends BaseObject {
  type: 'pen';
  /** Flat local coordinates relative to (x, y). */
  points: number[];
  /** Pen pressure (0-1) at each point: the line width varies with it. */
  pressures?: number[];
  stroke: string;
  strokeWidth: number;
}

export interface RedactObject extends BaseObject {
  type: 'redact';
  width: number;
  height: number;
  fill: string;
}

export interface SignatureObject extends BaseObject {
  type: 'signature';
  width: number;
  height: number;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  signerName: string;
  /** ISO timestamp of placement. */
  signedAt: string;
  /** Draw a small caption under the ink with signer + date. */
  showCaption: boolean;
  kind: 'signature' | 'initials';
}

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature' | 'button' | 'barcode';

/** What a button does when clicked (saved as a standard PDF action). */
export type FieldAction =
  | { kind: 'submit'; email: string; subject: string }
  | { kind: 'reset' }
  | { kind: 'print' }
  | { kind: 'url'; url: string }
  | { kind: 'showhide'; fields: string[]; hide: boolean }
  | { kind: 'page'; page: number };

export interface FieldObject extends BaseObject {
  type: 'field';
  fieldKind: FieldKind;
  width: number;
  height: number;
  /** Field name; radio buttons sharing a name form one group. */
  name: string;
  /** Export value for radio options, default text for text fields. */
  value: string;
  options: string[];
  required: boolean;
  fontSize: number;
  multiline: boolean;
  /** Text fields: format, allowed range and calculation (saved as Acrobat form actions). */
  logic?: import('@/lib/formLogic').FieldLogic;
  /** Buttons: the click action (the caption is `value`). */
  action?: FieldAction;
  /** Barcode fields: what they encode ({Field} placeholders take the field values when saving). */
  barcode?: { symbology: 'qr' | 'code128'; template: string };
}

export type EditorObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | LineObject
  | PenObject
  | VectorObject
  | RedactObject
  | SignatureObject
  | FieldObject
  | NoteObject
  | MarkupObject
  | StampObject
  | LinkObject
  | PolyObject
  | AttachmentObject
  | MeasureObject;

export type EditorObjectType = EditorObject['type'];

/** An edited bookmark (outline item). */
export interface BookmarkItem {
  id: string;
  title: string;
  /** Destination page (null for web links or pages that were deleted). */
  pageId: string | null;
  /** Top of the view on that page, PDF units from the page bottom (null = whole page). */
  top: number | null;
  url: string | null;
  bold: boolean;
  italic: boolean;
  open: boolean;
  children: BookmarkItem[];
}

/** The part of the document state that undo/redo snapshots. */
export interface DocSnapshot {
  pages: PageRef[];
  objects: EditorObject[];
  /** Edited bookmarks; null keeps the file's own outline unchanged. */
  outline?: BookmarkItem[] | null;
}

export interface SearchHit {
  pageId: string;
  /** Surrounding text with the match wrapped in [[ ]]. */
  snippet?: string;
  /** Rect in display space at scale 1. */
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface ToolStyle {
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
  highlightColor: string;
  fontFamily: FontFamily;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

export interface SavedSignature {
  id: string;
  kind: 'signature' | 'initials';
  src: string;
  width: number;
  height: number;
  signerName: string;
}

/** Status of a cryptographic signature found in (or applied to) the document. */
export interface SignatureValidation {
  fieldName: string;
  signerName: string;
  signedAt: string | null;
  reason: string | null;
  /** Digest over the signed ByteRange matches and the RSA signature verifies. */
  integrity: 'valid' | 'invalid' | 'unknown';
  /** Signed ranges cover the whole file (nothing appended after signing). */
  coversWholeFile: boolean;
  selfSigned: boolean;
  certSubject: string;
  certIssuer: string;
  certValidFrom: string;
  certValidTo: string;
  hasTimestamp: boolean;
  message: string;
  chainStatus?: 'trusted' | 'untrusted' | 'incomplete' | 'expired' | 'unknown';
  /** Human-readable chain, leaf → root. */
  chainDetails?: string[];
  revocationStatus?: 'good' | 'revoked' | 'unknown' | 'not-checked';
  revocationDetails?: string;
  modifiedAfterSigning?: boolean;
  /** Validation data for the whole chain is saved in the file (long-term validation). */
  ltv?: boolean;
  /** This signature certifies the document: 1 no changes, 2 form filling and signing, 3 also comments. */
  certified?: 1 | 2 | 3 | null;
  /** What later revisions changed (when the signature does not cover the whole file). */
  laterChanges?: { ltv: boolean; signatures: boolean; form: boolean; annotations?: boolean; other: boolean; reasons?: string[] } | null;
  /** The signature timestamp (or document timestamp) verified: signed by a trusted timestamping authority, over this signature. */
  timestampVerified?: boolean;
  /** Weak algorithms or keys, unsuitable certificates: valid, but not to be shown as fully good. */
  warnings?: string[];
  /** e.g. "RSA-2048 / SHA-256". */
  algorithm?: string;
  /** A document timestamp (ETSI.RFC3161), not a person's signature. */
  documentTimestamp?: boolean;
  /** PAdES baseline level (EU eIDAS) reached by this signature. */
  padesLevel?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA' | null;
  /** EU qualified certificate (QcCompliance); 'qscd': key on a qualified signature creation device. */
  qualified?: 'qc' | 'qscd' | null;
  /** The signer (or timestamp) certificate chains to an EU Trusted List service. */
  euTrusted?: string | null;
}
