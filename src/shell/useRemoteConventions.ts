import { useEffect, useLayoutEffect, useRef } from "react";
import { backAction } from "./keys";
import { firstContent, focusIsLost, focusTopBar, isEditable, isInLiveTopBar, ownsVerticalArrows } from "./topBarFocus";

/** Keys a remote sends to move or choose. With nothing focused, they would do nothing at all. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);

/**
 * The app-wide remote conventions, installed once by the app.
 *
 * Back, pressed anywhere on a page, scrolls to the top and focuses the top bar: the bar scrolls
 * away as the viewer moves down, and this is what makes it reachable again from thirty rows down.
 * Back pressed on the bar leaves the screen (`leave`, which answers whether it went anywhere; on
 * the home it does not, and the key is left to the platform). A press something on the page has
 * already consumed (a field clearing its text) does neither, and a held Back never leaves.
 *
 * Up from the first thing on a page moves into the bar, for every screen that does not steer its
 * own rows. Screens that do (the home, the Discover grid) hand focus to the bar themselves.
 *
 * With nothing focused, a remote's key lands on the top bar instead of on nothing. A held OK
 * acts once: its repeats are swallowed, so holding it on a poster cannot also press whatever the
 * next screen focuses.
 *
 * It also records how the viewer is driving the app: `data-input="pointer"` on the root after a
 * pointer is used, removed again by any key. The stylesheets mark every focused control until
 * then, because a remote gives the browser no reason to think focus should be visible.
 *
 * The listeners sit on the window. The main one runs after React has dispatched to the page, so
 * a component that handles a key calls `preventDefault` and this stands aside.
 */
export function useRemoteConventions(leave: () => boolean) {
  const leaveRef = useRef(leave);
  useLayoutEffect(() => {
    leaveRef.current = leave;
  });

  useEffect(() => {
    const swallowRepeatedOk = (event: KeyboardEvent) => {
      document.documentElement.removeAttribute("data-input");
      // In a text field a held Enter or Space is typing, not a held OK.
      const typing = isEditable(event.target instanceof Element ? event.target : null);
      if (event.repeat && !typing && (event.key === "Enter" || event.key === " ")) event.preventDefault();
    };
    const pointerUsed = () => document.documentElement.setAttribute("data-input", "pointer");

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!event.defaultPrevented && NAVIGATION_KEYS.has(event.key) && focusIsLost(target)) {
        event.preventDefault();
        focusTopBar({ scroll: false });
        return;
      }
      const action = backAction({
        key: event.key,
        keyCode: event.keyCode,
        editable: isEditable(target),
        handled: event.defaultPrevented,
        inTopBar: isInLiveTopBar(target),
        repeat: event.repeat,
      });
      if (action === "leave") {
        if (leaveRef.current()) event.preventDefault();
        return;
      }
      if (action === "focus-top-bar") {
        event.preventDefault();
        focusTopBar();
        return;
      }
      if (event.key === "ArrowUp" && !event.defaultPrevented && target && !ownsVerticalArrows(target) && target === firstContent()) {
        event.preventDefault();
        focusTopBar();
      }
    };

    window.addEventListener("keydown", swallowRepeatedOk, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", pointerUsed, true);
    return () => {
      window.removeEventListener("keydown", swallowRepeatedOk, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", pointerUsed, true);
    };
  }, []);
}
