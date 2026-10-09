/**
 * Component tests (jsdom): the desktop boundary (Tauri) and pdf.js are mocked,
 * browser APIs jsdom lacks are stubbed, and the DOM is cleaned after each test.
 */
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Tauri: nothing native is reachable; `isDesktop` in platform.ts stays false.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    throw new Error(`Tauri command ${cmd} is not available in component tests`);
  }),
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined), openPath: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));

// pdf.js: components never render pages here.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  AnnotationMode: { ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3, DISABLE: 0 },
  PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
  getDocument: vi.fn(() => ({ promise: Promise.reject(new Error('pdf.js is not available in component tests')), destroy: async () => undefined })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= ResizeObserverStub;
g.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= function () {};
// Canvas drawing (signature pads, thumbnails): a 2D context that draws nothing.
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return new Proxy({}, { get: (_t, p) => (p === 'canvas' ? this : p === 'measureText' ? () => ({ width: 0 }) : p === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined) });
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
