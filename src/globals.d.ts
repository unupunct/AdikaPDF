// tsconfig uses moduleDetection "force", so globals need `declare global`.
export {};

declare global {
  /** App version from package.json, injected by Vite (vite.config.ts `define`). */
  const __APP_VERSION__: string;
}
