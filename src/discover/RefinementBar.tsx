import { useRef } from "react";
import { REFINEMENTS, activeRefinements, isApplied, type ActiveRefinement, type Refinement } from "../catalogue/refinements";
import type { PreferenceState } from "../preferences/schema";

type RefinementBarProps = {
  state: PreferenceState;
  notice: string | null;
  /** How many catalogue titles match everything in effect, when known. */
  matchCount: number | null;
  barRef: React.RefObject<HTMLElement | null>;
  onChoose: (refinement: Refinement) => void;
  onUnchoose: (refinement: Refinement) => void;
  onWithdraw: (item: ActiveRefinement) => void;
  onRestore: () => void;
  onReset: () => void;
  /** Up or Back from the first rail. */
  onExitUp: () => void;
  /** Down from the last rail. */
  onExitDown: () => void;
};

/**
 * Things the viewer can say to Discover, as a rail of chips, and a second rail of everything
 * currently shaping the result, each removable. Rails navigate like the grid: Left/Right within
 * a rail, Up/Down between rails, so a remote reaches every chip.
 */
export function RefinementBar(props: RefinementBarProps) {
  const { state, notice, matchCount, barRef, onChoose, onUnchoose, onWithdraw, onRestore, onReset } = props;
  const suggestRef = useRef<HTMLDivElement | null>(null);
  const active = activeRefinements(state);
  const rejected = state.rejectedCandidateIds.length;
  const shaping = active.length > 0 || rejected > 0;

  /** The pressed button is about to disappear; hand focus to a neighbour that will not. */
  function keepFocusNear(button: HTMLElement) {
    const rail = button.parentElement;
    const buttons = rail ? Array.from(rail.querySelectorAll<HTMLButtonElement>("button")) : [];
    const index = buttons.indexOf(button as HTMLButtonElement);
    const neighbour = buttons[index + 1] ?? buttons[index - 1];
    const lastShaping = buttons.length <= 2;
    (lastShaping ? suggestRef.current?.querySelector<HTMLButtonElement>("button") : neighbour)?.focus();
  }

  return (
    <section className="discover-refine" aria-label="Refine the results" ref={barRef} onKeyDown={(event) => handleRailKey(event, props)}>
      <div className="discover-rail" data-rail="" role="group" aria-label="Say what you want" ref={suggestRef}>
        {REFINEMENTS.map((refinement) => {
          const applied = isApplied(refinement, state);
          return (
            <button
              key={refinement.id}
              type="button"
              className="discover-chip"
              aria-pressed={applied}
              onClick={() => (applied ? onUnchoose(refinement) : onChoose(refinement))}
            >
              {refinement.sentence}
            </button>
          );
        })}
      </div>

      {shaping && (
        <div className="discover-rail discover-rail-active" data-rail="" role="group" aria-label="Shaping the result">
          <span className="discover-rail-label" aria-live="polite">
            {matchCount === null ? "Narrowing…" : `${matchCount.toLocaleString("en")} ${matchCount === 1 ? "title matches" : "titles match"}`}
          </span>
          {active.map((item) => (
            <button
              key={item.key}
              type="button"
              className="discover-chip discover-chip-active"
              aria-label={`Remove ${item.label}`}
              onClick={(event) => {
                keepFocusNear(event.currentTarget);
                onWithdraw(item);
              }}
            >
              {item.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          {rejected > 0 && (
            <button
              type="button"
              className="discover-chip discover-chip-active"
              aria-label={`Bring back ${rejected} turned-down ${rejected === 1 ? "title" : "titles"}`}
              onClick={(event) => {
                keepFocusNear(event.currentTarget);
                onRestore();
              }}
            >
              {rejected} turned down <span aria-hidden="true">×</span>
            </button>
          )}
          <button
            type="button"
            className="discover-chip discover-chip-reset"
            onClick={() => {
              suggestRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
              onReset();
            }}
          >
            Start over
          </button>
        </div>
      )}

      {notice && (
        <p className="discover-refine-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

/** Focus lands on the button nearest the horizontal position the viewer left from. */
function focusNearest(rail: HTMLElement, from: HTMLElement) {
  const buttons = Array.from(rail.querySelectorAll<HTMLButtonElement>("button"));
  const origin = from.getBoundingClientRect().left;
  const nearest = buttons.reduce<HTMLButtonElement | undefined>((best, button) => {
    if (!best) return button;
    const distance = Math.abs(button.getBoundingClientRect().left - origin);
    return distance < Math.abs(best.getBoundingClientRect().left - origin) ? button : best;
  }, undefined);
  nearest?.focus();
  nearest?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function handleRailKey(event: React.KeyboardEvent<HTMLElement>, props: RefinementBarProps) {
  const target = event.target as HTMLElement;
  const rail = target.closest<HTMLElement>("[data-rail]");
  if (!rail || target.tagName !== "BUTTON") return;
  const rails = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-rail]"));
  const railIndex = rails.indexOf(rail);

  switch (event.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const buttons = Array.from(rail.querySelectorAll<HTMLButtonElement>("button"));
      const next = buttons[buttons.indexOf(target as HTMLButtonElement) + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return;
    }
    case "ArrowUp": {
      event.preventDefault();
      const above = rails[railIndex - 1];
      if (above) focusNearest(above, target);
      else props.onExitUp();
      return;
    }
    case "ArrowDown": {
      event.preventDefault();
      const below = rails[railIndex + 1];
      if (below) focusNearest(below, target);
      else props.onExitDown();
      return;
    }
    case "Escape":
    case "GoBack":
    case "BrowserBack":
      event.preventDefault();
      props.onExitUp();
  }
}
