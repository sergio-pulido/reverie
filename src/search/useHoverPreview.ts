import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueTitle } from "../catalogue/contract";
import type { Critique } from "../conversation/contract";
import { createDwell } from "./dwell";
import type { CardHover } from "./ResultCard";

/**
 * Wires the cards' pointer events to the dwell rule: `open` runs for a card the pointer has rested
 * on. Any key press or scroll cancels a pending open, because either means the viewer is doing
 * something else than hovering.
 */
export function useHoverPreview(open: (title: CatalogueTitle, card: HTMLElement, critique: Critique | null) => void) {
  const shown = useRef(new WeakMap<HTMLElement, { title: CatalogueTitle; critique: Critique | null }>());
  const openRef = useRef(open);
  openRef.current = open;
  const [dwell] = useState(() =>
    createDwell<HTMLElement>((card) => {
      const on = shown.current.get(card);
      if (on && card.isConnected && !card.closest("[inert]")) openRef.current(on.title, card, on.critique);
    }),
  );

  useEffect(() => {
    const stop = () => dwell.cancel();
    window.addEventListener("keydown", stop, true);
    window.addEventListener("scroll", stop, true);
    return () => {
      window.removeEventListener("keydown", stop, true);
      window.removeEventListener("scroll", stop, true);
      dwell.cancel();
    };
  }, [dwell]);

  const hover = useMemo<CardHover>(
    () => ({
      onPointerMove(title, critique, event) {
        const card = event.currentTarget;
        shown.current.set(card, { title, critique });
        dwell.rest(card, { pointerType: event.pointerType, moved: event.movementX !== 0 || event.movementY !== 0 });
      },
      onPointerLeave(event) {
        dwell.leave(event.currentTarget);
      },
    }),
    [dwell],
  );

  return { hover, dwell };
}
