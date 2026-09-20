import type { KeyboardEvent } from "react";
import { focusTopBar } from "../shell/topBarFocus";

/**
 * Which shelf Catalog is browsing: the one Reverie reads, or the one it made.
 *
 * Films made here used to be a destination of their own. They are not a different place — they
 * are a different source of the same thing, which is the whole claim — so they are a switch over
 * the same grid instead.
 *
 * It is the first thing under the bar, so a remote's first Down lands on it: Left and Right
 * choose, Up returns to the bar, Down goes on into the page.
 */
export type CatalogSource = "catalogue" | "made";

const SOURCES: ReadonlyArray<{ id: CatalogSource; label: string }> = [
  { id: "catalogue", label: "The catalogue" },
  { id: "made", label: "Made in Reverie" },
];

type SourceFilterProps = {
  source: CatalogSource;
  onSource: (next: CatalogSource) => void;
  barRef: React.RefObject<HTMLDivElement | null>;
  /** Down from the switch: into whatever the chosen source put below it. */
  onExitDown: () => void;
};

export function SourceFilter({ source, onSource, barRef, onExitDown }: SourceFilterProps) {
  function move(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || event.defaultPrevented) return;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        event.preventDefault();
        buttons[event.key === "ArrowRight" ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0)]?.focus();
        return;
      case "ArrowUp":
        event.preventDefault();
        focusTopBar();
        return;
      case "ArrowDown":
        event.preventDefault();
        onExitDown();
    }
  }

  return (
    <div className="catalog-source" role="radiogroup" aria-label="Which films to browse" ref={barRef} onKeyDown={move}>
      {SOURCES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={source === id}
          className={`catalog-source-choice${source === id ? " active" : ""}`}
          onClick={() => onSource(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
