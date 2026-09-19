import { useEffect } from "react";

/**
 * How much of the screen a phone's software keyboard has taken, and how much is left to draw in.
 *
 * A phone keyboard does not resize the page. By default a browser keeps the layout viewport the
 * size it was and shrinks the *visual* viewport — what is actually on screen — so `100dvh` still
 * measures the whole screen and anything anchored to the bottom of the page sits behind the keys.
 * The visual viewport is the only thing that reports the keyboard, so the screen reads it and
 * publishes two custom properties the stylesheet can use; where it is missing (an older browser,
 * a test document) the properties are absent and the stylesheet's `dvh` defaults stand.
 */

/** The height left on screen, in CSS pixels. */
export const VIEWPORT_HEIGHT = "--search-viewport";
/** How far the bottom of the page is covered, in CSS pixels. */
export const KEYBOARD_INSET = "--search-keyboard";

export type ViewportReading = {
  /** The height of the page's own viewport, which the keyboard does not change. */
  layoutHeight: number;
  /** The height on screen, which it does. */
  visibleHeight: number;
  /** How far the visible part has been pushed down the page. */
  offsetTop: number;
  /** The pinch-zoom scale; anything but 1 means the viewer zoomed, not that a keyboard opened. */
  scale: number;
};

/**
 * A reading that is too small to be a keyboard is noise — a browser's own toolbars retracting, a
 * rounding difference — and moving the field for it would make the page twitch as it scrolls.
 */
const LEAST_KEYBOARD = 90;

/**
 * What the keyboard covers, from a visual-viewport reading. Zoomed in, the visible area is small
 * for a reason that is not a keyboard, and nothing moves.
 */
export function keyboardInset({ layoutHeight, visibleHeight, offsetTop, scale }: ViewportReading): number {
  if (Math.abs(scale - 1) > 0.05) return 0;
  const covered = layoutHeight - (visibleHeight + offsetTop);
  return covered >= LEAST_KEYBOARD ? Math.round(covered) : 0;
}

/**
 * Publishes the reading on the document, for as long as the screen is mounted. It is on the
 * document because the screen's layers (the preview, the filter panel) are drawn outside its own
 * element and need the same numbers; both properties are removed again when it unmounts.
 */
export function useViewport() {
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const root = document.documentElement;
    const publish = () => {
      const reading: ViewportReading = {
        layoutHeight: root.clientHeight,
        visibleHeight: visual.height,
        offsetTop: visual.offsetTop,
        scale: visual.scale,
      };
      root.style.setProperty(VIEWPORT_HEIGHT, `${Math.round(visual.height)}px`);
      root.style.setProperty(KEYBOARD_INSET, `${keyboardInset(reading)}px`);
    };
    publish();
    visual.addEventListener("resize", publish);
    visual.addEventListener("scroll", publish);
    window.addEventListener("orientationchange", publish);
    return () => {
      visual.removeEventListener("resize", publish);
      visual.removeEventListener("scroll", publish);
      window.removeEventListener("orientationchange", publish);
      root.style.removeProperty(VIEWPORT_HEIGHT);
      root.style.removeProperty(KEYBOARD_INSET);
    };
  }, []);
}
