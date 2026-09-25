import type { EditorObject, PageRef, Rotation } from '@/types';

/** 2D affine matrix in PDF operator order: [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 · m2 — apply m2 first, then m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function translate(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

/** Rotation by `deg` degrees clockwise in a y-down space (matches Konva). */
export function rotateCw(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

export function normalizeRotation(deg: number): Rotation {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

export function normalizeAngle(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return Math.abs(r - 360) < 1e-9 ? 0 : r;
}

export function totalRotation(page: PageRef): Rotation {
  return normalizeRotation(page.baseRotation + page.userRotation);
}

/** Page size as displayed (rotation applied), in points. */
export function displaySize(page: PageRef): { width: number; height: number } {
  const r = totalRotation(page);
  return r % 180 === 0
    ? { width: page.width, height: page.height }
    : { width: page.height, height: page.width };
}

/**
 * Maps display space (top-left origin, y down, rotation applied) to PDF user
 * space for a page whose visible box is [x0, y0, x0 + w, y0 + h] and whose
 * /Rotate is `rotation`.
 */
export function displayToPdfMatrix(
  rotation: Rotation,
  box: { x: number; y: number; width: number; height: number },
): Matrix {
  const { x: x0, y: y0, width: w, height: h } = box;
  switch (rotation) {
    case 0:
      return [1, 0, 0, -1, x0, y0 + h];
    case 90:
      return [0, 1, 1, 0, x0, y0];
    case 180:
      return [-1, 0, 0, 1, x0 + w, y0];
    case 270:
      return [0, -1, -1, 0, x0 + w, y0 + h];
  }
}

/**
 * Where a display-space point lands after the page is rotated by `delta`
 * degrees clockwise. `w`/`h` are the display size *before* the rotation.
 */
export function rotateDisplayPoint(
  x: number,
  y: number,
  delta: Rotation,
  w: number,
  h: number,
): [number, number] {
  switch (delta) {
    case 0:
      return [x, y];
    case 90:
      return [h - y, x];
    case 180:
      return [w - x, h - y];
    case 270:
      return [y, w - x];
  }
}

/** Re-anchors an object after its page rotated by `delta` clockwise. */
export function rotateObjectWithPage<T extends EditorObject>(
  obj: T,
  delta: Rotation,
  w: number,
  h: number,
): T {
  const [x, y] = rotateDisplayPoint(obj.x, obj.y, delta, w, h);
  return { ...obj, x, y, rotation: normalizeAngle(obj.rotation + delta) };
}

/** Axis-aligned local size of an object (before its own rotation). */
export function objectLocalBounds(obj: EditorObject): Rect {
  switch (obj.type) {
    case 'line':
    case 'arrow': {
      const [x1, y1, x2, y2] = obj.points;
      const pad = obj.strokeWidth * 2;
      return {
        x: Math.min(x1, x2) - pad,
        y: Math.min(y1, y2) - pad,
        width: Math.abs(x2 - x1) + pad * 2,
        height: Math.abs(y2 - y1) + pad * 2,
      };
    }
    case 'pen': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < obj.points.length; i += 2) {
        minX = Math.min(minX, obj.points[i]);
        maxX = Math.max(maxX, obj.points[i]);
        minY = Math.min(minY, obj.points[i + 1]);
        maxY = Math.max(maxY, obj.points[i + 1]);
      }
      if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
      const pad = obj.strokeWidth;
      return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    }
    default:
      return { x: 0, y: 0, width: obj.width, height: obj.height };
  }
}

/** Bounding box of an object in display space (its rotation applied). */
export function objectDisplayBounds(obj: EditorObject): Rect {
  const local = objectLocalBounds(obj);
  const m = multiply(translate(obj.x, obj.y), rotateCw(obj.rotation));
  return transformRectBounds(m, local);
}

export function transformRectBounds(m: Matrix, r: Rect): Rect {
  const pts = [
    applyMatrix(m, r.x, r.y),
    applyMatrix(m, r.x + r.width, r.y),
    applyMatrix(m, r.x, r.y + r.height),
    applyMatrix(m, r.x + r.width, r.y + r.height),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
