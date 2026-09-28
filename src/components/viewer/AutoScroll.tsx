/**
 * Auto-scroll (Acrobat "Automatically Scroll", Ctrl+Shift+H): the document
 * scrolls by itself. While it runs: ↑/↓ change the speed, − reverses the
 * direction, Esc (or Ctrl+Shift+H) stops. It stops at the end of the document.
 */
import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';

/** Speeds in CSS pixels per second. */
export const AUTO_SPEEDS = [15, 25, 40, 60, 90, 130, 190, 280, 400];

interface AutoScrollState {
  on: boolean;
  /** Index into AUTO_SPEEDS. */
  level: number;
  /** 1 = down, -1 = up. */
  direction: 1 | -1;
  toggle: () => void;
  stop: () => void;
  faster: (steps: number) => void;
  reverse: () => void;
}

export const useAutoScroll = create<AutoScrollState>()((set) => ({
  on: false,
  level: 2,
  direction: 1,
  toggle: () => set((s) => ({ on: !s.on, direction: s.on ? s.direction : 1 })),
  stop: () => set({ on: false }),
  faster: (steps) => set((s) => ({ level: Math.max(0, Math.min(AUTO_SPEEDS.length - 1, s.level + steps)) })),
  reverse: () => set((s) => ({ direction: s.direction === 1 ? -1 : 1 })),
}));

export function autoScrollSpeed(): number {
  const s = useAutoScroll.getState();
  return AUTO_SPEEDS[s.level] * s.direction;
}

export function AutoScroller({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const on = useAutoScroll((s) => s.on);

  useEffect(() => {
    if (!on) return;
    const el = container.current;
    if (!el) return;
    let last = performance.now();
    // Sub-pixel carry: scrollTop only takes whole (device) pixels.
    let carry = 0;
    let raf = 0;
    const step = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      carry += autoScrollSpeed() * dt;
      const whole = Math.trunc(carry);
      if (whole !== 0) {
        const before = el.scrollTop;
        el.scrollTop = before + whole;
        carry -= whole;
        // Reached the end (or the top when going up): stop.
        if (el.scrollTop === before) {
          useAutoScroll.getState().stop();
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const onKey = (e: KeyboardEvent) => {
      const s = useAutoScroll.getState();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Faster in the current direction with the arrow that points that way.
        s.faster((e.key === 'ArrowDown') === (s.direction === 1) ? 1 : -1);
      } else if (e.key === '-' || e.key === 'Subtract') s.reverse();
      else if (e.key === 'Escape') s.stop();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [on, container]);

  return null;
}
