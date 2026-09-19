/**
 * Opening a film's preview by resting the pointer on its card. Pure apart from the clock it is
 * given, so the rules are testable without a browser.
 *
 * Only a pointer that hovers (a mouse or a pen) opens anything, and only after it has rested on
 * one card for the dwell delay: sweeping across a row opens nothing, because every new card
 * starts the wait again. Keyboard and remote focus never open a preview here; they use OK.
 *
 * A pointer that did not move does not count. Content scrolled under a resting mouse (a remote
 * moving the row) makes the browser report the pointer over a new card, and that must not open
 * it. Once a card's preview has opened, however it was opened, that card stays spent until the
 * pointer leaves it, so closing a preview with the pointer still on its card does not reopen it.
 */

export const PREVIEW_DWELL_MS = 650;

export type DwellClock = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const BROWSER_CLOCK: DwellClock = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** The pointer kinds that can rest over something without pressing it. */
export function hovers(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen";
}

export type PointerRest = { pointerType: string; moved: boolean };

export type Dwell<K> = {
  /** The pointer is over the card `key` (a move within it, or entering it). */
  rest: (key: K, pointer: PointerRest) => void;
  /** The pointer left the card `key`. */
  leave: (key: K) => void;
  /** A preview opened for `key`, by any means. */
  opened: (key: K) => void;
  /** The open preview closed. */
  closed: () => void;
  /** Stops a pending open, for a key press or a scroll. */
  cancel: () => void;
};

export function createDwell<K>(open: (key: K) => void, { delayMs = PREVIEW_DWELL_MS, clock = BROWSER_CLOCK }: { delayMs?: number; clock?: DwellClock } = {}): Dwell<K> {
  let pending: { key: K; handle: unknown } | null = null;
  let spent: { key: K } | null = null;
  let previewing = false;

  const cancel = () => {
    if (pending) clock.clearTimeout(pending.handle);
    pending = null;
  };

  return {
    rest(key, { pointerType, moved }) {
      if (previewing || !moved || !hovers(pointerType)) return;
      if (spent && Object.is(spent.key, key)) return;
      // Moving within the card it is already waiting on keeps the same wait.
      if (pending && Object.is(pending.key, key)) return;
      cancel();
      const handle = clock.setTimeout(() => {
        pending = null;
        open(key);
      }, delayMs);
      pending = { key, handle };
    },
    leave(key) {
      if (previewing) return;
      if (pending && Object.is(pending.key, key)) cancel();
      if (spent && Object.is(spent.key, key)) spent = null;
    },
    opened(key) {
      cancel();
      spent = { key };
      previewing = true;
    },
    closed() {
      previewing = false;
    },
    cancel,
  };
}
