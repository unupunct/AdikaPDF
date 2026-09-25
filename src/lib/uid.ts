let counter = 0;

/** Short unique id, stable for the session. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 0xffffff;
  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
